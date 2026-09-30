import type { AgentWaitResult } from "../../run-wait.types.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SessionFollowupCompletion } from "./session-followup-completion.js";

export type FollowupReply = AgentWaitResult & { replyText?: string };
type FollowupCustody = {
  run<T>(work: () => T): T;
  assertCurrent(): void;
  signal: AbortSignal;
  release(): void;
};
export type FollowupRequesterAuthority = {
  release(): void;
  run<T>(runId: string, run: () => Promise<T>): Promise<T>;
};
export type FollowupRequest = {
  runId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterAgentId: string;
  targetSessionKey: string;
  targetAgentId: string;
  custody: FollowupCustody;
  requesterAuthority?: FollowupRequesterAuthority | undefined;
  completion?: FollowupCompletionOwner;
};
export type FollowupCohort = { entries: readonly SubagentRunRecord[]; generation: number };
export type FollowupSuccessor = {
  owner: FollowupCompletionOwner;
  cohort: FollowupCohort;
  runId: string;
  assertCurrent(): void;
};

export type FollowupSettlement = { kind: "yielded" } | { kind: "terminal"; reply: FollowupReply };
/** Logical result custody outlives each physical execution and its projections. */
export type FollowupCompletionOwner = Pick<
  SessionFollowupCompletion,
  keyof SessionFollowupCompletion
>;
