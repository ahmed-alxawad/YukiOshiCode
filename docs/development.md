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

## Building the Kothora edition

One build setting picks the edition: `yukioshi` (the default, unchanged) or `kothora`.

```bash
cd packages/opencode
bun run script/build.ts --single --skip-install --edition=kothora
# or: YUKIOSHI_EDITION=kothora bun run script/build.ts --single --skip-install
```

The build defines `YUKIOSHI_EDITION` in the binary, so a shipped binary cannot be switched at run time. When
running from source (`bun run dev`, tests) and nothing was defined, the `YUKIOSHI_EDITION` environment variable
picks the edition. An unknown name stops with an error.

| | `yukioshi` | `kothora` |
| --- | --- | --- |
| Command | `yukioshi` | `kothora` |
| Product name | YukiOshi Code | Kothora Code |
| Config, data, cache, state folders | `yukioshi` | `kothora` |
| Keychain service | `yukioshi-code` | `kothora-code` |
| Model providers | all | Kothora only |
| Own API keys (`providers`, config providers, env keys) | allowed | hidden and refused |
| Extra rule file | none | `KOTHORA.md` |

The Kothora edition is defined in `packages/core/src/edition.ts`; its client is in
`packages/opencode/src/kothora/`.

### What the Kothora edition needs

| Setting | Meaning |
| --- | --- |
| `KOTHORA_API_URL` | Address of the Kothora API, for example `https://api.example.com`. The default `https://api.kothora.invalid` is a placeholder that never resolves and is to be set. |

Commands: `kothora login` (device sign-in: shows a code and address, opens the browser, waits for approval),
`kothora logout` (deletes the local tokens), `kothora whoami` (account, plan and credits). Tokens are kept in
the OS keychain, or in an owner-only file where no keychain exists. The access token is refreshed before it
expires and after a 401. Network failures retry with backoff and never delete the stored tokens. Every model
request carries `Authorization: Bearer <device token>` and an `Idempotency-Key` (one UUID per request, the
same on retries). Credits used up, paced for today and spend-stop answers are shown as plain messages.

Models are listed from `GET /code/v1/models` (Fast, Balanced, Expert). If the list cannot be fetched, all three
are offered. Context and output sizes are placeholders until the API gives them.

### Rule files

In the Kothora edition the project rule files are read in this order, and all that are found are used:

1. `KOTHORA.md` in the global config folder, then the nearest `KOTHORA.md` in the project. It comes first in the
   prompt and wins when rules conflict.
2. The nearest `AGENTS.md`, or, if there is none, `CLAUDE.md` (as in the YukiOshi edition).

The default permission mode is the same in both editions: Auto-All is off unless the user turns it on.
