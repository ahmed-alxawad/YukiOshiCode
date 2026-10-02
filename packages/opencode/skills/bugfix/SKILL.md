---
name: bugfix
description: Works through a findings report (from the nightmare or disaster skills, a code review, or an issue list) and fixes the problems one at a time with tests and verification. Use when asked to fix the findings, fix the bugs from the review, or run /bugfix after a nightmare or disaster test.
argument-hint: '[report path or finding IDs, e.g. N1 N3]'
---

# Bugfix

Turn findings into verified fixes. One finding at a time, smallest safe change,
proof that it works.

## 1. Collect the findings

- Use the report the user names; otherwise the newest file in `docs/reviews/`
  (or the project's review folder) whose findings have `Status: open`.
- List the open findings with ID, severity, and a one-line summary, then fix in
  order: critical → high → medium → low. Ask before large or risky changes.

## 2. For each finding

1. **Reproduce.** Write a failing test that shows the problem (or explain why a
   test is impossible and how you confirmed it instead). Run it and see it fail.
2. **Fix.** Make the smallest change that removes the cause, not just the
   symptom. Keep unrelated refactors out.
3. **Verify.** Run the new test and the related suite; run the project's
   typecheck and lint when they exist. Show the command output.
4. **Check the neighborhood.** Look for the same mistake elsewhere and fix or
   list those places.
5. **Record.** Update the finding in the report:
   `Status: fixed in <files> — test: <test name>` or
   `Status: won't fix — <reason>` or `Status: needs decision — <question>`.

Never mark a finding fixed without evidence from a tool result.

## 3. Finish

Summarize what was fixed (with the tests that prove it), what remains open and
why, and anything that needs a human decision. If a fix changed behavior users
can see, mention it for the changelog.
