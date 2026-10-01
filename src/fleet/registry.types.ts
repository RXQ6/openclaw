import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { fleetOperations } from "./registry.worker.js";

export type FleetCellRecord = {
  tenantId: string;
  createdAtMs: number;
  image: string;
  runtime: "docker" | "podman";
  hostPort: number;
  containerName: string;
  dataDir: string;
};

export type ReserveFleetCellParams = Omit<FleetCellRecord, "hostPort"> & {
  requestedPort?: number;
};

export type FleetCellOperationName =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "upgrade"
  | "backup"
  | "restore"
  | "rm";

export type FleetRegistryWriteOperations = WorkerOperations<typeof fleetOperations>;
