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

## Repository hygiene

No secrets and no private URLs belong in this repository. The Kothora edition
must not embed credentials or internal endpoints; anything environment-specific
is supplied by the kothora auth plugin or the environment at runtime, never
committed here.
