import type { DatabaseSync } from "node:sqlite";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import {
  acquireFleetCellOperationInDatabase,
  assertFleetCellOperationInDatabase,
  deleteFleetCellInDatabase,
  heartbeatFleetCellOperationInDatabase,
  releaseFleetCellOperationInDatabase,
  reserveFleetCellInDatabase,
  updateFleetCellImageInDatabase,
} from "./registry.kernel.js";
import type { FleetCellOperationName, ReserveFleetCellParams } from "./registry.types.js";

function inTransaction<Input, Output>(operation: (db: DatabaseSync, input: Input) => Output) {
  return (input: Input, { open, stateOptions }: WorkerOperationContext): Output =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db, input), {
      database: open(),
      ...stateOptions(),
    });
}

export const fleetOperations = {
  "fleet.cell.reserve": inTransaction(
    (db, input: ReserveFleetCellParams & { operationOwner?: string }) => {
      assertFleetCellOperationInDatabase(db, input.tenantId, input.operationOwner);
      return reserveFleetCellInDatabase(db, input);
    },
  ),
  "fleet.cell.updateImage": inTransaction(
    (db, input: { tenantId: string; image: string; operationOwner?: string }) => {
      assertFleetCellOperationInDatabase(db, input.tenantId, input.operationOwner);
      return updateFleetCellImageInDatabase(db, input.tenantId, input.image);
    },
  ),
  "fleet.cell.delete": inTransaction((db, input: { tenantId: string; operationOwner?: string }) => {
    assertFleetCellOperationInDatabase(db, input.tenantId, input.operationOwner);
    return deleteFleetCellInDatabase(db, input.tenantId);
  }),
  "fleet.operation.acquire": inTransaction(
    (
      db,
      input: { tenantId: string; operation: FleetCellOperationName; owner: string; nowMs?: number },
    ): void => acquireFleetCellOperationInDatabase(db, input),
  ),
  "fleet.operation.heartbeat": inTransaction(
    (db, input: { tenantId: string; owner: string; nowMs?: number }): void =>
      heartbeatFleetCellOperationInDatabase(db, input),
  ),
  "fleet.operation.release": inTransaction((db, input: { tenantId: string; owner: string }): void =>
    releaseFleetCellOperationInDatabase(db, input),
  ),
} satisfies WorkerOperationHandlers;
