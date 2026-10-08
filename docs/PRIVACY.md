# Privacy and permissions

What each plugin reads, saves and sends. Everything stays on your machine except where a section says otherwise.

## branch-guard

It reads the text of the Bash command Claude is about to run, runs `git` commands to measure it, and shows the result in a band. It saves nothing and sends nothing out. State lives in the session only and is cleared on reload.

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

## tailscale

- **Read:** `TS_API_KEY`, on every call. It is never taken from tool input.
- **Sent:** requests to the Tailscale API only.
- **Filtered:** read responses drop `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token`, and any field whose name ends in `Key`, `Secret` or `Token`. Write responses are not filtered, because a new key's secret comes back once.

## hud

- **Read:** the usage figures Claude Code provides (context, limits, session cost, each request's token counts), the session's subagents, and the prompt-cache environment switches (`DISABLE_PROMPT_CACHING`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`).
- **Saved:** in the plugin's local store, the latest limits reading and, per session, recent context readings, the last request's cache figures and the last prompt's cost; a session idle for 8 days is deleted.
- **Sent:** nothing. It makes no network requests.

## pantheon

- **Read:** user and repository `pantheon.json` configuration, the session directory and repository root, and Codex job output. The panel watches native subagent spawns (type, description and model), step usage, completion status and tool inputs, plus the main session's model, effort, turn timing and context readings.
- **Saved in `$.state`:** `pantheon.jobs` holds Codex job metadata, session ids for resume, activity, token usage, results and errors. `pantheon.natives` keeps at most 24 native records with spawn descriptions, model, rounds, token readings, step counts and the latest short tool description. `pantheon.session` holds main-session readings; `pantheon.view` holds the selected tab. Job, native and session snapshots use queues that keep only the latest pending snapshot. After reload, running native rounds and active Codex jobs are marked lost.
- **Redacted:** native tool descriptions keep at most 64 characters and mask common credential patterns before shortening; file paths keep only their last two components. This is pattern-based masking, not a guarantee that all secrets are removed. Spawn descriptions and Codex job output are not covered by that masking.
- **Sent and executed:** delegation sends the role and task prompt to the local `codex exec` process, which uses the configured Codex service and sandbox. Native agents use the session's tools and permissions. The panel's tracking itself only watches and passes events on unchanged; it adds no network requests or file writes. Job actions can cancel a process or copy its id and resume hint to the clipboard.
