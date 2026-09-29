import path from "node:path";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { publicationMethods } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session-only chat read gates" });

suite.define(() => {
  it("does not load publication options or PR status with session-only scopes", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1180 },
      },
      async ({ page }) => {
        const row = createControlUiSessionRow("agent:main:main", "Scoped workspace", Date.now());
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          sessionKey: row.key,
          sessions: [row],
          operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
          featureMethods: publicationMethods,
          methodResponses: {
            "sessions.github.options": {
              __mockError: { code: "FORBIDDEN", message: "missing scope operator.read" },
            },
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: {
              __mockError: { code: "FORBIDDEN", message: "missing scope operator.read" },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
        await gateway.waitForRequest("chat.startup");
        await page.locator("openclaw-chat-pane.chat-pane-cache__pane--active").waitFor();
        expect(await gateway.getRequests("sessions.github.options")).toHaveLength(0);
        expect(await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).toHaveLength(0);
        expect(await page.getByText("missing scope operator.read").count()).toBe(0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "session-only-chat-after.png"),
            animations: "disabled",
          });
        }
      },
    );
  });
});
