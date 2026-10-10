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
- **Edit gate:** when the `gate` option is on, the main session's `Edit`, `Write` and `NotebookEdit` calls are judged locally by size and path rules from the tool name, the resolved path and the line counts. Nothing about them (no path, content or metadata) leaves the machine, the gate makes no network request and it reads no API key. The judge's `judgeKey` option is not used by the gate.
- **Sent and executed:** agents use the session's tools and permissions. The panel's tracking itself only watches and passes events on unchanged; it adds no network requests or file writes.

### Judge (optional)

The decision flow can ask an outside judge, Jev, to check the agent's own report at a task end or a retry. It is off by default and is the only part of pantheon that sends text off the machine.

- **When:** only while the `judge` option is `shadow` or `escalate`, a `judgeKey` is set, and the plan in force is approved, at the end of a flow task whose checks pass (and that is not a side-effect task) or whose failing check has attempts left. With `judge` `off` (the default) nothing is sent, no key is read and none of the settings sources below is read; with `judge` on but no key, nothing is sent and they are not read either. "Off" is the value the plugin ends up with, not only yours: if a cloned repository's `.claude/settings.json` sets `judge` and `judgeKey` while yours is off, the plugin sees it on with a key, reads the settings sources below to tell whose option it is, and then turns it off because it is the repository's. Nothing is sent and nothing is stored, but those sources are read.
- **Sent:** three texts, as one request: the task's goal as the approved plan block states it (for a task adopted from a plan edit, as the lead wrote it); the last 2000 characters of the agent's final message; and, on a retry, the last 1500 characters of the first failing check's output and of the previous failing output. The request also carries the fixed questions (in English) and the model's name.
- **Redacted:** before sending, secrets in common shapes (API keys, tokens, passwords, credentials in URLs), email addresses and file paths (your home becomes `~`, the repository root is dropped, any other absolute path becomes `<path>`) are removed, and nothing else. Code, diffs, commands, file excerpts and names that the message or the output quotes are sent as written. This is pattern-based masking, not a guarantee that all secrets are removed: an unquoted `api_key => value`, and a value after any other unquoted separator the masking does not know, is not redacted, by design. The plan as a whole, other tasks, file contents and the lead's messages are not sent as such.
- **Where:** `openrouter.ai` (`/api/alpha/decisions`), or `api.typesafe.ai` (`/v1/systemone`) with `judgeRoute` set to `typesafe`, or the host of your own `judgeBaseUrl` (https, or a loopback address). One request per delivery, 3 seconds at most. The key travels only in that request's `Authorization` header: no `HTTP-Referer`, no `X-Title`, not in the body. The typings of the host's `$.http.fetch` do not say whether a redirect is followed with that header kept and offer no option to refuse one, so the route hosts are trusted not to redirect elsewhere.
- **Key:** read only from the plugin's own options (stored as a secret): not from a file of the repository, not from `pantheon.json`, not from the environment. It is never logged, journaled, stored in a file, shown in a toast or kept in an error message.
- **Read:** once a key is set, each of the engine's settings sources (user, project, local, flag and policy), only to tell your plugin options from ones a cloned repository carries (a repository's settings can outrank yours). The engine hands each source over whole, `env` and helper commands included; only this plugin's `pluginConfigs` entry is looked at, and nothing from them is stored or sent. An option that only the repository set is ignored (your own value for it is used), and when a source cannot be read the judge is off for the session. Options you set in your own `.claude/settings.local.json` count as the repository's and are ignored: set them in your user settings. You are told once per kind of problem, naming the options and never their values.
- **Saved:** in `.pantheon/flow/<plan>/journal.jsonl`, one entry per judged checkpoint: the model asked for and the one that answered, the request id and usage, a hash of the question set, the answers as returned, the thresholds, what they escalated to and what happened; for a failed call its reason, the HTTP status, `retryAfterMs`, whether it switched the judge off, and `detail` (up to 200 characters, for any failure: for a malformed answer up to 40 characters taken from the response; for a network failure the host's own error message, which can include the gateway's host name; for a rejection the provider's error code, never its message). Never the key, the goal, the agent's message, a check's output or a command. In `.pantheon/flow/<plan>/state.json`, while the judge is on: each failing task's last check output (redacted as above, up to 1500 characters), kept for the next retry's comparison and dropped when the task is done, passes, or the judge is turned off.
- **Effect:** the judge can only make a decision stricter (ask for a QA verdict, or send a failing task to the architect's diagnosis); it never marks a task done. Its answers are kept nowhere outside the journal above.
