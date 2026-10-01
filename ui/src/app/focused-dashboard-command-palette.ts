import { consume } from "@lit/context";
import { html } from "lit";
import { property, query } from "lit/decorators.js";
import type { RouteId } from "../app-routes.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  isCommandPaletteShortcut,
  type CommandPaletteElement,
} from "../components/command-palette-contract.ts";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import {
  openPreferredApplicationSession,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  renderCommandPaletteElement,
  renderCommandPaletteLoading,
  ShellCommandPaletteOwner,
} from "./app-shell-command-palette-loading.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "./context.ts";
import {
  COMMAND_PALETTE_ELEMENT,
  LazyCustomElementRequestController,
} from "./lazy-custom-element.ts";

/** The shell-free dashboard supplies navigation, not another palette implementation. */
class FocusedDashboardCommandPalette extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  context?: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @query("openclaw-command-palette") commandPalette?: CommandPaletteElement;
  readonly commandPaletteElement = COMMAND_PALETTE_ELEMENT;
  readonly lazyCustomElements = new LazyCustomElementRequestController(this, () =>
    this.palette.closePending(),
  );
  private readonly palette = new ShellCommandPaletteOwner(this, {
    request: (element, _event, replay) => this.lazyCustomElements.request(element, replay),
    clear: () => this.lazyCustomElements.abandon(),
    cancel: () => this.palette.loading.clear(),
    pending: () => this.lazyCustomElements.visibleState !== undefined,
  });
  constructor() {
    super();
    new SubscriptionsController(this)
      .watchStore(
        () => this.context?.gateway,
        () => this.palette.synchronizeScope(),
      )
      .effect(
        () => this.ownerDocument,
        (document) => {
          const controller = new AbortController();
          const options = { signal: controller.signal };
          document.addEventListener("keydown", this.handleKeydown, { ...options, capture: true });
          window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, this.palette.open, options);
          window.addEventListener("openclaw:native-open-search", this.palette.open, options);
          window.addEventListener(
            "openclaw:native-toggle-search",
            this.handleNativeToggle,
            options,
          );
          return () => {
            controller.abort();
            this.palette.closePending();
          };
        },
      );
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.palette.handlePendingShortcut(event)) {
      return;
    }
    if (
      !event.defaultPrevented &&
      !document.openClawModalLayers?.size &&
      !this.commandPalette &&
      isCommandPaletteShortcut(event)
    ) {
      event.preventDefault();
      this.palette.toggle();
    }
  };

  private readonly handleNativeToggle = (event: Event): void => {
    event.preventDefault();
    this.palette.toggle();
  };

  chatNavigationOptions(face: "chat"): ApplicationNavigationOptions | undefined {
    return this.context
      ? sessionNavigationTarget({
          context: this.context,
          face,
          sessionKey: this.sessionKey,
          agentId: this.agentId,
        }).options
      : undefined;
  }

  navigate(routeId: RouteId, options?: ApplicationNavigationOptions): void {
    this.context?.navigate(routeId, options);
  }

  selectChatSession(sessionKey: string): void {
    if (this.context) {
      openPreferredApplicationSession(this.context, sessionKey);
    }
  }

  handleCommandPaletteSlashCommand(command: string): void {
    this.palette.handleSlashCommand(command);
  }

  override render() {
    const state = this.lazyCustomElements.visibleState;
    return html`
      ${
        this.palette.loading.active && state?.status !== "error"
          ? renderCommandPaletteLoading(this.palette.loading, () => this.palette.closePending())
          : renderLazyElementModal(this.lazyCustomElements)
      }
      ${renderCommandPaletteElement(this)}
      <openclaw-toast-host></openclaw-toast-host>
    `;
  }
}

customElements.define("openclaw-focused-dashboard-command-palette", FocusedDashboardCommandPalette);
