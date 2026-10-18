// Regression test for installer checksum and signature verification
// This test ensures the installer validates both SHA256SUMS and its .sig file.
// It runs the installer in a temporary directory with mocked archive, checksum,
// and signature files. The test checks three scenarios:
//   1. Valid checksum & valid signature -> installer succeeds.
//   2. Invalid checksum -> installer aborts with checksum error.
//   3. Invalid signature -> installer aborts with signature error.
//
// The implementation details (key generation, signing, mock HTTP) are left as
// TODOs for the developer to flesh out according to the project's test helpers.

import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

describe("installer signature verification", () => {
  const tempDir = mkdtempSync("/tmp/installer-test-");

  // TODO: generate a dummy archive and corresponding SHA256SUMS
  // TODO: create a test GPG/Ed25519 keypair and sign SHA256SUMS to produce SHA256SUMS.sig
  // TODO: mock network requests if installer fetches remote files

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("succeeds with valid checksum and signature", () => {
    // TODO: place valid files in tempDir and invoke installer
    // expect(execSync(`bash ${join(tempDir, "install")} ...`).toString()).toContain("Installation succeeded");
  });

  it("fails on bad checksum", () => {
    // TODO: corrupt SHA256SUMS and assert installer aborts
    // expect(() => execSync(`bash ${join(tempDir, "install")} ...`)).toThrow();
  });

  it("fails on bad signature", () => {
    // TODO: corrupt SHA256SUMS.sig and assert installer aborts
    // expect(() => execSync(`bash ${join(tempDir, "install")} ...`)).toThrow();
  });
});
