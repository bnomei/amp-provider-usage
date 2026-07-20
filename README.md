# amp-provider-usage

[![Git Tag](https://img.shields.io/github/v/tag/bnomei/amp-provider-usage?sort=semver)](https://github.com/bnomei/amp-provider-usage/tags)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Source](https://img.shields.io/badge/source-GitHub-181717.svg?logo=github)](https://github.com/bnomei/amp-provider-usage)
[![Discord](https://flat.badgen.net/badge/discord/bnomei?color=7289da&icon=discord&label)](https://discordapp.com/users/bnomei)
[![Buymecoffee](https://flat.badgen.net/badge/icon/donate?icon=buymeacoffee&color=FF813F&label)](https://www.buymeacoffee.com/bnomei)

An Amp plugin that shows remaining quota, reset timing, plan details, and
credits for Amp, OpenAI Codex, and xAI Grok.

## What you get

- One combined view of all three providers.
- A **Refresh provider usage** command for Amp's command palette.
- A `provider_usage` tool that agents can call for all providers or a selected
  subset.
- Reads provider credentials locally.

<a title="click to open" target="_blank" style="cursor: zoom-in;" href="https://raw.githubusercontent.com/bnomei/amp-provider-usage/main/screenshot.png"><img src="https://raw.githubusercontent.com/bnomei/amp-provider-usage/main/screenshot.png" alt="AMP Provider Usage Modal TUI screenshot" style="width: 100%;" /></a>

## Example output

```text
Amp · Pro
  Remaining: Agents 82% · Orb 91%
  Renews in 12d · Credits: $18.00

Codex · Plus
  5h: 74% remaining · resets in 2h 15m
  Weekly: 93% remaining · resets in 5d 8h

Grok
  Monthly: 68% remaining · resets in 19d
```

Values above are illustrative only.

## Requirements

- Amp with a local executor
- The `amp` CLI on your `PATH` when querying Amp usage
- A Codex login when querying Codex usage
- A Grok login when querying Grok usage

## Install

The plugin ships as a single TypeScript file and is not published to npm.

```sh
amp plugins add https://raw.githubusercontent.com/bnomei/amp-provider-usage/main/provider-usage.ts --auto-update
```

After installation, use **Refresh provider usage** from the Amp command palette,
or call the `provider_usage` tool. The command displays results in a modal;
tool results are returned to the Amp thread and model context.

To update or remove the plugin:

```sh
amp plugins update provider-usage.ts
amp plugins remove provider-usage.ts
```

## Use the plugin

Choose **Refresh provider usage** in Amp's command palette to query all three
providers. In an Amp thread, an agent can call `provider_usage` with an
optional `providers` array:

```json
{ "providers": ["codex"] }
```

Use any combination of `amp`, `codex`, and `grok`, or omit `providers` to query
all three. Providers without a local credential file are omitted. If a
configured provider fails temporarily, the result explains why while still
returning the other selected providers.

## Security and privacy

The plugin reads credentials locally from `$CODEX_HOME/auth.json` (or
`~/.codex/auth.json`) and `$GROK_HOME/auth.json` (or `~/.grok/auth.json`).
Credentials are sent only to the fixed `chatgpt.com` and `grok.com` endpoints
used for usage queries. Requests refuse redirects. The plugin has no telemetry
and no third-party runtime dependencies.

Command output stays in the Amp modal, while tool output enters the Amp
thread/model context. Amp plugins execute with the user's authority, so install
and use this plugin only if you trust its source and the endpoints it contacts.

A remote Amp executor cannot query local provider credentials; provider usage
requires a local executor. The provider APIs used here are unsupported/internal
endpoints and may change or stop working without notice.

## Development

From a checkout, verify the plugin with:

```sh
bun build provider-usage.ts --outdir /tmp/amp-provider-usage-build
git diff --check
```

Keep the plugin runtime dependency-free.

## Support

Questions and feedback are welcome on [Discord](https://discordapp.com/users/bnomei).
If the plugin saves you time, you can support its development through
[Buy Me a Coffee](https://www.buymeacoffee.com/bnomei).

## License

[MIT](LICENSE)
