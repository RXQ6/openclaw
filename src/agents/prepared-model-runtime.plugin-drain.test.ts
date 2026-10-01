// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { adoptRuntimeContextEngineRegistrations } from "../context-engine/registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { adoptRuntimeToolRegistrations } from "../plugins/tool-registry-adoption.js";
import { runContextEngineMaintenanceWork } from "./embedded-agent-runner/context-engine-maintenance-work.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import {
  acquireAgentRunPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { ownPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-runtime-plugin-drain" });

it.each([false, true])(
  "settles maintenance model acquisition so donor replacement can drain (quiesced=%s)",
  async (quiesced) => {
    const config = { plugins: { allow: ["fixture"], slots: { contextEngine: "fixture" } } };
    const replacementConfig = { ...config, agents: { defaults: { workspace: "/synthetic/new" } } };
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const input = { ...fixture.agentInput("default", config), loadRuntimePlugins: true };
    const abort = new AbortController();
    const createRegistry = (runtime: boolean) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "fixture",
        source: "/synthetic/fixture.ts",
        enabled: true,
        contracts: { tools: ["fixture_tool"] },
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config });
      api.registerTool(() => null, { name: "fixture_tool" });
      if (runtime) {
        api.registerContextEngine("fixture", () => ({
          info: { id: "fixture", name: "Fixture" },
          async ingest() {
            return { ingested: false };
          },
          async assemble({ messages }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
          async maintain() {
            // Match runtime.llm.complete's executable lease request, without provider I/O.
            const acquisition = acquireAgentRunPreparedModelRuntime(input, {
              abortSignal: abort.signal,
              catalogMode: "static",
            });
            // A deterministic escape distinguishes a gate wait from immediate rejection.
            abort.abort(new Error("acquisition reached the replacement wait"));
            const lease = await acquisition;
            await lease[Symbol.asyncDispose]();
            return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
          },
        }));
        markPluginRegistryActive(builder.registry);
        setPluginRuntimeLoadContext(builder.registry, {
          rawConfig: config,
          config,
          activationSourceConfig: config,
          autoEnabledReasons: {},
          workspaceDir: "/synthetic",
          env: process.env,
          logger: { info() {}, warn() {}, error() {} },
        });
      }
      return { registry: builder.registry, instance: getPluginInstance(record)! };
    };
    const donor = createRegistry(true);
    const local = createRegistry(false);
    const registry = adoptRuntimeContextEngineRegistrations(
      adoptRuntimeToolRegistrations(local.registry, donor.registry, config),
      donor.registry,
    );
    expect(registry.tools[0]!.factory).toBe(donor.registry.tools[0]!.factory);
    const lifetime = ownPreparedPluginGeneration({
      pluginRegistry: registry,
      pluginMetadataSnapshot: createPluginMetadataSnapshot({ manifestRegistry: makeRegistry([]) }),
      remoteCatalog: null,
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    });
    const releaseRun = lifetime.retain(true);
    let lease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
    let releaseReplacement: (() => void) | undefined;
    try {
      lease = await withPluginRuntimeRegistryScope(registry, () =>
        createContextEngineLogicalTurnLease({
          identity: { runId: "plugin-drain", sessionId: "fixture" },
          config,
        }),
      );
      lease.begin();
      await lease.engine.assemble({ sessionId: "fixture", messages: [] });
      expect(donor.instance.retainedWorkCount).toBeGreaterThan(0);

      // An expired invocation frame must not confer admission on a new reader.
      const expiredInvocation = donor.instance.run(() => AsyncLocalStorage.snapshot());
      markPreparedModelRuntimeSnapshotsStale("donor plugin replacement", {
        waitForReplacement: true,
      });
      const reader = expiredInvocation(() => acquireAgentRunPreparedModelRuntime(input));
      releaseReplacement = donor.instance.reserveReplacement();
      if (quiesced) {
        donor.instance.quiesce();
      }
      const replacement = donor.instance
        .waitForRetainedWork(new AbortController().signal, true)
        .then(() => refreshPreparedModelRuntimeSnapshots(replacementConfig));
      const maintenance = runContextEngineMaintenanceWork(async () => {
        await lease!.engine.maintain?.({
          sessionId: "fixture",
          sessionFile: "/synthetic/session.jsonl",
        });
      }, new AbortController().signal);
      const result = maintenance.catch((error: unknown) => error);
      lease.deferDisposalUntil(maintenance);
      const error = await result;
      await lease.dispose();
      await releaseRun();
      expect(donor.instance.retainedWorkCount).toBe(0);
      await replacement;
      await using newReader = await reader;
      expect(newReader.snapshot.config).toBe(replacementConfig);
      expect(error).toMatchObject({
        message:
          "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
      });
    } finally {
      abort.abort();
      releaseReplacement?.();
      await lease?.dispose();
      await releaseRun();
      await donor.instance.dispose();
    }
  },
);
