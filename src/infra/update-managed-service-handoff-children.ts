import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  type createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import type {
  HandoffProcessIdentity,
  ManagedHandoffLeaseAction,
  ManagedHandoffLeasePayload,
} from "./update-managed-service-handoff-schema.js";

export function managedCommandCustody(
  lease: ManagedHandoffParent | ManagedHandoffLeasePayload | null,
) {
  return lease?.version === 2 && lease.action.kind === "update" ? lease.action.custody : undefined;
}

/** Tracked command reservations outlive their helper; only group extinction closes a binding. */
export function managedCommandUnsettled(lease: ManagedHandoffLease): boolean {
  return (
    managedCommandCustody(lease) !== "bound" ||
    process.platform === "win32" ||
    isChildProcessTreeAlive(lease.executor)
  );
}

export function managedCommandAllowsBinding(
  lease: ManagedHandoffLease,
  action: ManagedHandoffLeaseAction,
  executor?: HandoffProcessIdentity,
): boolean {
  const custody = managedCommandCustody(lease);
  return custody
    ? custody === "reserved" &&
        action.kind === "update" &&
        action.custody === "bound" &&
        executor !== undefined &&
        executor.pid !== lease.helper.pid
    : action.kind !== "update" || !action.custody;
}

export function createManagedHandoffChildReader(deps: {
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  handle: ReturnType<typeof createManagedHandoffLeaseRows>["handle"];
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
}) {
  return function hasUnsettledChildren(
    parent: ManagedHandoffParent | string,
    connection?: HandoffDatabase,
  ): boolean {
    if (typeof parent !== "string" && (parent.version === 3 || parent.version === 4)) {
      return true;
    }
    const prefix = `${typeof parent === "string" ? parent : parent.key}/.openclaw-update-child-`;
    const inspect = (db: HandoffDatabase) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["install_root", "owner", "payload_json", "updated_at"])
          .where("install_root", ">=", prefix)
          .where("install_root", "<", prefix + "\uffff"),
      ).rows.some((entry) => {
        const child = deps.handle(entry.install_root, entry);
        return managedCommandCustody(child)
          ? managedCommandUnsettled(child)
          : child.version === 3 ||
              child.version === 4 ||
              deps.processState(child.helper) !== "dead" ||
              deps.processState(child.executor) !== "dead" ||
              (process.platform !== "win32" && isChildProcessTreeAlive(child.executor));
      });
    return connection ? inspect(connection) : deps.withDatabase(false, inspect);
  };
}
