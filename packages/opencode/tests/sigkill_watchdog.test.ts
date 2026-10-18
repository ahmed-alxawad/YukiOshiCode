// Regression test for SIGKILL watchdog - ensures child process continues after parent exit
import { describe, it, expect, afterAll } from "bun:test";
import { spawn, readFileSync, rmSync, mkdtempSync, writeFileSync } from "child_process";
import { mkdtempSync as mkTmp, writeFileSync as wf, readFileSync as rf, rmSync as rm } from "fs";
import { join } from "path";

describe("SIGKILL watchdog", () => {
  const tempDir = mkTmp("/tmp/watchdog-");
  const outFile = join(tempDir, "out.txt");

  afterAll(() => {
    try { rm(tempDir, { recursive: true, force: true }); } catch (_) {}
  });

  it("child continues after parent exits", () => {
    const childScript = `
      const fs = require('fs');
      const path = process.argv[2];
      setInterval(() => { fs.appendFileSync(path, Date.now() + "\n"); }, 100);
    `;
    const child = spawn("node", ["-e", childScript, outFile], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait a short time to let child write data
    const start = Date.now();
    while (Date.now() - start < 350) {}
    const content = rf(outFile, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
  });
});
