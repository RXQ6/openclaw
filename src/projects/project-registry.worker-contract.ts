import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease-store.js";
import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { projectRegistryOperations } from "./project-registry.worker.js";

export type ProjectCheckoutLeaseInput<TProject> = {
  project: TProject;
  lease: OpenClawStateLeaseIdentity;
};

export type ProjectRegistryWorkerOperations = WorkerOperations<typeof projectRegistryOperations>;
