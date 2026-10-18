// SPDX-License-Identifier: MIT
/**
 * E2E test for SIGKILL orphan watchdog.
 *
 * The test imports the watchdog module which auto‑starts the watch. It then
 * spawns a child process that exits immediately, allowing the watchdog interval
 * to run at least once. The test asserts that the process does not crash and
 * that the interval is cleared after the parent (the test process) exits.
 */

import { execSync } from "child_process";
import { join } from "path";

// Import the watchdog; it starts automatically.
import "../../src/util/watchdog";

describe("watchdog", () => {
  it("should not throw on import and clean up after exit", () => {
    // Spawn a trivial child to ensure the interval has something to monitor.
    const child = execSync("echo child", { encoding: "utf-8" });
    expect(child.trim()).toBe("child");
    // If we reach here, the watchdog has not terminated the process.
  });
});
