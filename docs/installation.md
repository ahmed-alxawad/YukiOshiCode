# Installation

After installing, run `yukioshi doctor` to verify the install, local tools, provider configuration, sandbox, clipboard, and writable state. Add `--network` when you also want provider-host reachability checked.

YukiOshi Code ships as one self-contained binary per platform. Nothing else
needs to be installed.

| System  | Builds                                                             |
| ------- | ------------------------------------------------------------------ |
| Linux   | x64 and arm64, glibc and musl; x64 also as a baseline build for CPUs without AVX2 |
| macOS   | Apple Silicon and Intel (Intel also as a baseline build)           |
| Windows | x64 (also baseline) and arm64                                      |

Every release is tested on macOS (Apple Silicon and Intel), Windows (x64 and
arm64), and Linux (arm64 and musl) before it is published.

## macOS and Linux

```bash
curl -fsSL https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install | bash
```

The installer:

1. detects your OS, CPU, and C library (glibc or musl) and whether the CPU
   supports AVX2;
2. downloads the matching archive from the latest release;
3. checks the archive against the release's `SHA256SUMS` and stops if it does
   not match (if the release has no `SHA256SUMS`, it warns and continues
   without the check);
4. runs the new binary once (`--version`) before installing it;
5. puts it in `~/.yukioshi/bin`, keeping the previous binary as
   `yukioshi.old`, and adds that folder to your shell's `PATH`.

If that version is already installed, it does nothing.

Options (after `bash -s --`):

| Option                  | Effect                                              |
| ----------------------- | --------------------------------------------------- |
| `--version <version>`   | install a specific version, for example `0.3.1`     |
| `--no-modify-path`      | do not edit `.bashrc`, `.zshrc`, or other shell files |
| `--binary <path>`       | install a binary you already have                   |

```bash
curl -fsSL https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install | bash -s -- --version 0.3.1
```

Piping to `sh` also works: the installer restarts itself under `bash`.

## Windows

In PowerShell (5.1 or later; no administrator rights needed):

```powershell
irm https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install.ps1 | iex
```

It picks the x64, x64 baseline, or arm64 build, verifies `SHA256SUMS` (with a
warning and no check if the release has none), checks
that the new `yukioshi.exe` runs, keeps the previous one as `yukioshi.exe.old`,
installs to `%USERPROFILE%\.yukioshi\bin`, and adds that folder to your user
`PATH`. To pass options, run the script as a script block:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install.ps1))) -Version 0.3.1
```

| Option          | Effect                                         |
| --------------- | ---------------------------------------------- |
| `-Version`      | install a specific version                     |
| `-NoModifyPath` | do not change your `PATH`                      |
| `-DryRun`       | print what would be downloaded and where, then stop |

## Manual install

Download the archive for your platform from the
[releases page](https://github.com/ahmed-alxawad/YukiOshiCode/releases),
check it against `SHA256SUMS` from the same release, extract it, and put
`yukioshi` (`yukioshi.exe` on Windows) on your `PATH`.

## Upgrading

```bash
yukioshi upgrade            # latest release
yukioshi upgrade 0.3.1      # a specific version
```

`yukioshi upgrade` runs the installer that belongs to the release you are
moving to, with the same checksum check and backup. Downloads and installation
enforce a default 5-minute timeout (`300000` ms, configurable via
`YUKIOSHI_UPGRADE_TIMEOUT_MS`).

### Automatic updates

When you start the terminal UI or `yukioshi run`, YukiOshi checks for a newer
release at most once a day. The check runs in a separate background process, so
it never slows down startup and keeps going after a short `yukioshi run` exits.

For an install made with the install script (`~/.yukioshi/bin`, or a binary in
`~/.local/bin`), a newer minor or patch release (for example 0.4.1 to 0.5.0) is
downloaded in the background, checked against the release's `SHA256SUMS`, and
started once with `--version` before anything is replaced. The current binary is
kept next to it as `yukioshi.old` (`yukioshi.exe.old` on Windows), and the new
version is used from the next start. You see one line about it: a toast in the
terminal UI, or one line on stderr in `yukioshi run`.

A major release (for example 1.x to 2.0) is never installed automatically; you
are only told about it. You are also only told, with the command to run, when
YukiOshi was installed with npm, pnpm, yarn, bun, Homebrew, Scoop or Chocolatey,
when it cannot tell how it was installed, or when it cannot replace its own
binary (the file or its folder is not writable).

If anything fails (no network, a checksum that does not match, a release without
`SHA256SUMS`, a new binary that does not start), the current binary stays as it
is and you are told once. Only one yukioshi process updates at a time.

There is no check at all when:

- `"autoupdate": false` is set,
- `YUKIOSHI_DISABLE_AUTOUPDATE=1` is set,
- the `CI` environment variable is set (any value except empty, `0` and `false`),
- `yukioshi run` is used with `--format json` (its output stays pure JSON),
- YukiOshi runs from a source checkout instead of a release binary.

Set the behaviour in your global `~/.config/yukioshi/yukioshi.json` (a
project's config cannot change it):

```json
{ "autoupdate": "notify" }
```

| Value         | Behaviour                                                       |
| ------------- | --------------------------------------------------------------- |
| not set       | install newer minor and patch releases, notify about major ones |
| `true`        | same as not set                                                 |
| `"notify"`    | only notify                                                     |
| `false`       | never check                                                     |

The time of the last check and its result are kept in
`autoupdate.json` in the state folder (`~/.local/state/yukioshi` on Linux and
macOS); delete that file to check again on the next start.

### Rolling back

If a new version misbehaves, the previous binary is still next to it:

```bash
mv ~/.yukioshi/bin/yukioshi.old ~/.yukioshi/bin/yukioshi
```

Or install the version you want with `--version`.

## Uninstalling

```bash
yukioshi uninstall
```

It removes YukiOshi's data, cache, and configuration folders, and the `PATH`
line the installer added. For installs made with the install script, it then
prints the last step, removing the binary itself. Options:

| Option              | Effect                                   |
| ------------------- | ---------------------------------------- |
| `--keep-config`, `-c` | keep your configuration                |
| `--keep-data`, `-d`   | keep sessions and snapshots            |
| `--dry-run`         | show what would be removed               |
| `--force`, `-f`     | do not ask for confirmation              |

## Where YukiOshi keeps its files

| Purpose        | Linux and macOS                    |
| -------------- | ---------------------------------- |
| Binary         | `~/.yukioshi/bin`                  |
| Configuration  | `~/.config/yukioshi`               |
| Data, sessions | `~/.local/share/yukioshi`          |
| Cache          | `~/.cache/yukioshi`                |
| State          | `~/.local/state/yukioshi`          |

These follow the XDG variables (`XDG_CONFIG_HOME` and so on) when they are set.
`yukioshi debug paths` prints the exact folders on your machine.

## Ripgrep and search

YukiOshi uses ripgrep for workspace file and text search (`grep`, `glob`, file search, and `@` file completion).

- If `rg` is already present on your `PATH` (or installed via Homebrew or Chocolatey), YukiOshi uses it directly.
- If ripgrep is missing, YukiOshi downloads and verifies a pinned, SHA-256-validated ripgrep release (v15.1.0) into its data directory (`Global.Path.data/bin`) on first use. All redirect locations are restricted strictly to GitHub releases.
- If ripgrep cannot be downloaded or executed (e.g. in offline, proxy-restricted, or air-gapped environments), YukiOshi automatically falls back to built-in pure-JavaScript search with a clear warning: `ripgrep binary is not available; falling back to built-in search`. All tools continue to work seamlessly.

## Release signing (for the owner)

`SHA256SUMS.sig` is an Ed25519 signature (base64 or raw 64 bytes) of the
`SHA256SUMS` file, published next to it. The updater and `yukioshi upgrade`
verify it with the public key in `packages/opencode/src/installation/release-key.ts`
(`RELEASE_PUBLIC_KEY`; empty means no check). Only the in-binary updater
verifies it; `install` (the shell installer) does not, because `openssl` ed25519
support is not reliable across macOS LibreSSL and older OpenSSL.

One-time setup:

1. `bun packages/opencode/script/release-keygen.ts` prints a private key (PEM)
   and the base64 public key.
2. Store the PEM as the repository secret `YUKIOSHI_RELEASE_SIGNING_KEY`.
3. Paste the public key into `RELEASE_PUBLIC_KEY` and release a version with it.
4. Once releases are signed, set `SIGNING_REQUIRED_FROM` to the first signed
   version; older unsigned releases then still update with a warning, newer
   ones without a valid `.sig` are refused.

Release workflow step, after `SHA256SUMS` is created and before it is uploaded
(add it yourself; this repository change does not touch `.github/workflows`):

```yaml
- name: Sign SHA256SUMS
  env:
    YUKIOSHI_RELEASE_SIGNING_KEY: ${{ secrets.YUKIOSHI_RELEASE_SIGNING_KEY }}
  run: bun packages/opencode/script/release-sign.ts SHA256SUMS
```

Then upload `SHA256SUMS.sig` with the other release assets.
