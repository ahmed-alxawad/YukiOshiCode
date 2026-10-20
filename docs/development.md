# Development

YukiOshi Code is a [Bun](https://bun.sh) monorepo written in TypeScript. You
need Bun (the version in `package.json`'s `packageManager` field) and git.

## Running from source

```bash
bun install
bun run dev                 # opens the terminal UI in the current folder
```

`packages/opencode/bin/yukioshi-dev` runs the checkout from any folder and
opens that folder as the project. To use it as your `yukioshi` command:

```bash
ln -s "$(pwd)/packages/opencode/bin/yukioshi-dev" ~/.local/bin/yukioshi
```

## Layout

| Folder                           | Contains                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| `packages/code-graph`            | repository structure signals and dependency graph analysis             |
| `packages/codemode`              | confined code execution and interpreter runtime over schema tools      |
| `packages/core`                  | configuration, permissions, security guards, provider catalog, storage |
| `packages/effect-drizzle-sqlite` | Drizzle ORM SQLite database integration for Effect-TS                  |
| `packages/http-recorder`         | cassette recorder and replayer for deterministic HTTP testing          |
| `packages/indexing`              | semantic code search, chunking, and local symbol indexing engine       |
| `packages/llm`                   | low-level LLM provider adapters, protocols, streaming, and tool runners|
| `packages/opencode`              | the `yukioshi` command, agent loop, tools, providers, built-in skills  |
| `packages/plugin`                | plugin runtime, manifest parsing, and auth hook interfaces             |
| `packages/protocol`              | HTTP API contract definitions, route endpoints, and shared middleware  |
| `packages/sandbox`               | OS-level sandbox profiles, bubblewrap runner, and path confinement     |
| `packages/schema`                | shared domain types, Effect schemas, and system event definitions      |
| `packages/script`                | repository automation scripts, build helpers, and maintenance tooling  |
| `packages/sdk`                   | TypeScript client SDK for external programmatic integrations           |
| `packages/server`                | HTTP API server, route handlers, authentication, and PTY environment   |
| `packages/tui`                   | terminal user interface, themes, keyboard interaction, and logo        |
| `packages/ui`                    | shared design system, frontend components, fonts, and provider icons   |

## Checks

Tests run per package, never from the repository root:

```bash
bun run typecheck                       # every package
cd packages/opencode && bun test        # one package
cd packages/opencode && bun test test/plugin/google.test.ts
```

The pre-push hook runs the typecheck, so keep `~/.bun/bin` on your `PATH`.
The hook also checks that your Bun version matches `packageManager`. Pull
requests and pushes to `main` run typecheck, a Markdown link check
(`bun packages/opencode/script/check-docs.ts`), the test suites, and a binary
smoke test in CI.

## CLI benchmark

The CLI benchmark uses a local fake instant model, so its measurements cover
CLI and process work without network or model latency. It reports `--version`,
`run --help`, start-to-first-request, and a complete scripted turn. The default
is 10 samples; use `--runs N` to change it. To benchmark a built binary, pass
`--binary PATH`.

```bash
cd packages/opencode
bun run script/bench.ts
bun run script/bench.ts --runs 20 --binary ./dist/yukioshi-linux-x64/bin/yukioshi
```

The output names Linux/macOS/Windows as supported platforms and explicitly
states that it is diagnostics only, makes no comparison with other tools, and
makes no AI speed claims.

## Building

```bash
cd packages/opencode
bun run build --single      # only the binary for this machine
bun run build               # every platform
```

Binaries are written to `packages/opencode/dist/yukioshi-<os>-<arch>/bin/`.

Run `bun run notices` to regenerate `THIRD-PARTY-NOTICES.md` after a dependency change.

## Releasing

Pushing a tag such as `v0.3.6` starts the release workflow: it builds every
platform, writes `SHA256SUMS`, checks the binaries on macOS, Windows, Linux
(x64 and ARM), and Alpine, publishes the release, and then tests the installers against
it. To rebuild an existing tag, run the workflow by hand with that tag.

## Logo

The terminal logo in `packages/tui/src/logo-art.ts` is generated from the
files in `assets/brand/`. After changing them, run:

```bash
python3 packages/tui/script/generate-logo.py   # needs Pillow
```
