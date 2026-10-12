# codex-models

Use ChatGPT's Codex models in Claude Code through a local loopback proxy. Codex conversations go to OpenAI; Claude models pass through to Anthropic with your usual login.

## Install

Requires macOS, [mise](https://mise.jdx.dev) and a ChatGPT account with Codex access.

```text
/plugin install codex-models --marketplace anderson-spider/claude-mods
```

Run `install.sh` from the installed plugin folder or this checkout:

```sh
plugins/codex-models/install.sh
~/.claude/codex-models/ccmproxy login codex
```

Start a new Claude Code session; running ones keep old settings. `/codex-models:status` checks proxy reachability, version, login, models and settings. `install.sh --check` checks prerequisites/settings without changes; `--dry-run` prints a masked settings diff without changing the installation. Other flags are refused.

The installer checks existing settings before building or touching the LaunchAgent, then verifies this proxy and its version before writing settings. An existing foreign base URL, or one with no matching config, requires uninstall first. Reinstall is idempotent with the current config.

## Use

- Pick a model in `/model`, then use `/effort`; an effort suffix such as `-high` or `:high` pins it instead. Run `~/.claude/codex-models/ccmproxy models` for the current catalog, rather than copying a model table.
- For subagents, use a model id in the agent definition's `model:` field.
- With crew, start a new session for Codex-twin registration; `/reload-plugins` alone is insufficient. See [crew](../../README.md#crew) for its routing options.

For standalone proxy operation and context-window hints, see [proxy/README.md](proxy/README.md).

## Settings and removal

Install owns the loopback `ANTHROPIC_BASE_URL`, one `X-Ccmproxy-Token` line, `ENABLE_TOOL_SEARCH=true`, and picker rows marked `(codex-models)`. Other settings/header lines/unmarked rows stay. Settings changes are atomic, with private timestamped backups beside the symlink-resolved file; backups can hold secrets and are retained. A concurrent edit or filesystem failure aborts the write.

```sh
~/.claude/codex-models/uninstall.sh
claude plugin uninstall codex-models@spider-claude-mods
```

Uninstall accepts no arguments. It removes the base URL only when it is loopback HTTP and carried our header, removes owned header/tool-search/picker entries, and keeps unrelated settings. No old values are restored. Cleanup/backup must succeed before unloading the LaunchAgent; failure leaves it loaded. Restart running sessions. The installation, login, config, binary, logs and copied scripts remain; `ccmproxy logout codex` removes the native login.

## Privacy

- **Sent:** Codex conversations include whatever session/subagent tools read. The proxy uses `chatgpt.com` for Codex and `auth.openai.com` for login/refresh; Claude traffic goes to `api.anthropic.com`. Plain status is local. Crew may request `?refresh=limits`, which reads unofficial `wham/usage` with the held access token, no prompt, at most once per five minutes and without refreshing login. Plugin hooks probe loopback only.
- **Saved/read:** `~/.claude/codex-models/` contains config, logs, scripts, binary and native `<auth_dir>/codex.json` credentials, not Codex CLI credentials. Credentials/settings/backups are 0600, credential/config directories 0700. The settings token header and backups are secrets; backups are never deleted by the scripts. Rate-limit readings stay in memory.
- **Logged:** method, path, status, sizes and duration, not query strings, secrets, tokens, prompts or upstream error text. The log at `~/.claude/codex-models/home/log/ccmproxy.log` identifies the account/plan and credential path at startup.
- **Local risk:** any process knowing the secret can use the loopback proxy. On this single-user setup, another local user could bind its port while it is down and receive Claude's bearer and proxy secret.

## Tests and live gaps

Plugin tests use pure modules and a fake host/network. Proxy unit/contract tests use local fakes; installer tests use a temporary HOME and fake services, never loading the real LaunchAgent. Commands for contributors are in [AGENTS.md](AGENTS.md); golden rules are in [contract/README.md](proxy/contract/README.md).

Still unverified live:
- A new session offering Codex `/model` rows while staying on Claude.
- Real `wham/usage` fields (`rate_limit.primary_window`/`secondary_window`, `used_percent`, `limit_window_seconds`, `reset_at`/`reset_after_seconds`) and usage reads/status during real token refresh; the schema is third-party-reported and unreadable fields are skipped.
- Multi-turn Codex reasoning replay and Jev effort; `crew:architect-codex` denial outside `.crew/`.
- Startup notices with stopped proxy, wrong secret or another app on the port.
- Real uninstall retaining unrelated settings/files while removing owned entries; changed settings use 2-space JSON.

Known gap: crew confirmation accepts planned/dated ids, but effort before the date reads as a mismatch.
