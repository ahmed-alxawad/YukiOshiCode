# Notice

YukiOshi Code is proprietary, source-available software (see
[LICENSE](LICENSE)). It includes work from the following projects, which keep
their own licenses.

## opencode

- Source: <https://github.com/anomalyco/opencode>
- License: MIT, Copyright (c) 2025 opencode
  ([licenses/opencode-kilocode-MIT.txt](licenses/opencode-kilocode-MIT.txt))

YukiOshi Code is a fork of opencode and keeps its Bun workspace, Effect-TS
services, agent loop, tool system, terminal UI, server, and models.dev-based
provider system. The executable, package scope (`@yukioshi/*`), environment
variables (`YUKIOSHI_*`), and runtime directories were renamed. Legacy
`opencode.json` and `.opencode/` configuration is still read, and some
identifiers keep the opencode name where compatibility needs it, such as
third-party package and provider names, plugin fields, and upstream service
URLs. opencode's web and desktop apps are not part of this repository.

## Kilo Code

- Source: <https://github.com/Kilo-Org/kilocode>
- License: MIT, Copyright (c) 2026 Kilo Code
  ([licenses/opencode-kilocode-MIT.txt](licenses/opencode-kilocode-MIT.txt))

- `packages/sandbox` is ported from Kilo Code's sandbox package (bubblewrap
  on Linux, `sandbox-exec` on macOS), with identifiers renamed.
- `packages/indexing` is ported from Kilo Code's indexing package. Kilo Code's
  hosted embedding service was removed because it cannot work outside Kilo's
  backend.
- The project memory tools and `task_parallel` follow Kilo Code's designs but
  are smaller reimplementations on top of opencode's services.

## Bundled skills

- Source: <https://github.com/anthropics/knowledge-work-plugins> and
  Anthropic's example skills
- License: Apache License 2.0, Copyright Anthropic, PBC

The `design`, `engineering`, `productivity`, `skill-creator`, and
`web-artifacts-builder` skills in `packages/opencode/skills` are distributed
under the Apache License 2.0. The license text and the list of modifications
are in [`packages/opencode/skills/LICENSES`](packages/opencode/skills/LICENSES)
and [`packages/opencode/skills/NOTICE`](packages/opencode/skills/NOTICE).

## Other dependencies

Third-party npm packages are used under their own licenses, as listed in
each package's metadata.
