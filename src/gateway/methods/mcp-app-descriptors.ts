/** Ordered MCP App method policies, composed into the single core registry table. */
import type { CoreGatewayMethodSpecRow } from "./core-descriptors.js";

export const MCP_APP_EXTENSION_METHOD_SPECS = [
  [
    "mcp.app.onboard",
    "mcp-app-onboarding",
    "operator.write",
    "2026.9",
    { sessionAccess: { mode: "write" } },
  ],
  [
    "mcp.app.discover",
    "mcp-app-extensions",
    "operator.write",
    "2026.9",
    { sessionAccess: { mode: "write" } },
  ],
  [
    "mcp.app.launch",
    "mcp-app-extensions",
    "operator.write",
    "2026.9",
    { sessionAccess: { mode: "write" } },
  ],
  [
    "mcp.app.settings",
    "mcp-app-extensions",
    "operator.write",
    "2026.9",
    { sessionAccess: { mode: "write" } },
  ],
  [
    "mcp.app.mention",
    "mcp-app-extensions",
    "operator.write",
    "2026.9",
    { sessionAccess: { mode: "write" } },
  ],
  ["mcp.app.formResource", "mcp-app", "operator.write", "2026.9"],
  ["mcp.app.modelContext", "mcp-app", "operator.read", "2026.9"],
  ["mcp.app.removeModelContext", "mcp-app", "operator.write", "2026.9"],
  ["mcp.app.writeResource", "mcp-app", "operator.write", "2026.9"],
  ["mcp.app.subscribeResource", "mcp-app", "operator.read", "2026.9"],
  ["mcp.app.unsubscribeResource", "mcp-app", "operator.read", "2026.9"],
  ["mcp.app.openFile", "mcp-app", "operator.read", "2026.9"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];

/** These retained methods keep their original indices in the advertised catalog. */
export const MCP_APP_GATEWAY_METHOD_SPECS = [
  ["mcp.app.view", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.listTools", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.listResources", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.listResourceTemplates", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.readResource", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.callTool", "mcp-app", "operator.write", "<=2026.7"],
  ["mcp.app.updateModelContext", "mcp-app", "operator.write", "<=2026.7"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];
