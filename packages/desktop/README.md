# Kothora desktop

Electron shell for Kothora Chat and the local Kothora Code agent. The renderer receives only a
narrow, validated preload API; it has no Node.js access. No Kothora server URL, token, code,
prompt, or crash payload is committed or sent by this package.

The local Code area always starts. Set `KOTHORA_WEB_URL` to the public HTTPS Kothora web app
to enable the isolated Chat area; it receives no preload bridge and cannot access local files.
Set `KOTHORA_CRASH_REPORT_URL` to a public HTTPS collector to enable anonymous crash reports.
Reports contain only app version, platform, architecture and a sanitized error class—never an
exception message, stack, source code, prompt or workspace path. Updates remain off unless
`KOTHORA_AUTO_UPDATE_URL` is configured by the release environment.

## Development

```sh
bun install --frozen-lockfile
bun run --cwd packages/desktop typecheck
bun run --cwd packages/desktop test
bun run --cwd packages/desktop build
```

Packaging uses `electron-builder`. Signing, notarisation and update publishing are enabled only
by release credentials supplied outside the repository.

## Bundled terminal installer

`script/terminal-installer/index.ts` builds a deterministic local installer from an explicit
bundled-Node artifact and the built Kothora CLI. It rejects absolute paths, traversal, duplicate
files and symlinks, hashes every payload, and revalidates it while staging. The staged bundle has
no download URL or credential and runs the CLI with its own Node executable on Windows, macOS
and Linux.
