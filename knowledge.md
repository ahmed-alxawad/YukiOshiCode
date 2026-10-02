# Knowledge — project structure and organization

This file describes the **`opencode-foundation` branch** (the opencode fork). `main` (the original from-scratch implementation) has a different, much simpler structure — check `git branch --show-current` first. If you're on `main`, this file mostly doesn't apply; look at `main`'s own `README.md` and `docs/` instead.

## Monorepo layout

Bun workspaces (`package.json`: `workspaces.packages: ["packages/*", "packages/sdk/js"]`), plus a `workspaces.catalog` for shared dependency version pinning (reference a pinned version via `"catalog:"` in a package's own `package.json`).

| Package | Purpose |
|---|---|
| `packages/core` | Shared foundation: config schema (`v1/config/*`), permissions, agents, models.dev-backed provider metadata, the `effect/layer-node` DI abstraction, git, process spawning (`cross-spawn-spawner.ts`), and more. Everything else depends on this. |
| `packages/opencode` | The actual CLI/server application. Tool definitions (`src/tool/`), session handling (`src/session/`), the permission service (`src/permission/`), the plugin system (`src/plugin/`), the HTTP API routes (`src/server/`), the hooks system (`src/hooks/`), the top-level app wiring (`src/effect/app-runtime.ts`). This is where most feature work happens. |
| `packages/indexing` | Semantic code search engine (`code_search` tool's backend). Ported from Kilo Code's `@kilocode/kilo-indexing`. 8 embedding providers, 2 vector stores (LanceDB, Qdrant), tree-sitter chunking. |
| `packages/sandbox` | OS-level sandbox for bash tool execution. Ported from Kilo Code's `@kilocode/sandbox`. |
| `packages/llm` | Schema-first LLM core: one typed request/response/event/tool language, with provider-specific quirks isolated in adapters. |
| `packages/schema` | Shared wire-format schemas (events, manifests, agent/command/credential shapes) used across server and clients. |
| `packages/protocol` | API contract definitions (groups, middleware, errors) that both the server and generated clients are built from. |
| `packages/plugin` | The public plugin API surface (`Hooks` interface, `ToolDefinition`, etc.) that both built-in and third-party plugins implement against. |
| `packages/codemode` | Confined code execution over schema-described tools (Effect-native). |
| `packages/client`, `packages/sdk`, `packages/sdk-next` | Generated/hand-written clients for the HTTP API. `sdk-next` is an in-progress Effect-native replacement for the generated `sdk`. |
| `packages/server` | Server-side HTTP concerns: auth, CORS, location resolution, middleware, request handlers — consumed by `packages/opencode`'s route wiring. |
| `packages/tui` | The terminal UI (React-like component model via its own `component/` tree, audio/attention notifications, clipboard, config). |
| `packages/ui`, `packages/session-ui` | Web/VS Code-facing UI components (React), including Storybook stories and i18n. |
| `packages/cli` | CLI command framework and services used to build out `yukioshi`/`opencode`-style subcommands. |
| `packages/httpapi-codegen` | Generates typed clients from the Effect `HttpApi` definition. |
| `packages/http-recorder` | Deterministic record/replay of Effect HTTP client traffic, for tests. |
| `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node` | Effect-native SQLite/Drizzle integration layers. |
| `packages/script` | Build/release scripting. |

## Core architectural patterns (read before editing `packages/opencode`)

- **Effect-TS throughout.** `Effect.gen`, `Context.Service`, `Layer.effect`/`Layer.succeed`. If you haven't worked in Effect before, read a few existing services in `packages/opencode/src/` (e.g. `src/indexing/index.ts`, `src/hooks/index.ts`) before writing new ones — the patterns are consistent and copying them is the fastest path to correct code.
- **`LayerNode`** (`packages/core/src/effect/layer-node.ts`): a custom dependency-graph abstraction on top of Effect `Layer`. Each service exports a `node = LayerNode.make({service, layer, deps: [...]})`. `LayerNode.group([...])` + `LayerNode.compile(group, replacements?)` resolves the full transitive closure of `deps`. **Gotcha**: the production app composes its node graph in more than one place — `packages/opencode/src/effect/app-runtime.ts` (CLI/non-server bootstrap) and `packages/opencode/src/server/routes/instance/httpapi/server.ts` (the `const app = LayerNode.group([...])` list, used by the real HTTP server and by server-integration tests) are two **separately maintained, near-duplicate lists**. Adding a new top-level service node to one does not automatically add it to the other. The more robust place to add a new dependency is as a `deps:` entry on whichever existing node already needs it transitively (e.g. `ToolRegistry.node`), not as a new top-level entry in either list — that way every graph that already includes the parent node picks it up for free.
- **`Tool.define(id, Effect.gen(...))`** (`packages/opencode/src/tool/tool.ts`): returns `{id, init}`; `Tool.init(info)` produces the real `Def` with `.execute`. New tools are registered in `packages/opencode/src/tool/registry.ts`'s `Effect.all({...})` map, gated by config flags via `...(enabled ? {key: Tool.init(x)} : {})`, and listed in the `builtin: [...]` array.
- **`RuntimeFlags.Service`** (`packages/opencode/src/effect/runtime-flags.ts`): experimental features are gated behind both a specific env var and the broad `YUKIOSHI_EXPERIMENTAL` flag.
- **Testing**: `testEffect(layer)` (`packages/opencode/test/lib/effect.ts`) returns `{effect, live, instance}` — use `.instance(...)` for tests that need a real tmp-directory project instance, `.effect(...)` otherwise. Any test compiling a `LayerNode` graph that transitively includes `InstanceStore.node` needs `noopBootstrapReplacement` (from `test/fixture/fixture.ts`) in its `replacements` array, or it fails with "Unbound layer node: `@yukioshi/InstanceBootstrap`".
- **Config schema**: `packages/core/src/v1/config/*.ts`, one file per concern, wired into the big `Info` struct in `config.ts`. New config fields: add the file, import it, add the field with a `.annotate({description})`.
- **Risk classification**: `packages/core/src/permission/risk.ts` — every tool's permission id must be classified `low`/`medium`/`high` or it defaults to `high` (never auto-allowed).

## Mindmap

```
YukiOshi Code (repo)
├── main branch — original, from-scratch implementation (Node built-ins only)
│   └── see main's own README.md / docs/
│
└── opencode-foundation branch — opencode fork + ported features
    │
    ├── foundation: upstream opencode (Bun + Effect-TS, kept as-is except where noted)
    │
    ├── ported from Kilo Code
    │   ├── packages/sandbox        → bash tool OS-level sandboxing
    │   ├── src/memory/ + tools     → memory_recall / memory_save
    │   ├── src/tool/task-parallel.ts → task_parallel (composed from opencode's own
    │   │                                TaskTool + Worktree.Service, not a raw port)
    │   ├── packages/indexing + src/indexing/ + src/tool/code-search.ts
    │   │                           → code_search (semantic search)
    │   └── src/hooks/              → all six hook events landed: PreToolUse,
    │                                  PostToolUse, UserPromptSubmit, SessionStart,
    │                                  Stop, Notification
    │
    ├── patched in from main
    │   └── multi-provider model gateway: OmniRoute / OpenRouter / NVIDIA NIM /
    │       Google AI Studio / OpenCode Zen / custom OpenAI-compatible  ← Done
    │
    ├── investigated (no port)
    │   └── Kimi Code (MoonshotAI/kimi-code, MIT) — Moonshot/Kimi works out of the
    │       box with zero code changes; long-context mechanisms already matched by
    │       opencode's native compaction and truncation — nothing ported  ← Done
    │
    └── branding migration
        └── executable/package/env rename to yukioshi / @yukioshi/* /
            YUKIOSHI_*  ← Done (compatibility config and attribution names retained)
```

## Where the detailed, feature-by-feature attribution lives

`NOTICE.md` (on `opencode-foundation` only) — what was ported verbatim, what was rebuilt, what was dropped and why, test coverage, and known gaps per feature. Read it before touching any ported feature.
