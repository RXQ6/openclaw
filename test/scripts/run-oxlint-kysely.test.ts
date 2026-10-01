import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("run-oxlint Kysely inputs", () => {
  it.each([false, true])(
    "prepares declarations only for type-aware lint (focused=%s)",
    (focused) => {
      const cwd = createTempDir("openclaw-oxlint-kysely-");
      mkdirSync(join(cwd, ".git"));
      mkdirSync(join(cwd, "src/state"), { recursive: true });
      mkdirSync(join(cwd, "config/tsconfig"), { recursive: true });
      symlinkSync(join(process.cwd(), "node_modules"), join(cwd, "node_modules"), "junction");
      for (const name of ["openclaw-state", "openclaw-agent"]) {
        writeFileSync(
          join(cwd, "src/state", `${name}-schema.sql`),
          "CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n",
        );
      }
      writeFileSync(
        join(cwd, "config/tsconfig/oxlint.core.json"),
        JSON.stringify({
          compilerOptions: { strict: true, target: "ESNext", module: "NodeNext" },
          include: ["../../src", "../../.artifacts"],
        }),
      );
      writeFileSync(
        join(cwd, ".oxlintrc.json"),
        JSON.stringify({
          categories: { correctness: "off" },
          plugins: ["typescript"],
          rules: focused
            ? { "no-var": "error" }
            : { "typescript/no-redundant-type-constituents": "error" },
        }),
      );
      writeFileSync(
        join(cwd, "src/example.ts"),
        focused
          ? "export const value = 1;\n"
          : 'import type { DB } from "../.artifacts/kysely/openclaw-state-db.generated.js";\nexport type Database = DB | { extra: string };\n',
      );
      const generated = join(cwd, ".artifacts/kysely/openclaw-state-db.generated.ts");
      expect(existsSync(generated)).toBe(false);
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "scripts/run-oxlint.mts"),
          ...(focused ? ["--openclaw-focused-config"] : ["--type-aware"]),
          "--tsconfig",
          "config/tsconfig/oxlint.core.json",
          "--threads=1",
          "src/example.ts",
        ],
        { cwd, encoding: "utf8", env: { ...process.env, CI: "true" }, timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(generated)).toBe(!focused);
      expect(existsSync(join(cwd, "dist"))).toBe(false);
      if (!focused) {
        expect(readFileSync(generated, "utf8")).toContain("export interface DB");
        expect(existsSync(join(cwd, ".artifacts/kysely/openclaw-agent-db.generated.ts"))).toBe(
          true,
        );
      }
    },
  );
});
