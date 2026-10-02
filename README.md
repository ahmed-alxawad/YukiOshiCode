# YukiOshi Code — opencode foundation

<p align="center">
  <img src="assets/brand/yukioshi-code-wordmark-light.png" alt="YukiOshi Code geometric snowflake wordmark" width="900">
</p>

YukiOshi Code is an AI coding agent for the terminal, built on the fast Bun and Effect-TS architecture of upstream [opencode](https://github.com/anomalyco/opencode). This `opencode-foundation` branch is the integrated YukiOshi implementation; the separate `main` branch remains the original from-scratch implementation and product reference.

The major port and branding work is landed. The CLI is `yukioshi`, workspace packages use `@yukioshi/*`, and application-owned environment variables use `YUKIOSHI_*`. Use `yukioshi.json` and `.yukioshi/` for new configuration; legacy `opencode.json` and `.opencode/` names remain recognized for backward compatibility. Provider IDs, upstream service URLs, and third-party package names remain where interoperability requires them.

## What is included

- Multi-provider model access through the native models.dev-backed provider system, including OmniRoute, Google AI Studio, OpenCode Zen, OpenRouter, NVIDIA NIM, Anthropic, OpenAI, and generic OpenAI-compatible endpoints.
- Permission modes, OS-level shell sandboxing, write/edit path enforcement, and OS-keychain-backed credential storage with a restricted-file fallback.
- Cross-session memory, semantic code search, code-graph repository signals, parallel/worktree-isolated subagents, and all six supported Claude Code-style hook events.
- Evidence-based post-turn verification in the CLI and TUI.

Code-search and code-graph results are retrieval signals, not ground truth. YukiOshi still re-reads files and verifies relevant checks before treating a change as complete.

## Development

Requirements: [Bun](https://bun.sh). From this repository root:

```sh
bun install
bun run dev
```

The root test command intentionally refuses to run the entire monorepo at once. Run focused tests from the package that owns them, for example:

```sh
cd packages/opencode
bun test test/tool/write.test.ts test/tool/edit.test.ts
bunx tsgo --noEmit
```

Run the core typecheck separately from `packages/core` with `bunx tsgo --noEmit`.

## Configuration and migration

- [Provider configuration](docs/providers.md)
- [Migrating from upstream opencode](docs/migration-from-opencode.md)
- [Repository structure and branch status](documentation.md)
- [Feature attribution, adaptations, and known gaps](NOTICE.md)

## Attribution

This project is MIT-licensed and retains substantial upstream opencode architecture and code. Some features were adapted from Kilo Code or rebuilt from YukiOshi Code's original `main` implementation. See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for details.
