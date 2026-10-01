import type { SessionEntryCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import type { placementTurnClaimOperations } from "./placement-turn-claims.worker.js";
export type PlacementTurnClaimReceipt = {
  placement?: WorkerSessionPlacementRecord;
  claim?: WorkerSessionTurnClaim;
};
export type PlacementTurnClaimCurrentCheck = {
  sessionEntry?: SessionEntryCurrentCheck;
  assertPlacementCurrent(placement: WorkerSessionPlacementRecord | undefined): void;
};
export type PlacementTurnClaimWorkerOperations = WorkerOperations<
  typeof placementTurnClaimOperations
>;
