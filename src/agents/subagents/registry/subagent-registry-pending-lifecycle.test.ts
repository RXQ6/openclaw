import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";

describe("pending lifecycle registration ownership", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["scheduleError", "scheduleTimeout", "scheduleCancellation"] as const)(
    "%s cannot settle a same-ID successor",
    (schedule) => {
      vi.useFakeTimers();
      const original = createSubagentRunRecord({ runId: "reused", generation: 1 });
      const runs = new Map([[original.runId, original]]);
      const completeInBackground = vi.fn();
      const scheduler = createPendingLifecycleScheduler({ runs, completeInBackground });
      scheduler[schedule]({ runId: original.runId, endedAt: 123, error: "old failure" });
      const successor = createSubagentRunRecord({ runId: original.runId, generation: 2 });
      runs.set(original.runId, successor);

      vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);

      expect(completeInBackground).not.toHaveBeenCalled();
      scheduler[schedule]({ runId: successor.runId, endedAt: 456, error: "new failure" });
      vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
      expect(completeInBackground).toHaveBeenCalledOnce();
      expect(completeInBackground).toHaveBeenCalledWith(
        expect.objectContaining({ runId: successor.runId, endedAt: 456, expectedEntry: successor }),
        expect.any(String),
      );
    },
  );

  it("rejects a registration whose generation changes on the same row", () => {
    vi.useFakeTimers();
    const entry = createSubagentRunRecord({ runId: "rotated", generation: 1 });
    const completeInBackground = vi.fn();
    const scheduler = createPendingLifecycleScheduler({
      runs: new Map([[entry.runId, entry]]),
      completeInBackground,
    });
    scheduler.scheduleError({ runId: entry.runId, endedAt: 123, error: "old failure" });
    entry.generation = 2;

    vi.advanceTimersByTime(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);

    expect(completeInBackground).not.toHaveBeenCalled();
  });
});
