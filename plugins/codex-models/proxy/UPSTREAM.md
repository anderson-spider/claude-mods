# Upstream

Vendored from a fork of ccmproxy.

- Upstream: https://github.com/jclab-joseph/claude-code-model-proxy, commit `1125881` (`docs: lead with the /etc/hosts setup and show the model picker`).
- Fork: `andersonsilva/hardening`, commit `267fe57` (`chore: pin Go with mise and drop the license file`), taken with `git archive`.
- Left out of the copy: `.github/`, `run.sh`, `docs/` and the fork's `mise.toml` (Go is pinned in the repository's root `mise.toml`).
- Go module path unchanged: `github.com/jclab-joseph/claude-code-model-proxy`.

## Local changes

One line each, so a new upstream release can be diffed against this copy.

- Removed `internal/ca`, `internal/resolve`, `internal/proxy/proxy.go`, the CONNECT, TLS and DNS listeners, hosts interception and the bootstrap rewrite (`--experimental-modify-bootstrap-models`); `directTransport` stays, with `Proxy: nil`.
- One plain HTTP listener (`listen_http`) on a literal loopback address with an explicit port, checked again on the bound socket.
- Config: `auth_token` and `session_salt` added and required by `serve`; `use_codex_cli_auth` (default false) added; removed keys (`listen_proxy`, `listen_tls`, `intercept_hosts`, `proxy_username`, `proxy_password`, `ca_dir`, `dns`) refused by name; `upstream` pinned to `https://api.anthropic.com`, `codex.base_url` to `https://`; file mode 0600 enforced on load; `config init` upgrades an existing file in place.
- `serve` refuses to start when the upstream resolves to loopback.
- `internal/router/guard.go`: secret header (`X-Ccmproxy-Token`, SHA-256, constant time, deleted first), `Host` check, GET/POST/HEAD only, 403 and never 401, no CORS, `HEAD /api/hello` answered locally; the header is stripped again in rewrite and `fetchUpstream`.
- `GET /__ccmproxy/status` and `ccmproxy models --json`; `ccmproxy env` prints the secret header and `ENABLE_TOOL_SEARCH`, and has a `json` shell.
- Version stamped at build (`-X main.version`).
- `message_start.model` reports the model the upstream returned; `output_config.effort` takes precedence over the adaptive-thinking mapping; `tool_use` blocks pass through both SSE and JSON answers.
- `Session_id` is an HMAC of `metadata.user_id` keyed by `session_salt`.
- Error mapping to Anthropic's types; no 401 toward Claude Code (a Codex 401 or login problem is 403 naming the fix); a stream that ends without its terminal event is an error.
- Codex login: the proxy's own file by default; the Codex CLI's `auth.json` only read, never refreshed, written or removed; `auth_file` resolving to it refused; atomic 0600 write under `flock` with a re-read before refresh; a rejected refresh is `ErrLoginExpired`.
- Logs drop the query string and never carry secrets.
- Outbound transports never use the environment's proxy, including a nil transport.
- Catalog matches `codex debug models`; `gpt-daybreak-blue-latest` is opt-in through `codex.models`.
