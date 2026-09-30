import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const pluginInspection = vi.hoisted(() => vi.fn());
vi.mock("../../plugins/active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: () => undefined,
}));
vi.mock("../../plugins/loader.js", () => ({
  acquirePluginRegistryForInspection: pluginInspection,
}));
vi.mock("../../plugins/manifest-contract-runtime.js", () => ({
  resolveManifestContractRuntimePluginResolution: () => ({ pluginIds: ["fixture-storage"] }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function invoke(
  method: "storage.locations.list" | "storage.locations.probe",
  config: OpenClawConfig,
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  const handler = coreGatewayHandlers[method];
  if (!handler) {
    throw new Error(`Missing ${method} handler`);
  }
  await handler({
    req: { type: "req", id: "storage-request", method },
    params,
    context: createDirectChatContext({ getRuntimeConfig: () => config }),
    client: null,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

describe("storage Gateway methods", () => {
  it("does not activate an unavailable provider through CLI plugin inspection", async () => {
    const respond = await invoke(
      "storage.locations.probe",
      {
        storage: {
          locations: { remote: { provider: "fixture-storage", settings: {}, encryption: "none" } },
        },
      },
      { name: "remote" },
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ state: "error" }),
      undefined,
    );
    expect(pluginInspection).not.toHaveBeenCalled();
  });

  it("lists config without opening a missing destination or exposing settings and secrets", async () => {
    const root = path.join(tempDirs.make("openclaw-storage-rpc-"), "missing");
    const config: OpenClawConfig = {
      storage: {
        locations: {
          archive: {
            provider: "filesystem",
            settings: { path: root },
            encryption: {
              passphrase: { source: "env", provider: "default", id: "STORAGE_TEST_KEY" },
            },
          },
        },
      },
    };
    const respond = await invoke("storage.locations.list", config, {});
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        locations: [
          { name: "archive", provider: "filesystem", displayTarget: root, encrypted: true },
        ],
      },
      undefined,
    );
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an unavailable destination through probe without creating its root", async () => {
    const root = path.join(tempDirs.make("openclaw-storage-rpc-"), "missing");
    const respond = await invoke(
      "storage.locations.probe",
      {
        storage: {
          locations: {
            archive: { provider: "filesystem", settings: { path: root }, encryption: "none" },
          },
        },
      },
      { name: "archive" },
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ state: "unavailable" }),
      undefined,
    );
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["storage.locations.list", "storage.locations.probe"] as const)(
    "%s is available with read scope and rejects unknown request properties",
    async (method) => {
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: true,
      });
      expect(authorizeOperatorScopesForMethod(method, [])).toEqual({
        allowed: false,
        missingScope: "operator.read",
      });
      const respond = await invoke(method, {}, { name: "../invalid", unexpected: true });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );
});
