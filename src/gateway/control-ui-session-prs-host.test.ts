import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps a public session reader outside a same-named private Enterprise repository", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const provider = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      return githubJson([
        pullListItem({
          state: "closed",
          head: {},
          title: url.hostname === "api.github.com" ? "Public change" : "Private Enterprise secret",
          html_url: `https://${url.hostname === "api.github.com" ? "github.com" : "ghe.example.test"}/synthetic/publication/pull/103469`,
          base: { repo: { name: "publication", owner: { login: "synthetic" } } },
        }),
      ]);
    });
    vi.stubGlobal("fetch", provider);
    const f = await createFixture("operator.read", true);
    try {
      setRuntimeConfigSnapshot({
        ...f.cfg,
        gateway: {
          ...f.cfg.gateway,
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
          controlUi: { github: { host: "ghe.example.test", token: "synthetic-enterprise-token" } },
        },
      });
      const privateKey = "agent:main:private-enterprise";
      for (const [key, host, creator] of [
        [sessionKey, "github.com", f.profile.id],
        [privateKey, "ghe.example.test", f.other.id],
      ]) {
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey: key!,
          url: `https://${host}/synthetic/publication`,
          branch: "guest-change",
          assertCurrent: () => {},
        });
        await f.seed(key!, creator, {
          repositoryWorkspaceId: repository.workspaceId,
          ...(key === privateKey ? { visibility: "draft" } : {}),
        });
      }
      await f.subscribe([sessionKey, privateKey]);
      await f.subscriptions.pollNow();
      const delivered = JSON.stringify(f.socket.send.mock.calls);
      expect(delivered).toContain("Public change");
      expect(delivered).not.toContain("Private Enterprise secret");
      expect(provider).toHaveBeenCalledOnce();
      const [input, options] = provider.mock.calls[0]!;
      expect(new URL(requestUrl(input)).origin).toBe("https://api.github.com");
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
    } finally {
      await f.close();
    }
  });
});

it("reads an admitted Enterprise session and builds its branch link on that host", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const provider = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(requestUrl(input));
      expect(url.origin).toBe("https://ghe.example.test");
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        "Bearer synthetic-enterprise-token",
      );
      return url.pathname.endsWith("/pulls") ? githubJson([]) : githubJson({ fork: false });
    });
    vi.stubGlobal("fetch", provider);
    const f = await createFixture("operator.read", true);
    try {
      setRuntimeConfigSnapshot({
        ...f.cfg,
        gateway: {
          ...f.cfg.gateway,
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
          controlUi: { github: { host: "ghe.example.test", token: "synthetic-enterprise-token" } },
        },
      });
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: "https://ghe.example.test/synthetic/publication",
        branch: "guest-change",
        assertCurrent: () => {},
      });
      await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      await f.subscribe();
      await f.subscriptions.pollNow();
      expect(JSON.stringify(f.socket.send.mock.calls)).toContain(
        "https://ghe.example.test/synthetic/publication/pull/new/guest-change",
      );
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
});
