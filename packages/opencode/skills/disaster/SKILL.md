---
name: disaster
description: Escalated "disaster test" that looks for catastrophic, cascading, or systemic failures — single points of failure, data loss, security breaches, and events that take everything down at once. Use when asked for the worst case, the real risks, blast radius, or after a nightmare test. Writes a findings report the bugfix skill can use.
argument-hint: '[system, component, or plan]'
---

# Disaster test

Think like an incident review written in advance. The question is not "can
this fail?" but "what failure ends the project, loses the data, or breaks
everything around it?"

## 1. Map the system

- Components, data stores, external services, credentials, and the people or
  processes that operate them.
- For each: what depends on it, and what it depends on.
- Where the irreplaceable things live: user data, keys, audit logs, backups.

## 2. Hunt for severity, not frequency

| Lens                     | Examples to test                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Single points of failure | One process, one disk, one region, one maintainer, one API key                               |
| Cascades                 | Retries that multiply load, timeouts that pile up, queues that never drain                   |
| Data loss and corruption | Crashes mid-write, bad migrations, silent truncation, backup that was never restored         |
| Security                 | Credential leaks, privilege escalation, supply-chain compromise, trust of repository content |
| Irreversible actions     | Deletes without undo, force pushes, destructive commands run automatically                   |
| Recovery                 | How long to detect, who notices, can it be restored, is there a runbook                      |
| Correlated failures      | Two "independent" safeguards that share a dependency                                         |

Combine failures: most disasters are two or three ordinary problems at once.
Write the chain explicitly (A fails → B retries → C runs out of memory → …).

## 3. Rate every finding

- **Blast radius:** contained, service-wide, all users, beyond this system.
- **Recoverability:** automatic, manual (hours), manual (days), impossible.
- **Likelihood:** plausible, rare, only under attack.
- **Detection:** immediate, delayed, silent.

## 4. Report

Write `docs/reviews/<YYYY-MM-DD>-disaster.md` (or the project's review folder)
and summarize the top risks in your answer:

```markdown
# Disaster test: <target> (<date>)

## Summary

<the one or two scenarios that matter most and why>

## Findings

### D1 — <short title> · blast radius: all users · recoverability: impossible · silent

- **Chain:** <step-by-step failure sequence>
- **Evidence:** path/to/file.ts:88, configuration, or design section
- **Mitigation:** <prevent>, <detect>, <recover>
- **Status:** open
```

Prioritize mitigations that turn silent, unrecoverable failures into loud,
recoverable ones. Do not change code during the test unless asked.
