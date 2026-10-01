import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as groups from "../process/child-process-tree.js";
import {
  createUpdateDoctorProcessCustody,
  retainUpdateDoctorProcesses,
} from "./update-doctor-process-custody.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import * as nativeCustody from "./update-managed-command-custody.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "preserves Windows Doctor completion without admitting interrupted recovery (interrupted=%s)",
  async (interrupted) => {
    const root = directories.make("doctor-windows-custody-");
    const resultPath = path.join(root, "result.json");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValue(false);
    vi.spyOn(nativeCustody, "createManagedCommandProcessCustody").mockImplementation(() => {
      throw new Error("Windows command groups have no extinction receipt");
    });
    const parent = createUpdateDoctorProcessCustody("run", root, resultPath);
    expect(await retainUpdateDoctorProcesses()).toBeUndefined();
    const settlement = await parent.settle({
      pid: 4242,
      stdout: "",
      stderr: "",
      code: interrupted ? null : 0,
      signal: interrupted ? "SIGKILL" : null,
      killed: interrupted,
      cleanup: interrupted ? "forced" : "normal",
      termination: interrupted ? "timeout" : "exit",
    });
    if (interrupted) {
      expect(settlement).toMatchObject({
        exitCode: 1,
        failureFacts: [
          expect.objectContaining({
            code: "doctor-processes-unsettled",
            message: expect.stringContaining("4242"),
          }),
        ],
      });
    } else {
      expect(settlement).toBeUndefined();
    }
    parent.close();
    expect(fs.existsSync(`${resultPath}.processes`)).toBe(interrupted);
  },
);
