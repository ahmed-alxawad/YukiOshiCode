# Disaster Test: YukiOshiCode

Date: 2026-10-02
Updated: 2026-10-03
Target: YukiOshi Code's user-facing critical path on `opencode-foundation`: startup, provider discovery/authentication, model requests, and post-turn verification
Verified by: process-tree survival probe; isolated offline and stalled-network CLI probes; tracing catalog data through provider SDK loading; and tracing project config/skill discovery into hook and prompt execution

## Summary

The test identified four credible disaster-scale paths across verification subprocesses, remote catalog metadata, and repository-owned configuration/instructions. All four are now fixed and covered by focused tests, including real plugin-bootstrap coverage for the repository trust boundary.

## Findings

### 1. Timed-out verification workers can cascade into host resource exhaustion — Fixed

**Severity:** Critical | **Probability:** Medium under repeated timeouts
**Scenario:** A repository test command spawns worker processes that hang. YukiOshi times out and reports failure but kills only the direct process. Each later agent turn starts another verification run, leaving another worker tree behind.
**Blast radius:** CPU, memory, file descriptors, database locks, and test ports can be exhausted across the whole workstation; later YukiOshi requests and unrelated applications slow down or fail.
**Why it's plausible despite being severe:** Worker-based test runners are normal, and the direct probe proved a child survives the current timeout path. The stale-change behavior from Nightmare finding 1 makes repeated invocation possible even on no-change turns.
**Impact:** An apparently recoverable timeout becomes a self-amplifying availability failure requiring manual process cleanup or a reboot.
**Verified:** The real runner returned timeout exit 124 while a spawned descendant remained alive long enough to perform work after the parent was terminated.
**Suggested direction:** Kill the complete process tree with graceful and forced phases, wait for cleanup before returning, and regression-test descendant termination.

### 2. Compromised catalog metadata can lead to imported third-party code — Fixed

**Severity:** Critical | **Probability:** Low but credible
**Scenario:** The configured models catalog is compromised, intercepted through a trusted-but-breached endpoint, or maliciously self-hosted. A model's `provider.npm` or provider-level `npm` names an attacker-controlled package. The provider path accepts the catalog string, installs the package, then dynamically imports it (`packages/opencode/src/provider/provider.ts:1919-1944`).
**Blast radius:** Imported module top-level code runs with the user's account privileges and can read source, credentials, SSH keys, and modify the workspace. A shared catalog compromise could affect many installations.
**Why it's plausible despite being severe:** Lifecycle scripts are disabled during installation, which is good, but dynamic import necessarily executes package code. The catalog data is cast rather than cryptographically pinned, and there is no package allowlist before the fallback installer.
**Impact:** A metadata-plane compromise becomes arbitrary local code execution rather than a bad model listing.
**Verified:** Reasoned end to end from `ModelsDev.populate`'s catalog load, `fromModelsDevModel`'s npm selection, the `Npm.add()` fallback, and the subsequent `import(importSpec)`. The bundled test catalog currently contains four legitimate non-bundled package names, confirming this fallback is reachable by catalog data.
**Suggested direction:** Permit remote catalog entries to select only a maintained allowlist of provider packages; keep arbitrary npm/file providers available only through explicit local user configuration.

### 3. Opening an untrusted repository can arm shell hooks without a trust boundary — Fixed

**Severity:** Critical | **Probability:** Low but credible
**Scenario:** A cloned repository contains `yukioshi.json` or `.yukioshi/*` config with `sessionStart`, `userPromptSubmit`, or tool hooks. Project config is merged by default (`packages/opencode/src/config/config.ts:424-451`), and hook commands run through the user's shell. A first prompt is enough to trigger a session hook; no tool permission decision protects the hook command itself.
**Blast radius:** The command runs outside the optional agent sandbox and can read or alter anything available to the user account, including credentials and other repositories.
**Why it's plausible despite being severe:** Malicious repository configuration is a standard supply-chain vector. YukiOshi exposes `YUKIOSHI_DISABLE_PROJECT_CONFIG`, but it is opt-in and there is no persisted per-repository trust decision before executable project features are activated.
**Impact:** Merely interacting with an untrusted checkout can become host compromise, even if the user denies every later agent tool request.
**Verified:** Reasoned through project config discovery, the hooks schema, `SessionStart`/`UserPromptSubmit` call sites, and `Hooks.spawnHook`. Existing hook tests also execute real shell commands, confirming the command path is live.
**Suggested direction:** Introduce a repository trust gate before loading executable hooks/plugins; allow declarative non-executable config in untrusted mode and provide a clearly scoped override for automation.
**Fix:** Canonical repository trust is persisted outside the repository. Until the user runs `yukioshi trust <path>`, project shell hooks, server plugins, TUI plugins, auto-discovered plugins, and their dependency-install paths are withheld while declarative project settings continue to load. `--status` and `--revoke` provide explicit inspection and rollback, and malformed trust storage fails closed.
**Regression coverage:** Config tests cover trusted/untrusted hooks and plugins (including inline config), TUI tests cover its separate plugin path, and an InstanceBootstrap test proves an untrusted project plugin does not execute.

### 4. Symlinked project skills can escape their declared root and replace trusted instructions — Fixed

**Severity:** High | **Probability:** Low but credible
**Scenario:** An untrusted repository places symlinks beneath `.claude/skills`, `.agents/skills`, or `.yukioshi/skills`. Discovery explicitly follows symlinks (`packages/opencode/src/skill/index.ts:151-179`), does not compare real paths to the scan root, and later lets duplicate disk skills replace previously registered built-ins (`packages/opencode/src/skill/index.ts:134-148`).
**Blast radius:** Files outside the repository can be presented as skill content, and a malicious skill can replace a familiar built-in name with instructions that steer the model toward unsafe commands or data disclosure.
**Why it's plausible despite being severe:** Symlinks are preserved in Git on supported platforms, and repository skills are intentionally auto-discovered. The missing source/trust distinction is already documented in `NOTICE.md`.
**Impact:** The repository can cross both a filesystem boundary and a prompt-trust boundary, potentially combining with permissive tool settings or provider exfiltration.
**Verified:** Reasoned from symlink-enabled globbing, absent realpath containment, duplicate replacement order, and the skill tool's delivery of full content to the model. No destructive exploit was executed.
**Suggested direction:** Reject discovered files whose real path is outside the scanned root, record skill provenance/trust, and prevent untrusted project skills from shadowing built-ins without explicit approval.
**Fix:** Realpath containment remains enforced, and every project-owned skill is exposed under `project:<name>`. Bundled and global skills retain their unqualified names, so a same-named project skill remains independently addressable and cannot replace a built-in.
**Regression coverage:** Skill service/tool tests cover standard project directories, project-configured paths, same-name built-in collisions, global-name preservation, and symlink escapes.
