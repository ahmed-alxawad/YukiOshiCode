import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@yukioshi/core/fs-util"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import {
  Auth,
  makeLayer,
  makeNode,
  MacKeychainStore,
  SecretServiceStore,
  WindowsDpapiStore,
  InMemoryKeychainStore,
  createKeychainStore,
  type KeychainStore,
} from "../../src/auth"
import { packSecret, unpackSecret, type ProcessRunner, type ProcessResult } from "../../src/auth/keychain"

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = []

  constructor(
    private readonly handler: (
      executable: string,
      args: readonly string[],
      stdin?: string,
    ) => Partial<ProcessResult>,
  ) {}

  run(executable: string, args: readonly string[], stdin?: string): Promise<ProcessResult> {
    this.calls.push({ executable, args, stdin })
    const res = this.handler(executable, args, stdin)
    return Promise.resolve({
      exitCode: res.exitCode ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    })
  }
}

describe("packSecret and unpackSecret", () => {
  it("roundtrips arbitrary strings and JSON safely", () => {
    const json = JSON.stringify({ type: "api", key: 'sk-test"with"quotes\nand\nnewlines\\escaped' })
    const packed = packSecret(json)
    expect(packed.startsWith("b64:")).toBe(true)
    expect(packed.includes('"')).toBe(false)
    expect(packed.includes("\n")).toBe(false)
    expect(unpackSecret(packed)).toBe(json)
  })

  it("handles raw unpack fallbacks", () => {
    expect(unpackSecret('{"type":"api","key":"sk-raw"}')).toBe('{"type":"api","key":"sk-raw"}')
    expect(unpackSecret("plain-text")).toBe("plain-text")
  })
})

describe("MacKeychainStore", () => {
  it("passes secrets on stdin via security -i, never on argv", async () => {
    let stored = ""
    const runner = new RecordingRunner((executable, args, stdin) => {
      if (args[0] === "help") return { exitCode: 0 }
      if (args[0] === "-i") {
        stored = stdin ?? ""
        return { exitCode: 0 }
      }
      if (args[0] === "find-generic-password") {
        const match = stored.match(/-w "([^"]+)"/)
        return match ? { exitCode: 0, stdout: match[1] + "\n" } : { exitCode: 1 }
      }
      return { exitCode: 0 }
    })

    const store = new MacKeychainStore(runner, "test-service")
    expect(await store.isAvailable()).toBe(true)

    await store.set("openai", JSON.stringify({ key: "sk-mac-secret" }))

    const writeCall = runner.calls.find((c) => c.args[0] === "-i")
    expect(writeCall).toBeDefined()
    expect(writeCall?.args.join(" ")).not.toContain("sk-mac-secret")
    expect(writeCall?.stdin).toContain("add-generic-password")
    expect(writeCall?.stdin).toContain("b64:")

    const read = await store.get("openai")
    expect(read).toBe(JSON.stringify({ key: "sk-mac-secret" }))

    await store.delete("openai")
    const delCall = runner.calls.find((c) => c.args[0] === "delete-generic-password")
    expect(delCall).toBeDefined()
  })

  it("reports unavailable when security command fails", async () => {
    const runner = new RecordingRunner(() => ({ exitCode: 127, stderr: "security: command not found" }))
    const store = new MacKeychainStore(runner, "test-service")
    expect(await store.isAvailable()).toBe(false)
  })
})

describe("SecretServiceStore", () => {
  it("detects missing D-Bus in headless/CI environments", async () => {
    const runner = new RecordingRunner((executable, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "secret-tool 0.20.5" }
      if (args[args.length - 1] === "__probe__") {
        return { exitCode: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }
      }
      return { exitCode: 0 }
    })

    const store = new SecretServiceStore(runner, "test-service")
    expect(await store.isAvailable()).toBe(false)
  })

  it("passes secrets on stdin via secret-tool store, never in argv", async () => {
    let stored = ""
    const runner = new RecordingRunner((executable, args, stdin) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "secret-tool 0.20.5" }
      if (args[args.length - 1] === "__probe__") return { exitCode: 1, stderr: "" }
      if (args[0] === "store") {
        stored = stdin ?? ""
        return { exitCode: 0 }
      }
      if (args[0] === "lookup") {
        return stored ? { exitCode: 0, stdout: stored + "\n" } : { exitCode: 1 }
      }
      return { exitCode: 0 }
    })

    const store = new SecretServiceStore(runner, "test-service")
    expect(await store.isAvailable()).toBe(true)

    await store.set("anthropic", "sk-ant-secret")
    const storeCall = runner.calls.find((c) => c.args[0] === "store")
    expect(storeCall).toBeDefined()
    expect(storeCall?.args.join(" ")).not.toContain("sk-ant-secret")
    expect(storeCall?.stdin).toContain("b64:")

    const val = await store.get("anthropic")
    expect(val).toBe("sk-ant-secret")

    await store.delete("anthropic")
    const clearCall = runner.calls.find((c) => c.args[0] === "clear")
    expect(clearCall).toBeDefined()
  })
})

describe("WindowsDpapiStore", () => {
  it("encrypts and decrypts via powershell without writing plaintext to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yk-dpapi-test-"))
    try {
      const runner = new RecordingRunner((executable, args, stdin) => {
        const script = args[args.length - 1] ?? ""
        if (script.includes("ConvertFrom-SecureString")) {
          return { exitCode: 0, stdout: "ENCRYPTED_DPAPI_BLOB" }
        }
        if (script.includes("PtrToStringBSTR")) {
          return { exitCode: 0, stdout: stdin === "ENCRYPTED_DPAPI_BLOB" ? packSecret("sk-win-secret") : "" }
        }
        return { exitCode: 0, stdout: "5" }
      })

      const store = new WindowsDpapiStore(runner, dir, "powershell.exe")
      expect(await store.isAvailable()).toBe(true)

      await store.set("openai", "sk-win-secret")
      const dpapiFile = join(dir, "openai.dpapi")
      expect(existsSync(dpapiFile)).toBe(true)
      expect(readFileSync(dpapiFile, "utf8").trim()).toBe("ENCRYPTED_DPAPI_BLOB")

      const val = await store.get("openai")
      expect(val).toBe("sk-win-secret")

      await store.delete("openai")
      expect(existsSync(dpapiFile)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Auth service with Keychain primary and fallback", () => {
  const memoryKeychain = new InMemoryKeychainStore()
  const itKeychain = testEffect(LayerNode.compile(makeNode(memoryKeychain)))

  const unavailableKeychain: KeychainStore = {
    name: "Unavailable Store",
    isAvailable: () => Promise.resolve(false),
    get: () => Promise.resolve(undefined),
    set: () => Promise.reject(new Error("No keychain")),
    delete: () => Promise.resolve(),
  }
  const itFallback = testEffect(LayerNode.compile(makeNode(unavailableKeychain)))

  itKeychain.instance("uses keychain when available and stores credentials securely", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("test-keychain-prov", {
        type: "api",
        key: "sk-keychain-123",
      })

      const item = yield* auth.get("test-keychain-prov")
      expect(item).toBeDefined()
      expect(item?.type).toBe("api")
      if (item?.type === "api") expect(item.key).toBe("sk-keychain-123")

      const all = yield* auth.all()
      expect(all["test-keychain-prov"]).toBeDefined()

      // Verify the credential is stored inside the keychain
      const rawKeychain = yield* Effect.promise(() => memoryKeychain.get("credentials"))
      expect(rawKeychain).toBeDefined()
      expect(rawKeychain).toContain("sk-keychain-123")
    }),
  )

  itFallback.instance("falls back to auth.json when keychain is unavailable", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("test-fallback-prov", {
        type: "api",
        key: "sk-fallback-456",
      })

      const item = yield* auth.get("test-fallback-prov")
      expect(item).toBeDefined()
      expect(item?.type).toBe("api")
      if (item?.type === "api") expect(item.key).toBe("sk-fallback-456")

      const all = yield* auth.all()
      expect(all["test-fallback-prov"]).toBeDefined()

      yield* auth.remove("test-fallback-prov")
      const after = yield* auth.all()
      expect(after["test-fallback-prov"]).toBeUndefined()
    }),
  )

  itKeychain.instance("reads and updates credentials through auth service seamlessly", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("openai", {
        type: "api",
        key: "sk-migrated-key",
      })

      const val = yield* auth.get("openai")
      expect(val).toBeDefined()
      if (val?.type === "api") expect(val.key).toBe("sk-migrated-key")
    }),
  )
})

describe("createKeychainStore factory", () => {
  it("returns disabled store when YUKIOSHI_DISABLE_KEYCHAIN is set", async () => {
    const original = process.env.YUKIOSHI_DISABLE_KEYCHAIN
    try {
      process.env.YUKIOSHI_DISABLE_KEYCHAIN = "1"
      const store1 = createKeychainStore()
      expect(await store1.isAvailable()).toBe(false)
      expect(store1.name).toBe("Disabled Keychain")
      await expect(store1.set("foo", "bar")).rejects.toThrow("Keychain disabled")

      process.env.YUKIOSHI_DISABLE_KEYCHAIN = "true"
      const store2 = createKeychainStore()
      expect(await store2.isAvailable()).toBe(false)
      expect(store2.name).toBe("Disabled Keychain")
    } finally {
      if (original !== undefined) process.env.YUKIOSHI_DISABLE_KEYCHAIN = original
      else delete process.env.YUKIOSHI_DISABLE_KEYCHAIN
    }
  })

  it("selects correct store implementation based on platform", () => {
    const original = process.env.YUKIOSHI_DISABLE_KEYCHAIN
    delete process.env.YUKIOSHI_DISABLE_KEYCHAIN
    try {
      const macStore = createKeychainStore({ platform: "darwin" })
      expect(macStore instanceof MacKeychainStore).toBe(true)

      const winStore = createKeychainStore({ platform: "win32" })
      expect(winStore instanceof WindowsDpapiStore).toBe(true)

      const linuxStore = createKeychainStore({ platform: "linux" })
      expect(linuxStore instanceof SecretServiceStore).toBe(true)
    } finally {
      if (original !== undefined) process.env.YUKIOSHI_DISABLE_KEYCHAIN = original
      else delete process.env.YUKIOSHI_DISABLE_KEYCHAIN
    }
  })
})
