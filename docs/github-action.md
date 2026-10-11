# GitHub Action

YukiOshi Code includes a first-party composite GitHub Action for a bounded,
headless review or plan. It is not a hosted bot: the action runs in your own
GitHub Actions runner and calls the model provider you choose. You must provide
that provider's API key as a repository or organization secret.

```yaml
name: YukiOshi review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: yukioshi
        uses: ahmed-alxawad/YukiOshiCode@main
        with:
          prompt: >-
            Review this pull request. List bugs, risky changes, and missing
            tests as concise Markdown with file and line references.
          model: anthropic/claude-sonnet-5-5
          mode: review
          max_turns: "30"
          max_cost: "2"
          provider_api_key_env: ANTHROPIC_API_KEY
          version: "0.3.6"
          comment: "true"
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

For a stable workflow, pin the `uses:` reference to an action tag or commit and
pin `version` to the matching released YukiOshi binary. The action invokes the
repository's `install` script, requires its release `SHA256SUMS` manifest, and
the installer verifies the downloaded archive before installation.

## Inputs

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `prompt` | yes | | Prompt sent to `yukioshi run`. |
| `model` | yes | | A `provider/model` identifier. |
| `mode` | no | `review` | Permission mode: `review` or `plan`. |
| `max_turns` | no | `30` | Maximum model turns. |
| `max_cost` | no | `2` | Maximum cost in US dollars. |
| `provider_api_key_env` | yes | | Name of the environment variable that already holds the provider API key. |
| `output_schema` | no | | Inline JSON Schema or a path accepted by `yukioshi run --output-schema`. |
| `version` | no | `latest` | Release version to install. |
| `comment` | no | `false` | Set to `true` to comment on a pull request. |
| `github_token` | no | | Token used only for a pull request comment. |

Put the API key in `env`, not in `with`. The action checks that the named
environment variable is present but never prints its value. Provider variable
names are listed in [Providers](providers.md#connecting-a-provider).

## Outputs and exit status

`result` contains the stdout from `yukioshi run`, and `exit_code` contains its
numeric exit code. The action writes the same result and run metadata to the
job step summary, then exits with that exact run exit code. In particular,
budget limits remain failures: 5 for `max_turns` and 6 for `max_cost`; see
[exit codes](commands.md#exit-codes).

When `comment` is `true`, the action posts `result` only for `pull_request`
events and only when `github_token` is nonempty. It does not use the token for
`pull_request_target` or for the model provider. Comment-posting failures are
reported as a warning so they do not replace the YukiOshi run's exit code.

`plan` is the safest choice for unattended review prompts because it permits
only low-risk actions. `review` asks a reviewer model to decide actions that
are not low risk; see [Permissions and safety](permissions-and-safety.md).
