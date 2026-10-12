# claude-code-model-proxy (`ccmproxy`)

Adds OpenAI **Codex** models to Claude Code, paid for by your ChatGPT
subscription. They show up in `/model` next to the Claude models, and
everything else still goes to Anthropic untouched.

Claude Code reaches the proxy through `ANTHROPIC_BASE_URL`, on a plain HTTP
listener bound to a loopback address. There is no certificate authority, no
TLS interception and no `/etc/hosts` change.

## Quick start

**1. Build the binary.**

```sh
go build -ldflags "-X main.version=$(git describe --tags --always)" -o ccmproxy ./cmd/ccmproxy
```

**2. Write the configuration.** This picks a random free port on `127.0.0.1`
and generates the proxy's secret (`auth_token`) and `session_salt`. Run on an
existing file, it adds only the keys that are missing.

```sh
./ccmproxy config init
```

**3. Sign in to ChatGPT.**

```sh
./ccmproxy login codex
```

**4. Start the proxy, then point Claude Code at it.**

```sh
./ccmproxy serve

# in another terminal
eval "$(./ccmproxy env)"   # ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, ENABLE_TOOL_SEARCH
claude
```

`ccmproxy env` prints the secret, so treat its output like a password.
`--shell fish`, `--shell powershell` and `--shell json` format it for other
shells, or for the `env` block of `~/.claude/settings.json`.
`ENABLE_TOOL_SEARCH=true` is there because Claude Code turns MCP tool search
off for a base URL that is not Anthropic's.

The models reach the `/model` picker through a `modelPicker` block; see
[Making the models appear in `/model`](#making-the-models-appear-in-model).
Reasoning effort is Claude Code's own control — `/effort` or `--effort`.

## What it does

All traffic is forwarded to `api.anthropic.com` exactly as it arrives, with two
exceptions:

1. **`GET /v1/models`** — the upstream catalog is returned with the added
   models appended. Note that this endpoint does *not* drive Claude Code's
   `/model` picker; see [Making the models appear in `/model`](#making-the-models-appear-in-model).
2. **Requests naming an added model** — these are translated and sent to that
   model's own provider instead of Anthropic.

The added models are OpenAI's **Codex** models, reached through a ChatGPT
subscription over OAuth 2.0 (authorization code + PKCE), the same way the Codex
CLI does. The OAuth and Responses API details follow
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

```
Claude Code ──ANTHROPIC_BASE_URL──▶ http://127.0.0.1:<port>   (listen_http)
                                         │
                                 ┌───────────────┐
                                 │    router     │
                                 └───┬───────┬───┘
                    Codex model      │       │  everything else
                                     ▼       ▼
        chatgpt.com/backend-api/codex       https://api.anthropic.com
        (Responses API, OAuth)              (verbatim pass-through)
```

The one listener is `listen_http`. It must be a literal loopback IP
(`127.0.0.0/8` or `::1`) with an explicit port: `:8081`, `0.0.0.0`, `[::]` and
host names are refused, and the bound socket is checked again after it opens.
Without the key it defaults to `127.0.0.1:8081`.

## Install

Download the archive for your platform from the
[latest release](https://github.com/jclab-joseph/claude-code-model-proxy/releases/latest)
and verify it against `checksums.txt`:

```sh
sha256sum -c checksums.txt --ignore-missing
tar -xzf ccmproxy_*_linux_amd64.tar.gz     # or unzip on Windows
./ccmproxy version
```

Builds are published for `linux`, `darwin` and `windows` on both `amd64` and
`arm64`. They are statically linked (`CGO_ENABLED=0`), so there is nothing to
install alongside them.

## Build from source

```sh
go build -o ccmproxy ./cmd/ccmproxy
```

Go 1.26 or newer. It builds on macOS and Linux only (the credential lock uses
`flock`). `ccmproxy version` reports `dev` for a plain `go build`;
stamp a version with `-ldflags "-X main.version=..."`. Dependencies:
`gjson`/`sjson` for JSON rewriting.

## Making the models appear in `/model`

Claude Code's `/model` picker is **not** built from `GET /v1/models`. Verified
against Claude Code 2.1.263 by logging every request of a full session: that
endpoint is fetched zero times. The picker is Claude Code's own model catalog
plus two lists it is given:

- `additional_model_options` in the `GET /api/claude_cli/bootstrap` response —
  this is how Anthropic itself adds a model (that is where the `Fable` row
  comes from); Claude Code fetches it from Anthropic directly, not through
  the base URL, so the proxy never sees it, and
- `modelPicker.options` in `settings.json`, which is what this proxy uses.

There *is* a `/v1/models` discovery path in the binary, but it cannot work
here, for two independent reasons:

```js
// it only runs when the base URL points somewhere that is NOT the real API
function Qv(){ let e=process.env.ANTHROPIC_BASE_URL; if(!e) return true; return Gw(e) }
function Gw(e){ return ["api.anthropic.com"].includes(new URL(e).host) }
function Dp(){ …; if(po()) return false; if(!a.ANTHROPIC_BASE_URL) return false; … }

// and it drops every id that is not Anthropic's
.filter((c) => /(claude|anthropic)/i.test(c.id))
```

With `ANTHROPIC_BASE_URL` pointing at this proxy the first condition holds,
but the second would still discard `gpt-5.5`. So the model list is still merged
for correctness and for other clients (`curl`, the SDKs), but it is not what
makes the picker work.

### `modelPicker` in settings.json

```sh
./ccmproxy models --settings-json
```

emits a ready-to-merge block:

```json
{
  "modelPicker": {
    "options": [
      {
        "model": "gpt-5.6-sol",
        "label": "GPT-5.6 Sol (Codex)",
        "description": "Frontier coding and research model. …",
        "behavesAs": "claude-opus-5"
      }
    ]
  }
}
```

`behavesAs` is required, not decoration: it names a model the installed Claude
Code knows, whose client-side handling — prompt profile, capability and effort
defaults — is applied. Without it, *a row for a model this version does not
know is not offered at all*, and selecting the model prints

```
"gpt-5.5" isn't described by this version's model catalog …
```

The model id sent upstream is unchanged; only the client's own assumptions
come from `behavesAs`. Add `"replaceBuiltInOptions": true` to show *only* these
rows, and see `./ccmproxy models` for the mapping each model uses.

The context window Claude Code assumes comes from `behavesAs` too, so a model
with a larger one is compacted earlier than it needs to be. Either append
`[1m]` to the model name (the proxy strips the suffix before routing) or set
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the real window.

## Model names and effort

Every model is accepted under several spellings:

| Name | Meaning |
| --- | --- |
| `gpt-5.5` | the model, with the effort the client asks for |
| `gpt-5.5-high` | pins the effort to `high`, overriding the client |
| `gpt-5.5:high` | the same, colon separated |
| `codex/gpt-5.5-high` | with a namespace prefix |
| `gpt-5.5[1m]` | Claude Code's context-window suffix, ignored |

**Reasoning effort is Claude Code's own control, not a model name.** `/effort`
and `--effort` send the choice with the request as `output_config.effort`, and
the proxy maps it onto the Codex `reasoning.effort`, so one picker row per
model is enough:

```
--effort high   →  output_config.effort=high   →  reasoning.effort=high
--effort low    →  output_config.effort=low    →  reasoning.effort=low
(unset)         →  output_config.effort=medium →  reasoning.effort=medium
```

Claude Code remembers the last effort you chose, so a run with no `--effort`
still sends one; the proxy forwards whatever arrives rather than second
guessing it. Token counting ignores effort, since it does not affect the
prompt.

Claude Code offers the effort levels of the model a picker row *behaves as*,
which can exceed the real model's range, so the value is clamped: `max` on
`gpt-5.5` (which stops at `xhigh`) becomes `xhigh`, and Claude Code's `ultra`
becomes the highest level the model has.

A name that pins the effort still works and wins over the client's choice.
Those per-effort ids are **not** advertised by default — they would multiply
the picker rows for something Claude Code already controls. Set
`codex.effort_variants` to `true` to list them, which is worth doing for a
client that has no effort control of its own.

Set `codex.models` to a list to restrict the catalog.

## Credentials

Codex credentials are looked for in this order, and the **first file that
exists wins**:

| Order | File | Written by |
| --- | --- | --- |
| 1 | `~/.config/ccmproxy/auth/codex.json` (`<auth_dir>/codex.json`) | `ccmproxy login codex` |
| 2 | `~/.codex/auth.json` (`CODEX_HOME` is honoured), read-only | the Codex CLI |

`codex.auth_file`, when set, replaces both: it is the only file consulted, its
layout is detected from its contents, and it is this proxy's own file. It must
not be the Codex CLI's file: an `auth_file` that resolves to it (directly,
through a symlink or `..`, or in another case on a case-insensitive volume) is
refused.

The second is consulted only when `codex.use_codex_cli_auth` is `true`; it is
`false` by default, so the proxy keeps its own login. Both layouts are
understood, including the CLI's, which nests the tokens under `tokens` and
records no expiry — that is read from the access token's own `exp` claim, along
with the account id and plan.

**The Codex CLI's file is read-only for the proxy**: never refreshed, written or
removed. OpenAI rotates refresh tokens, so a refresh by the proxy would sign
the Codex CLI out (and the crew's `codex exec`, which runs under the same
login). A borrowed login is used while its access token is valid; once it has
expired, requests fail with an error asking to run `codex login` (which renews
it) or `ccmproxy login codex` (which gives the proxy its own login). A file
that changes underneath the proxy is re-read rather than served from cache, so
a token the Codex CLI renewed is picked up at once.

The proxy's own file is refreshed when its token is within five minutes of
expiry, written in its own layout (an `auth_file` in the CLI's layout keeps the
fields this proxy does not own). Writes are atomic: a temporary file in the
same directory, synced, set to mode `600` and renamed over the old one, so a
looser mode on an existing file does not survive; the auth directory is kept
at `700`. A refresh and a login hold an exclusive lock on
`<auth_dir>/codex.lock` and re-read the file under it, so two proxy processes
never both spend the same refresh token: the second uses the token the first
wrote.

`ccmproxy login codex` always writes this proxy's own file and never touches
`~/.codex/auth.json`; `ccmproxy logout codex` likewise removes only its own,
and refuses a file that is (or links to) the CLI's.

## Commands

```
ccmproxy serve                run the proxy (default command)
ccmproxy login codex          sign in to a ChatGPT account
ccmproxy logout codex         remove the stored credentials
ccmproxy status               configuration and login state
ccmproxy models               the models this proxy adds
ccmproxy models --settings-json   a modelPicker block for settings.json
ccmproxy models --json        the picker rows as [{"id","label","description"}]
ccmproxy env [--shell SHELL]  the environment Claude Code needs (posix,
                              fish, powershell or json); includes the secret
ccmproxy config init          write a config file, or add the missing
                              secrets to an existing one
ccmproxy version              the version stamped at build and build details
```

Every request must name the listener in `Host` and carry the secret in
`X-Ccmproxy-Token`; the header is removed before anything is forwarded, and a
miss is a `403` `permission_error` (never `401`, which would send Claude Code
into an OAuth refresh). `OPTIONS` is refused and no `Access-Control-*` header
is ever sent. The one exception is `HEAD /api/hello`, Claude Code's start-up
probe, which is answered locally with an empty `200`.

`GET /__ccmproxy/status`, behind the secret, answers
`{"service":"ccmproxy","version":"…","codexLogin":true,"models":["…"]}`.

## Configuration

`~/.config/ccmproxy/config.json` (override with `--config`, or relocate the
whole directory with `CCMPROXY_HOME` / `XDG_CONFIG_HOME`). A leading `~` is
expanded in every path setting — `auth_dir`, `codex.auth_file` and
`--config` — since a value read from a file never passes through a shell.
`~otheruser` is not expanded. Every field is optional and unset fields take
the value below. `ccmproxy config init` writes this file with every field
filled in, a random port and new secrets; run on an existing file, it keeps
every value (unknown keys included) and adds only `auth_token` and
`session_salt` when they are missing.

The file holds the proxy's secret, so it is written with mode `600` in a `700`
directory, and loading refuses a file that group or others can access
(`chmod 600` it, or run `ccmproxy config init`).

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

- `listen_http`: a literal loopback IP with an explicit port (see above).
- `upstream`: only `https://api.anthropic.com` is accepted; the passthrough
  carries the Claude Code login.
- `auth_token`: the secret Claude Code sends in the `X-Ccmproxy-Token` header
  (through `ANTHROPIC_CUSTOM_HEADERS`). `serve` refuses to start without it
  or without `session_salt`.
- `session_salt`: mixed into the hash of Claude Code's `metadata.user_id`
  before it becomes the Codex session id.
- `codex.base_url`: must be `https://`; the ChatGPT access token is sent to
  it.

Keys of earlier versions — `listen_proxy`, `listen_tls`, `intercept_hosts`,
`proxy_username`, `proxy_password`, `ca_dir` and `dns` — are refused by name;
remove them from the file.

## What the translation covers

Anthropic Messages ⇄ OpenAI Responses, in both directions:

- **System prompt** → a `developer` input message.
- **Text, images and PDFs** → `input_text` / `input_image` / `input_file`.
  Non-PDF documents are dropped, which is all the Responses API accepts.
- **Tools** → `function` tools; `input_schema` is normalized (`$schema`
  removed, `properties` filled in). Names over 64 characters are shortened
  uniquely — MCP tools keep their leaf name — and mapped back on the way out,
  so the client always sees the name it registered.
- **Tool calls and results** → `function_call` / `function_call_output`, with
  ids shortened by hash when they exceed the upstream limit.
- **Thinking** → reasoning summaries stream back as `thinking` blocks, and each
  block carries the encrypted reasoning state as its signature so the next turn
  can replay it. Parallel tool calls are serialized into non-overlapping
  content blocks, which is what the Messages API requires.
- **Reasoning effort** ← the model name suffix, otherwise derived from
  `thinking.budget_tokens`.
- **Usage** → `input_tokens` / `output_tokens`, with cached tokens reported
  separately as `cache_read_input_tokens`.

Non-streaming requests go through the same translator and are then folded back
into one message, since the Codex backend only serves streaming responses and
does not repeat the output items in its terminal event.

### Compressed request bodies

Claude Code gzips request bodies once they grow past a threshold, so most real
sessions arrive as `Content-Encoding: gzip`. The router decodes the body to
read the model name — otherwise every large request would look like one for an
unknown model and be sent to Anthropic regardless of what was selected.

Pass-through still forwards the **original compressed bytes** and the client's
`Content-Encoding` untouched; only a body the proxy has to rewrite is sent
decoded, with the coding header dropped. `gzip` and `deflate` are decoded;
anything else (a request under `br` or `zstd`, or a corrupt stream) is
forwarded untouched with a warning, since a request that cannot be inspected
can still be proxied.

### Two deliberate deviations from byte-exact pass-through

- **`/v1/messages/count_tokens` for an added model** is answered locally with a
  length-based estimate. The Codex backend exposes no counting endpoint and its
  tokenizer is not public, so the estimate is deliberately conservative —
  Claude Code uses this number to decide when to compact a conversation.
- **Thinking blocks this proxy issued are stripped** from requests that go to
  Anthropic. Codex reasoning state is not a valid Anthropic signature, so a
  session that switched from a Codex model back to a Claude model would
  otherwise be rejected upstream. Requests that never touched a Codex model are
  detected by a byte scan and pass through unmodified.

## Tests

```sh
go test ./...
```

The suite runs the whole path without network access:

- The configuration: the loopback-only listener (a table of accepted and
  refused addresses), the pinned upstream and `https` Codex base URL, removed
  keys refused by name, file modes, and `config init` creating a file or
  upgrading one in place.
- The start-up check that refuses an upstream resolving to a local address.
- Model-list merging and byte-for-byte pass-through fidelity.
- The streaming translation state machine, including parallel tool calls.
- OAuth exchange and refresh against a fake token endpoint; reading a Codex
  CLI `auth.json` and never writing, refreshing or removing it (an expired one
  fails without a network call, an `auth_file` resolving to it is refused);
  atomic `600` writes; and two stores refreshing at once spending the refresh
  token once.
- Effort handling: that the client's `output_config.effort` reaches the Codex
  backend, that it is clamped to the levels the real model has, and that an
  effort pinned in the model name overrides it.
- Compressed request bodies: that a gzipped or deflated request for an added
  model is routed to it, that pass-through keeps the original bytes and
  coding, that a rewritten body drops the coding, and that an undecodable or
  corrupt body is forwarded byte for byte.

## Security notes

- The listener binds only to a literal loopback address, checked in the
  configuration and again on the bound socket.
- Pass-through goes only to `https://api.anthropic.com`, and the Codex token
  only to an `https://` base URL. `serve` refuses to start when
  `api.anthropic.com` resolves to a local address, which is what a leftover
  `/etc/hosts` redirect looks like.
- Upstream connections ignore the ambient proxy environment variables, so a
  stale `HTTPS_PROXY` cannot point the proxy at itself.
- The configuration file holds `auth_token` and is kept at mode `600`;
  credential files are written with mode `600`.
- ID and access tokens are read for the account id, plan and expiry only; their
  signatures are not verified, because they arrive over TLS directly from the
  issuer's token endpoint and are never trusted as proof of anything.
