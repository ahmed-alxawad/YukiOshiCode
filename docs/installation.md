# Installation

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
   not match;
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

It picks the x64, x64 baseline, or arm64 build, verifies `SHA256SUMS`, checks
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
moving to, with the same checksum check and backup.

### Automatic updates

When the terminal UI starts, YukiOshi checks for a newer release. By default it
installs patch releases (for example 0.3.1 to 0.3.2) on its own and only tells
you about minor and major releases. Change this in `yukioshi.json`:

```json
{ "autoupdate": "notify" }
```

| Value         | Behaviour                                         |
| ------------- | ------------------------------------------------- |
| not set       | install patch releases, notify about the rest     |
| `true`        | same as not set                                   |
| `"notify"`    | only notify                                       |
| `false`       | never check                                       |

`YUKIOSHI_DISABLE_AUTOUPDATE=1` turns the check off as well.

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
