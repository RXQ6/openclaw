import { randomUUID } from "node:crypto";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import type { CommandProcessCustody } from "../process/command-process-custody.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";

/** Adapt command-process settlement to the existing durable update lease owner. */
export function createManagedCommandProcessCustody(options: {
  roots: readonly string[];
  runId: string;
  databasePath?: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  assertCurrent?: () => void;
}): {
  custody: CommandProcessCustody;
  databasePath: string;
  databaseIdentity: ManagedUpdateLeaseDatabaseIdentity;
} {
  const roots = [...new Set(options.roots)];
  if (!roots.length || roots.some((root) => !root || root.endsWith("/"))) {
    throw new Error("Managed command custody requires installation roots");
  }
  const requestedPath =
    options.databasePath ??
    options.databaseIdentity?.databasePath ??
    resolveManagedUpdateLeaseDatabasePath();
  const databaseIdentity =
    options.databaseIdentity ??
    createManagedHandoffLeaseDatabase(requestedPath)(true, () =>
      captureManagedUpdateLeaseDatabaseIdentity(requestedPath),
    );
  const databasePath = databaseIdentity.databasePath;
  if (options.databasePath && options.databaseIdentity && options.databasePath !== databasePath) {
    throw new Error("Managed command custody database path changed");
  }
  const store = createManagedHandoffLeaseStore({
    databasePath,
    existingIdentity: databaseIdentity,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  const custody: CommandProcessCustody = {
    reserve(argv) {
      options.assertCurrent?.();
      const child = `.openclaw-update-child-${randomUUID()}-command`;
      let leases: ManagedHandoffLease[] = [];
      try {
        for (const root of roots) {
          const acquired = store.acquire(`${root}/${child}`, options.runId, {
            kind: "update",
            custody: "reserved",
          });
          if (acquired.kind !== "acquired") {
            throw new Error("Managed command custody reservation is busy");
          }
          leases.push(acquired.lease);
        }
      } catch (error) {
        // No spawn has been requested while constructing the reservation.
        for (const lease of leases) {
          store.releaseCommandReservation(lease);
        }
        throw error;
      }
      let bound = false;
      return {
        spawned({ pid }) {
          options.assertCurrent?.();
          const next = store.bindUpdateChildren(leases, pid, argv);
          if (!next) {
            throw new Error("Managed command custody binding was not retained");
          }
          leases = next;
          bound = true;
        },
        settled() {
          const released = bound
            ? store.releaseAll(leases)
            : leases.map((lease) => store.releaseCommandReservation(lease)).every(Boolean);
          if (!released) {
            throw new Error("Managed command custody settlement was not retained");
          }
        },
      };
    },
  };
  return { custody, databasePath, databaseIdentity };
}
