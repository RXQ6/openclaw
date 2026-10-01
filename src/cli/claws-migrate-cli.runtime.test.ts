import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === "cancelled"),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.config,
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  isCancel: mocks.isCancel,
}));

const { runClawsMigrateCommand } = await import("./claws-migrate-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("claws migrate interactive consent", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.config.mockReset();
    mocks.confirm.mockReset();
    mocks.isCancel.mockClear();
  });

  it("defaults to no and leaves the existing agent untouched when cancelled", async () => {
    const root = tempDirs.make("openclaw-claws-migrate-cli-");
    const workspace = join(root, "workspace");
    const stateDir = join(root, "state");
    const env = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await mkdir(workspace);
    await writeFile(join(workspace, "AGENTS.md"), "Keep this agent as-is.\n", "utf8");
    mocks.config.mockReturnValue({
      agents: { entries: { worker: { workspace } } },
    } satisfies OpenClawConfig);
    mocks.confirm.mockResolvedValue(false);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeJson: vi.fn(),
      writeStdout: vi.fn(),
      exit: vi.fn(),
    };

    await runClawsMigrateCommand("worker", {}, runtime);

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: false,
        message: expect.stringContaining('"worker"'),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Generated local Claw package files:"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Migration cancelled; no Claw ownership was recorded.",
    );
    await expect(access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(stateDir, "claws", "local", "worker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
