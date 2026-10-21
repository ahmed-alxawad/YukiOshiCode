import { describe, expect, test } from "bun:test"
import { SafetyGuards } from "../src/permission/guards"

const blocked = (command: string) => SafetyGuards.check("bash", [command]) !== undefined

// Destructive forms that got past the hard block (permissions review, 2026-10-21).
describe("hard block covers everyday destructive forms", () => {
  test.each([
    'rm -rf "$OUT_DIR"/*',
    "rm -rf $OUT_DIR/*",
    'rm -rf "${OUT_DIR}"/*',
    "rm -rf $HOME/*",
    "rm -rf ./*",
    "rm -rf ../..",
    "rm -rf ~/.*",
    "bash -c -- 'rm -rf /'",
    "eval rm -rf /",
    "su -c 'rm -rf /'",
    "doas rm -rf /",
    "doas -u root rm -rf /",
    "busybox rm -rf /",
    "dd if=/dev/zero of=/dev/vda",
    "dd if=/dev/zero of=/dev/mmcblk0",
    "cat x > /dev/xvda",
  ])("blocks %s", (command) => {
    expect(blocked(command)).toBe(true)
  })

  test.each([
    'rm -rf "${OUT_DIR:?}"/*',
    "rm -rf '$OUT_DIR'/*",
    "rm -rf ./build",
    "rm -rf dist/*",
    "eval echo hello",
    "su -c 'ls /'",
    "doas ls",
    "busybox ls",
    "bash -c -- 'echo ok'",
  ])("allows %s", (command) => {
    expect(blocked(command)).toBe(false)
  })
})
