import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { legacyMcpOAuthOperations } from "./state-migrations.mcp-oauth.worker.js";

/** Prepared under the original Doctor source claim before worker dispatch. */
export type PreparedLegacyMcpOAuthImport = {
  sourceKey: string;
  sourcePath: string;
  storeKey: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  store: Record<string, unknown>;
  now: number;
};

export type LegacyMcpOAuthImportResult = { sourceKey: string; imported: boolean };

export type LegacyMcpOAuthWorkerOperations = WorkerOperations<typeof legacyMcpOAuthOperations>;
