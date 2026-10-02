# YukiOshi Code — Documentation

## What this is

YukiOshi Code is an open-source AI coding agent for the terminal and VS Code. You type `yukioshi` in a project and talk to it: it reads code, plans, edits files through reviewable diffs, runs checks, and reports exactly what was verified.

## Two branches, two codebases

This repository currently holds **two separate implementations** of YukiOshi Code, on two branches. Know which one you're on before you edit anything — they do not share code or architecture.

### `main` — the original, from-scratch implementation

A Node.js-built-ins-only coding agent (no runtime dependencies). Ships today at version 0.2.0 (preview).

- Works like Claude Code: interactive session, slash commands, `@` file mentions, `!` shell commands, `#` memory notes, mode switching, `-p` print mode, `--continue`/`--resume`.
- Model providers: OmniRoute (default, bring-your-own OpenAI-compatible URL), OpenRouter, NVIDIA NIM, Google AI Studio, OpenCode Zen, or any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, LiteLLM). One provider at a time, switchable.
- Skills: Claude-compatible `SKILL.md` format, 26 built in.
- Hooks: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, Notification — Claude Code compatible, already fully implemented and shipped.
- Permission modes: Manual, Auto, Auto-All, Plan (plus Claude Code's names as aliases).
- Safety: hard safety blocks, workspace sandboxing, OS-keychain API keys, undo for every change.
- See `README.md` and `docs/product/*.md` on this branch for full details.

### `opencode-foundation` — the YukiOshi fork of opencode

A fork of the upstream `opencode` project (Bun workspaces, Effect-TS throughout), chosen because opencode is materially faster than the from-scratch `main` implementation. The plan, in order:

1. Fork opencode. **Done.**
2. Port the valuable features from Kilo Code into the fork (Kilo is feature-rich but slow). **Done**: OS-level sandbox, cross-session memory (`memory_recall`/`memory_save`), parallel/worktree-isolated subagents (`task_parallel`), semantic code search/indexing (`code_search`), and all six Claude-Code-compatible hook events.
3. Patch in `main`'s own distinguishing features that opencode-foundation still lacks: the multi-provider model gateway (OmniRoute/OpenRouter/NVIDIA NIM/Google AI Studio/OpenCode Zen/custom). **Done.**
4. Investigate and port relevant pieces of Kimi Code (`MoonshotAI/kimi-code`, MIT-licensed). **Done: investigated — Moonshot/Kimi works out of the box with zero code changes (models.dev already catalogs it; opencode's compaction and truncation already match Kimi Code's long-context mechanisms). Nothing ported; see `NOTICE.md`.**
5. Rename the entire fork from the upstream executable/package/env branding to `yukioshi`, `@yukioshi/*`, and `YUKIOSHI_*`. **Done.** New configuration can use `yukioshi.json` and `.yukioshi/`; legacy `opencode.json` and `.opencode/` remain recognized for backward compatibility. Third-party package names, provider identifiers, and upstream attribution remain where required.

See `NOTICE.md` on this branch for the detailed, per-feature attribution and port notes (what was kept, what was dropped, what was tested).

For user-facing setup instructions, see [Provider configuration](docs/providers.md). Existing upstream users should also read [Migrating from upstream opencode](docs/migration-from-opencode.md).

## Which branch should you work on?

Check `git branch --show-current` before editing. Treat `main` and `opencode-foundation` as different projects that happen to share a repository. Do not cherry-pick or merge between them without being asked — they are intentionally kept independent until the fork work above is far enough along for a human to decide how (or whether) to reconcile them.

## Master prompt (give this to every AI tool working in this repo)

> You are working in a shared repository that other AI tools may also be editing right now. Before any edit: (1) run `git branch --show-current` and confirm which branch you're meant to be on; (2) read `documentation.md`, `knowledge.md`, and `history.md` for context — don't re-derive what's already written there; (3) read `edits.md` and check the "Active claims" table for overlap with the files you're about to touch — if another tool has an in-progress claim on them, stop and pick different work instead of editing the same files; (4) add your own row to `edits.md`'s "Active claims" table before you start, and move it to "Completed log" when you finish or abandon the task; (5) when editing `edits.md` itself, only touch your own row — append, don't reorder or rewrite others'; (6) after any significant change, add a short dated entry to `history.md`. If you're unsure whether your task overlaps someone else's active claim, ask the human rather than guessing.

## Where to look first

- `knowledge.md` — project structure, how the code is organized, a mindmap of the packages.
- `history.md` — chronological log of major milestones and decisions.
- `edits.md` — **read this before editing anything**, especially if more than one agent/tool may be working here at once.
- `NOTICE.md` (opencode-foundation branch only) — feature-by-feature port attribution.
