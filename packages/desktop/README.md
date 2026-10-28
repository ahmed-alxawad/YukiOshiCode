# Kothora desktop

Electron shell for Kothora Chat and the local Kothora Code agent. The renderer receives only a
narrow, validated preload API; it has no Node.js access. No Kothora server URL, token, code,
prompt, or crash payload is committed or sent by this package.

## Development

```sh
bun install --frozen-lockfile
bun run --cwd packages/desktop typecheck
bun run --cwd packages/desktop test
bun run --cwd packages/desktop build
```

Packaging uses `electron-builder`. Signing, notarisation and update publishing are enabled only
by release credentials supplied outside the repository.
