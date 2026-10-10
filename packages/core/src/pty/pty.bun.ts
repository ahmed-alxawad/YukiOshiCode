import { spawn as create } from "bun-pty"
import { dlopen, FFIType } from "bun:ffi"
import type { Exit, Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

// bun-pty reports exit only when its native read returns "child exited". When a short-lived child
// exits before the native waiter records the status, the read fails with a plain error instead
// (observed on macOS) and bun-pty ends its read loop without ever firing onExit, so the session
// would stay "running" forever. The native layer still records the exit status, so we poll it as a
// fallback and deliver the exit ourselves. Duplicate deliveries are suppressed.
const NATIVE_POLL_MS = 100

function nativeLibraryPath(): string {
  try {
    // Same statically analyzable lookup bun-pty uses so compiled binaries embed the library.
    // @ts-ignore - require returns a path for binary files in Bun
    const embedded: string = require(
      `bun-pty/rust-pty/target/release/${process.platform === "win32" ? "rust_pty.dll" : process.platform === "darwin" ? (process.arch === "arm64" ? "librust_pty_arm64.dylib" : "librust_pty.dylib") : process.arch === "arm64" ? "librust_pty_arm64.so" : "librust_pty.so"}`,
    )
    if (embedded) return embedded
  } catch {}
  // Outside a compiled binary the require above tries to evaluate the library as JavaScript.
  const file =
    process.platform === "win32"
      ? "rust_pty.dll"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "librust_pty_arm64.dylib"
          : "librust_pty.dylib"
        : process.arch === "arm64"
          ? "librust_pty_arm64.so"
          : "librust_pty.so"
  return require.resolve(`bun-pty/rust-pty/target/release/${file}`)
}

function loadExitCode(): ((handle: number) => number) | undefined {
  try {
    const lib = dlopen(nativeLibraryPath(), { bun_pty_get_exit_code: { args: [FFIType.i32], returns: FFIType.i32 } })
    return (handle) => lib.symbols.bun_pty_get_exit_code(handle)
  } catch {
    return undefined
  }
}

const exitCodeOf = loadExitCode()

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const pty = create(file, args, opts)
  const exitListeners = new Set<(event: Exit) => void>()
  let exited: Exit | undefined
  let watchdog: ReturnType<typeof setInterval> | undefined

  const finish = (event: Exit) => {
    if (exited) return
    exited = event
    if (watchdog) clearInterval(watchdog)
    for (const listener of [...exitListeners]) listener(event)
  }
  pty.onExit(finish)

  const handle = (pty as unknown as { handle?: number }).handle
  if (exitCodeOf && typeof handle === "number" && handle >= 0) {
    // Require the status on two consecutive ticks so bun-pty's own loop can drain output and
    // report the exit first in the normal case.
    let seen = false
    watchdog = setInterval(() => {
      if (exited) return
      const code = exitCodeOf(handle)
      if (code < 0) {
        seen = false
        return
      }
      if (!seen) {
        seen = true
        return
      }
      finish({ exitCode: code })
    }, NATIVE_POLL_MS)
    watchdog.unref?.()
  }

  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener) {
      exitListeners.add(listener)
      return { dispose: () => void exitListeners.delete(listener) }
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      pty.kill(signal)
    },
  }
}
