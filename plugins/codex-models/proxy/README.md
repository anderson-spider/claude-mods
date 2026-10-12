# ccmproxy

Adds OpenAI **Codex** models to Claude Code, paid for by a ChatGPT subscription. They show up in `/model` next to the Claude models; everything else goes to Anthropic untouched.

Claude Code reaches the proxy through `ANTHROPIC_BASE_URL`, on a plain HTTP listener bound to a loopback address. There is no certificate authority, no TLS interception and no `/etc/hosts` change. The plugin's `install.sh` does the steps below for you; this file describes the proxy on its own.

This is a vendored, hardened fork; see [UPSTREAM.md](UPSTREAM.md) for what differs from upstream.

## Quick start

```sh
go build -ldflags "-X main.version=dev" -o ccmproxy ./cmd/ccmproxy
./ccmproxy config init      # random loopback port, secret (auth_token), session_salt; adds only missing keys to an existing file
./ccmproxy login codex      # sign in to ChatGPT
./ccmproxy serve

# in another terminal
eval "$(./ccmproxy env)"    # ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, ENABLE_TOOL_SEARCH
claude
```

`ccmproxy env` prints the secret, so treat its output like a password. `--shell fish`, `--shell powershell` and `--shell json` format it for other shells or for the `env` block of `~/.claude/settings.json`. `ENABLE_TOOL_SEARCH=true` is there because Claude Code turns MCP tool search off for a base URL that is not Anthropic's.

Go 1.27 (pinned in the repository's `mise.toml`). It builds on macOS and Linux only (the credential lock uses `flock`). Dependencies: `gjson`/`sjson`.

## What it does

All traffic is forwarded to `api.anthropic.com` exactly as it arrives, with these exceptions:

1. **`GET /v1/models`**: the upstream catalog with the added models appended. It does not drive Claude Code's `/model` picker.
2. **Requests naming an added model** are translated and sent to the Codex backend (Responses API, OAuth, the same way the Codex CLI does).
3. **`/v1/messages/count_tokens` for an added model** is a local, conservative length-based estimate (the backend has no counting endpoint); Claude Code uses it to decide when to compact.
4. **Thinking blocks this proxy issued** are stripped from requests that go to Anthropic: Codex reasoning state is not a valid Anthropic signature. Requests that never touched a Codex model pass through unmodified.

```
Claude Code ──ANTHROPIC_BASE_URL──▶ http://127.0.0.1:<port>   (listen_http)
                                         │
                                 ┌───────────────┐
                                 │     guard     │  secret, Host, method
                                 └───────┬───────┘
                                 ┌───────────────┐
                                 │    router     │
                                 └───┬───────┬───┘
                    Codex model      │       │  everything else
                                     ▼       ▼
        chatgpt.com/backend-api/codex       https://api.anthropic.com
        (Responses API, OAuth)              (verbatim pass-through)
```

`listen_http` must be a literal loopback IP (`127.0.0.0/8` or `::1`) with an explicit port; `:8081`, `0.0.0.0`, `[::]` and host names are refused, and the bound socket is checked again after it opens. Without the key it defaults to `127.0.0.1:8081`.

Every request must name the listener in `Host` and carry the secret in `X-Ccmproxy-Token`. The header is removed before anything is forwarded. A miss is a `403` `permission_error`, never `401` (which would send Claude Code into an OAuth refresh). Only `GET`, `POST` and `HEAD` are served; `OPTIONS` and the other methods are refused and no `Access-Control-*` header is ever sent. The one exception to the secret is `HEAD /api/hello`, Claude Code's start-up probe, answered locally with an empty `200`.

`GET /__ccmproxy/status`, behind the secret, answers `{"service":"ccmproxy","version":"…","codexLogin":true,"models":["…"]}`.

## `/model` rows

Claude Code's `/model` picker is not built from `GET /v1/models`. It is Claude Code's own catalog plus `additional_model_options` from its bootstrap response (fetched from Anthropic directly, never through the base URL) and `modelPicker.options` in `settings.json`, which is what this proxy uses.

```sh
./ccmproxy models --settings-json   # a ready-to-merge modelPicker block
./ccmproxy models --json            # [{"id","label","description","behavesAs"}], which install.sh reads
```

Each row carries `behavesAs`, a model the installed Claude Code knows, whose client-side handling (prompt profile, capabilities, effort defaults) is applied. Without it a row for an unknown model is not offered. The id sent upstream is unchanged. The context window Claude Code assumes comes from `behavesAs` too: append `[1m]` to the model name (the proxy strips it) or set `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.

## The models

The catalog mirrors `codex debug models` (visibility `list`) for a ChatGPT account; whether an account may use each one is decided upstream.

| Id | Label | Context | Effort levels | Default | Behaves as |
| --- | --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | GPT-6.1 Sol | 373k | low to ultra | low | `claude-sonnet-5` |
| `gpt-6-astra` | GPT-6 Astra | 272k | low to ultra | medium | `claude-opus-5` |
| `gpt-6-sol` | GPT-6 Sol | 272k | low to ultra | medium | `claude-sonnet-5` |
| `gpt-6-luna` | GPT-6 Luna | 272k | low to max | medium | `claude-haiku-4-5` |
| `gpt-5.6-sol` | GPT-5.6 Sol | 272k | low to ultra | low | `claude-sonnet-5` |
| `gpt-5.6-terra` | GPT-5.6 Terra | 272k | low to ultra | medium | `claude-sonnet-5` |
| `gpt-5.6-luna` | GPT-5.6 Luna | 272k | low to max | medium | `claude-haiku-4-5` |
| `gpt-daybreak-blue-latest` | Daybreak Blue | 272k | low to ultra | low | `claude-opus-5` |

All take text and images. `gpt-daybreak-blue-latest` is for accounts in the Daybreak Blue access program, so it is not advertised or routed by default: list it in `codex.models` to use it (that list then restricts the catalog to the ids it names).

## Model names and effort

| Name | Meaning |
| --- | --- |
| `gpt-6-luna` | the model, with the effort the client asks for |
| `gpt-6-luna-high` | pins the effort to `high`, overriding the client |
| `gpt-6-luna:high` | the same, colon separated |
| `codex/gpt-6-luna-high` | with a namespace prefix |
| `gpt-6-luna[1m]` | Claude Code's context-window suffix, ignored |

Reasoning effort is Claude Code's own control: `/effort` and `--effort` send `output_config.effort`, which the proxy maps onto the Codex `reasoning.effort`. Precedence: a name that pins the effort, then `output_config.effort`, then `thinking.budget_tokens`, then the model's default. The value is clamped to the model's levels (`ultra` on `gpt-6-luna` becomes `max`; below the lowest becomes the lowest; unknown becomes the default). The per-effort ids are not advertised unless `codex.effort_variants` is `true`.

## Credentials

Codex credentials are looked for in this order; the first file that exists wins:

| Order | File | Written by |
| --- | --- | --- |
| 1 | `<auth_dir>/codex.json` (default `~/.config/ccmproxy/auth`) | `ccmproxy login codex` |
| 2 | `~/.codex/auth.json` (`CODEX_HOME` honoured), read-only | the Codex CLI |

The second is consulted only when `codex.use_codex_cli_auth` is `true` (default `false`). `codex.auth_file`, when set, replaces both and must not be the Codex CLI's file: one that resolves to it (directly, by symlink or `..`, or in another case on a case-insensitive volume) is refused.

**The Codex CLI's file is read-only for the proxy**: never refreshed, written or removed. OpenAI rotates refresh tokens, so a refresh here would sign the Codex CLI out. A borrowed login is used while its access token is valid; once expired, requests fail with a `403` asking for `codex login` or `ccmproxy login codex`. A changed file is re-read, so a token the CLI renewed is picked up at once.

The proxy's own file is refreshed within five minutes of expiry and written atomically (temp file, sync, mode `600`, rename; `auth_dir` kept at `700`). A refresh and a login hold an exclusive lock on `<auth_dir>/codex.lock` and re-read the file under it, so two proxy processes never spend the same refresh token. A rejected refresh is reported as an expired login (`403`). `login codex` always writes the proxy's own file; `logout codex` removes only that, and refuses a file that is (or links to) the CLI's.

## Commands

```
ccmproxy serve                    run the proxy (default command)
ccmproxy login codex              sign in to a ChatGPT account
ccmproxy logout codex             remove the stored credentials
ccmproxy status                   configuration and login state
ccmproxy models                   the models this proxy adds
ccmproxy models --settings-json   a modelPicker block for settings.json
ccmproxy models --json            the picker rows
ccmproxy env [--shell SHELL]      the environment Claude Code needs (posix, fish, powershell or json); includes the secret
ccmproxy config init              write a config file, or add the missing secrets to an existing one
ccmproxy version                  the version stamped at build
```

## Configuration

`~/.config/ccmproxy/config.json`; override with `--config`, or relocate the directory with `CCMPROXY_HOME` / `XDG_CONFIG_HOME`. A leading `~` is expanded in `auth_dir`, `codex.auth_file` and `--config`. Every field is optional except the two secrets, which `config init` generates. The file holds the secret, so it is written `600` in a `700` directory and loading refuses a file others can access.

```json
{
  "listen_http": "127.0.0.1:8081",
  "upstream": "https://api.anthropic.com",
  "auth_token": "<64 hex characters>",
  "session_salt": "<64 hex characters>",
  "auth_dir": "~/.config/ccmproxy/auth",
  "log_level": "info",
  "codex": {
    "base_url": "https://chatgpt.com/backend-api/codex",
    "user_agent": "codex-tui/...",
    "originator": "codex-tui",
    "models": [],
    "effort_variants": false,
    "model_prefix": "",
    "callback_port": 1455,
    "auth_file": "",
    "use_codex_cli_auth": false
  }
}
```

- `listen_http`: a literal loopback IP with an explicit port.
- `upstream`: only `https://api.anthropic.com`; the passthrough carries the Claude Code login.
- `auth_token`: the secret Claude Code sends in `X-Ccmproxy-Token` (through `ANTHROPIC_CUSTOM_HEADERS`). `serve` refuses to start without it or without `session_salt`.
- `session_salt`: keys the HMAC of Claude Code's `metadata.user_id` that becomes the Codex `Session_id`.
- `codex.base_url`: must be `https://`; the ChatGPT access token is sent to it.

Keys of earlier versions (`listen_proxy`, `listen_tls`, `intercept_hosts`, `proxy_username`, `proxy_password`, `ca_dir`, `dns`) are refused by name.

## What the translation covers

Anthropic Messages and OpenAI Responses, both directions:

- **System prompt** becomes a `developer` input message.
- **Text, images and PDFs** become `input_text` / `input_image` / `input_file`; other documents are dropped.
- **Tools** become `function` tools; `input_schema` is normalized. Names over 64 characters are shortened uniquely and mapped back on the way out.
- **Tool calls and results** become `function_call` / `function_call_output`; ids over the upstream limit are shortened by hash.
- **Thinking**: reasoning summaries stream back as `thinking` blocks carrying the encrypted reasoning state as their signature, so the next turn can replay it. Parallel tool calls are serialized into non-overlapping content blocks.
- **Usage** maps to `input_tokens` / `output_tokens`, with cached tokens as `cache_read_input_tokens`.
- **Model**: `message_start.model` is the model the upstream reported, falling back to the resolved id.
- **Errors** map to Anthropic's types; a stream that ends without its terminal event is an error.

Non-streaming requests go through the same translator and are folded into one message, since the backend only streams.

Claude Code gzips large request bodies. The router decodes `gzip` and `deflate` to read the model name; pass-through still forwards the original bytes and `Content-Encoding`. Anything else (`br`, `zstd`, a corrupt stream) is forwarded untouched with a warning.

## Tests

```sh
go test ./...
```

No network access. They cover the configuration (loopback table, pinned URLs, removed keys, file modes, `config init`), the guard and the routes, byte-for-byte pass-through, the streaming translation, OAuth and the credential store (the Codex CLI's file never written, atomic `600` writes, one refresh spent once under the lock), effort handling, the catalog and compressed bodies.

## Security notes

- The listener binds only to a literal loopback address, checked in the configuration and again on the bound socket.
- Pass-through goes only to `https://api.anthropic.com`, and the Codex token only to an `https://` base URL. `serve` refuses to start when `api.anthropic.com` resolves to a local address.
- Upstream connections ignore the ambient proxy environment variables.
- The configuration file holds `auth_token` and is kept at mode `600`; credential files are written with mode `600`.
- Logs carry no query string, secret, token or prompt.
- ID and access tokens are read for the account id, plan and expiry only; signatures are not verified, because they arrive over TLS directly from the issuer.
