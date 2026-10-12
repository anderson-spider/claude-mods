# Privacy and permissions

What each plugin reads, saves and sends. Everything stays on your machine except where a section says otherwise.

## chatgpt

- **Sent:** the prompt, and any files you attach, go to chatgpt.com through the tab of your logged-in browser (terminal-browser). The plugin never sees your ChatGPT credentials; it drives the page you are already signed in to.
- **Saved:** answers are written to `$TMPDIR/chatgpt/` (`/tmp/chatgpt/` when `TMPDIR` is unset). Generated images are written there too, with a JPEG preview. The first line of an answer file is the chat URL.
- **Read:** `TMPDIR`, and the files you pass as attachments.
- **Kept in memory:** the list of background jobs, until a reload.

## codex-computer-use

- **Read:** the newest `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`, to start the computer-use server. Environment values are never printed.
- **Saved by the helper** (`~/.claude/mcp/codex-cu/state/`): `approvals.json`, the apps you answered "always" for, and `helper.log`, which records the bundle id and your choice for each approval.
- **Saved by Codex:** answering "always" makes Codex save the app in its own `ComputerUseAppApprovals.json`. `/codex-cu forget` removes the app from both files; the plugin only ever removes from Codex's file.
- **Not stored:** what you see in the apps. The helper passes screen content between Claude and the computer-use server and keeps none of it.
- The helper listens on a Unix socket under `~/.claude/mcp/codex-cu/run/`, readable by your user only. Auto-approve is off by default.

## codex-models

- **Sent:** a session or subagent that uses a Codex model sends its conversation, including what its tools read from the repository, through the local proxy to OpenAI's Codex backend (`chatgpt.com`), under your ChatGPT login. Claude models go through the same proxy to `api.anthropic.com` unchanged, with your usual Claude Code login. Besides those calls, the proxy talks to OpenAI's sign-in server (`auth.openai.com`) for the ChatGPT login: once when you run `ccmproxy login codex`, and to refresh the access token with the stored refresh token when a Codex request finds it within 5 minutes of expiry. It sends one more request only when asked: `GET /__ccmproxy/status?refresh=limits` (sent by the crew's quota routing, see below) may read the unofficial `wham/usage` endpoint at `chatgpt.com`, at most once every 5 minutes, with the access token the proxy already holds (it never starts a token refresh for it) and no prompt. A plain status never calls OpenAI. The plugin's hooks never send anything off the machine: the status check at session start, and `/codex-models:status`, only probe the local proxy at its loopback address (the session's base URL when that is loopback, else the configured listen address), with the proxy's secret.
- **Listens:** the proxy binds a loopback address only, on a random port chosen at install, and refuses any other listen address. A process on your machine that knows the secret can use it.
- **Saved:** `~/.claude/codex-models/` holds the proxy binary, copied scripts, logs, config (with the proxy's secret, `auth_token`) and native ChatGPT credentials. `ccmproxy login codex` writes `<auth_dir>/codex.json` atomically at mode 600 in a mode-700 directory; one lock beside that credential file coordinates login, refresh and logout. `~/.claude/settings.json` holds the proxy secret as an `X-Ccmproxy-Token` line in `env.ANTHROPIC_CUSTOM_HEADERS`. Each install or uninstall that changes an existing settings file leaves a mode-600 backup beside its symlink-resolved target, `settings.json.bak-codex-models-<timestamp>`, which can hold the same line. The scripts never delete backups or record earlier settings values.
- **Read:** the proxy reads its native ChatGPT credentials, not Codex CLI credentials. The installer reads its proxy config and `~/.claude/settings.json` to merge current entries; the session-start probe reads the proxy's base URL and secret from the session's environment.
- **Logged:** the proxy logs method, path, status, sizes and duration; never query strings (so `?refresh=limits` is not logged), the secret, tokens, prompts or the message text of a Codex error. An outbound error's logged text has the URL's query and userinfo cut. The log is `~/.claude/codex-models/home/log/ccmproxy.log`; at start it names the ChatGPT account (its email, or the account id) and plan, and the credential file in use. The status keeps the latest Codex rate-limit readings (percent used, window length, reset time) in memory only.
- **Removed:** `~/.claude/codex-models/uninstall.sh` takes no flags. It removes the loopback HTTP base URL only when our token header was present, removes our header lines, `ENABLE_TOOL_SEARCH` and marked picker rows, drops empty owned containers, and keeps unrelated settings and `settings.json`. Cleanup and its backup must succeed before it stops and removes the LaunchAgent; a failure keeps the service loaded. `~/.claude/codex-models/` remains, including login, config, logs, binary and scripts. `ccmproxy logout codex` removes the proxy's native ChatGPT credentials.

## crew

See [crew privacy and permissions](../plugins/crew/README.md#privacy-and-permissions) for Jev requests, automatic OpenAI routing, local decision records and trust boundaries.

## tailscale

- **Read:** `TS_API_KEY`, on every call. It is never taken from tool input.
- **Sent:** requests to the Tailscale API only.
- **Filtered:** read responses drop `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token`, and any field whose name ends in `Key`, `Secret` or `Token`. Write responses are not filtered, because a new key's secret comes back once.
