import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { sessionDeliveryOperations } from "./session-delivery-queue.worker.js";

export type SessionDeliveryAgentRunUpdate = {
  expectedMediaUrls?: string[];
  message?: string;
  suppressTextDelivery?: boolean;
};

export type SessionDeliveryWorkerOperations = WorkerOperations<typeof sessionDeliveryOperations>;
