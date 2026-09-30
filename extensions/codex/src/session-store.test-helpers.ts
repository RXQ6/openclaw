import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll } from "vitest";

/** Retain case stores until their maintenance and history Workers drain together. */
export function useCodexSessionStoreTempDirs(prefix: string): { make(): string } {
  let root: string | undefined;
  afterAll(async () => {
    if (!root) {
      return;
    }
    const currentRoot = root;
    root = undefined;
    await closeOpenClawAgentDatabasesAsync(currentRoot);
    await fs.rm(currentRoot, { recursive: true, force: true });
  });
  return {
    make() {
      // openclaw-temp-dir: allow suite-owned session stores require one drain before removal
      root ??= mkdtempSync(path.join(realpathSync.native(os.tmpdir()), prefix));
      // openclaw-temp-dir: allow isolated cases share the suite's database teardown
      return mkdtempSync(path.join(root, "case-"));
    },
  };
}
