---
name: nightmare
description: Adversarial "nightmare test" of code, a plan, or a design — hunts for plausible, everyday ways it breaks (bad input, wrong assumptions, edge cases, races, missing error handling). Use when asked to stress-test, poke holes, find what could go wrong, or review something before it ships. Writes a findings report that the bugfix skill can work through.
argument-hint: '[file, folder, feature, or document to test]'
---

# Nightmare test

Find the realistic failures a careful reviewer would lose sleep over. Stay at
the level of things that plausibly happen in normal use; catastrophic,
cascading failures belong to the `disaster` skill.

## 1. Scope

- Name the target precisely (files, feature, or document) and its purpose.
- Read it fully before judging. Follow the code paths that handle input,
  state, I/O, errors, and permissions.
- List the assumptions the target makes (input shape, ordering, platform,
  network, file system, concurrency, configuration, user behavior).

## 2. Attack each assumption

Work through these lenses and write down only concrete, reproducible problems:

| Lens            | Questions                                                                         |
| --------------- | --------------------------------------------------------------------------------- |
| Input           | Empty, huge, malformed, Unicode, control characters, unexpected types, duplicates |
| Boundaries      | Off-by-one, limits, zero/negative, time zones, very old or future dates           |
| State           | Stale caches, partial writes, re-entrancy, restarts in the middle, retries        |
| Concurrency     | Two users, two processes, two tabs; lost updates; lock ordering                   |
| Errors          | Swallowed exceptions, misleading messages, missing cleanup, error loops           |
| Environment     | Windows paths, spaces, symlinks, read-only disks, slow or absent network          |
| Security basics | Injection, path traversal, secrets in logs, trust of external data                |
| Operations      | Upgrades, migrations, configuration typos, missing observability                  |

For code, prefer evidence: point to the exact line, and when you can, write or
describe a minimal reproduction (a failing test is best).

## 3. Rate every finding

- **Severity:** critical (data loss, security hole), high (wrong results or crash
  in normal use), medium (degraded behavior, confusing errors), low (polish).
- **Likelihood:** likely, possible, unlikely.
- **Confidence:** confirmed (reproduced or read directly in code) or suspected.

Drop anything you cannot tie to a concrete scenario.

## 4. Report

Write the report to `docs/reviews/<YYYY-MM-DD>-nightmare.md` (or the folder
the project already uses for reviews) and summarize it in your answer. Use
stable IDs so the `bugfix` skill can refer to them:

```markdown
# Nightmare test: <target> (<date>)

## Summary

<two or three sentences: overall risk and the top three problems>

## Findings

### N1 — <short title> · severity: high · likelihood: likely · confirmed

- **Where:** path/to/file.ts:42
- **Scenario:** <how it breaks, step by step>
- **Impact:** <what the user or system experiences>
- **Suggested fix:** <smallest change that removes the failure>
- **Status:** open
```

Order findings by severity, then likelihood. Do not fix anything during a
nightmare test unless the user asks; the report is the deliverable.
