import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { auditOperations } from "./audit-event-writer.worker.js";
import type { ExecutionDecisionWork } from "./execution-decision-work.types.js";
import type { ExecutionIdentityAdmissionWork } from "./execution-identity-admission.js";

export type AuditWriterRequest =
  | { type: "record-event"; input: AuditEventInput }
  | { type: "record-execution-identity"; work: ExecutionIdentityAdmissionWork }
  | { type: "record-execution-decision"; receipt: DecisionReceiptV1 }
  | { type: "record-execution-decision-work"; work: ExecutionDecisionWork };

export type AuditMaintenanceFamily = "events" | "identity" | "decisions" | "progress";

/** Only a completed native contention attempt authorizes the FIFO to retry. */
export type AuditWriterResult =
  | { status: "settled"; deleted?: number; error?: string }
  | { status: "retry" };

export type AuditWorkerOperations = WorkerOperations<typeof auditOperations>;
export type AuditWriterOperations = Pick<
  AuditWorkerOperations,
  "audit.writer.process" | "audit.writer.prune"
>;
