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

## pantheon

- **Read:** user and repository `pantheon.json` configuration and the session's repository root. The panel watches native subagent spawns (type, description and model), step usage, completion status and tool inputs, plus the main session's model, effort, turn timing and context readings.
- **Read by the above-prompt strip:** the usage figures Claude Code provides (context, 5-hour and 7-day limits, the session cost, each request's token counts and cache figures), and, for the last-turn receipt, which main-loop tools ran (only their names, to count edits and failed calls) and how many subagents were spawned, as counts that are not saved, the prompt-cache environment switches (`DISABLE_PROMPT_CACHING`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`), and git facts (repository name, branch, changed files and line counts) from `git` processes run in the session's working directory.
- **Saved by the strip:** in the plugin's local store, the latest limits reading (shared across sessions) and, per session, recent context readings, the last request's cache figures and, for the pace projection, up to about 10 recent `{time, percent used}` readings per limit window together with that window's reset time (no other data; they start over when the reset time changes or the use drops); a session idle for 8 days is deleted. The strip makes no network requests.
- **Saved in `$.state`:** `pantheon.natives` keeps at most 24 native records with spawn descriptions, model, rounds, token readings, step counts and the latest short tool description. `pantheon.session` holds main-session readings; `pantheon.view` holds the folded groups. Native, session and view snapshots use queues that keep only the latest pending snapshot. After reload, running native rounds are marked lost.
- **Redacted:** native tool descriptions keep at most 64 characters and mask common credential patterns before shortening; only paths from `file_path` keep their last two components. Text from `command`, `pattern`, `url` and `description` is redacted and shortened without trimming path components, so full paths embedded in those fields can remain. This is pattern-based masking, not a guarantee that all secrets are removed. Spawn descriptions are not covered by that masking.
- **Edit gate:** when the `gate` option is on, the main session's `Edit`, `Write` and `NotebookEdit` calls are judged locally by size and path rules from the tool name, the resolved path and the line counts. Nothing about them (no path, content or metadata) leaves the machine, the gate makes no network request and it reads no API key. Jev's key is not used by the gate.
- **Sent and executed:** agents use the session's tools and permissions. The panel's tracking itself only watches and passes events on unchanged; it adds no network requests or file writes.

### Jev (optional)

At every Stop that the flow's budgets, caps, regressions and loop phases do not settle, the flow asks an outside judge, Jev, where the work is; without a key no flow starts. It is the only part of pantheon that sends text off the machine, and it runs only while a flow started with `/pantheon:goal` (or at your request) is active and a key is set.

- **Key:** the plugin's `judgeKey` option (stored as a secret) or, when it is empty, the `OPENROUTER_API_KEY` environment variable. Claude Code also puts the settings' `env` blocks into the environment, so an `OPENROUTER_API_KEY` that the repository's `.claude/settings.json` or `.claude/settings.local.json` declares is ignored: a cloned repository cannot send your flow's data under its own account. To tell, pantheon reads those two settings sources once and looks only at `env.OPENROUTER_API_KEY`; if they cannot be read, the environment key is not used. The key goes only in the request's `Authorization` header and is never logged, stored in a file or shown; the status says only where it came from.
- **When:** at a Stop of the main session that those deterministic rules do not settle, at most `max_jev_calls` times per flow (200 by default), up to two requests per Stop (the judgment, then a verify call on the phase it picked).
- **Sent:** the flow's goal and phases (names, `done_when`, status), the current phase, each check's result with up to 800 characters of failing output, the tail of the lead's last message, the uncommitted file names with line counts (the diff only when the flow sets `privacy.send_diff`) and the last few decisions, plus the fixed questions and the model name (`typesafe/jev-1.13`).
- **Redacted:** secrets in common shapes are removed from every string before it is trimmed and sent. This is pattern-based masking, not a guarantee that all secrets are removed.
- **Where:** `openrouter.ai` (`/api/alpha/decisions`), 15 seconds per attempt, retried up to 3 times on 429 and 5xx answers.
- **Saved:** in the flow's `state.json`, the number of Jev calls, the last failed call's error (redacted, at most 300 characters) and each Stop's decision with the judged probabilities. Never the key or the request text.
- **Effect:** Jev's answer feeds the flow's fixed policy; it never marks a phase done without its verify call, and without Jev nothing advances: with no key a flow does not start, and a Jev failure holds the Stop once with a message to fix Jev or disable the plugin.
