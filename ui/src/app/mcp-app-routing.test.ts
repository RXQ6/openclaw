import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpAppRouteFromSearch } from "../lib/mcp-app-route.ts";
import { navigateMcpAppLink, startMcpAppRouting } from "./mcp-app-routing.ts";

describe("MCP app link routing", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

  it("passes the marketplace plugin identity through the real click boundary", () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    anchor.href = "codex://plugins/vendor-parts@team/app/cad.library?path=%2Fselected%3Fid%3D42";
    document.body.append(anchor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    expect(anchor.dispatchEvent(click)).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0]?.[0]).toBe("apps");
    expect(mcpAppRouteFromSearch(navigate.mock.calls[0]?.[1].search)).toEqual({
      kind: "plugin",
      pluginId: "vendor-parts",
      marketplace: "team",
      toolName: "cad.library",
      deepLink: "/selected?id=42",
    });
  });

  it("routes ordinary chat links even when their renderer requests a new tab", () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    anchor.href = "codex://plugins/parts@team/app/cad.library?path=%2Fparts%3Ftag%3Dbolt";
    anchor.target = "_blank";
    const event = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("apps", {
      search: "?tool=cad.library&path=%2Fparts%3Ftag%3Dbolt&plugin=parts&marketplace=team",
    });
  });

  it("does not hijack external URLs or modified navigation", () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    expect(
      navigateMcpAppLink({ navigate }, "https://example.com/plugins/parts/app/cad.library"),
    ).toBe(false);
    const anchor = document.createElement("a");
    anchor.href = "chatgpt://plugins/parts/app/cad.library";
    const event = new MouseEvent("click", {
      button: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
