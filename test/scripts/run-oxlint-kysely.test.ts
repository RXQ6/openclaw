import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const checkout = process.cwd();
const runner = path.join(checkout, "scripts/run-oxlint.mjs");
const lintArgs = ["--tsconfig", "config/tsconfig/oxlint.core.json", "source.ts"];

function createFixture() {
  const root = tempDirs.make("oxlint-kysely-");
  for (const directory of ["src/state", "config/tsconfig", "node_modules"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const schemas = ["openclaw-state", "openclaw-agent"].map((name) =>
    path.join(root, "src/state", `${name}-schema.sql`),
  );
  for (const schema of schemas) {
    fs.writeFileSync(schema, "CREATE TABLE records (name TEXT NOT NULL);");
  }
  // Only the fixture's real lint tools and type dependency are borrowed, never a mutable graph.
  for (const name of [".bin", "kysely", "oxlint", "oxlint-tsgolint"]) {
    fs.symlinkSync(
      fs.realpathSync(path.join(checkout, "node_modules", name)),
      path.join(root, "node_modules", name),
      "junction",
    );
  }
  fs.writeFileSync(
    path.join(root, ".oxlintrc.json"),
    JSON.stringify({
      plugins: ["typescript"],
      rules: { "typescript/no-redundant-type-constituents": "error" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
      },
      include: ["source.ts", ".artifacts/**/*.ts"],
    }),
  );
  fs.writeFileSync(
    path.join(root, "config/tsconfig/oxlint.core.json"),
    JSON.stringify({ extends: "../../tsconfig.json" }),
  );
  const source = path.join(root, "source.ts");
  const useTable = (table: string) =>
    fs.writeFileSync(
      source,
      `import type { DB } from "./.artifacts/kysely/openclaw-state-db.generated.js";\nexport type Row = DB["${table}"] | undefined;\n`,
    );
  useTable("records");
  return {
    root,
    source,
    schemas,
    useTable,
    artifacts: path.join(root, ".artifacts/kysely"),
    run(args = lintArgs) {
      const result = spawnSync(process.execPath, [runner, ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, ".state"),
          TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
          GITHUB_ACTIONS: "false",
          OPENCLAW_CI_STATIC_EVIDENCE: "0",
          // Shard children skip extension preparation but still need database types.
          OPENCLAW_OXLINT_SKIP_PREPARE: "1",
        },
      });
      expect(result.error).toBeUndefined();
      return { status: result.status, output: result.stdout + result.stderr };
    },
  };
}

describe("oxlint generated database prerequisites", () => {
  it("lints cold and changed schemas while still rejecting real type violations", () => {
    const fixture = createFixture();
    const cold = fixture.run();
    expect(cold.status, cold.output).toBe(0);
    expect(fs.existsSync(fixture.artifacts)).toBe(true);

    fs.appendFileSync(fixture.schemas[0]!, "ALTER TABLE records RENAME TO renamed;");
    fixture.useTable("renamed");
    const changed = fixture.run();
    expect(changed.status, changed.output).toBe(0);

    fs.appendFileSync(fixture.source, 'export type Invalid = string | "redundant";\n');
    const invalid = fixture.run();
    expect(invalid.status, invalid.output).toBe(1);
    expect(invalid.output).toContain("no-redundant-type-constituents");
    expect(invalid.output).toContain("redundant is overridden by string");
  });

  it("reports schema generation failures instead of running with missing types", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.schemas[0]!, "not valid SQL");
    fs.writeFileSync(fixture.source, "export const valid = true;\n");
    const failed = fixture.run();
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain("syntax error");
    expect(fs.existsSync(fixture.artifacts)).toBe(false);
  });

  it("keeps help and focused syntax-only lint independent of generated types", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.schemas[0]!, "not valid SQL");
    const help = fixture.run(["--help"]);
    expect(help.status, help.output).toBe(0);
    const focused = fixture.run([
      "--openclaw-focused-config",
      "--config",
      ".oxlintrc.json",
      "source.ts",
    ]);
    expect(focused.status, focused.output).toBe(0);
    expect(fs.existsSync(fixture.artifacts)).toBe(false);
  });
});
