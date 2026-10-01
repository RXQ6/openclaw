import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import {
  createWorkerInferenceStoreKernel,
  type WorkerInferenceRetentionPolicy,
} from "./inference-store.kernel.js";

type Kernel = ReturnType<typeof createWorkerInferenceStoreKernel>;
type KernelInput<Method extends keyof Kernel> = Parameters<Kernel[Method]>[0];

function operation<Input, Output>(type: string, execute: (store: Kernel, input: Input) => Output) {
  return (
    input: { input: Input; nowMs: number; retention: Partial<WorkerInferenceRetentionPolicy> },
    { open }: WorkerOperationContext,
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const store = createWorkerInferenceStoreKernel({
          db,
          now: () => input.nowMs,
          retention: input.retention,
        });
        const result = execute(store, input.input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { database: open() },
      { operationLabel: type },
    );
}

export const workerInferenceOperations = {
  "workerInference.begin": operation(
    "workerInference.begin",
    (store, input: KernelInput<"begin">) => store.begin(input),
  ),
  "workerInference.complete": operation(
    "workerInference.complete",
    (store, input: KernelInput<"complete">) => store.complete(input),
  ),
  "workerInference.cancelPending": operation(
    "workerInference.cancelPending",
    (store, input: KernelInput<"cancelPending">) => store.cancelPending(input),
  ),
  "workerInference.recoverPending": operation(
    "workerInference.recoverPending",
    (store, input: KernelInput<"recoverPending">) => store.recoverPending(input),
  ),
} satisfies WorkerOperationHandlers;
