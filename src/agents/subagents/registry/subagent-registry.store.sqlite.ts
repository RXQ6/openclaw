import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql, type ExpressionBuilder, type RawBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import type {
  SubagentRunReadRecord,
  SubagentMaintenanceDurableBasis,
  SubagentRunsDurableBasis,
} from "./subagent-registry-read.types.js";
import {
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
  type SubagentRunSqliteRow,
} from "./subagent-registry.store.codec.js";
import {
  hasParentStoreColumns,
  writeSubagentRunValuesInDatabase,
  type BoundSubagentRunRecord,
} from "./subagent-registry.store.kernel.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
function parentStoreColumns(db: DatabaseSync) {
  return hasParentStoreColumns(db)
    ? (["requester_store_path", "controller_store_path"] as const)
    : [
        sql.val<string | null>(null).as("requester_store_path"),
        sql.val<string | null>(null).as("controller_store_path"),
      ];
}

export function readSubagentRunRow(
  database: Pick<OpenClawStateDatabase, "db">,
  runId: string,
): SubagentRunSqliteRow | undefined {
  return executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
      .selectFrom("subagent_runs")
      .selectAll()
      .where("run_id", "=", runId),
  ).rows[0];
}

export function readSubagentRun(
  database: OpenClawStateDatabase,
  runId: string,
): SubagentRunRecord | null {
  const row = readSubagentRunRow(database, runId);
  return row ? rowToSubagentRunRecord(row) : null;
}

function writeSubagentRunValues(
  values: readonly BoundSubagentRunRecord[],
  deleteRunIds: readonly string[],
): void {
  if (values.length === 0 && deleteRunIds.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction((database) =>
    writeSubagentRunValuesInDatabase(database, values, deleteRunIds),
  );
}

type SubagentRegistryReadScope =
  | { kind: "controller"; sessionKey: string }
  | { kind: "controllers"; sessionKeys: readonly string[] }
  | { kind: "session"; sessionKey: string }
  | { kind: "child"; sessionKey: string }
  | { kind: "runs"; runIds: readonly string[] };

function subagentControllerFilter(controllerSessionKeys: readonly string[]) {
  // The writer trims controller keys; older null/empty rows belong to their requester.
  return (eb: ExpressionBuilder<SubagentRegistryDatabase, "subagent_runs">) =>
    eb.or([
      eb("controller_session_key", "in", controllerSessionKeys),
      eb.and([
        eb.or([eb("controller_session_key", "is", null), eb("controller_session_key", "=", "")]),
        eb("requester_session_key", "in", controllerSessionKeys),
      ]),
    ]);
}

function readSubagentRegistryRows(
  scope?: SubagentRegistryReadScope,
  database: Pick<OpenClawStateDatabase, "db"> = openOpenClawStateDatabase(),
  projection: "full" | "maintenance" | "session-list" = "full",
): SubagentRunSqliteRow[] {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  let query = stateDb
    .selectFrom("subagent_runs")
    .select([
      "run_id",
      "child_session_key",
      "controller_session_key",
      "requester_session_key",
      ...parentStoreColumns(db),
      "created_at",
    ])
    .select(
      projection === "full"
        ? "payload_json"
        : (projection === "maintenance"
            ? subagentMaintenancePayload
            : subagentSessionListPayload
          ).as("payload_json"),
    );
  if (scope?.kind === "child") {
    query = query.where("child_session_key", "=", scope.sessionKey);
  } else if (scope?.kind === "runs") {
    query = query.where("run_id", "in", sqliteStringSet(scope.runIds));
  } else if (scope?.kind === "session") {
    query = query.where((eb) =>
      eb.or([
        eb("controller_session_key", "=", scope.sessionKey),
        eb("requester_session_key", "=", scope.sessionKey),
      ]),
    );
  } else if (scope?.kind === "controllers") {
    query = query.where(subagentControllerFilter(scope.sessionKeys));
  } else if (scope?.kind === "controller") {
    query = query.where(subagentControllerFilter([scope.sessionKey]));
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("run_id", "asc"))
    .rows;
}

const subagentRetainedPayloadPaths = [
  "$.task",
  "$.completion.resultText",
  "$.completion.fallbackResultText",
  "$.completion.terminalReply",
  "$.delivery.payload",
  "$.delivery.lastError",
  "$.execution.outcome.error",
  "$.collectorCompletion.structured",
  "$.collectorCompletion.schemaError",
  "$.outputSchema",
  "$.structuredOutput",
  "$.queuedLaunch",
];

type SubagentMetadataShape = { [key: string]: true | SubagentMetadataShape };
const sessionListMetadata: SubagentMetadataShape = {
  ...Object.fromEntries(
    "taskRunId pauseReason swarmRunId collect groupId swarmRequesterSessionKey requesterAgentId model generation createdAt sessionStartedAt accumulatedRuntimeMs runTimeoutSeconds endedReason cleanupCompletedAt expectsCompletionMessage completionTarget"
      .split(" ")
      .map((key) => [key, true as const]),
  ),
  execution: {
    status: true,
    interruptionReason: true,
    startedAt: true,
    endedAt: true,
    outcome: { status: true },
  },
  completion: { required: true },
  delivery: {
    status: true,
    disposition: true,
    suspendedAt: true,
    handoffLeaseId: true,
    handoffLeasedAt: true,
    handoffInjectedAt: true,
  },
  collectorCompletion: { status: true },
};

function projectSubagentMetadataSql(
  source: RawBuilder<unknown>,
  shape: SubagentMetadataShape,
  depth = 0,
): RawBuilder<string> {
  const alias = `metadata_${depth}`;
  const key = sql.ref(`${alias}.key`);
  const value = sql.ref(`${alias}.value`);
  const type = sql.ref(`${alias}.type`);
  const objects = Object.entries(shape).flatMap(([name, child]) =>
    child === true
      ? []
      : [
          sql`WHEN ${key} = ${name} THEN CASE
      WHEN ${type} = 'object' THEN ${projectSubagentMetadataSql(value, child, depth + 1)}
      WHEN ${type} = 'null' THEN 'null'
      WHEN ${type} = 'false' OR (${type} IN ('integer', 'real') AND ${value} = 0)
        OR (${type} = 'text' AND ${value} = '') THEN 'false'
      ELSE 'true' END`,
        ],
  );
  // JSON1 preserves duplicate members here; the canonical JSON parser chooses the last.
  // Only named metadata crosses into JavaScript, including inside duplicate envelopes.
  return /* kysely-allow-raw: Bounded JSON1 metadata projection preserves member order and scalar types. */ sql<string>`(
    SELECT json_group_object(${key}, json(CASE
      ${sql.join(objects, sql` `)}
      WHEN ${key} IN ('handoffLeaseId', 'handoffLeasedAt', 'handoffInjectedAt') THEN 'null'
      WHEN ${type} IN ('true', 'false', 'null') THEN ${type}
      WHEN ${type} = 'text' THEN json_quote(${value})
      ELSE CAST(${value} AS TEXT)
    END) ORDER BY ${sql.ref(`${alias}.id`)})
    FROM json_each(${source}) AS ${sql.id(alias)}
    WHERE ${key} IN (${sql.join(Object.keys(shape))})
  )`;
}

const subagentSessionListPayload =
  /* kysely-allow-raw: Invalid JSON stays ineligible without transferring its retained content. */
  sql<string>`CASE WHEN json_valid(payload_json)
    AND length(CAST(payload_json AS BLOB)) = length(CAST(printf('%s', payload_json) AS BLOB))
    AND json_type(payload_json) = 'object'
    THEN ${projectSubagentMetadataSql(sql.ref("payload_json"), { ...sessionListMetadata, parentCompletion: sessionListMetadata })}
    ELSE 'null' END`;

// Keep envelope selection with JSON.parse, whose duplicate-key semantics differ from JSON1.
// SQLite treats literal NUL as EOF; malformed/overdepth text must also reach the original parser.
const subagentMaintenancePayload =
  /* kysely-allow-raw: Preserve full-reader parsing while omitting unused retained payloads. */
  sql<string>`CASE WHEN json_valid(payload_json)
      AND length(CAST(payload_json AS BLOB)) = length(CAST(printf('%s', payload_json) AS BLOB))
    THEN json_remove(payload_json, ${sql.join(subagentRetainedPayloadPaths.flatMap((path) => [path, `$.parentCompletion${path.slice(1)}`]))})
    ELSE payload_json END`;

function loadScopedSubagentRuns(
  scope: Exclude<SubagentRegistryReadScope, { kind: "controllers" }>,
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  const normalizedScope =
    scope.kind === "runs" ? scope : { ...scope, sessionKey: scope.sessionKey.trim() };
  if (
    normalizedScope.kind === "runs"
      ? normalizedScope.runIds.length === 0
      : !normalizedScope.sessionKey
  ) {
    return [];
  }
  return readSubagentRegistryRows(normalizedScope, database).flatMap((row) => {
    const run = rowToSubagentRunRecord(row);
    return run ? [run] : [];
  });
}

/** Loads runs controlled by one session, preserving the legacy requester fallback. */
export function loadSubagentRunsForControllerFromSqlite(
  controllerSessionKey: string,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "controller", sessionKey: controllerSessionKey });
}

export function loadSubagentRunsForSessionFromSqlite(
  sessionKey: string,
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "session", sessionKey }, database);
}

export function loadSubagentRunsForChildSessionFromSqlite(
  childSessionKey: string,
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "child", sessionKey: childSessionKey }, database);
}

export function loadSubagentRunsByRunIdsFromSqlite(
  runIds: readonly string[],
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "runs", runIds }, database);
}

export function loadSubagentRegistryFromSqlite(
  database?: Pick<OpenClawStateDatabase, "db">,
): Map<string, SubagentRunRecord> {
  // Retired file-era runs are intentionally not recovered here: after SQLite
  // pruning, the file cannot prove whether a run is live or stale. Doctor owns discard.
  const runs = new Map<string, SubagentRunRecord>();
  for (const row of readSubagentRegistryRows(undefined, database)) {
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, entry);
    }
  }
  return runs;
}

function decodeSubagentMaintenanceRows(
  rows: Iterable<SubagentRunSqliteRow>,
  observe?: (row: SubagentRunSqliteRow) => void,
): Map<string, SubagentRunMaintenanceRecord> {
  const runs = new Map<string, SubagentRunMaintenanceRecord>();
  for (const row of rows) {
    observe?.(row);
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, projectSubagentRunForMaintenance(entry));
    }
  }
  return runs;
}

/** Uses the canonical codec without transferring retained prompts and completion results. */
export function loadSubagentMaintenanceRunsFromSqlite(): Map<string, SubagentRunMaintenanceRecord> {
  return decodeSubagentMaintenanceRows(
    readSubagentRegistryRows(undefined, undefined, "maintenance"),
  );
}

/** Hash physical projection rows before decoding, including malformed and colliding identities. */
export function loadSubagentMaintenanceRunsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
): { runs: Map<string, SubagentRunMaintenanceRecord>; digest: string } {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const hash = createHash("sha256");
    const runs = decodeSubagentMaintenanceRows(
      readSubagentRegistryRows(undefined, database, "maintenance"),
      (row) => {
        hash.update(JSON.stringify(row));
      },
    );
    return { runs, digest: hash.digest("hex") };
  });
}

export function subagentMaintenanceDurableBasisMatches(
  database: Pick<OpenClawStateDatabase, "db">,
  basis: SubagentMaintenanceDurableBasis,
): boolean {
  return loadSubagentMaintenanceRunsInDatabase(database).digest === basis.digest;
}

export function loadSubagentSessionListRunsFromSqlite(
  controllerSessionKeys?: readonly string[],
  database?: Pick<OpenClawStateDatabase, "db">,
): Map<string, SubagentRunReadRecord> {
  const runs = new Map<string, SubagentRunReadRecord>();
  const keys = controllerSessionKeys?.map((key) => key.trim()).filter(Boolean);
  if (keys?.length === 0) {
    return runs;
  }
  for (const row of readSubagentRegistryRows(
    keys ? { kind: "controllers", sessionKeys: keys } : undefined,
    database,
    "session-list",
  )) {
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, projectSubagentRunForSessionList(entry));
    }
  }
  return runs;
}

/** Select identities and physical records in one snapshot, before codec filtering. */
function loadSubagentRunsForSessions(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">>,
  observe?: (kind: "topology" | "row", row: unknown) => void,
) {
  const { db } = database;
  return runSqliteDeferredTransactionSync(db, () => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const identities = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_runs")
        .select(["run_id", "child_session_key", "requester_session_key"])
        .orderBy("run_id", "asc"),
    ).rows;
    const selected = collectSubagentSessionReadKeys(
      sessionKeys,
      identities.map((row) => ({
        childSessionKey: row.child_session_key,
        requesterSessionKey: row.requester_session_key,
      })),
      inMemoryRuns,
    );
    // Preserve duplicate physical identities, including rows outside the selected tree.
    const selectedRunIds = new Set(
      identities
        .filter((row) => selected.has(row.child_session_key.trim()))
        .map((row) => row.run_id.trim()),
    );
    const runIds = identities
      .filter((row) => selectedRunIds.has(row.run_id.trim()))
      .map((row) => row.run_id);
    const runs = new Map<string, SubagentRunRecord>();
    const complete = runIds.length === identities.length;
    // Topology includes malformed payloads and newly attached descendant branches.
    if (observe) {
      for (const row of identities) {
        if (selected.has(row.child_session_key.trim()) || selectedRunIds.has(row.run_id.trim())) {
          observe("topology", row);
        }
      }
    }
    if (runIds.length) {
      const query = stateDb.selectFrom("subagent_runs").selectAll();
      const rows = executeSqliteQuerySync(
        db,
        (complete ? query : query.where("run_id", "in", sqliteStringSet(runIds)))
          .orderBy("created_at", "asc")
          .orderBy("run_id", "asc"),
      ).rows;
      for (const row of rows) {
        observe?.("row", row);
        const entry = rowToSubagentRunRecord(row);
        if (entry) {
          runs.set(entry.runId, entry);
        }
      }
    }
    return { sessionKeys: selected, runIds, runs, complete };
  });
}

export function loadSubagentRunsForSessionsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">>,
) {
  const hash = createHash("sha256");
  const selected = loadSubagentRunsForSessions(database, sessionKeys, inMemoryRuns, (kind, row) => {
    hash.update(JSON.stringify([kind, row]));
  });
  return { ...selected, digest: hash.digest("hex") };
}

export function subagentRunsDurableBasisMatches(
  database: Pick<OpenClawStateDatabase, "db">,
  basis: SubagentRunsDurableBasis,
): boolean {
  return (
    loadSubagentRunsForSessionsInDatabase(database, basis.sessionKeys, basis.liveTopology)
      .digest === basis.digest
  );
}

export function saveSubagentRegistryChangesToSqlite(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
): void {
  const runIds = [...new Set(changedRunIds.map((runId) => runId.trim()).filter(Boolean))];
  const values: BoundSubagentRunRecord[] = [];
  const deleteRunIds: string[] = [];
  for (const runId of runIds) {
    const entry = runs.get(runId);
    if (entry) {
      values.push(bindSubagentRunRecord(entry));
    } else {
      deleteRunIds.push(runId);
    }
  }
  writeSubagentRunValues(values, deleteRunIds);
}

/** Mutation ownership cannot discard undecodable retained rows as presentation readers do. */
export function hasSubagentSessionOwnerInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKey: string,
): boolean {
  return (
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
        .selectFrom("subagent_runs")
        .select("run_id")
        .where((eb) =>
          eb.or([
            eb("child_session_key", "=", sessionKey),
            eb("requester_session_key", "=", sessionKey),
            eb("controller_session_key", "=", sessionKey),
          ]),
        )
        .limit(1),
    ).rows.length > 0
  );
}
