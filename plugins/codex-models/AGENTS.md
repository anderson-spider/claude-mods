# codex-models

Installing, using, checking privacy or planning live validation: read [README.md](README.md). This file owns editing invariants; `install.sh` owns env/model integration because hooks cannot set it.

## Map

- `hooks/register.tsx`: session probe and `/codex-models:status`; `hooks/status.ts`: pure, injected network/timer. `commands/status.md` is the fallback.
- `install.sh`, `uninstall.sh`, `install/cli.mjs` (I/O), `install/settings.mjs` (pure merge/masking): copied to `~/.claude/codex-models/`; LaunchAgent `com.anderson-spider.codex-models`.
- `proxy/` is standard-library-only Go; keep the empty `go.sum` for CI. `cmd/ccmproxy` owns CLI and shutdown; `internal/config` owns config; `internal/proxy` owns the listener.
- `internal/router`: `guard.go` (entry), `router.go` (dispatch), `messages.go`, `request.go`, `body.go` (request handling), `codex.go`, `passthrough.go`, `status.go`, `models.go`, `keepalive.go`.
- `internal/translate`: Messages ↔ Responses; `internal/codex`: native login/store, Responses, `catalog.go`, `limits.go`, `usage.go`.
- `internal/netx` (outbound transport), `httplog`/`logx` (logging), `tokenize` (local conservative estimate), `jsonread` (shared parsing), `jsontest` (test-only helpers); `contract/` is the black-box suite.

## Safety and contracts

- One plain HTTP listener, literal loopback IP (127/8 or `::1`), explicit port; verify the bound socket too. No TLS listener, CA, CONNECT, hosts redirect or DNS resolver. Upstream stays `https://api.anthropic.com` and must not resolve to loopback; Codex base URL must be HTTPS.
- Before routing, remove `X-Ccmproxy-Token` and compare its SHA-256 digest in constant time. Match `Host` to the listener; allow only GET/POST/HEAD, no CORS headers. Local unauthenticated `HEAD /api/hello` returns empty 200. Secret misses, Codex 401 and login failures return **403 `permission_error`, never 401**.
- Every outbound transport uses `netx.DirectTransport` (`Proxy: nil`), never environment proxies, including nil-transport fallbacks. Never follow redirects on token, Responses, usage, model-list or passthrough requests; Codex 3xx is an error, Anthropic 3xx passes through.
- Single-user assumption: while the proxy is down, another local user can bind its port and receive the secret/bearer. Keep LaunchAgent restart-on-failure and 30 s throttle; the proxy cannot eliminate this risk.
- Native credentials only: `<auth_dir>/codex.json`; refuse symlinks (dangling too), read with `O_NOFOLLOW`. Canonicalize the parent for one exclusive `codex.json.lock`; wait at most 45 s, cancellably, release on every path, re-read under lock. Save atomically (temp, sync, 0600, rename), directory 0700. Callback refuses non-GET (405) or missing/wrong `state` (400, constant-time match) without ending login. Token claims supply account/plan/expiry from the TLS issuer; signatures are not locally verified.
- Rejected refresh stays latched as `ErrLoginExpired` until the credential file/refresh token changes or login is saved; a still-valid access token remains usable without retrying the rejected refresh.
- Never log queries, userinfo, secrets, tokens, prompts, tool arguments or upstream error bodies/messages. Only identifier-like upstream error type/code may be logged; client error text is sanitized/capped by `translate.CleanMessage`.
- Config: `listen_http`, `upstream`, `auth_token`, `session_salt`, `auth_dir`, `log_level`, `codex.base_url`; file 0600, directory 0700, refuse loose files or serving without either secret. `config init` preserves unknown members and adds only missing secrets.
- Preserve names `ccmproxy`, `X-Ccmproxy-Token`, `CCMPROXY_HOME`, error prefix `ccmproxy:` and literal `unexpected Host header` (hooks/installer readers); transcript signature `ccmp1:<encrypted_content>` (strip proxy thinking before Anthropic); tool-name cut/de-duplication at 64 characters.
- Readers depend on status `{service:"ccmproxy",version,codexLogin,models,codexLimits}`, model rows `{id,label,description,behavesAs}`, and `env --shell json` keys `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ENABLE_TOOL_SEARCH`. Keep posix/fish/powershell/json shells, `-X main.version`, and the `vcs.revision` version line.
- `codexLimits` is always present (empty array without readings); rows are `{kind,percentUsed,resetsAt?,windowMinutes,observedAt}`, with `five_hour`, `seven_day`, or `window_<minutes>m`. Plain status never calls OpenAI. Only `?refresh=limits` may read `wham/usage`, using the held token, never refreshing it or waiting for a refresh; skip tokens within 5 min of expiry. Single flight, 5 min backoff including failures, status waits at most 1 s (`internal/codex/usage_test.go`, `internal/router/status_limits_test.go`).
- Fixed backend `UserAgent`, `Originator` (`codex-tui`), `CallbackPort` (1455). Responses headers: `Content-Type`, `Authorization`, `Accept: text/event-stream`, `Connection: Keep-Alive`, `User-Agent`, `Originator`, `Chatgpt-Account-Id` (only with account id), `Session_id` (HMAC-SHA-256 of user id keyed by `session_salt`, v4 UUID). Usage uses the same auth/identity headers, `Accept: application/json`, no `Session_id`.
- Contract seams only in `contract_on.go` with `//go:build contract`, inert `contract_off.go` plus public-API default-build tests; normal binary must contain no `CCMPROXY_CONTRACT` string. Installer builds with `env GOFLAGS=-tags= GOTOOLCHAIN=local`; pins match root `mise.toml` (`tests/scripts/install.test.mjs`). macOS/Linux proxy, macOS-only installer.
- Shutdown stays in `cmd/ccmproxy`: stop accepting, drain up to 5 s on SIGTERM/SIGINT, close remainder, exit 0; ignore a second signal during drain.
- Preserve informational 1xx passthrough (except 101), Codex-only invalid UTF-8 replacement with U+FFFD, and no iteration of objects in array positions. Tested translation/stream details: `internal/translate/{codex_to_claude,json_rules,tool_call_order}_test.go` (upstream model, complete tool calls, max-token stop, frame order and JSON bytes); `internal/router/{codex,request,keepalive,keepalive_adversarial,contract_off}_test.go` (effort, parsing, truncation, pings); `internal/httplog/{httplog,lines}_test.go` (size formatting).
- Other tested behavior: `internal/codex/models_test.go` (catalog/`behavesAs`/spellings), `internal/config/case_keys_test.go` (decoding), `contract/errors_test.go` (error mapping), `internal/codex/login_state_test.go` (nonblocking status), `cmd/ccmproxy/{version,contract_on}_test.go` (help/build stamp), `internal/router/router_test.go` (local token counting). Do not duplicate their matrices here.

## Installer and hooks

- Order: precheck before build/copy/plist/launchctl → pinned normal build → config init → LaunchAgent → authenticated preflight (403 without secret, HEAD 200, authenticated status identifying this service/version) → settings write. Never point settings at a down/foreign proxy. Malformed settings or a different base URL require refusal before changes (`tests/scripts/install.test.mjs`).
- Atomic settings writes beside the symlink-resolved target: 0600 temp/rename, refuse concurrent changes. Before changing an existing file, create a timestamped 0600 backup beside it; none on no-op. Restrict settings and regular old backups to 0600 even on no-op; do not follow backup symlinks/directories. Abort on filesystem failure; retain backups (may contain secrets).
- Owned settings are the base URL, token header, tool-search key and `(codex-models)` picker rows; preserve unrelated settings, no value/history restoration. Merge/unmerge rules and idempotence: `tests/settings.test.ts`.
- Uninstall cleans/backs up settings **before** unloading the LaunchAgent; failure keeps it loaded. Retain installation/login/config/logs/scripts, never migrate or clean unreferenced files. Secret must never enter argv, output, plist or backup names; mask old/new header values in dry runs.
- Install accepts only `--check` (no changes), `--dry-run` (masked diff, no changes) or no arguments; uninstall takes none.
- Session probe sends the secret only to a path-free loopback HTTP base URL, with a 1.5 s host-clock deadline; probe/filesystem failures never block start. Notices/reports never quote reply bodies or secrets. Hook outcomes/report fields: `tests/{status,register}.test.ts`.

## Checks

Run from the repository root (tool versions in `mise.toml`):
- `claude plugin validate plugins/codex-models`; `claude plugin test plugins/codex-models`; `tsc -p plugins/codex-models/tsconfig.json`.
- `go -C plugins/codex-models/proxy test -race ./...`; `go -C plugins/codex-models/proxy test -race -tags contract ./...` (local fakes; CI requires a build revision). Re-record only goldens allowed by `proxy/contract/README.md`, one test at a time.
- `node --test plugins/codex-models/tests/scripts/*.test.mjs` (temporary HOME/fakes); `node scripts/check-consistency.mjs`; `node scripts/check-version-bump.mjs origin/main`.

Live validation: use the current gaps in [README.md](README.md#tests-and-live-gaps); keep their status there rather than duplicating it.
