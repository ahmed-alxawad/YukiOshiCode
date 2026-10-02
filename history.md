# History

Append-only log of major milestones and decisions. Newest entry at the bottom. When you (human or agent) finish a significant piece of work, add an entry — a few lines, dated, in your own words. Don't rewrite or delete earlier entries; if something was wrong, add a correction entry instead.

Full commit-level detail lives in `git log`; this file is for the *why*, which git log doesn't capture well.

---

**2026-09-28 and earlier — `main` branch: the original YukiOshi Code**
Built from scratch on Node.js built-ins only (no runtime dependencies). Reached feature parity with Claude Code on the basics (sessions, skills, hooks, permission modes, memory) plus its own multi-provider model gateway (OmniRoute/OpenRouter/NVIDIA NIM/Google AI Studio/OpenCode Zen/custom OpenAI-compatible). Status: 0.2.0 (preview).

**2026-09-28 — Decision: fork `opencode` instead of continuing from-scratch for performance**
`main`'s from-scratch implementation works but is slower than the upstream `opencode` project. Decision made to fork `opencode` (Bun + Effect-TS) as a new foundation, port Kilo Code's best features into it (Kilo is feature-rich but slow), then patch in `main`'s own distinguishing features, then rename the whole thing to YukiOshi Code. This work happens on the `opencode-foundation` branch; `main` stays untouched throughout.

**2026-09-28 — Permission mode ported onto opencode's live permission service**
Hard safety blocks and manual/auto/auto-all/plan modes ported from `main`'s design onto `opencode-foundation`'s actual permission service (not a copy — the real one in use). Exposed over the API and wired into `opencode run`/`--mini`.

**2026-09-29 — YukiOshi's skill content bundled into opencode's existing skill system**
opencode already had a skill-loading mechanism; `main`'s Apache-2.0-licensed skill content was bundled into it rather than building a second skill system.

**2026-09-30 — Kilo Code's OS-level sandbox ported (`packages/sandbox`)**
Ported near-verbatim from Kilo's `packages/kilo-sandbox`, renamed `KILO_*` → `OPENCODE_SANDBOX_*`. Wired into the bash tool. Found and fixed a real bug: non-git projects set `worktree` to `"/"`, which was being treated as a writable root and tripping the sandbox's own safety check.

**2026-10-01 — Explicit cross-session memory system added (`memory_recall`/`memory_save`)**
Not a port — opencode had no equivalent, so this was built fresh (smaller in scope than Kilo's own memory system), reusing Kilo's markdown-storage format and slugging logic almost verbatim.

**2026-10-02 — Parallel/worktree-isolated subagent orchestration added (`task_parallel`)**
Also not a port: opencode already had both a single-task subagent tool and a mature native git-worktree service, so `task_parallel` composes those two rather than porting Kilo's ~2000-line equivalent. Found and fixed a real bug: `Effect.result` only catches typed failures, not defects, and the Tool wrapper converts typed failures to defects via `Effect.orDie` — had to switch to `Effect.exit`/`Exit.isFailure` to stop one failing subtask from crashing the whole batch.

**2026-10-02 — Semantic code search/indexing ported and wired in (`code_search`)**
Unlike the other three Kilo features, opencode had no equivalent infrastructure at all, so `packages/indexing` is a close-to-verbatim port of Kilo's `@kilocode/kilo-indexing` (8 embedding providers, 2 vector stores, tree-sitter chunking for ~25 languages). Kilo's own hosted "managed-indexing" embedder was removed outright (Kilo-proprietary SaaS, not portable). Wired into opencode via a thin `Indexing.Service` and a `code_search` tool, gated behind `indexing.enabled`. Two real crash bugs found and fixed while tracing the enabled-but-unconfigured path (missing API key): both the service and the tool would call into the manager's `startIndexing()`/`searchIndex()` without checking `isFeatureConfigured`, which throws when the manager's internal services were never constructed.

**2026-10-02 — Claude-Code-compatible hooks: in progress, not yet landed**
Porting the hooks concept (PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop/Notification — `main` already has a full, shipped implementation of this to use as a reference) into `opencode-foundation`. A `Hooks.Service` was built and wired into `session/tools.ts` for PreToolUse (can block a tool call) and PostToolUse (feedback appended to the tool's output). While building this, found and fixed a real, unrelated latent bug in `packages/core/src/cross-spawn-spawner.ts`: a child process that exits without ever reading stdin closes its end of the pipe, and writing to it afterward raised an EPIPE with zero listeners attached — Node treats that as an uncaught exception that crashes the whole process, not just the one Effect computation. Fixed with one defensive early listener. As of this entry, one test file (`test/server/httpapi-sdk.test.ts`) still fails after the `Hooks.node` wiring change — root cause being actively tracked down (server.ts and app-runtime.ts each maintain their own, separately-composed copy of the full app's `LayerNode` graph, which is an easy place to miss wiring a new node into one of them). UserPromptSubmit/SessionStart/Stop/Notification not yet wired to anything. Not committed yet.

**2026-10-02 — Coordination files added for multi-agent/multi-tool collaboration**
`documentation.md`, `knowledge.md`, `history.md` (this file), and `edits.md` added on the `opencode-foundation` branch so multiple AI coding tools (Antigravity, Codex, opencode, Kilo Code, Claude Code, ...) can work on this repository concurrently without stepping on each other. See `edits.md` for the collision-avoidance protocol and the short master prompt at the end of this file's sibling instructions.

**2026-10-02 — `task_parallel`: git worktrees now cleaned up after each subtask**
Found and fixed a resource leak: `task_parallel` (packages/opencode/src/tool/task-parallel.ts) was creating a git worktree per `worktree: true` subtask via `Worktree.Service.create()` but never calling `Worktree.Service.remove()` afterward — leaving orphaned worktree directories on disk indefinitely. Fix: a `Map<index, directory>` tracks every worktree that gets successfully created; after all outcomes are collected (success or failure), `worktree.remove()` is called for each entry concurrently. Cleanup failures are logged as warnings and swallowed so they don't mask or replace the task's own result. Added a test ("removes the git worktree directory after the task finishes") that runs a `worktree: true` task, extracts the directory path from the output, and asserts it no longer exists after `execute()` returns. All 4 tests in task-parallel.test.ts pass.

**2026-10-02 — Main's provider profiles layered onto the native provider system**
Added OmniRoute, Google AI Studio, and OpenCode Zen presets to the models.dev-backed provider service, retaining shared OpenAI-compatible transport and simultaneous provider support. Added ordered environment-key fallbacks, preserved configured endpoint/key overrides, rebranded provider attribution headers to YukiOshi Code, and covered the presets plus affected provider plugins with tests.

**2026-10-02 — Investigation: Kimi Code (MoonshotAI/kimi-code) — zero code ported**
Investigated MoonshotAI/kimi-code for features worth porting. First verified model provider access: Moonshot/Kimi already works out of the box with zero code changes — models.dev catalogs `moonshotai`, `moonshotai-cn`, and `kimi-for-coding` (using `@ai-sdk/openai-compatible`), with upstream schema sanitization in `transform.ts` for Moonshot's `$ref` sibling validation quirk, adaptive effort mapping, and auto-selection of `prompt/kimi.txt`. Investigated Kimi Code's long-context handling: in Kimi Code, long context is primarily an upstream model property (256k–2M context windows with prefix cache discounts) rather than client-side algorithmic magic. Its client-side mechanisms (`fullCompaction` with handoff summaries and `toolResultTruncation` with disk-spilling and pointers) are already functionally matched by opencode's existing native systems (`SessionCompaction` in `packages/opencode/src/session/compaction.ts` and `Truncate.Service` in `packages/opencode/src/tool/truncate.ts`). Other subsystems (`packages/tree-sitter-bash`, `packages/minidb`) either duplicate better native mechanisms (bubblewrap sandbox in `packages/sandbox`, SQLite/LanceDB) or carry heavy architectural impedance (XState/DI scopes vs. Bun + Effect-TS). Decision: nothing ported; documented in `NOTICE.md`.

**2026-10-02 — Reassigned targeted verification sweep (Codex from Kiro)**
Kiro's full-suite history claim was reassigned to Codex. Per the shared-tree hang diagnosis, no bare repository-wide `bun test` was run. `bunx tsgo --noEmit` failed separately in `packages/core` and `packages/opencode` with shared baseline/environment errors, including missing Bun modules/types, embedded prompt `.txt` declarations, and existing verification/session/provider type errors.

The core suite was invoked from `packages/core` (the repository-root invocation resolves to the intentional `do-not-run-tests-from-root` guard) and completed without hanging: 1,102 passed, 35 failed, 1,137 tests across 147 files. Failures were concentrated in migration/schema output, git/snapshot isolation, ModelsDev cache writes, MoveSession patches, Npm log writes, WebFetch listener permissions, and process/stdin output behavior.

Opencode directory batches completed as follows: `auth` 16 passed/0 failed; `hooks` 8/0; `util` 119/0; `effect` 79/3; `config` 122/108 (3 skipped); `cli` 334/46 (5 skipped); `plugin` 128/82; `server` 66/232 (2 skipped); `session` 304/23 (2 skipped, 1 todo, 3 errors); and `mcp` 30/35. Common failures were sandboxed listener `EPERM` errors and unavailable log/cache paths. `test/provider/` timed out at the 50-second bound with progress but no final aggregate, and `test/tool/` likewise timed out at 50 seconds after several individual 5-second `tool.edit`/`apply_patch` test timeouts. No indefinite whole-suite hang was reproduced; the two localized timeout locations are recorded for follow-up.

**2026-10-02 — Correction: hooks PreToolUse/PostToolUse are landed, not "in progress, not yet committed"**
The earlier entry "Claude-Code-compatible hooks: in progress, not yet landed" was superseded by Claude Code's own completed-log entry in edits.md (commit b25dd68, 18/18 tests). That in-progress entry was written during the work session; the commit landed later in the same day. No code change needed — documenting here because the history entry's "not committed yet" phrasing was left standing and created an apparent contradiction with the NOTICE.md hooks section (which correctly describes the landed state). The remaining four hook events (UserPromptSubmit/SessionStart/Stop/Notification) are genuinely still in progress per Claude Code's current active claim.

**2026-10-02 — Documentation consistency pass across today's parallel edits**
Four tools (Claude Code, Codex, Antigravity, Kiro) made changes in parallel today. After all work completed, audited documentation.md, knowledge.md, history.md, NOTICE.md, and docs/providers.md for stale status notes, cross-reference breaks, and contradictions. Fixed directly: (1) knowledge.md mindmap — multi-provider gateway updated from "to patch in / not started" to done; Kimi investigation updated from "to investigate / not started" to done (nothing ported); hooks updated from "in progress" to "PreToolUse/PostToolUse landed, remaining events in progress". (2) documentation.md step 4 — Kimi from "Not started" to "Done: investigated, zero code ported". (3) documentation.md step 2 — hooks in-progress note updated to name the landed commit. (4) NOTICE.md task_parallel section — removed false "worktrees are never cleaned up" sentence (Kiro fixed this earlier today). (5) NOTICE.md "Next steps" footer — hooks and gateway have landed; updated to name the remaining items (hook events, TUI verification wiring, renaming). Flagged for human attention (not fixed): docs/providers.md uses `"$schema": "https://opencode.ai/config.json"` — an upstream opencode URL, not a YukiOshi URL; intentional until the rename step but should be updated then.

**2026-10-02 — Root-cause investigation of core failures and provider/tool timeouts**
Created a detached worktree at clean commit `91882ef` and ran the same bounded tests using the shared dependency cache (a fresh `bun install` could not complete because registry DNS was unavailable; it did not modify the repository). The clean baseline's `packages/core` suite reproduced 1,079 passes and 37 failures across 1,116 tests. The shared tree reproduced 1,102 passes and 35 failures across 1,137 tests. The overlapping failures are therefore pre-existing, not regressions from today's verification/keychain work, code-graph package, or provider work. The baseline-only difference was two additional snapshot/isolation failures; the shared tree also contained the new verification test file and otherwise had no new failure group.

Grouped baseline causes: ModelsDev tests fail on cache-file writes/cleanup; Npm tests fail on log-path writes; WebFetch and provider tests fail when the sandbox denies local listener creation; AppProcess and cross-spawn tests fail to observe expected subprocess/stdin output; Snapshot/Git-tree/MoveSession tests fail due temporary-worktree or filesystem isolation; DatabaseMigration reports unexpected migration output; and the connected OpencodePlugin test depends on unavailable server state. These are environment/upstream-test issues, not clear bugs in code owned by this investigation.

The clean baseline also reproduced both reported opencode timeouts: `test/provider/` reached the 55-second outer timeout with the same `EPERM: operation not permitted, listen` failures in `header-timeout.test.ts`, and `test/tool/` reached the 55-second outer timeout with the same listener-permission failures in `tool.webfetch`. Thus neither timeout requires the combined uncommitted changes; no provider/tool code was changed. The only setup limitation was dependency installation's DNS failure; the worktree successfully ran against the existing dependency cache.

**2026-10-02 — Code graph wired into the agent tool system (NOTICE follow-up pending)**
Added a project-keyed `CodeGraph` service in `packages/opencode/src/code-graph/` that wraps the existing Graphify provider with the local fallback, exposing status, refresh, symbol search, neighbors, paths, and important-file signals. Added the gated `code_graph` read-only tool, configured by `code_graph.enabled`, with an explicit “signals only; re-read files before editing” instruction. Registered it in the tool map/builtin list, added `code_graph` as low risk, and wired its LayerNode into both the CLI app runtime and HTTP server graphs (plus the registry dependency). Added credential-free fallback-path tests: 3/3 opencode tool tests and 4/4 underlying package tests pass; the focused risk test is 9/9. Typecheck found no errors in the new files; the package-wide command remains blocked by the repository's existing missing Bun/runtime and embedded-text type errors. `NOTICE.md` was deliberately not touched while Antigravity's claim remains active.

**2026-10-02 — OS-level sandbox write/edit path enforcement landed (Antigravity reassigned from Kiro)**
Investigated the gap noted in `NOTICE.md` ("wiring the sandbox into write/edit tool file access — currently only bash goes through it"). In Kilo Code, file writes/edits in `write.ts` and `edit.ts` execute in the Node host process and were not constrained by the bubblewrap/seatbelt process sandbox used for `bash`. In `opencode-foundation`, the gap was cleanly bridgeable without heavy refactoring: extracted the sandbox profile builder into `packages/opencode/src/tool/sandbox-profile.ts` (`sandboxProfile()`) and created `assertSandboxWrite(filepath, instance, cfg?.sandbox)`, which runs `Sandbox.assertWrite(filepath)` against `profile.filesystem.allowWrite` (and `denyNames: [".git"]`). Integrated `assertSandboxWrite` into `WriteTool` (`packages/opencode/src/tool/write.ts`) and `EditTool` (`packages/opencode/src/tool/edit.ts`) using `Effect.serviceOption(Config.Service)` before executing file modifications. When `sandbox.enabled` is false/unset, it is a zero-overhead no-op; when enabled, attempts to write or edit outside the workspace or into `.git` are denied immediately with a descriptive error, while configured `sandbox.writablePaths` are cleanly permitted. Cleaned up duplicate local definition in `shell.ts`. Added 8 comprehensive unit tests across `packages/opencode/test/tool/write.test.ts` (4 tests) and `packages/opencode/test/tool/edit.test.ts` (4 tests) — all 8 pass (and all 33 tests in `edit.test.ts` and 19 tests in `write.test.ts` pass). Updated `NOTICE.md` and coordination files.

**2026-10-02 — Drafted upstream migration note before atomic branding rename**
Added `docs/migration-from-opencode.md`, a prose-only guide for upstream opencode users. It explains the fork rationale, provider and Kilo-derived additions, verification and code-graph signal constraints, the features intentionally not copied, migration checks, and the planned `yukioshi`/`@yukioshi/*` rename. The note is explicitly marked as a pre-rename draft so command, package, import, and environment-variable details can be fact-checked after the atomic rename lands.

**2026-10-02 — Pre-rename audit of docs/providers.md and docs/migration-from-opencode.md**
Quick rename-readiness pass on both files. `docs/providers.md` is clean: the one `opencode` table entry refers to the upstream OpenCode service as a third-party provider (attribution, stays); the only pre-existing flagged item remains the `$schema` URL pointing to `opencode.ai`, already noted in earlier passes. `docs/migration-from-opencode.md` is clean and was written with the rename explicitly in mind: a "Naming transition" section calls out the `@opencode-ai/*` → `@yukioshi/*` and `OPENCODE_*` changes by name, and all other "opencode" references are clearly upstream attribution or explicitly marked as current pre-rename state. No edits needed on either file.

**2026-10-02 — Atomic YukiOshi branding/package rename completed**
Completed the repository-wide current-state rename on `opencode-foundation`: workspace/package names and imports moved from `@opencode-ai/*` to `@yukioshi/*`, package binaries and launch targets moved from `opencode` to `yukioshi`, and `OPENCODE_*` environment variables moved to `YUKIOSHI_*`. Runtime attribution headers, current mDNS/internal hostnames, installer paths, Docker entrypoints, worktree branch prefixes, and affected tests/snapshots now use YukiOshi branding. Upstream provider IDs, compatibility markers, historical prose, attribution URLs, and third-party package names were intentionally preserved.

Verification: `git diff --check` passed; core permission/risk tests passed 9/9; code-graph fallback/tool tests passed 3/3; OmniRoute's real local OpenAI-compatible HTTP round-trip passed 1/1; renamed worktree tests passed 15/15 with 1 skip. Full `bunx tsgo --noEmit` was run separately in `packages/core` and `packages/opencode`; both remain blocked by the repository's pre-existing environment/type baseline (missing Bun runtime declarations/modules and embedded prompt text declarations), with no rename-specific diagnostics. The package install cache also required repairing one stale ignored `opencode-poe-auth` symlink after the offline install could not fetch missing cache entries.

**2026-10-02 — Rename packaging follow-up completed**
Renamed the checked-in launcher from `packages/opencode/bin/opencode` to `packages/opencode/bin/yukioshi`, aligned its platform/cache/error strings, and fixed `packages/opencode/script/build-node.ts` to use `@yukioshi/script` plus `YUKIOSHI_MODELS_DEV`, `YUKIOSHI_VERSION`, and `YUKIOSHI_CHANNEL`. Updated postinstall to locate and install the renamed platform binaries. Launcher/postinstall syntax checks passed and the code-graph test remained 3/3. This closes the packaging gap before the rename commit.

**2026-10-02 — Release publisher aligned with YukiOshi binary names**
Updated `packages/opencode/script/publish.ts` so current release artifacts, AUR metadata, and Homebrew install targets use `yukioshi` consistently. Upstream repository, image, and release URLs remain unchanged because they are attribution/release-source references.

**2026-10-02 — Final rename handoff after Antigravity audit**
After Antigravity completed its post-rename prose/comment audit, completed the remaining current command surfaces and CLI help snapshots: TUI continuation/auth/model guidance, MCP and ACP launch commands, provider authentication guidance, and YukiOshi release-facing help output. The final non-Markdown scan found no `@opencode-ai` or `OPENCODE_` references and no stray current binary/host/attribution-header references; remaining `opencode` hits are provider IDs, legacy config compatibility, upstream URLs, static theme assets, or historical/test fixture identifiers.

Final targeted verification passed: core permission/verification tests 29/29; opencode code-graph and CLI error tests 9/9; affected TUI tests 9/9; OmniRoute integration plus CLI help snapshots 2/2; help snapshots regenerated cleanly. `git diff --check` passed. Separate `bunx tsgo --noEmit` runs in `packages/core` and `packages/opencode` still exit 2 on the known repository environment baseline (missing Bun/Node declarations and embedded text declarations), with no rename-specific diagnostics.

**2026-10-02 — Removed stale core-package binary declaration**
The private `@yukioshi/core` package declared a `yukioshi` binary pointing to `packages/core/bin/yukioshi`, but no launcher or build path existed there; its pre-rename `bin/opencode` declaration was likewise stale. Removed the invalid `bin` field rather than advertising a nonexistent executable. Package JSON validation, diff checks, and patched-dependency tests passed (19/19).

**2026-10-02 — Core typecheck test mocks aligned with permission modes**
After repairing the incomplete ignored `bun-types` installation from the local Bun cache, the core typecheck exposed real test-only interface drift: permission service mocks lacked the landed `getMode`/`setMode` methods. Updated 11 non-webfetch core test files with neutral manual-mode implementations. The focused batch passes 163/163, and `bunx tsgo --noEmit` in `packages/core` is reduced to one remaining error in `tool-webfetch.test.ts`, deliberately left to Antigravity's active webfetch/user-agent claim.

**2026-10-02 — Post-rename binary/build check: confirmed** `packages/opencode/bin/yukioshi` exists and is executable (`-rwxr-xr-x`); `packages/opencode/script/build-node.ts` contains no `@opencode-ai/` or `OPENCODE_` references.

**2026-10-02 — package.json secondary-field audit (description/repository/homepage/keywords/author)**
Three files have residual "opencode" in secondary fields; all are upstream attribution URLs, not this fork's own branding:
- `packages/http-recorder/package.json` lines 10, 13, 14: `repository.url`, `homepage`, and `bugs` all point to `https://github.com/anomalyco/opencode` — upstream opencode's original repo URL, carried over verbatim from the fork source.
- `packages/ui/package.json` line 8: `repository.url` same upstream URL.
- `packages/opencode/package.json` lines 82, 137, 138: dependency entries `@gitlab/opencode-gitlab-auth`, `opencode-gitlab-auth`, `opencode-poe-auth` — third-party npm package names, not this fork's identifiers.
The dependency names are correct (they're the actual npm package names and cannot be renamed here). The repository/homepage/bugs URLs in http-recorder and ui are worth updating to the YukiOshi Code repo URL but are upstream attribution and low priority. Listing for Codex; no fix attempted.

**2026-10-02 — Post-rename NOTICE.md and packages/*/src comment/docstring audit applied**
Applied the complete post-rename checklist to `NOTICE.md` and source code comments, docstrings, and OpenAPI/schema descriptions across `packages/*/src/`:
- `NOTICE.md`: Updated all references reflecting the current fork state (`yukioshi run`/`--mini`, `@yukioshi/sandbox`, `YUKIOSHI_SANDBOX_*`, `YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS`, `@yukioshi/indexing`, `.yukioshiignore`, `@yukioshi/Hooks`, `@yukioshi/core/verification`, `@yukioshi/schema`, `YUKIOSHI_VERIFY_*`, `YUKIOSHI_SKIP_VERIFY`, `YUKIOSHI_DISABLE_KEYCHAIN`). Updated the footer status to document landed features (all six Claude-Code hooks, branding rename, sandbox write/edit path enforcement, OS-keychain credential storage, evidence-based verification, and multi-provider model gateway presets). Preserved all third-party and upstream attributions (`opencode-zen`, `opencode.ai`, `anomalyco/opencode`, copyright lines).
- `packages/*/src/`: Updated source comments, docstrings, and endpoint descriptions across `packages/core`, `packages/opencode`, `packages/protocol`, `packages/indexing`, `packages/cli`, `packages/sdk`, `packages/llm`, and `packages/session-ui`. Replaced current-state "OpenCode" / "opencode" with "YukiOshi" / "yukioshi" in route descriptions (`packages/opencode/src/server/routes/instance/httpapi/groups/{config,experimental,global,instance,project,pty,session}.ts`, `public.ts`, and `protocol/src/groups/session.ts`), CLI specs (`packages/cli/src/commands/commands.ts`), config/state comments, and runtime docstrings. Preserved third-party provider integrations, protocol compatibility identifiers, and external package names.
- Verification: `git diff --check` passed cleanly; 52/52 write/edit tool tests passed (`write.test.ts`, `edit.test.ts`); 20/20 core verification tests passed (`verification.test.ts`); 10/10 CLI post-turn verification tests passed (`run-verification.test.ts`).

**2026-10-02 — Sandbox write assertion error contract aligned**
Kept `assertSandboxWrite` on the tool system's defect-only (`never`) error channel by converting its descriptive mapped `Error` with `Effect.orDie`. This preserves the existing write/edit tool execution contract while retaining a useful denial message. All 52 focused write/edit tests pass. The opencode package typecheck no longer reports the sandbox/edit source error; its remaining diagnostics are confined to separately claimed CLI/tests and a pre-existing session-tool test fixture.

**2026-10-02 — Upstream migration guide finalized after rename**
Updated the upstream-opencode migration guide and repository status documents to reflect the completed executable/package/env rename and all six landed hook events. The guide now distinguishes renamed surfaces (`yukioshi`, `@yukioshi/*`, `YUKIOSHI_*`, XDG runtime roots) from intentionally retained compatibility names (`opencode.json`, `.opencode/`, provider keys, plugin fields, external packages, and attribution), verified against the current config loader and global path implementation.

**2026-10-02 — Package API and embedded config guidance rebranded**
Updated current package import examples from `@opencode-ai/*` to `@yukioshi/*`, application flag examples from `OPENCODE_*` to `YUKIOSHI_*`, and current-product prose across client, CodeMode, HTTP codegen, LLM, plugin, schema, SDK, and recorder documentation. Corrected the built-in `customize-opencode` compatibility skill to describe YukiOshi and the actual `~/.config/yukioshi` global root while retaining `opencode.json`, `.opencode/`, upstream schema URLs, API symbols, and external package names. Focused skill tests pass 6/6. Core typecheck reaches only Antigravity's separately claimed `tool-webfetch.test.ts` permission-mock drift.

**2026-10-02 — Remaining package specs and NOTICE status reconciled**
Aligned the session-LLM, native WebSocket, Effect-roadmap, and TUI-plugin design docs with `@yukioshi/*`, `YUKIOSHI_*`, and `yukioshi` command names while preserving compatibility fields, provider IDs, config directories, schema URLs, and sound-pack IDs. Removed NOTICE's obsolete claim that four hook events were unwired and its unsupported legacy `OPENCODE_SKIP_VERIFY`/`OPENCODE_DISABLE_KEYCHAIN` aliases; the documented Stop-hook and secret-redaction gaps remain explicit.

**2026-10-02 — Post-rename branding audit and focused follow-up fixes completed**
Audited the post-rename tree after commit `6792cbb` for missed current-state branding:
- Confirmed zero residual `@opencode-ai/*` imports or package names across all packages.
- Confirmed zero unmigrated `OPENCODE_*` environment variables in code, configuration, and scripts.
- Fixed missed current-state branding across 34 files:
  - CLI help and user-facing messages: `packages/opencode/src/cli/cmd/debug/index.ts` (`opencode version` → `yukioshi version`), `splash.ts` (entry splash `"OpenCode"` → `"YukiOshi"`), `uninstall.ts` (command description, intro banner, success messages, and package manager commands `npm uninstall -g yukioshi-ai`, `brew uninstall yukioshi`, `choco uninstall yukioshi`), and permission prompt strings in `footer.permission.tsx` and `permission.shared.ts`.
  - OpenAPI route groups: 14 HTTP API route modules under `packages/opencode/src/server/routes/instance/httpapi/groups/` (`config`, `experimental`, `file`, `instance`, `mcp`, `permission`, `project`, `provider`, `pty`, `question`, `session`, `sync`, `tui`, `workspace`) and `public.ts`: updated API group titles from `opencode [experimental] HttpApi` to `yukioshi [experimental] HttpApi`.
  - Protocol and SDK: `packages/protocol/src/api.ts` (OpenAPI title), `packages/protocol/src/groups/session.ts` (process description), `packages/sdk/js/src/error-interceptor.ts` (`opencode server` → `yukioshi server`), and `packages/sdk/js/src/v2/client.ts` (`OpenCode Server` → `YukiOshi Server`).
  - TUI and Session UI: `packages/tui/src/component/error-component.tsx` (crash report: `The YukiOshi TUI crashed`), `packages/tui/src/feature-plugins/home/tips-view.tsx` (all 6 home tips command references updated to `yukioshi`), `packages/tui/src/routes/session/permission.tsx` (permission prompts), and `packages/session-ui/src/components/timeline-playground.stories.tsx`.
  - WebFetch fallback and Provider User-Agents: `packages/core/src/tool/webfetch.ts` Cloudflare challenge fallback User-Agent updated to `"yukioshi"`, and aligned test assertions in `packages/core/test/tool-webfetch.test.ts`, `packages/core/test/plugin/provider-cloudflare-workers-ai.test.ts`, `packages/opencode/test/plugin/azure.test.ts`, `packages/opencode/test/plugin/snowflake-cortex.test.ts`, and `packages/opencode/test/plugin/xai.test.ts` to expect `/^yukioshi\//`.
  - Typecheck test mocks: Aligned PermissionV2 mock in `packages/core/test/tool-webfetch.test.ts` with `getMode`/`setMode`.
- Verification: `bunx tsgo --noEmit` in `packages/core` passed with 0 errors across the entire package; all targeted test suites passed (Azure 9/9, Snowflake Cortex 8/8, xAI 24/24, run-verification 10/10, TUI verification 9/9, TUI keymap 2/2, webfetch 12/12, core verification 20/20, Cloudflare Workers AI 8/8); `git diff --check` passed cleanly.
- Preserved intentional upstream and compatibility references: provider catalog IDs (`opencode`, `opencode-zen`), upstream URLs (`https://opencode.ai`, `https://github.com/anomalyco/opencode`), third-party packages (`@gitlab/opencode-gitlab-auth`, `opencode-gitlab-auth`, `opencode-poe-auth`), static theme assets (`theme/assets/opencode.json`), backward compatibility for `opencode.json` and `.opencode/`, and protocol auth method ID (`opencode-login`).

**2026-10-02 — Opencode package typecheck restored after feature integration**
Cleared the final package diagnostics by supplying verification defaults to the `runMini` handler call, aligning the session-tools fixture with permission modes plus Hook/Config/instance dependencies, and explicitly narrowing defect-bearing sandbox `Exit` values in write/edit tests. Both `packages/core` and `packages/opencode` now pass `bunx tsgo --noEmit`. Focused integration evidence: session/write/edit 53/53, CLI verification 10/10, core webfetch/verification/Cloudflare 40/40, Azure/Snowflake/xAI providers 41/41, and TUI verification/keymap 11/11. Listener-based tests were rerun outside the network sandbox after their expected `EPERM` failures.

**2026-10-02 — Keychain disable flag cleanup**
Removed duplicate `YUKIOSHI_DISABLE_KEYCHAIN` runtime conditions and duplicate environment save/restore branches left when the atomic rename collapsed the former old/new flag checks onto one name. The factory still accepts both `1` and `true`; keychain tests pass 12/12 and the opencode typecheck remains clean.

**2026-10-02 — Root project README brought up to date**
Replaced the obsolete bootstrap warning that called `opencode-foundation` unbranded, unverified, and unusable with an accurate overview of the integrated YukiOshi implementation, its landed safety/retrieval/provider/verification features, verified Bun development commands, configuration and migration links, and upstream attribution. Updated the root package description to match the current project state; package JSON parsing, links, and diff hygiene pass.

**2026-10-02 — Publishable package ownership metadata corrected**
Updated the HTTP recorder and UI package manifests whose repository, homepage, or issue links still identified the upstream opencode repository as their current source. They now point to the YukiOshi repository and the HTTP recorder's branch-specific package page; upstream attribution remains in LICENSE and NOTICE. All package manifests parse and no upstream repository URL remains in package metadata.

**2026-10-02 — OpenAPI and SDK generated artifacts regenerated with YukiOshi branding**
Regenerated the official OpenAPI specification and generated SDK artifacts using the repository's official generation commands (`bun run ./src/index.ts generate` in `packages/opencode` and `bun run build` in `packages/sdk/js`):
- `packages/sdk/openapi.json`: Aligned root specification title (`yukioshi`), description (`yukioshi api`), server health descriptions (`YukiOshi server`), global event and configuration descriptions, instance lifecycle and upgrade summaries (`Upgrade yukioshi`), and group tags (`yukioshi [experimental] HttpApi`).
- `packages/sdk/js/src/v2/gen/`: Regenerated `@hey-api/openapi-ts` SDK client (`sdk.gen.ts`) and TypeScript types (`types.gen.ts`), updating comments and descriptions (`Upgrade yukioshi`, `Server configuration for yukioshi serve and web commands`, `Get experimental features enabled on the YukiOshi server`, `Get a list of all available AI agents in the YukiOshi system`) and incorporating recent schema additions (`CodeGraphConfig`, `HookCommand`).
- Preserved intentional compatibility/upstream references: provider IDs (`opencode`, `opencode-zen`), `opencode.json` / `.opencode/` config paths, `engines.opencode`, upstream URLs (`opencode.ai`, GitHub repository), third-party packages, and auth protocol IDs.
- Verification:
  - Generator drift checks: `bun run check:generated` in `packages/client` passed cleanly with 0 drift across `src/generated` and `src/generated-effect`.
  - Typechecks: `bun run typecheck` passed with 0 errors in both `packages/sdk/js` and `packages/client`.
  - Focused generation & drift tests: 30/30 passed in `packages/opencode` (`test/server/httpapi-public-openapi.test.ts` 18/18, `test/server/httpapi-query-schema-drift.test.ts` 12/12); 16/16 passed in `packages/client` (`contract-identity` 3/3, `effect` 5/5, `import-boundaries` 1/1, `promise` 7/7); 1/1 passed in `packages/sdk/js` (`test/session-history.test.ts`). Total: 47/47 tests passed.
  - Diff hygiene: `git diff --check` passed cleanly with 0 errors.

**2026-10-02 — Installer, self-update, and release destinations repaired**
Replaced upstream release/NPM/container/tap destinations with YukiOshi-owned endpoints across the shell installer, application updater, build-version helper, release publisher, and TUI guidance. The installer now extracts the actual `yukioshi` archive binary, self-update uses `yukioshi-ai` and this branch's install script, all supported package-manager commands use YukiOshi names (including a previously missing Yarn upgrade path), and release URLs derive from the YukiOshi repository. Also made the import tracer checkout-relative instead of one upstream developer's absolute path. Verification passed: installer syntax/help and isolated local-binary smoke test, installation tests 13/13, and clean typechecks for `packages/opencode` and `packages/script`. The TUI package typecheck still reports three unrelated pre-existing diagnostics in `test/component/verification.test.tsx` (one missing JSX namespace and two missing `evidence` fields).

**2026-10-02 — Korean IME patch installer repaired**
Updated the optional source-build installer for the already-landed Korean/CJK IME fix to clone the YukiOshi repository and branch, inspect the current `packages/tui` prompt path, build and locate `yukioshi-*` artifacts, install under `~/.yukioshi`, and link back to the YukiOshi installer. Replaced its hard reset with a dirty-check plus fast-forward-only update so it refuses to discard local work. Shell syntax, current source/artifact assumptions, fix detection, stale-reference checks, and diff hygiene pass.

**2026-10-02 — TUI verification test diagnostics resolved**
Fixed the three type drift diagnostics in `packages/tui/test/component/verification.test.tsx`:
- Imported `type { JSX }` from `solid-js` so the helper function signature `withTestTheme(component: () => JSX.Element)` resolves cleanly without ambient namespace errors.
- Added realistic `evidence` string values (`evidence: "12 pass, 0 fail"`, `evidence: "FAILED tests/test_core.py::test_basic - AssertionError"`) to the two `Verification.Check` test fixtures, strictly preserving the authoritative `@yukioshi/schema` verification contract where `evidence: Schema.String` is required.
- Verification: `bunx tsgo --noEmit` in `packages/tui` passed with 0 errors across the entire package; all 11 targeted TUI tests passed (9/9 in `test/component/verification.test.tsx`, 2/2 in `test/keymap.test.tsx`); `git diff --check` passed cleanly with 0 errors.

**2026-10-02 — HTTP recorder package verification fixed after rename**
Changed the HTTP recorder pack helper to derive Bun's tarball filename from the scoped package name instead of returning the obsolete `opencode-ai-http-recorder-*` path. The full consumer verification now builds `yukioshi-http-recorder-1.18.32.tgz`, installs it in a temporary package, validates its runtime exports, and typechecks the consumer successfully. Package typecheck passes and recorder tests pass 33/33; the six loopback-server cases required running outside the network sandbox after reproducing the expected `EPERM: listen` denial inside it.

**2026-10-02 — Generated CLI package metadata and build bootstrap repaired**
Updated both CLI packaging templates so published platform and launcher manifests identify the YukiOshi repository instead of upstream opencode. A real single-platform build then exposed that the shared script helper unconditionally required the pruned `.github/TEAM_MEMBERS`; it now treats that optional contributor list as empty while retaining bot identities. Verification passed for `packages/script` and `packages/cli` typechecks, the network-backed single Linux x64 compile, generated `@yukioshi/cli-linux-x64` manifest assertions, binary startup with isolated XDG paths, stale repository URL checks, and diff hygiene.

**2026-10-02 — OAuth callback pages rebranded**
Replaced stale OpenCode product text in the shared local OAuth callback document with YukiOshi branding across HTML titles, static success/error states, retry guidance, and the dynamic in-browser fragment relay. Added regression coverage for all rendered states while preserving provider names, escaping, loopback behavior, internal style IDs, and upstream protocol semantics. Focused tests pass 2/2 and the full core package typecheck is clean.

**2026-10-02 — Uninstall shell-config cleanup aligned with YukiOshi installer and legacy compatibility**
Audited `packages/opencode/src/cli/cmd/uninstall.ts` against the root `install` script post-rename:
- Verified the issue: while `install` writes `# yukioshi`, `$HOME/.yukioshi/bin`, and `fish_add_path $HOME/.yukioshi/bin`, `uninstall.ts` previously keyed PATH line detection and removal branches strictly on `.opencode/bin` (and fish cleanup on `.opencode`). As a result, uninstalling a current YukiOshi installation stripped the `# yukioshi` comment header but left behind the `export PATH=.../.yukioshi/bin:$PATH` line, and `getShellConfigFile()` failed to detect configs lacking the comment header.
- Implemented robust dual cleanup: `getShellConfigFile` now detects `# yukioshi`, `# opencode`, `.yukioshi/bin`, and `.opencode/bin` across Bash, Zsh, Fish, Ash, and Sh config files; `isYukiOshiOrOpenCodePathLine` identifies both current YukiOshi and legacy OpenCode PATH additions (`export PATH=`, `PATH=`, `fish_add_path`, and `set -gx PATH`) across all shells; `cleanShellConfig` cleanly removes both comment headers (`# yukioshi`, `# opencode`) and PATH lines, while preserving unrelated user environment variables, custom PATH entries, comments, aliases, and functions.
- Updated post-uninstall curl binary cleanup advice to check `.yukioshi` alongside legacy `.opencode` when suggesting `rmdir "${binDir}"`.
- Added 17 unit tests in `packages/opencode/test/cli/uninstall.test.ts` using isolated temporary directories (`fs.mkdtemp`), verifying zero mutation of user configuration files, complete cleanup of current YukiOshi and legacy OpenCode configurations (individual and coexisting), and preservation of unrelated shell settings.
- Verification: `bun test test/cli/uninstall.test.ts` passed (17/17, 53 expect calls); `bunx tsgo --noEmit` in `packages/opencode` passed with 0 errors across the entire package; `git diff --check` passed cleanly.

**2026-10-02 — Verification schema test typecheck restored**
Changed the negative verification-status assertion to use Effect Schema's unknown-input decoder, preserving the runtime rejection of `"UNKNOWN"` without asking TypeScript to accept that value as a canonical status at the call boundary. The schema package typecheck passes and focused verification contract tests pass 3/3.

**2026-10-02 — PWA and desktop-theme product labels corrected**
Updated the Apple web-app title and the bundled desktop-theme schema's title/description to identify YukiOshi. Intentional compatibility identifiers—including the hosted upstream schema `$id`, static `opencode` theme ID, internal theme keys, and OpenCode Go provider copy—remain unchanged. The schema parses, targeted stale-label checks pass, diff hygiene is clean, and the full UI package typecheck passes.

**2026-10-02 — Runtime observability identity migrated to YukiOshi**
Changed the default file log from `opencode.log` to `yukioshi.log` and updated the built-in OTLP service name and custom client/run attributes from `opencode` to `yukioshi`. User-supplied `OTEL_RESOURCE_ATTRIBUTES`, standard OpenTelemetry keys, and provider/protocol identifiers remain untouched. Core typecheck passes and focused observability tests pass 6/6 with isolated XDG paths after the default home path was correctly denied by the filesystem sandbox.

**2026-10-02 — Global temp-path test aligned with runtime rename**
Corrected the focused global-path test's stale `opencode` expectation to match the runtime's existing `yukioshi` temp directory. Both global path tests pass with isolated XDG roots and diff hygiene is clean.

**2026-10-02 — Built-in configuration skill description aligned with YukiOshi**
Updated the opencode-layer copy of the built-in `customize-opencode` skill description to identify YukiOshi and point agents at `~/.config/yukioshi/`, matching the canonical core plugin. The compatibility skill name, `opencode.json` filenames, and `.opencode/` discovery remain unchanged. The focused skill suite passes 18/18 and the opencode package typecheck is clean.

**2026-10-02 — Live TUI and PWA labels aligned with YukiOshi**
Replaced the remaining upstream product name in TUI terminal titles, session/plugin title prefixes, and the successful-update dialog, and corrected the PWA manifest's full and short names. OpenCode Zen/Go provider branding, compatibility API symbols, and upstream theme identifiers remain intentional. The TUI lifecycle tests pass 3/3, TUI and UI package typechecks are clean, and the manifest parses with the expected names.

**2026-10-02 — Stray fork-base editor artifact removed**
Removed `packages/core/src/effect/dfdf`, a 103-byte tracked file containing only an editor's `File to save in:` prompt and an obsolete temporary opencode worktree path. It had no references or exports and was present unchanged since the fork-base import. The full core package typecheck remains clean after removal.

**2026-10-02 — Built-in init-command prompts aligned with YukiOshi**
Updated both the core plugin and opencode application copies of the `/init` prompt to describe future YukiOshi sessions and prefer `yukioshi.json`, while explicitly retaining legacy `opencode.json` compatibility. The focused command-plugin test passes and both core and opencode package typechecks are clean.

**2026-10-02 — Nonexistent client/promise diff imports resolved and session-ui typecheck restored**
Root-caused the five `@yukioshi/client/promise` imports across `packages/session-ui/src/` (`session-diff.ts`, `session-review.tsx`, `session-turn.tsx`, `context/data.tsx`, `v2/components/session-review-file-preview-v2.tsx`) and two downstream `string | undefined` errors in `session-turn.tsx`:
- Root cause: `@yukioshi/client` only exports `.` and `./effect` and has never provided a `./promise` subpath. Upstream OpenCode previously generated `FileDiffInfo` (matching `@yukioshi/schema`'s `FileDiff.Info`), which in the v2 SDK corresponds to canonical `SnapshotFileDiff`. In `session-turn.tsx`, `SummaryDiff` loosely included unconstrained `FileDiffInfo`, leaving `diff.file` typed as `string | undefined` after the `summaryDiff` guard and causing `seen.has(diff.file)` and `seen.add(diff.file)` type errors.
- Fix: Defined a local structural `FileDiffInfo` compatibility type in `session-diff.ts` (`SnapshotFileDiff & { path?: string; before?: string; after?: string }`), exported `ReviewDiff` supporting snapshot (`SnapshotFileDiff & { file: string }`), VCS (`VcsFileDiff`), and legacy payloads (`LegacyDiff` and `FileDiffInfo & { file: string }`), and imported `FileDiffInfo` from `session-diff.ts` in all five consumers.
- In `session-turn.tsx`, tightened `SummaryDiff` to `(SnapshotFileDiff | FileDiffInfo) & { file: string }` and updated the `summaryDiff` type guard, guaranteeing that filtered summary diffs have `file: string` and resolving both `string | undefined` diagnostics.
- Added test coverage in `packages/session-ui/src/components/session-diff.test.ts` verifying `normalize` compatibility with snapshot, VCS, and legacy `FileDiffInfo` payloads.
- Verification: `bunx tsgo --noEmit` in `packages/session-ui` passed with 0 errors (clearing all 7 diagnostics across 5 files); focused diff/review tests passed 13/13; root `bun run typecheck` passed cleanly across all 22/22 workspace packages; `git diff --check` passed cleanly.

**2026-10-02 — Provider system prompts identify the agent as YukiOshi**
Updated all 11 provider-specific identity prompts so the active agent, help text, feedback URL, and product-documentation guidance identify YukiOshi rather than upstream OpenCode. Provider-specific behavioral instructions were otherwise preserved, and the `opencode-foundation` branch name remains only inside the fork's documentation URL. A focused regression test passes with 22 assertions, the opencode package typecheck is clean, and the combined root typecheck completes successfully across all workspace tasks.

**2026-10-02 — ACP and MCP client identity aligned with YukiOshi**
Updated ACP's displayed agent name, terminal-login label, and safe fallback errors, plus MCP dynamic OAuth registration's client name and project URL. The protocol-stable ACP auth method ID remains `opencode-login` for client compatibility. Focused ACP/MCP tests pass 57/57 (including real initialize metadata and fallback-error paths), and the opencode package typecheck is clean.

**2026-10-02 — Provider auth copy and V2 compatibility guidance corrected**
Rebranded DigitalOcean and Snowflake browser-login instructions as YukiOshi, and replaced a V2-permission diagnostic that told users to run the nonexistent `opencode2` binary with accurate V1-rule guidance for the current runtime. The focused config assertion passes, Snowflake provider tests pass 8/8, the obsolete executable name is absent, and the opencode package typecheck is clean.
**2026-10-02 — TUI crash screen, GitHub handler, and tips rebranded as YukiOshi**
Fixed user-facing branding in three files:
- `error-component.tsx`: crash headline, version footer, bug report URL (→ `ahmed-alxawad/YukiOshiCode`), version param, and auto-report description all say YukiOshi instead of OpenCode.
- `github.handler.ts`: bot username `yukioshi-agent[bot]`, workflow file `yukioshi.yml`, default mention triggers `/yukioshi,/oc`, inline workflow template (job name, action reference `ahmed-alxawad/YukiOshiCode/github@latest`, mention filters), GitHub App install URL, OIDC audience, session log labels, share link text, and agent prompt instructions.
- `tips-view.tsx`: GitHub mention tips updated from `/opencode` to `/yukioshi`.
Preserved: `opencode` provider IDs, `opencode.default` sound pack, `opencode.status`/`opencode.debug` keybind IDs, `opencode` theme name, `.opencode/themes/` config path, `opencode-plain-text` filetype ID, `opencode` trait owner, upstream social-card service URL.
Verification: `bunx tsgo --noEmit` passed for both `packages/tui` and `packages/opencode`; TUI tests 208/208 pass (1 skip); GitHub handler tests 33/33 pass.

**2026-10-02 — YukiOshi-native configuration names supported end to end**
Added first-class discovery for `yukioshi.json`, `yukioshi.jsonc`, and `.yukioshi/` across the core and application config loaders, TUI config migration, resource directories, and the default global config writer. Legacy `opencode.json`, `opencode.jsonc`, and `.opencode/` remain supported; at the same location their values load first so YukiOshi-named configuration wins. Updated the built-in customization skill and user documentation to recommend the current names while explaining compatibility.

Verification: core config and built-in-skill tests pass 16/16; focused opencode config tests pass 5/5; the complete TUI config file passes 34/34 with 3 Windows-only skips; `bunx tsgo --noEmit` is clean in both `packages/core` and `packages/opencode`; `git diff --check` is clean. One TUI plugin-alignment assertion failed during an intentionally parallel test run because another process shared its global test state, then passed in the isolated full-file rerun.

**2026-10-02 — YukiOshi-native indexing ignore paths made functional**
Closed a mismatch between the documented indexing behavior and the implementation: `.yukioshiignore` is now discovered at every repository level and applied after `.gitignore`, `.opencodeignore`, and `.kilocodeignore` at the same level, so the current YukiOshi file has final precedence while both migration formats remain supported. Local indexing-plugin paths under `.yukioshi/` are recognized, and generated `.yukioshi/worktrees/` content is excluded alongside legacy worktree roots.

Verification: focused detection/ignore/watcher tests pass 52/52 and the indexing package typecheck is clean. The broader `test/kilocode/indexing/` batch reports 499 pass, 9 intentional skips, and one environment-only failure where the sandbox rejects a local `Bun.serve` listener with `EPERM` in `manager.test.ts`; the failing test does not exercise the changed ignore paths.

**2026-10-02 — Remaining live TUI guidance and theme discovery aligned with YukiOshi**
Updated the TUI docs action, model-error guidance, custom-provider instructions, home tips, sidebar copy/logo, built-in sound-pack display name, and mode-stack diagnostic to use YukiOshi names. Stable compatibility IDs such as `opencode.default` and `opencode.status`, OpenCode Zen/Go provider branding, upstream sharing URLs, and the bundled `opencode` theme ID remain unchanged. Theme discovery now scans both `.opencode/themes/` and `.yukioshi/themes/` from repository root to the current directory, with nearer directories and YukiOshi names winning while global themes remain the lowest precedence.

Verification: focused TUI tests pass 22/22, the full bounded `packages/tui/test/` batch passes 211/211 with one existing skipped render case, and `bunx tsgo --noEmit` is clean in `packages/tui`.

**2026-10-02 — YukiOshi client namespace added without breaking compatibility**
Updated `@yukioshi/httpapi-codegen` so Promise and Effect client entrypoints export the generated client module as `YukiOshi`, with `OpenCode` retained as an alias to the same module. Regenerated `@yukioshi/client`, added `YukiOshiEvent` aliases alongside the existing event type names, and switched current documentation/examples to the branded namespace. Existing consumers do not need to migrate immediately.

Verification: HTTP API generator tests pass 60/60, Promise/Effect client tests pass 12/12, generation updates only the expected two index files, and `bunx tsgo --noEmit` is clean in both `packages/httpapi-codegen` and `packages/client`.

**2026-10-02 — Official YukiOshi web origin trusted by the local server**
Added `https://yukioshi.com` and its HTTPS subdomains to the server's built-in CORS allowlist, reflecting the official parent-brand domain while retaining `opencode.ai` compatibility. The matching remains strictly anchored so lookalike suffixes and plain-HTTP production origins are rejected; local development, desktop origins, explicit user allowlists, and same-host requests are unchanged.

Verification: focused CORS boundary tests pass 10/10 and `bunx tsgo --noEmit` is clean in `packages/server`.

**2026-10-02 — CLI and built-in skill guidance prefer current config names**
Updated both built-in `customize-opencode` registrations, CLI model errors, provider credential guidance, Amazon Bedrock setup text, and the workspace-debug README to lead with `yukioshi.json` and `.yukioshi/`, while explicitly retaining legacy `opencode.json`/`.opencode/` compatibility. The skill integration test now discovers its primary example from `.yukioshi/skill/`; existing tests continue to cover legacy `.opencode/skill/` discovery.

Verification: core skill tests pass 1/1, opencode CLI/skill tests pass 24/24, the isolated full skill file passes 18/18 after switching the primary discovery case, and both core and opencode package typechecks are clean.

**2026-10-02 — Official YukiOshi Code product logos added**
Added the project-owner-supplied wide light-background geometric snowflake wordmark and square dark-background snowflake/code emblem under `assets/brand/`, preserving both PNGs byte-for-byte. The repository README now presents the wide product wordmark. An asset note records that these are YukiOshi Code product marks, distinct from the parent-brand YukiOshi logos, and that future crops or icon variants should be separate derivatives rather than replacements.

Verification: copied source/destination SHA-256 hashes match for both originals; the stored files retain their supplied 1774×887 and 1254×1254 RGB PNG formats; `git diff --check` is clean.

**2026-10-02 — New project agents and plans use YukiOshi paths**
Changed project-scoped agent creation to write under `.yukioshi/agents/` and project plan files to `.yukioshi/plans/`. Both current and legacy plan directories remain explicitly writable by the constrained plan agent, so existing `.opencode/plans/` sessions remain compatible. Global and explicitly supplied agent paths are unchanged.

Verification: core agent tests pass 7/7; opencode agent tests pass 43/43; agent-path and session tests pass 10/10; `bunx tsgo --noEmit` is clean in both `packages/core` and `packages/opencode`; `git diff --check` is clean. A first parallel run exceeded Bun's default five-second timeout under shared load, while every isolated rerun passed.

**2026-10-02 — GitHub commit attribution consolidated under ahmed-alxawad**
Rewrote the independent `main` and `opencode-foundation` histories, plus the annotated `v0.2.0` tag, to remove 30 Claude co-author/session metadata pairs that caused GitHub to list a separate Claude contributor. Normalized the first two release commits from the owner's older Outlook identity to `Ahmed Alxawad <ahmed-alxawad@users.noreply.github.com>`. References to Claude Code as a product or compatibility target were deliberately preserved.

Verification: all 74 commits reachable from the two project branches now use the `ahmed-alxawad` noreply identity and contain no Claude co-author/session trailers; both rewritten branch tip tree hashes exactly match their pre-rewrite trees. A complete pre-rewrite recovery bundle is stored at `/tmp/yukioshi-before-attribution-rewrite-20261002.bundle`.

**2026-10-02 — Plugin installation writes YukiOshi-native project paths**
Changed local plugin installation to create `.yukioshi/yukioshi.jsonc` and `.yukioshi/tui.jsonc` by default, with current configuration preferred when current and legacy files both exist. Projects that only have `.opencode` plugin configuration continue to be updated in place. Local TUI theme installation now follows the originating `.yukioshi` or `.opencode` config directory and otherwise defaults to `.yukioshi/themes`; global scope remains unchanged.

Verification: plugin installer and cross-process concurrency tests pass 25/25; TUI plugin install/loader tests pass 17/17; `bunx tsgo --noEmit` is clean in `packages/opencode`; `git diff --check` is clean.

**2026-10-02 — MCP configuration writes and discovers YukiOshi paths correctly**
Corrected `yukioshi mcp add` to default to comment-preserving `yukioshi.jsonc`, prefer JSONC over JSON, and update existing `opencode.json(c)` files or `.opencode` project directories when those are the only configuration present. Updated the subprocess integration tests to assert the actual YukiOshi global path and removed their unnecessary local LLM-server dependency, allowing them to run in network-restricted environments.

Verification: pure path-resolution and real CLI subprocess tests pass 5/5; `bunx tsgo --noEmit` is clean in `packages/opencode`; `git diff --check` is clean.

**2026-10-02 — Managed configuration supports YukiOshi-native enterprise paths**
Added `/etc/yukioshi`, `/Library/Application Support/yukioshi`, and `%ProgramData%\\yukioshi` as the preferred managed-config directories while retaining their OpenCode predecessors at lower precedence. Managed loading now recognizes both `yukioshi.json(c)` and `opencode.json(c)`, with current names winning. macOS MDM lookup accepts `com.yukioshi.managed` first and retains `ai.opencode.managed` as a migration fallback.

Verification: focused managed configuration, precedence, platform-path, and MDM-domain tests pass 7/7; `bunx tsgo --noEmit` is clean in `packages/opencode`; `git diff --check` is clean.

**2026-10-02 — Repository project IDs use a YukiOshi cache marker**
Changed new repository-local project ID persistence from `.git/opencode` to `.git/yukioshi`, including common Git directories used by linked worktrees and bare repositories. Resolution reads `.git/yukioshi` first and falls back to `.git/opencode`, preserving stable IDs for existing repositories; resolving alone still performs no write.

Verification: core project resolution/cache tests pass 12/12; application project/worktree/bare-repository tests pass 36/36; `bunx tsgo --noEmit` is clean in both `packages/core` and `packages/opencode`; `git diff --check` is clean.

**2026-10-02 — Public SDKs expose YukiOshi names and embedded databases rebuild safely**
Added `createYukiOshi`, `createYukiOshiClient`, `createYukiOshiServer`, `createYukiOshiTui`, `YukiOshiClient`, and `YukiOshiClientConfig` to both JavaScript SDK generations, retaining all existing OpenCode spellings as aliases. SDK Next now exports a first-class `YukiOshi` namespace and `YukiOshiEvent` type alongside compatibility names. During full embedded verification, fixed `Database.node` so its configured path is resolved whenever a runtime layer is built rather than frozen at module import; this prevents a closed or removed database path from leaking into later embedded hosts.

Verification: JavaScript SDK tests pass 2/2; full SDK Next tests pass 6/6, including the real embedded router/service layer; the database path lifecycle regression test passes 1/1; typechecks are clean in `packages/sdk/js`, `packages/sdk-next`, `packages/core`, and `packages/opencode`; `git diff --check` is clean.

**2026-10-02 — Plugin and daemon surfaces consume YukiOshi SDK names**
Updated the public plugin input/TUI client types, application plugin host, and daemon service to use the newly first-class YukiOshi SDK constructor and client names. Compatibility exports remain available for external consumers. Updated the application-tool registration guidance to lead with the `YukiOshi` SDK namespace and explicitly identify `OpenCode` as an alias.

Verification: typechecks are clean in `packages/plugin`, `packages/cli`, and `packages/opencode`; the plugin declaration build completes successfully; `git diff --check` is clean.

**2026-10-02 — Public event-manifest regression expectations repaired**
Updated the schema package's public-event inventory test to reflect the already-exported permission-mode and session-revert events: 59 server definitions, 89 total/latest definitions, and 35 durable definitions. Replaced a brittle absolute array offset with an identity-based lookup while retaining the ordering assertion for the legacy session tail.

Verification: all schema tests pass 18/18 and `bunx tsgo --noEmit` is clean in `packages/schema`.

**2026-10-02 — Permission confirmation-copy tests aligned with YukiOshi**
Updated the two stale CLI assertions for wildcard and explicit always-allow patterns to expect the already-renamed YukiOshi restart message. This was the only branding assertion failure found in the bounded CLI sweep that did not depend on a sandbox-denied listener or subprocess.

Verification: the focused permission-copy test passes 5/5.

**2026-10-02 — Plugin npm-protocol fixtures use the current namespace**
Corrected two parser fixtures whose expected target had been renamed to `@yukioshi/acme` while their input still named `@opencode/acme`. The cases now consistently exercise current YukiOshi scoped npm aliases; parser behavior remains generic and unchanged.

Verification: the focused plugin-specifier test passes 12/12.

**2026-10-02 — Notification-hook test no longer races partial marker writes**
Changed the permission integration test to wait for complete parseable hook JSON instead of treating file creation as write completion, and renamed its temporary marker to YukiOshi. This removes a real timing race where the shell creates the output file before `cat` has consumed and flushed the hook payload.

Verification: `packages/opencode` typecheck is clean. In the restricted Codex sandbox, 88/89 tests in the focused file pass; the hook case now reaches its explicit timeout because the sandbox blocks child-process stdin (the same pre-existing restriction independently reproduced by AppProcess/cross-spawn tests), rather than failing on partial JSON.

**2026-10-02 — OpenCode Zen credential fallback collision fixed**
Restored `OPENCODE_API_KEY` as OpenCode Zen's provider-specific first credential source, followed by the shared `YUKIOSHI_API_KEY`. The atomic branding sweep had accidentally changed both entries to `YUKIOSHI_API_KEY`, so assigning a Zen key overwrote OmniRoute's shared YukiOshi key in the same process. Documentation already described the correct provider-specific chain.

Verification: focused precedence and fallback tests pass 2/2, including the shared-key fallback, and `packages/opencode` typecheck is clean.

**2026-10-02 — Server branding assertions aligned with YukiOshi runtime names**
Updated the mDNS publication and experimental worktree-branch test fixtures to expect `yukioshi-<port>` and `yukioshi/api-test`, matching the current runtime. Compatibility-oriented `opencode` protocol/header identifiers in neighboring tests remain unchanged.

Verification: focused mDNS tests pass 3/3 and experimental HTTP API tests pass 5/5.

**2026-10-02 — Standalone session graphs bind InstanceBootstrap explicitly**
Added the shared no-op `InstanceBootstrap` replacement to two standalone session integration-test graphs that transitively include `InstanceStore`. This closes the known LayerNode compile-time gap and lets the snapshot-race and structured-output tests execute their bodies instead of failing before setup.

Verification: snapshot-race passes 1/1, structured-output integration passes 1/1 with 4 intentional API-key skips, and both `packages/core` and `packages/opencode` typechecks are clean.

**2026-10-02 — Session-suite failures isolated and classified**
The isolated Cerebras replay failure was a stale test expectation, not a runtime defect: the actual OpenAI-compatible request correctly emits `reasoning_content: "thinking"`, while the test expected a non-existent `reasoning` field. Updated the assertion to match the protocol field and explicitly guard against the wrong field. The MCP-instructions test's hanging mock response was also removed: the test verifies prompt construction, so a completed local response is sufficient and avoids an existing AI SDK/test-harness interaction that prevented request observation.

Verification: the focused Cerebras replay test passes; the MCP-instructions test passes deterministically with its local response; both `packages/core` and `packages/opencode` typechecks are clean.

**2026-10-02 — Console compatibility headers and YukiOshi TUI wordmark**
Restored the upstream `x-opencode-*` wire headers alongside the existing parent-session header so the OpenCode Console provider receives the session, request, client, and project metadata it requires. These are protocol compatibility headers, not visible product branding. Replaced the TUI's duplicated OpenCode ASCII wordmark with the YukiOshi Code wordmark and added regression coverage.

Verification: the OpenCode-provider header integration test passes, the TUI presentation test passes, and both `packages/opencode` and `packages/tui` typechecks pass. The Console service may still reject free-tier requests from a forked harness by policy; paid/service-account access and other providers remain supported.

**2026-10-02 — Provider identities, OAuth composition, and terminal emblem corrected**
Removed the OmniRoute preset and its documentation. Split the Console catalog cleanly: the native provider is displayed as **OpenCode** and exclusively owns zero-cost models, while the `opencode-zen` alias is displayed as **OpenCode Zen** and contains paid models only. Added a real local-server round trip through a zero-cost `opencode` model and retained the Google AI Studio round trip. OpenCode's upstream service still restricts its free tier to the official client; YukiOshi keeps its identity transparent rather than spoofing that gate.

Provider auth now composes distinct methods registered by multiple plugins instead of allowing the last plugin to hide all earlier methods. This preserves built-in Codex browser/headless OAuth and allows an explicitly configured Antigravity Google OAuth plugin to coexist with other Google credentials. Callback state is isolated by provider and method, and successful credentials honor the plugin's returned provider. The TUI wordmark now renders a cyan snowflake/code emblem derived from the owner-supplied product mark; raster-capable surfaces continue to use the exact PNG in `assets/brand/`.

Verification: provider/preset/server tests pass 109/109; Codex and multi-plugin OAuth tests pass 60/60; TUI presentation passes 1/1; the repository-wide Turbo typecheck passes all 22 package tasks; targeted lint reports zero errors; and `git diff --check` is clean. One integration test exceeded Bun's five-second default only during a concurrent CPU-heavy run, then passed alone; its explicit timeout is now 30 seconds and the final sequential 109-test batch is clean.

**2026-10-02 — Interactive provider waits bounded and provider pickers curated**
Reduced the five-minute provider header/chunk waits to interactive defaults of 15 seconds for response headers and 30 seconds between streamed chunks. Transient failures now receive at most two retries with a 10-second delay cap, and sustained capacity errors provide actionable guidance to change model or provider. Repository-wide post-turn verification is now opt-in with `--verify`, preventing short prompts from automatically launching heavyweight test/lint/typecheck commands.

Restricted both TUI and CLI connection pickers to Claude, Codex, Antigravity/Google, Grok, OpenRouter, AgentRouter, OpenCode, Abacus, Kimi, Moonshot, Z.AI/GLM, and NVIDIA NIM, and removed the synthetic Other/custom credential option. The provider HTTP payload now omits the unused models.dev catalog while retaining explicitly configured local/OpenAI-compatible endpoints for backward compatibility. Regenerated the OpenAPI and JavaScript SDK timeout descriptions and documented the policy and override controls.

Verification: 130 focused tests pass with one intentional skip across provider HTTP, timeout, retry, session processor, CLI verification, CLI/TUI provider picker, and argument parsing coverage. `bunx tsgo --noEmit` passes in `packages/core`, `packages/opencode`, `packages/tui`, and `packages/sdk/js`; the SDK generator/build succeeds; targeted lint reports zero errors; formatting and `git diff --check` are clean.

**2026-10-02 — Nightmare/disaster review hardened critical runtime boundaries**
Ran the supplied Nightmare, Disaster, and Bugfix workflows against startup, provider discovery/authentication, model loading, agent requests, skills, and post-turn verification. Fixed current-turn change attribution (including multi-step tool turns), process-tree cleanup after verification timeouts, quoted verification overrides, first-run offline catalog startup, network-blocked provider login, catalog-controlled provider-package loading, and skill symlink escapes. Ordinary `yukioshi run` again leaves stdout unchanged unless verification is explicitly requested. The isolated CLI fixture now pins `PWD` to its temporary project, preventing test activity from leaking into the shared checkout.

Remote catalog adapters are restricted to reviewed packages while explicit local provider configuration remains available. Two architectural policies remain proposed rather than silently imposed: file/package-aware verification scope and a persisted trust gate for executable project hooks/plugins. Realpath containment is complete for project skills; whether project skills may shadow built-ins remains an explicit product decision. Findings, evidence, outcomes, and open items are recorded in `YukiOshiCode.nightmare.md`, `YukiOshiCode.disaster.md`, and `YukiOshiCode.bugfix.md`.

Verification: core models/verification tests pass 30/30; the focused opencode critical-path batch passes 105/105; the full provider suite passes 106/106; the full non-interactive CLI subprocess suite passes 13/13; TUI verification/keymap tests pass 11/11. The real tool-modifying CLI round trip reports `VERIFIED`, the timeout test proves descendants cannot write after cleanup, and the symlink test uses a directly matched `SKILL.md` file link. `bunx tsgo --noEmit` is clean in both `packages/core` and `packages/opencode`; formatting and `git diff --check` are clean. A concurrent unknown-model timing check exceeded its exact 15-second test deadline under shared load, then passed alone in 3.0 seconds and passed in the final 13-test sequential file run.
