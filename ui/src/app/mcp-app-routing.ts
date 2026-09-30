import { parseMcpAppLink, mcpAppRouteSearch } from "../lib/mcp-app-route.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { ApplicationContext } from "./context.ts";

export function navigateMcpAppLink(
  context: Pick<ApplicationContext, "navigate">,
  url: string,
): boolean {
  const target = parseMcpAppLink(url);
  if (!target) {
    return false;
  }
  context.navigate("apps", { search: mcpAppRouteSearch(target) });
  return true;
}

export function startMcpAppRouting(context: Pick<ApplicationContext, "navigate">) {
  const click = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (!anchor || anchor.hasAttribute("download")) {
      return;
    }
    // Chat links use target=_blank by default. Recognized plugin links still
    // belong to this host; modified clicks retain normal browser behavior.
    if (navigateMcpAppLink(context, anchor.href)) {
      event.preventDefault();
    }
  };
  document.addEventListener("click", click);
  return { dispose: () => document.removeEventListener("click", click) };
}
