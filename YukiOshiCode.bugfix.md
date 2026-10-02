# Bugfix: YukiOshiCode

Source report(s): `YukiOshiCode.nightmare.md`, `YukiOshiCode.disaster.md`
Date: 2026-10-02
Updated: 2026-10-03
Mode: mixed

## Results

1. A no-change turn can verify stale session edits or unrelated dirty files — **Fixed**
   Changed-file detection now scopes message inspection and snapshot retries to the current user/assistant turn and uses whole-worktree status only when no concrete turn result exists.
2. A timed-out verification command can keep its worker processes running — **Fixed**
   Verification commands now run in a POSIX process group, terminate the complete tree with graceful and forced phases, and use `taskkill /T /F` on Windows before reporting timeout completion.
3. Quoted verification overrides are split into invalid arguments — **Fixed**
   All `YUKIOSHI_VERIFY_*` command overrides now use a quote-aware, shell-free argv parser that rejects unterminated quotes.
4. First-run offline startup fails before configured local providers can be used — **Fixed**
   Models catalog loads validate JSON before caching and degrade to an empty catalog after an initial fetch failure, preserving explicitly configured providers.
5. Provider login blocks on a forced catalog refresh even when cached data is ready — **Fixed**
   Login no longer awaits a forced network refresh; it uses the cached/bundled catalog while the existing background refresh remains responsible for freshness.
6. One documentation edit schedules the same whole-project checks as a source edit — **Fixed**
   Project `typecheck`, `lint`, and `test` commands now require at least one source-file change. Documentation/configuration-only turns retain lightweight JSON syntax and editor-diagnostic checks; mixed turns and deleted source files still schedule project commands.
7. Timed-out verification workers can cascade into host resource exhaustion — **Fixed**
   Closed by the same process-tree lifecycle fix as Nightmare finding 2 and covered by a descendant-survival regression test.
8. Compromised catalog metadata can lead to imported third-party code — **Fixed**
   Remote catalog models may select only reviewed provider adapters. Arbitrary adapters remain available only through explicit local configuration.
9. Opening an untrusted repository can arm shell hooks without a trust boundary — **Fixed**
   A fail-closed trust store outside the repository now keys decisions by canonical repository root. `yukioshi trust [path]`, `--status`, and `--revoke` control trust explicitly. Untrusted project hooks and both server/TUI plugins are removed before runtime loading while declarative settings remain available.
10. Symlinked project skills can escape their declared root and replace trusted instructions — **Fixed**
    Discovery retains realpath containment and now records provenance. Project-owned skills—including project-configured paths and URLs—use `project:<name>`, so they cannot silently replace bundled skills; global and built-in names remain unchanged.

## Additional regression fixes uncovered during verification

- The isolated CLI fixture now pins `PWD` to its temporary project, preventing tests from indexing or writing into the shared checkout.
- Non-interactive `yukioshi run` no longer prints a misleading `SKIPPED_BY_USER` verification result when verification was never requested; `--verify` and explicit `--skip-verify` retain their intended behavior.
- The real multi-step CLI round trip now proves that an earlier tool step's patch reaches post-turn verification and produces `VERIFIED`.
- The repository trust review also closed the independent TUI-plugin loader and inline-config bypass paths rather than protecting only server plugins declared in the primary config.

## Files changed

- `packages/core/src/models-dev.ts`
- `packages/core/src/verification/runner.ts`
- `packages/core/src/verification/plan.ts`
- `packages/core/test/models.test.ts`
- `packages/core/test/verification.test.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/config/paths.ts`
- `packages/opencode/src/config/tui.ts`
- `packages/opencode/src/cli/cmd/trust.ts`
- `packages/opencode/src/cli/cmd/providers.ts`
- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/src/index.ts`
- `packages/opencode/src/project/trust.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/skill/index.ts`
- `packages/opencode/test/cli/trust.test.ts`
- `packages/opencode/test/cli/run-verification.test.ts`
- `packages/opencode/test/config/config.test.ts`
- `packages/opencode/test/config/project-trust.test.ts`
- `packages/opencode/test/config/tui.test.ts`
- `packages/opencode/test/fixture/fixture.ts`
- `packages/opencode/test/lib/cli-process.ts`
- `packages/opencode/test/lib/effect.ts`
- `packages/opencode/test/project/instance-bootstrap.test.ts`
- `packages/opencode/test/provider/provider.test.ts`
- `packages/opencode/test/skill/skill.test.ts`
- `packages/opencode/test/tool/skill.test.ts`
- `README.md`
- `YukiOshiCode.nightmare.md`
- `YukiOshiCode.disaster.md`
- `YukiOshiCode.bugfix.md`
- `history.md`
- `edits.md`

## Open items for a human

None from the Nightmare/Disaster reports remain unresolved. The three deferred policy choices were implemented according to the human decisions recorded on 2026-10-03.
