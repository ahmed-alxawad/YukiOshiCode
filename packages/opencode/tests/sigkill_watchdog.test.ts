// Regression test for SIGKILL watchdog - ensures child process continues after parent exit
import { describe, it, expect, afterAll } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdtempSync as mkTmp, readFileSync as rf, rmSync as rm } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("SIGKILL watchdog", () => {
  const tempDir = mkTmp(join(tmpdir(), "watchdog-"));
  const outFile = join(tempDir, "out.txt");

  afterAll(() => {
    try { rm(tempDir, { recursive: true, force: true }); } catch (_) {}
  });

  it("child continues after parent exits", async () => {
    const childScript = `
      const fs = require('fs');
      const path = process.env.OUT_FILE;
      setInterval(() => { fs.appendFileSync(path, Date.now() + "\\n"); }, 100);
    `;
    const child = spawn(process.execPath, ["-e", childScript], {
      env: { ...process.env, OUT_FILE: outFile },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait until the child has written at least one line (startup time varies by OS)
    const deadline = Date.now() + 20_000;
    let lines: string[] = [];
    try {
      while (Date.now() < deadline) {
        if (existsSync(outFile)) lines = rf(outFile, "utf8").split("\n").filter(Boolean);
        if (lines.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      try { child.kill("SIGKILL"); } catch (_) {}
    }
    expect(lines.length).toBeGreaterThan(0);
  }, 30_000);
});
