import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMcpAppExtensionRuntime } from "./mcp-app-extension-runtime.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  direct: vi.fn(),
  release: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  source: vi.fn(),
  releaseSource: vi.fn(),
  registered: vi.fn(),
  assert: vi.fn(),
  selection: vi.fn(),
}));
vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  acquireSessionMcpRuntime: mocks.direct,
  releaseSessionMcpRuntime: mocks.release,
}));
vi.mock("../agents/agent-bundle-mcp-materialize.js", () => ({
  buildBundleMcpToolsFromCatalog: () => [],
}));
vi.mock("../agents/agent-bundle-mcp-runtime-config.js", () => ({
  loadSessionMcpConfig: () => ({ loaded: { mcpServers: {} } }),
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir: () => "/agent",
  resolveAgentWorkspaceDir: () => "/workspace",
}));
vi.mock("../agents/harness/registry.js", () => ({ getRegisteredAgentHarness: mocks.registered }));
vi.mock("../agents/thinking-runtime.js", () => ({ resolveEffectiveAgentRuntime: mocks.selection }));
vi.mock("../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, sandboxRequired: false }),
}));
vi.mock("../agents/harness/session-preparation.js", () => ({
  prepareAgentHarnessSessionRuntime: mocks.prepare,
}));
vi.mock("../agents/mcp-codex-tool-approval.js", () => ({
  requiresMcpCodexToolApproval: () => false,
  resolveProjectedMcpCodexToolApprovalMode: () => undefined,
}));
vi.mock("../agents/mcp-tool-filter.js", () => ({
  isMcpToolAllowed: () => true,
  normalizeMcpToolFilter: () => undefined,
}));
vi.mock("../plugins/current-plugin-metadata-state.js", () => ({
  getGatewayPluginMetadataSnapshot: () => undefined,
}));
vi.mock("../plugins/tool-metadata.js", () => ({ getPluginToolMeta: () => undefined }));
vi.mock("./mcp-app-host-files.js", () => ({ resolveMcpAppRequesterId: () => "alice" }));
vi.mock("./mcp-app-tool-approval.js", () => ({ requestMcpAppToolApproval: vi.fn() }));
vi.mock("./operator-run-authority.js", () => ({
  captureGatewayOperatorRunAuthority: mocks.source,
}));
vi.mock("./session-resource-tool-policy.js", () => ({ resolveSessionResourceToolPolicy: vi.fn() }));
vi.mock("./session-row-projection-access.js", () => ({
  getSessionRowProjection: () => ({ sharingTarget: () => ({ entry, storePath: "/store" }) }),
}));
vi.mock("./session-utils-model-selection.js", () => ({
  resolveSessionSelectedModelRef: () => ({ provider: "openai", model: "model" }),
}));
const config = { mcp: { apps: { enabled: true } } };
let entry: { sessionId: string; agentRuntimeOverride?: string };
function options() {
  return {
    context: { getRuntimeConfig: () => config },
    sessionAccessAuthority: {
      assertCurrent: mocks.assert,
      target: { agentId: "main", sessionKey: "agent:main:app", sessionId: "session" },
    },
  } as unknown as GatewayRequestHandlerOptions;
}
beforeEach(() => {
  vi.resetAllMocks();
  entry = { sessionId: "session", agentRuntimeOverride: "codex" };
  mocks.selection.mockReturnValue("codex");
  mocks.registered.mockReturnValue({
    ownerPluginId: "codex",
    harness: { loadMcpToolCatalog: vi.fn(), acquireMcpAppRuntime: mocks.native },
  });
  mocks.source.mockResolvedValue({ authority: { kind: "fixture" }, release: mocks.releaseSource });
  mocks.prepare.mockResolvedValue({
    preparation: { version: 1, purpose: "mcp-app" },
    dispose: mocks.dispose,
  });
  mocks.native.mockImplementation(async ({ prepareSession }) => {
    await prepareSession();
    return {
      runtime: {
        getCatalog: async () => ({ version: 1, generatedAt: 1, servers: {}, tools: [] }),
        joinCleanup: async () => {},
      },
      releaseLease: vi.fn(),
    };
  });
});
describe("cold App request admission", () => {
  it("selects the current harness before any historical model turn and admits its native setup", async () => {
    const active = await prepareMcpAppExtensionRuntime(options());
    expect(mocks.selection).toHaveBeenCalledWith(expect.objectContaining({ sessionEntry: entry }));
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPluginId: "codex",
        sourceAuthority: { kind: "fixture" },
        input: expect.objectContaining({
          senderId: "alice",
          sessionId: "session",
          workspaceDir: "/workspace",
        }),
      }),
    );
    expect(mocks.native).toHaveBeenCalledWith(
      expect.objectContaining({ appRequester: { kind: "gateway-profile", profileId: "alice" } }),
    );
    expect(mocks.direct).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.releaseSource).toHaveBeenCalledOnce();
    entry = { ...entry, agentRuntimeOverride: "openclaw" };
    expect(active.assertCurrent).toThrow("runtime selection changed");
    await active.dispose();
  });
  it("does not fall back to a second transport when the selected harness is unavailable", async () => {
    mocks.registered.mockReturnValue(undefined);
    await expect(prepareMcpAppExtensionRuntime(options())).rejects.toThrow(
      "harness is unavailable",
    );
    expect(mocks.direct).not.toHaveBeenCalled();
  });
  it("does not prepare credentials after source authority disappears", async () => {
    mocks.source.mockImplementation(async () => {
      mocks.assert.mockImplementation(() => {
        throw new Error("revoked");
      });
      return { release: mocks.releaseSource };
    });
    await expect(prepareMcpAppExtensionRuntime(options())).rejects.toThrow("revoked");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.releaseSource).toHaveBeenCalledOnce();
  });
});
