# Kothora edition

Kothora is a distribution of this codebase: the same CLI, built as a
gateway-only client. A build/packaging setting switches the edition ON; with
the edition OFF (the default) this repository behaves exactly like YukiOshi,
byte for byte.

## What the edition switches

| Capability      | Edition off (YukiOshi)              | Edition on (Kothora)                          |
| --------------- | ----------------------------------- | --------------------------------------------- |
| `kothora` CLI   | absent                              | present, same entry point as `yukioshi`        |
| Providers       | all configured providers            | only the `kothora` provider (gateway-only models) |
| Bring-your-own-key | available                        | switched OFF (no API-key login surface)       |
| Sign-in         | per-provider methods                | device-code sign-in via the kothora auth plugin |
| Rule files      | `AGENTS.md`                         | `AGENTS.md` plus `KOTHORA.md`                 |

## The switch

The edition is driven by a single environment variable:

```
KOTHORA_EDITION=1   # also accepts "true"
```

- `packages/opencode/src/kothora/edition.ts` reads it (`isKothoraEdition()`)
  and exposes `filterProvidersForEdition()`, applied at the two provider
  surfaces: the runtime provider resolution (`Provider.list` and friends, via
  `isProviderAllowed` in `packages/opencode/src/provider/provider.ts`) and the
  login picker (`providerLoginOptions` in
  `packages/opencode/src/cli/cmd/providers.ts`).
- `packages/opencode/bin/kothora` sets `KOTHORA_EDITION=1` in the child
  environment and execs the same platform binary entry as `bin/yukioshi`, so
  installing the package exposes both commands.

## KOTHORA.md

The agent reads `KOTHORA.md` alongside `AGENTS.md` (and the global config
copies of both) with identical precedence: upward discovery from the working
directory to the project root, then the global config directory. A missing
`KOTHORA.md` changes nothing; when present, its instructions are loaded into
the same ambient instruction context as `AGENTS.md` (see
`packages/core/src/instruction-context.ts`).

## Models

After device sign-in the `kothora` provider's model catalog comes from the
Kothora gateway, not from a static list. The kothora auth plugin fetches
`{base}/code/v1/models` with the device access token and maps the gateway's
three tiers — `fast`, `balanced`, `expert` — into model entries whose
completions go to the OpenAI-compatible `{base}/code/v1/chat/completions`,
authenticated by the same token. Tiers the gateway marks unavailable are left
out of the picker, and a failed catalog fetch falls back to the provider's
existing catalog rather than breaking model selection
(`packages/opencode/src/plugin/kothora.ts`).

## Learn mode and answer languages

Two config options change how the agent talks, not what it may do. Both are off by default: unset,
the system prompt is exactly what it was before (edition-off is a no-op). They work in every answer
mode and every agent, and code, identifiers and commit messages stay English in all of them.

- `learning.mode: "teach"` — Learn mode for students. The system prompt gains a teaching
  directive: explain what you are doing and why, one step at a time, check understanding before
  large changes, never present unexplained code. `"off"` or unset is the default.
- `answers.language: english | bangla | mixed | auto` — the language of explanations:
  `bangla` writes them in Bangla in the polite আপনি form, `mixed` keeps English technical terms
  inline in Bangla prose, `auto` matches the user's latest message (Bengali script U+0980–U+09FF
  switches to Bangla), and `english` (the default) adds no behaviour beyond an explicit directive.

Both are wired as directives appended to the assembled system prompt
(`packages/opencode/src/session/kothora-prompts.ts`, applied in
`packages/opencode/src/session/prompt.ts`). The built-in `bangla-interface` skill keeps the Bangla
explanations correct and polite (register, which terms stay English, worked examples). The
freelancer pack skill from the build plan is intentionally omitted pending its contents.

## Repository hygiene

No secrets and no private URLs belong in this repository. The Kothora edition
must not embed credentials or internal endpoints; anything environment-specific
is supplied by the kothora auth plugin or the environment at runtime, never
committed here.
