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

## crew

Jev routing runs only when the `jevKey` option is filled in; with it empty, nothing is sent and no settings are read. The key is kept in Claude Code's secure storage (the option is marked sensitive), not in a settings file. Whether `$.config.list()` returns a sensitive value to other plugins is unverified. The key is checked once per activation (a `/reload-plugins` or an option change resolves it again), on the first request (the lead's prompt section names Jev only when there is one). The agents themselves read and send nothing.

- **Sent** (only with `jevKey` set, one request per `crew:*` Agent call that does not name a model and is not a fork or a workflow script's agent, to `https://api.typesafe.ai/v1/systemone`): the agent name, the call's description and its prompt. Secrets in common shapes, emails and absolute paths are removed first (paths under the repository become relative, your home becomes `~`; when no home can be trusted, the user's home under `/Users` or `/home` in the session's directory stands in for it), and the prompt is cut to 4000 characters.
- **Read:** the `jevKey` option, and `HOME`. The environment variables `TYPESAFE_API_KEY` and `JEV_API_KEY` and `~/.jev-router.env` are not read. A `jevKey` declared by the repository's project or local settings turns routing off entirely; a `HOME` declared there is ignored (the home is also skipped when it is not absolute), and when those settings cannot be read routing is off completely. A key that is not printable ASCII without spaces, or longer than 512 characters, is not used. The key is sent only in the `Authorization` header and is never logged. The settings of the repository are read only when a key is set, to check that it does not declare `jevKey`.
- **Shown** (only with `jevKey` set): on a routed subagent's first answered step, one transcript line with the call's description and the model and effort it ran on; like every transcript line it is also written to the debug log.
- **Saved** (only with `jevKey` set): each decision goes to the debug log of the session, without the prompt, and to one small JSON file in `~/.claude/crew/decisions/` (the home that was trusted for the key, never the repository's). The file holds the time, agent name, tier, confidence, depth, default and final model, default, planned and applied effort, what the first step ran on (the model id the API reported and the effort sent), Jev model id, duration and a short non-cryptographic hash of the call description (to match cases without keeping the text; a short, common description can be guessed from it); never the prompt, the description, the key or a path. Nothing in it leaves the machine, and the plugin never prunes it (about 400 bytes of JSON, one file each (a disk block on most file systems)). To delete it: `rm -r ~/.claude/crew/decisions`.
- **Kept in memory:** the resolved key and home, the effort chosen for each routed subagent and the state of the breaker, until a reload (changing `jevKey` reloads the plugin).

## tailscale

- **Read:** `TS_API_KEY`, on every call. It is never taken from tool input.
- **Sent:** requests to the Tailscale API only.
- **Filtered:** read responses drop `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token`, and any field whose name ends in `Key`, `Secret` or `Token`. Write responses are not filtered, because a new key's secret comes back once.
