import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OffsiteBackupResult } from "../../commands/backup-remote.js";
import { defaultRuntime } from "../../runtime.js";
import { readBackupRuns } from "../../state/backup-run-records.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerBackupCommand } from "./register.backup.js";
import { registerStorageCommand } from "./register.storage.js";

afterEach(() => vi.restoreAllMocks());

describe("offsite backup CLI", () => {
  it("refuses uninitialized storage, then uploads, lists, verifies and stages an encrypted archive", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const destination = state.path("offsite");
      const scratchRoot = state.path("scratch");
      await fs.mkdir(scratchRoot);
      vi.spyOn(os, "tmpdir").mockReturnValue(scratchRoot);
      await state.writeConfig({
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        storage: {
          locations: {
            archive: {
              provider: "filesystem",
              settings: { path: destination },
              encryption: { passphrase: "synthetic-backup-test-passphrase" },
            },
          },
        },
      });
      await fs.writeFile(state.statePath("operator-note.txt"), "preserved state\n");
      await fs.writeFile(
        path.join(state.workspaceDir, "workspace-note.txt"),
        "excluded workspace\n",
      );
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`CLI exit ${code}`);
      });
      const run = async (...argv: string[]) => {
        writeJson.mockClear();
        const program = new Command().exitOverride();
        registerBackupCommand(program);
        registerStorageCommand(program);
        await program.parseAsync([...argv, "--json"], { from: "user" });
        return writeJson.mock.calls.at(-1)?.[0];
      };
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      expect((await fs.stat(resolveOpenClawStateSqlitePath())).isFile()).toBe(true);
      const localCopy = state.path("retained.tar.gz");
      await expect(
        run("backup", "create", "--to", "archive", "--output", localCopy),
      ).rejects.toThrow();
      const unavailableMessage =
        "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory.";
      expect(errors.mock.calls.flat().join(" ")).toContain(unavailableMessage);
      expect((await readBackupRuns(process.env))[0]).toMatchObject({
        kind: "archive",
        target: "archive",
        status: "failed",
        error: unavailableMessage,
      });
      errors.mockClear();
      await fs.mkdir(destination);
      await expect(
        run("backup", "create", "--to", "archive", "--output", localCopy),
      ).rejects.toThrow();
      expect(errors.mock.calls.flat().join(" ")).toContain("openclaw storage init archive");
      await expect(fs.stat(localCopy)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect(
        (await readBackupRuns(process.env))[0],
        errors.mock.calls.flat().join("\n"),
      ).toMatchObject({
        kind: "archive",
        target: "archive",
        status: "failed",
        error: expect.stringContaining("storage init archive"),
      });

      await run("storage", "init", "archive");
      const namespaceDir = path.join(destination, "backups", "test-host");
      const otherDir = path.join(destination, "backups", "test-host-other");
      await fs.mkdir(namespaceDir, { recursive: true });
      await fs.mkdir(otherDir, { recursive: true });
      const oldKey = "20260101T000000Z-11111111.tar.gz";
      await fs.writeFile(path.join(namespaceDir, oldKey), Buffer.alloc(200));
      await fs.writeFile(path.join(namespaceDir, "foreign.txt"), "foreign");
      await fs.writeFile(path.join(otherDir, oldKey), Buffer.alloc(200));
      const created = (await run(
        "backup",
        "create",
        "--to",
        "archive",
        "--namespace",
        "test-host",
        "--no-include-workspace",
        "--keep-daily",
        "0",
      )) as OffsiteBackupResult;
      expect(created).toMatchObject({
        verified: true,
        localArchiveRetained: false,
        retention: { kept: 1, deleted: 1 },
      });
      expect(created.location?.storedBytes).toBeGreaterThan(created.location!.plaintextBytes);
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect(await fs.readdir(namespaceDir)).toEqual(
        expect.arrayContaining(["foreign.txt", created.location!.key]),
      );
      await expect(fs.stat(path.join(namespaceDir, oldKey))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(otherDir)).toEqual([oldKey]);
      const stored = await fs.readFile(path.join(namespaceDir, created.location!.key));
      expect(stored.subarray(0, 8).toString()).toBe("OCSTOR1\n");
      const listed = await run("backup", "list", "--from", "archive", "--namespace", "test-host");
      expect(listed).toMatchObject({
        backups: [{ key: created.location!.key, sizeBytes: created.location!.plaintextBytes }],
      });
      const verified = await run(
        "backup",
        "verify",
        "latest",
        "--from",
        "archive",
        "--namespace",
        "test-host",
      );
      expect(verified).toMatchObject({ ok: true });
      const target = state.path("staged");
      await run(
        "backup",
        "restore",
        "latest",
        "--from",
        "archive",
        "--namespace",
        "test-host",
        "--target",
        target,
      );
      const capturedState = created.assets.find((asset) => asset.kind === "state");
      expect(capturedState).toBeDefined();
      const restoredState = path.join(target, capturedState!.archivePath);
      expect(await fs.readFile(path.join(restoredState, "operator-note.txt"), "utf8")).toBe(
        "preserved state\n",
      );
      expect(await fs.readFile(path.join(restoredState, "openclaw.json"), "utf8")).toBe(
        await fs.readFile(state.configPath, "utf8"),
      );
      expect(created.assets.some((asset) => asset.kind === "workspace")).toBe(false);
      await expect(
        run(
          "backup",
          "restore",
          "latest",
          "--from",
          "archive",
          "--namespace",
          "test-host",
          "--target",
          target,
        ),
      ).rejects.toThrow();
      const configOnly = (await run(
        "backup",
        "create",
        "--to",
        "archive",
        "--namespace",
        "config",
        "--only-config",
        "--output",
        localCopy,
      )) as OffsiteBackupResult;
      expect(configOnly).toMatchObject({
        onlyConfig: true,
        verified: true,
        localArchiveRetained: true,
        assets: [{ kind: "config" }],
      });
      expect((await fs.stat(localCopy)).size).toBe(configOnly.location?.plaintextBytes);
    });
  });
});
