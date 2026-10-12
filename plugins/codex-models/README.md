# codex-models

Use ChatGPT's Codex models in Claude Code through a local loopback proxy. The local proxy is a thin router: Claude requests pass byte for byte to Anthropic with your usual login, and Codex requests go as Anthropic Messages to a remote [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance that holds the Codex login and translates for OpenAI. Your Claude credentials never reach the remote.

## Install

Requires macOS, [mise](https://mise.jdx.dev), and a CLIProxyAPI instance (v8 management API) reachable over HTTP or HTTPS with a ChatGPT Codex account signed in. Only you should be able to reach it: its inference endpoints may have no authentication. The proxy needs its remote management (`remote-management.allow-remote`), and the management key can act with the Codex login, so restrict network access to the remote to this Mac.

```text
/plugin install codex-models --marketplace anderson-spider/claude-mods
```

Run `install.sh` from the installed plugin folder or this checkout, with the remote's base URL and management key in the environment:

```sh
export CLIPROXY_URL=http://192.168.0.128:8317   # HTTP or HTTPS base URL
export CLIPROXY_MGMT_KEY=<management key>
plugins/codex-models/install.sh
```

The installer writes both into the private config through `ccmproxy config init --stdin`, never in argv, the plist or its output. Set both or neither: without them a reinstall keeps the configured remote. Start a new Claude Code session; running ones keep old settings. `/codex-models:status` checks proxy reachability, version, the remote's Codex account, models and settings. `install.sh --check` checks prerequisites/settings without changes; `--dry-run` prints a masked settings diff without changing the installation. Other flags are refused.

The installer checks existing settings before building or touching the LaunchAgent, then verifies this proxy and its version before writing settings. An existing foreign base URL, or one with no matching config, requires uninstall first. Reinstall is idempotent with the current config.

## Use

- Pick a model in `/model`, then use `/effort`; an effort suffix such as `-high` or `:high` pins it instead. The proxy sends the remote `<model>(<effort>)`. Run `~/.claude/codex-models/ccmproxy models` for the current catalog, rather than copying a model table.
- The remote does not honor `max_tokens`, so a Codex answer is not cut at the requested ceiling. `count_tokens` for a Codex model is a local estimate.
- If the remote is unreachable, Codex requests fail fast with `503 api_error` and the quota readings are cleared, so crew routes to Claude. Claude traffic does not depend on the remote.
- For subagents, use a model id in the agent definition's `model:` field.
- With crew, start a new session for Codex-twin registration; `/reload-plugins` alone is insufficient. See [crew](../../README.md#crew) for its routing options.

For standalone proxy operation and context-window hints, see [proxy/README.md](proxy/README.md).

## Settings and removal

Install owns the loopback `ANTHROPIC_BASE_URL`, one `X-Ccmproxy-Token` line, `ENABLE_TOOL_SEARCH=true`, and picker rows marked `(codex-models)`. Other settings/header lines/unmarked rows stay. Settings changes are atomic, with private timestamped backups beside the symlink-resolved file; backups can hold secrets and are retained. A concurrent edit or filesystem failure aborts the write.

```sh
~/.claude/codex-models/uninstall.sh
claude plugin uninstall codex-models@spider-claude-mods
```

Uninstall accepts no arguments. It removes the base URL only when it is loopback HTTP and carried our header, removes owned header/tool-search/picker entries, and keeps unrelated settings. No old values are restored. Cleanup/backup must succeed before unloading the LaunchAgent; failure leaves it loaded. Restart running sessions. The installation, config (with the remote and its key), binary, logs and copied scripts remain.

## Privacy

- **Sent:** Codex conversations, including whatever session/subagent tools read, go to the remote, which forwards them to OpenAI. The remote gets only `Content-Type`, `Accept`, `Anthropic-Version` and `Anthropic-Beta`, with `metadata.user_id` replaced by a salted HMAC; never an Anthropic credential, the proxy secret or a `User-Agent`. Claude traffic goes to `api.anthropic.com` unchanged, except that thinking blocks the remote issued (`ccmp1:` signatures) are dropped. The management key goes only to `/v8/management/*`: a credentials check at most once a minute, and, only for `?refresh=limits` (crew asks for it), one `wham/usage` api-call at most every five minutes, with the remote substituting the token. Plain status reads no usage. Plugin hooks probe loopback only.
- **Saved/read:** `~/.claude/codex-models/` contains config, logs, scripts and binary; no Codex credential is stored locally. The config holds the proxy secret, salt and management key. Config/settings/backups are 0600, config directory 0700. The settings token header and backups are secrets; backups are never deleted by the scripts. Rate-limit readings stay in memory.
- **Logged:** method, path, status, sizes and duration, not query strings, secrets, keys, prompts or upstream error text.
- **Local risk:** any process knowing the secret can use the loopback proxy. On this single-user setup, another local user could bind its port while it is down and receive Claude's bearer and proxy secret.

## Tests and live gaps

Plugin tests use pure modules and a fake host/network. Proxy unit/contract tests use local fakes; installer tests use a temporary HOME and fake services, never loading the real LaunchAgent. Commands for contributors are in [AGENTS.md](AGENTS.md); golden rules are in [contract/README.md](proxy/contract/README.md).

Live validation confirmed Codex `/model` rows in a new session and a successful chat with `gpt-6.1-sol`. The same session then continued on Claude (Opus) through the proxy, with `ANTHROPIC_BASE_URL` pointing at ccmproxy, including spawning subagents. Streaming responses and multi-round tool calls (Grep, Read, Bash) worked through the real remote with `crew:code-reader-codex` on `gpt-6-luna`, `crew:developer-codex` on `gpt-6.1-sol` and `crew:architect-codex` on `gpt-6-astra`. The remote accepted `<model>(medium)` ids; this does not establish that the effort took effect upstream.

Still unverified live:
- Effort actually applied upstream and remote error shapes.
- Real `wham/usage` fields through the api-call (`rate_limit.primary_window`/`secondary_window`, `used_percent`, `limit_window_seconds`, `reset_at`/`reset_after_seconds`); the schema is third-party-reported and unreadable fields are skipped.
- Multi-turn Codex reasoning replay and Jev effort; `crew:architect-codex` denial outside `.crew/`.
- Startup notices with stopped proxy, wrong secret or another app on the port.
- Real uninstall retaining unrelated settings/files while removing owned entries; changed settings use 2-space JSON.

Known gap: crew confirmation accepts planned/dated ids, but effort before the date reads as a mismatch.
