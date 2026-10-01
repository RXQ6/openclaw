import { existsSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import {
  settleCommandProcessGroups,
  type CommandProcessIdentity,
} from "./command-process-custody.js";
import { runUtf8CommandWithTimeout } from "./exec-runner.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "retains and stops a detached writer after its busy scope owner is killed",
  async () => {
    const root = directories.make("command-custody-");
    const receipt = path.join(root, "custody.json");
    const effect = path.join(root, "effect");
    const node = requireNodeTool("node");
    const moduleUrl = (name: string, sourceWorkerName = name) =>
      resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName,
        distWorkerPath: name === "pid-alive" ? "shared/pid-alive.js" : `process/${name}.js`,
      });
    const spawnOwner = moduleUrl("exec-spawn");
    const identityOwner = moduleUrl("pid-alive", "../shared/pid-alive");
    const leaf = `
      const fs = require('node:fs');
      globalThis.keepalive = new (require('node:worker_threads').MessageChannel)();
      keepalive.port1.on('message', () => {});
      process.on('SIGUSR2', () => fs.writeFileSync(${JSON.stringify(effect)}, 'still writable'));
      process.stdout.write('ready\\n');
    `;
    const script = `
      import fs from 'node:fs';
      import { once } from 'node:events';
      import { withCommandProcessScope, spawnCommand } from ${JSON.stringify(spawnOwner.href)};
      import { getProcessInstanceStartTime } from ${JSON.stringify(identityOwner.href)};
      const record = value => fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(value));
      process.on('SIGTERM', () => {});
      await withCommandProcessScope(async () => {
        const child = spawnCommand([${JSON.stringify(node)}, '-e', ${JSON.stringify(leaf)}], {
          stdio: ['ignore', 'pipe', 'ignore'], buffer: false, reject: false,
        });
        await once(child.stdout, 'data');
        process.stdout.write(JSON.stringify({ root: process.pid,
          identity: { pid: child.pid, startedAt: getProcessInstanceStartTime(child.pid) } }) + '\\n');
        while (true) {}
      }, undefined, { reserve() {
        record({ state: 'reserved' });
        return { spawned(identity) { record({ state: 'spawned', identity }); },
          settled() { record({ state: 'settled' }); } };
      } });
    `;
    const controller = new AbortController();
    let ready: { root: number; identity: CommandProcessIdentity } | undefined;
    let output = "";
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      const result = await runUtf8CommandWithTimeout(
        [
          node,
          ...(spawnOwner.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: process.cwd(),
          env: { OPENCLAW_STATE_DIR: root },
          signal: controller.signal,
          timeoutMs: 30_000,
          killGraceMs: 100,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          onOutputChunk(chunk, stream) {
            if (stream !== "stdout") {
              return;
            }
            output += chunk.toString();
            if (!ready && output.includes("\n")) {
              ready = JSON.parse(output.split("\n")[0]!) as typeof ready;
              controller.abort();
            }
          },
        },
      );
      expect(ready, result.stderr).toBeDefined();
      if (!ready) {
        throw new Error("Custody fixture did not reach its busy operation");
      }
      expect(result.cleanup).toBe("forced");
      expect(isChildProcessTreeAlive({ pid: ready.root })).toBe(false);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        state: "spawned",
        identity: ready.identity,
      });
      const written = new Promise<void>((resolve) => {
        watcher = watch(root, () => {
          if (existsSync(effect)) {
            resolve();
          }
        });
      });
      process.kill(ready.identity.pid, "SIGUSR2");
      await written;
      expect(readFileSync(effect, "utf8")).toBe("still writable");
      expect(await settleCommandProcessGroups([ready.identity])).toEqual({
        settled: true,
        pids: [],
      });
      expect(isChildProcessTreeAlive(ready.identity)).toBe(false);
    } finally {
      watcher?.close();
      const identity =
        ready?.identity ??
        (existsSync(receipt)
          ? (JSON.parse(readFileSync(receipt, "utf8")) as { identity?: CommandProcessIdentity })
              .identity
          : undefined);
      if (identity) {
        const cleanup = await settleCommandProcessGroups([identity]);
        expect(cleanup, "fixture writer cleanup must remain owned").toEqual({
          settled: true,
          pids: [],
        });
      }
    }
  },
);
