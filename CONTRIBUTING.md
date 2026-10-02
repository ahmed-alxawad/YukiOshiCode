# Contributing

Thanks for helping improve YukiOshi Code.

## Setup

```bash
bun install
bun run dev          # run the CLI from source
bun run typecheck
```

Bun 1.3 or newer is required. The version used in CI is pinned in the root
`package.json` (`packageManager`).

## Making a change

- Keep pull requests focused on one change, and explain what it fixes and how
  you checked it.
- Run `bun run typecheck` and the tests of the packages you touched, from
  that package's directory (for example `cd packages/opencode && bun test test/tool`).
  The root `bun test` deliberately refuses to run the whole monorepo at once.
- Add or update tests for behaviour changes, and update `README.md` or
  `docs/` when user-facing behaviour changes.
- Follow the style of the surrounding code. Services are written with
  Effect-TS and wired together with `LayerNode`.
- Never commit API keys or other secrets, including in tests and fixtures.

## Reporting bugs

Open an issue with your `yukioshi --version`, OS, the command you ran, and
what happened. For security problems, follow [SECURITY.md](SECURITY.md)
instead.
