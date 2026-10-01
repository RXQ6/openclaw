import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { telemetryOperations } from "./telemetry-store.worker.js";

export type TelemetryState = {
  lastPingAt?: number;
  latestVersion?: string;
  note?: string;
};

export type SuccessfulTelemetryState = TelemetryState & {
  lastPingAt: number;
  latestVersion: string;
};

export type TelemetryWorkerOperations = WorkerOperations<typeof telemetryOperations>;
