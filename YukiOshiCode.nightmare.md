# Nightmare Test: YukiOshiCode

Date: 2026-10-02
Updated: 2026-10-03
Target: YukiOshi Code's user-facing critical path on `opencode-foundation`: startup, provider discovery/authentication, model requests, and post-turn verification
Lens: code and system — plausible everyday failures in an interactive coding agent
Verified by: clean core/opencode typechecks; direct Bun probes against the real verification runner; an isolated-cache offline CLI launch; a deliberately stalled local models endpoint; and inspection of the provider, config, skill, and hook paths

## Summary

The adversarial run found six believable operational failures. All six are now fixed and covered by focused regression tests. The two most disruptive were verification attributing old or unrelated files to the current turn and timed-out verification commands leaving descendants alive; together they closely matched reports of apparently idle turns consuming time and machine resources.

## Findings

### 1. A no-change turn can verify stale session edits or unrelated dirty files — Fixed

**Severity:** High | **Likelihood:** Likely
**Scenario:** A user sends a conversational prompt such as "hi" after an earlier editing turn, or starts YukiOshi in a worktree already containing unrelated changes. The current assistant message has no edits, so `detectTurnChangedFiles()` falls back first to every message in the session and then to the entire `git status` of the workspace (`packages/core/src/verification/runner.ts:212-243`).
**Why it's realistic:** Long-lived sessions and pre-dirty worktrees are normal coding workflows, and the fallback is entered whenever the current response carries no patch/write evidence.
**Impact:** YukiOshi displays "Verifying changes..." and can launch expensive checks even though the current turn changed nothing. Old files can be re-verified repeatedly, adding latency and CPU use and producing misleading completion evidence.
**Verified:** A direct call with an empty current message and one historical diff returned `old-change.ts`. A second call with an empty current message in this worktree returned the unrelated coordination edit `edits.md`.
**Suggested direction:** Scope message fallback to the current assistant message ID (or at most the latest assistant message), and do not use whole-worktree status when a concrete completed turn result is available but contains no edit evidence.

### 2. A timed-out verification command can keep its worker processes running — Fixed

**Severity:** High | **Likelihood:** Possible
**Scenario:** A test runner starts workers and then exceeds YukiOshi's verification timeout. `executeVerificationCommand()` sends `SIGTERM` only to the direct child and resolves immediately (`packages/core/src/verification/runner.ts:274-284`), leaving descendants outside its lifecycle.
**Why it's realistic:** Bun, Vitest, Jest, compilers, and package-manager scripts commonly spawn child processes. Timeouts are most likely precisely when one of those children is stuck.
**Impact:** The UI says the check timed out, but orphaned workers continue consuming CPU and memory. Repeated turns can make both YukiOshi and the computer progressively slower.
**Verified:** A probe launched a verification parent that spawned a delayed child. The runner returned exit 124 after 108 ms, yet the child survived and wrote its marker afterward.
**Suggested direction:** Run verification in an isolated process group where supported, terminate the whole tree on timeout, wait a short grace period, then force-kill remaining processes before resolving.

### 3. Quoted verification overrides are split into invalid arguments — Fixed

**Severity:** Medium | **Likelihood:** Likely
**Scenario:** A user sets `YUKIOSHI_VERIFY_COMMAND='node -e "process.stdout.write(\"hello world\")"'` or any command containing a quoted path or argument. The implementation uses `trim().split(/\s+/)` for all four override variables (`packages/core/src/verification/runner.ts:27-67`).
**Why it's realistic:** Spaces and quoted expressions are routine in custom test commands, especially `node -e`, paths under user directories, and test-name filters.
**Impact:** A valid command is silently transformed into invalid argv and reported as a failed verification, undermining completion status and confusing users because the same command works in their shell.
**Verified:** Discovery produced arguments split at `hello world`; executing the discovered command failed with `Unterminated string constant`.
**Suggested direction:** Parse override strings with a small cross-platform argv tokenizer, retaining shell-free execution, and reject malformed quotes with a clear diagnostic.

### 4. First-run offline startup fails before configured local providers can be used — Fixed

**Severity:** High | **Likelihood:** Possible
**Scenario:** A source/dev build has no bundled catalog and no cache, and the models endpoint is offline. `ModelsDev.populate` has no last-resort fallback after its initial fetch and converts the failure into a defect (`packages/core/src/models-dev.ts:217-231`).
**Why it's realistic:** First launch on a plane, behind a firewall, during a catalog outage, or with a self-hosted `YUKIOSHI_MODELS_URL` is routine. A user may already have a complete local Ollama/LM Studio provider configuration that does not need the catalog.
**Impact:** Provider/model commands and application startup fail with a transport error; unrelated locally configured providers become unavailable because one remote catalog is unreachable.
**Verified:** With a fresh isolated cache and `YUKIOSHI_MODELS_URL=http://127.0.0.1:9`, the real CLI `models` command exited 1 with `Transport error`, rather than loading an empty catalog.
**Suggested direction:** Log the initial fetch failure and return an empty catalog when neither disk nor bundled data exists, allowing explicit provider configuration to continue working.

### 5. Provider login blocks on a forced catalog refresh even when cached data is ready — Fixed

**Severity:** Medium | **Likelihood:** Likely
**Scenario:** A user runs `yukioshi auth login --provider openai` while the models endpoint is slow. The login handler unconditionally awaits `modelsDev.refresh(true)` before reading the already available catalog (`packages/opencode/src/cli/cmd/providers.ts:387-397`).
**Why it's realistic:** Authentication is often attempted while diagnosing connectivity, and the service already performs periodic background refreshes.
**Impact:** The credential prompt appears frozen for up to the network timeout. The user cannot add or repair credentials even though cached provider metadata is sufficient.
**Verified:** Against a local endpoint that accepted the connection but never responded, the real login command printed only `Add credential` and was still blocked when killed after 13 seconds, despite a valid catalog fixture on disk.
**Suggested direction:** Use cached data immediately and let the existing background refresh update it; reserve a forced refresh for an explicit refresh command.

### 6. One documentation edit schedules the same whole-project checks as a source edit — Fixed

**Severity:** Medium | **Likelihood:** Possible
**Scenario:** Verification is enabled in a monorepo and the turn edits only `README.md`. Command discovery finds root `typecheck`, `lint`, and `test` scripts, while planning does not use file type or package ownership to narrow behavioral checks.
**Why it's realistic:** Documentation-only turns are common, and root scripts in large repositories frequently traverse every workspace.
**Impact:** A trivial prose change can trigger the entire monorepo's typecheck, lint, and test suite serially, making completion appear hung and consuming substantial CPU.
**Verified:** Running the real discovery/planning functions at this repository root planned `bun run typecheck`, `bun run lint`, and `bun run test` for both `README.md` and a TypeScript source file.
**Suggested direction:** Add conservative file-aware planning (for example, syntax/link checks for prose and package-scoped commands when ownership is unambiguous), with an opt-in full-suite mode for release confidence.
**Fix:** Verification planning now schedules discovered `typecheck`, `lint`, and `test` commands only when at least one recognized source file changed. Documentation/configuration-only turns retain applicable JSON syntax and editor-diagnostic checks. Mixed turns and deleted source files still trigger project commands.
**Regression coverage:** Core verification tests cover documentation-only edits, mixed documentation/source edits, deleted source files, and JSON-only configuration changes.

## Flagged for disaster test

- Repeated verification timeouts can accumulate orphaned worker trees until the host is resource-starved.
- The remote model catalog can select an npm package that is installed and dynamically imported.
- Project-local configuration can register executable hooks without a repository trust boundary.
- Project skill discovery follows symlinks and permits project skills to replace trusted built-ins.
