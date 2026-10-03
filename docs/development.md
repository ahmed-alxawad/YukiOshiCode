# Development

YukiOshi Code is a [Bun](https://bun.sh) monorepo written in TypeScript. You
need Bun (the version in `package.json`'s `packageManager` field) and git.

## Running from source

```bash
bun install
bun run dev                 # opens the terminal UI in the current folder
```

`packages/opencode/bin/yukioshi-dev` runs the checkout from any folder and
opens that folder as the project. To use it as your `yukioshi` command:

```bash
ln -s "$(pwd)/packages/opencode/bin/yukioshi-dev" ~/.local/bin/yukioshi
```

## Layout

| Folder              | Contains                                               |
| ------------------- | ------------------------------------------------------ |
| `packages/opencode` | the `yukioshi` command, agent loop, tools, providers, built-in skills |
| `packages/tui`      | the terminal UI, themes, and logo                      |
| `packages/core`     | configuration, permissions, guards, provider catalog, storage |
| `packages/plugin`   | the plugin and auth-hook API                           |
| `packages/sdk`      | the client SDK                                         |
| `packages/sandbox`  | the OS-level sandbox                                   |

## Checks

Tests run per package, never from the repository root:

```bash
bun run typecheck                       # every package
cd packages/opencode && bun test        # one package
cd packages/opencode && bun test test/plugin/google.test.ts
```

The pre-push hook runs the typecheck, so keep `~/.bun/bin` on your `PATH`.
Pull requests and pushes to `main` run typecheck, build, and the test suites
in CI.

## Building

```bash
cd packages/opencode
bun run build --single      # only the binary for this machine
bun run build               # every platform
```

Binaries are written to `packages/opencode/dist/yukioshi-<os>-<arch>/bin/`.

## Releasing

Pushing a tag such as `v0.3.2` starts the release workflow: it builds every
platform, writes `SHA256SUMS`, checks the binaries on macOS, Windows, Linux
ARM, and Alpine, publishes the release, and then tests the installers against
it. To rebuild an existing tag, run the workflow by hand with that tag.

## Logo

The terminal logo in `packages/tui/src/logo-art.ts` is generated from the
files in `assets/brand/`. After changing them, run:

```bash
python3 packages/tui/script/generate-logo.py   # needs Pillow
```
