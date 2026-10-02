import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FallbackCodeGraphProvider,
  GraphifyProvider,
  LocalSymbolGraphProvider,
  NullCodeGraphProvider,
  type LocalGraphFile,
} from "../src"

const files: LocalGraphFile[] = [
  {
    path: "src/auth/login.ts",
    imports: ["src/users/repository.ts"],
    symbols: [{ name: "login", kind: "function", line: 3, exported: true }],
  },
  {
    path: "src/users/repository.ts",
    imports: ["src/db/client.ts"],
    symbols: [{ name: "UserRepository", kind: "class", line: 1, exported: true }],
  },
  { path: "src/db/client.ts", imports: [], symbols: [{ name: "connect", kind: "function", line: 1, exported: true }] },
  { path: "test/login.test.ts", imports: ["src/auth/login.ts"], tests: ["src/auth/login.ts"], symbols: [] },
]

async function localProvider() {
  const provider = new LocalSymbolGraphProvider()
  provider.load({ files, builtAt: "now" })
  return provider
}

describe("code graph providers", () => {
  let workspace: string | undefined
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  })

  test("local provider exposes structural retrieval signals", async () => {
    const provider = await localProvider()
    assert.equal((await provider.status()).available, true)
    assert.equal((await provider.findSymbols({ text: "login" }))[0]?.path, "src/auth/login.ts")
    assert.equal(
      (await provider.neighbors({ path: "src/auth/login.ts", depth: 2 })).some(
        (item) => item.path === "src/db/client.ts" && item.distance === 2,
      ),
      true,
    )
    assert.deepEqual(await provider.path("test/login.test.ts", "src/db/client.ts"), [
      "test/login.test.ts",
      "src/auth/login.ts",
      "src/users/repository.ts",
      "src/db/client.ts",
    ])
    assert.equal((await provider.importantFiles(1))[0]?.path, "src/auth/login.ts")
  })

  test("Graphify loads node-link JSON and rejects traversal paths", async () => {
    const root = (workspace = join(tmpdir(), `code-graph-${Math.random().toString(16).slice(2)}`))
    await mkdir(join(root, "graphify-out"), { recursive: true })
    await writeFile(
      join(root, "graphify-out/graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", label: "a.ts", type: "module", source_file: "src/a.ts" },
          { id: "b", label: "b", type: "function", source_file: "src/b.ts", line: 2 },
          { id: "evil", label: "secret", source_file: "../../etc/passwd" },
        ],
        links: [
          { source: "a", target: "b", relation: "imports" },
          { source: "a", target: "evil", relation: "imports" },
        ],
      }),
    )
    const provider = new GraphifyProvider({ workspaceRoot: root })
    assert.equal((await provider.status()).available, true)
    assert.deepEqual(await provider.findSymbols({ text: "secret" }), [])
    assert.equal((await provider.neighbors({ path: "src/a.ts" }))[0]?.path, "src/b.ts")
    provider.noteWorkspaceChange(Date.now() + 1000)
    assert.equal((await provider.status()).fresh, false)
  })

  test("fallback reports explicit degradation while preserving local answers", async () => {
    const provider = new FallbackCodeGraphProvider(
      new GraphifyProvider({ workspaceRoot: "/missing" }),
      await localProvider(),
    )
    assert.equal((await provider.findSymbols({ text: "login" }))[0]?.name, "login")
    const status = await provider.status()
    assert.equal(status.provider, "local")
    assert.equal(status.degraded, true)
  })

  test("null provider is safe when graph retrieval is disabled", async () => {
    const provider = new NullCodeGraphProvider()
    assert.equal((await provider.status()).available, false)
    assert.deepEqual(await provider.findSymbols({ text: "anything" }), [])
    assert.equal(await provider.path("a", "b"), undefined)
  })
})
