# Migrating from upstream opencode

YukiOshi Code's `opencode-foundation` branch is a performance-oriented fork of upstream opencode. It keeps opencode's Bun workspace, Effect-TS services, model/runtime architecture, and simultaneous multi-provider foundation, then adds features that are useful for a more opinionated coding-agent workflow.

This guide reflects the completed YukiOshi rename. The executable, workspace package scope, runtime directories, and application environment-variable prefix have changed; selected upstream compatibility identifiers remain intentionally unchanged.

## Why this fork exists

The separate `main` implementation of YukiOshi Code demonstrated a useful product direction, but it was built from scratch on Node.js built-ins and was slower than opencode for the workloads that matter here. This fork keeps opencode as the foundation and ports the features that improve safety, retrieval, automation, and provider choice without replacing opencode's core architecture.

The two branches are intentionally separate implementations for now. Upstream opencode remains the reference for the foundation; this fork is the place where YukiOshi-specific features are integrated and verified.

## What is added or changed

### More provider profiles over the native provider system

The fork adds OmniRoute, Google AI Studio, and OpenCode Zen presets alongside opencode's existing providers, including OpenRouter and NVIDIA NIM. These profiles use opencode's native models.dev-backed, multi-provider system and shared SDK transports rather than introducing a separate single-provider HTTP client. Existing Anthropic, OpenAI, Gemini/Google, Bedrock, and other catalogued providers remain available.

Provider selection and configuration continue to use the fork's opencode-compatible configuration format. See [provider configuration](providers.md) for the provider names, environment-key precedence, endpoint overrides, and generic OpenAI-compatible setup.

### Kilo Code features integrated with opencode services

- OS-level sandboxing for shell execution, with write/edit path enforcement when the sandbox is enabled.
- Explicit cross-session project memory through `memory_recall` and `memory_save`.
- Parallel, optionally worktree-isolated subagents through `task_parallel`.
- Semantic code retrieval through `code_search`, backed by the `packages/indexing` service.
- Claude Code-compatible hooks for PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, and Notification.

These additions are wired into opencode's Effect and `LayerNode` graphs. They are not parallel application frameworks, so existing opencode plugins and services remain the integration points.

### Verification and repository-structure signals

The fork includes an evidence-based verification pipeline for reporting whether checks were verified, partially verified, failed, unavailable, or skipped. It also includes a provider-neutral code graph with Graphify and local/null fallbacks. Code-graph answers are retrieval signals only: they do not replace reading files, checking symbols with LSP, or verifying facts with grep/glob before editing.

### Features deliberately not copied

The Kimi Code investigation found that Moonshot/Kimi access already works through the existing models.dev catalog and that opencode's compaction and output-truncation systems already cover the relevant long-context behavior. No separate Kimi client was added.

## Migration checklist

1. Replace the `opencode` command with `yukioshi` in shell aliases, editor tasks, CI jobs, and scripts.
2. Replace imports from `@opencode-ai/*` with the corresponding `@yukioshi/*` package. Third-party package names such as `opencode-gitlab-auth` are external names and must not be rewritten.
3. Replace application environment variables named `OPENCODE_*` with `YUKIOSHI_*`. Provider-owned variables remain provider-specific: for example, OpenCode Zen still accepts `OPENCODE_API_KEY`; see [provider configuration](providers.md) for each credential chain.
4. Rename configuration to `yukioshi.json` and `.yukioshi/` when convenient. The loader reads both the YukiOshi names and legacy `opencode.json`/`.opencode/` names; at the same location, YukiOshi-named files take precedence. The default global root is the platform's `yukioshi` XDG/config directory—for example, `~/.config/yukioshi/yukioshi.json` on a typical Linux setup—so copy or deliberately recreate any global upstream configuration there.
5. Review stateful integrations separately. YukiOshi uses `yukioshi` under the platform's data, cache, state, config, and temporary roots; it does not treat upstream opencode runtime directories as its current storage locations.
6. Decide whether to enable optional features such as indexing, memory, hooks, sandboxing, verification, and code graph. Optional tools are gated and do not become active merely because their package exists.
7. Treat code-search, code-graph, and verification output as assistance for retrieval and reporting. Continue to re-read files and run the checks that matter before accepting an edit.

## Renamed surfaces and preserved compatibility

The repository-wide rename is complete: the executable is `yukioshi`, workspace packages use `@yukioshi/*`, application-owned environment variables use `YUKIOSHI_*`, and current runtime directories use `yukioshi`.

Not every occurrence of “opencode” is stale branding. The fork deliberately preserves upstream attribution, third-party package/provider names, protocol or plugin compatibility fields, upstream service URLs, and legacy `opencode.json`/`.opencode` discovery. Use the migration checklist above rather than blindly replacing text.

## Attribution and upstream relationship

This project remains recognizably based on opencode and retains upstream components where they are the best foundation. Ported or rebuilt features, dropped components, licenses, and known gaps are documented in the repository's `NOTICE.md`. Upstream opencode references in attribution or historical notes remain distinguishable from current YukiOshi branding.
