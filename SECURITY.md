# Security policy

YukiOshi Code runs model-proposed commands and edits on your machine, so
security reports get priority.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting (**Report a vulnerability** under this repository's **Security**
tab), or write to `[TBD owner: security contact]`, and include:

- your `yukioshi --version` and OS;
- steps to reproduce, such as a repository layout, prompt, or config;
- the impact, for example "a hook runs in an untrusted repository".

## Supported versions

Security fixes are made for the latest release. Run `yukioshi upgrade` to get
it.

## Response expectations

TBD. There is no committed acknowledgement or fix time yet.

For how the protections work, and what they do not cover, see
[docs/security-model.md](docs/security-model.md).

## In scope

- Bypassing permission rules, permission modes, or the hard safety blocks.
- Escaping the sandbox or the workspace write boundary.
- Running a repository's MCP servers, LSP or formatter commands, hooks, or
  plugins without `yukioshi trust`, or after they changed since trust was
  granted.
- Leaking API keys or OAuth tokens to logs, prompts, session exports, or
  child processes.
- Prompt injection from repository content that leads to an action the
  permission policy should have stopped.
