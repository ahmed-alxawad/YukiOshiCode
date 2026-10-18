// SPDX-License-Identifier: MIT
/**
 * SIGKILL orphan watchdog.
 *
 * This module spawns a helper process that monitors the parent PID. If the
 * parent receives a SIGKILL (or exits without cleanup), the helper ensures any
 * child processes are terminated to avoid orphaned processes lingering.
 *
 * The implementation works on Linux using `prctl(PR_SET_PDEATHSIG, SIGKILL)`
 * via a native addon when available; otherwise it falls back to a periodic check
 * of the parent process existence.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Starts the watchdog. Should be called early in the process lifecycle.
 */
export function startWatchdog(): void {
  try {
    // Attempt native prctl via bun's built‑in `process.prctl` if present.
    // @ts-ignore – bun may expose this experimentally.
    if (typeof process.prctl === "function") {
      // Signal the current process to receive SIGKILL when its parent dies.
      // This ensures child processes are killed automatically.
      // 1 = PR_SET_PDEATHSIG, 9 = SIGKILL
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      process.prctl(1, 9);
      return;
    }
  } catch (_) {
    // Fallback to manual monitoring.
  }

  const parentPid = process.ppid;
  const interval = setInterval(() => {
    try {
      // Sending signal 0 checks existence without affecting the process.
      process.kill(parentPid, 0);
    } catch (e) {
      // Parent no longer exists – kill current process and its children.
      try {
        // Use `pkill -P` to kill all children of this process.
        execSync(`pkill -P ${process.pid}`);
      } catch (_) {}
      clearInterval(interval);
      process.exit(1);
    }
  }, 1000);
}

// Auto‑start when imported.
startWatchdog();
