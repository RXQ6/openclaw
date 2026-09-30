import { expect, it, onTestFinished, vi } from "vitest";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import {
  getSubagentRegistryPublicationRevision,
  publishSubagentRunChanges,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";

it.each(["memory", "persistence"] as const)(
  "publishes %s projections before session observers and wakes persistence observers last",
  (source) => {
    const order: string[] = [];
    const revision = getSubagentRegistryPublicationRevision();
    const event = { runIds: ["run"], sessionKeys: ["child", undefined, "child"] };
    onTestFinished(
      subscribeSubagentRunChanges("projection", (published) => {
        expect(published).toEqual(event);
        expect(getSubagentRegistryPublicationRevision()).toBe(revision + 1);
        order.push("projection");
      }),
    );
    onTestFinished(
      sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === "child") {
          order.push("session");
        }
      }),
    );
    const persisted = vi.fn<Parameters<typeof subscribeSubagentRunChanges>[1]>((published) => {
      expect(published).toEqual(event);
      order.push("persistence");
      throw new Error("observer failed");
    });
    onTestFinished(subscribeSubagentRunChanges("persistence", persisted));
    onTestFinished(subscribeSubagentRunChanges("persistence", () => order.push("last")));

    expect(() => publishSubagentRunChanges(event.sessionKeys, event.runIds, source)).not.toThrow();
    expect(order).toEqual(
      source === "memory"
        ? ["projection", "session"]
        : ["projection", "session", "persistence", "last"],
    );
    expect(persisted).toHaveBeenCalledTimes(source === "memory" ? 0 : 1);
  },
);

it("propagates projection failures before session or persistence observers run", () => {
  const failure = new Error("projection failed");
  const session = vi.fn();
  const persisted = vi.fn();
  onTestFinished(
    subscribeSubagentRunChanges("projection", () => {
      throw failure;
    }),
  );
  onTestFinished(sessionChanges.subscribe(session));
  onTestFinished(subscribeSubagentRunChanges("persistence", persisted));

  expect(() => publishSubagentRunChanges(["child"], ["run"], "persistence")).toThrow(failure);
  expect(session).not.toHaveBeenCalled();
  expect(persisted).not.toHaveBeenCalled();
});
