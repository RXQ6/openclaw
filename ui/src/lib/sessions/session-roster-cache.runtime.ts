import { clearBootRecords } from "../../app/boot-record.ts";
import {
  openSessionRosterDatabase,
  resetSessionRosterDatabase,
  rosterRequestResult,
  rosterTransactionDone,
} from "./session-roster-cache-database.ts";
import {
  invalidateSessionRosterCache,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_ROSTER_STORE_NAME,
  sessionRosterCacheGeneration,
  type SessionRosterRecord,
} from "./session-roster-cache.ts";

const pending = new Map<string, SessionRosterRecord>();
const latestPublications = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let writeChain = Promise.resolve();

async function writeRecords(records: SessionRosterRecord[], generation: number): Promise<void> {
  if (generation !== sessionRosterCacheGeneration) {
    return;
  }
  const { boundSessionRosterRecord, parseSessionRosterRecord } =
    await import("./session-roster-cache.reader.ts");
  if (generation !== sessionRosterCacheGeneration) {
    return;
  }
  const database = await openSessionRosterDatabase();
  if (!database) {
    return;
  }
  try {
    if (generation !== sessionRosterCacheGeneration) {
      return;
    }
    const transaction = database.transaction(SESSION_ROSTER_STORE_NAME, "readwrite");
    const completed = rosterTransactionDone(transaction);
    const store = transaction.objectStore(SESSION_ROSTER_STORE_NAME);
    const values: unknown[] = await rosterRequestResult(store.getAll());
    const next = new Map<string, SessionRosterRecord>();
    for (const value of values) {
      const record = parseSessionRosterRecord(value);
      if (!record) {
        store.clear();
        next.clear();
        break;
      }
      next.set(record.scope, record);
    }
    for (const value of records) {
      const record = boundSessionRosterRecord(value);
      if (record) {
        store.put(record);
        next.set(record.scope, record);
      } else {
        store.delete(value.scope);
        next.delete(value.scope);
      }
    }
    const retained = [...next.values()].toSorted((left, right) => right.savedAt - left.savedAt);
    for (const [index, record] of retained.entries()) {
      if (index >= 6 || Date.now() - record.savedAt > SESSION_ROSTER_MAX_AGE_MS) {
        store.delete(record.scope);
      }
    }
    await completed;
  } catch {
    database.close();
    await resetSessionRosterDatabase();
  } finally {
    database.close();
  }
}

export function persistSessionRoster(record: SessionRosterRecord, publication: number): void {
  if (!globalThis.indexedDB || publication <= (latestPublications.get(record.scope) ?? 0)) {
    return;
  }
  latestPublications.set(record.scope, publication);
  pending.set(record.scope, record);
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => void flushSessionRosters(), 500);
}

export async function flushSessionRosters(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const records = [...pending.values()];
  pending.clear();
  const generation = sessionRosterCacheGeneration;
  if (records.length > 0) {
    writeChain = writeChain.then(() => writeRecords(records, generation));
  }
  await writeChain;
}

export async function clearCachedBootState(scope?: string, recoveryScope?: string): Promise<void> {
  const matchesScope = (key: string) =>
    recoveryScope && scope
      ? key === `account:${JSON.stringify([scope, recoveryScope])}`
      : key === scope || key.startsWith(`account:${JSON.stringify([scope]).slice(0, -1)},`);
  invalidateSessionRosterCache();
  clearBootRecords(scope);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (scope) {
    for (const key of pending.keys()) {
      if (matchesScope(key)) {
        pending.delete(key);
        latestPublications.delete(key);
      }
    }
  } else {
    pending.clear();
    latestPublications.clear();
  }
  // A successor write must wait for deletion as well as the retired writer's lazy load.
  const precedingWrites = writeChain;
  writeChain = (async () => {
    try {
      await precedingWrites;
    } finally {
      if (!scope) {
        await resetSessionRosterDatabase();
      } else {
        const database = await openSessionRosterDatabase();
        if (database) {
          try {
            const transaction = database.transaction(SESSION_ROSTER_STORE_NAME, "readwrite");
            const completed = rosterTransactionDone(transaction);
            const store = transaction.objectStore(SESSION_ROSTER_STORE_NAME);
            const keys = await rosterRequestResult(store.getAllKeys());
            for (const key of keys) {
              if (typeof key === "string" && matchesScope(key)) {
                store.delete(key);
              }
            }
            await completed;
          } finally {
            database.close();
          }
        }
      }
    }
  })();
  await writeChain;
}

if (
  globalThis.indexedDB &&
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  window.addEventListener("pagehide", () => void flushSessionRosters());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushSessionRosters();
    }
  });
}
