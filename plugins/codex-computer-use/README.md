# codex-computer-use

Control native Mac apps through Codex computer use, bundled with the ChatGPT desktop app. Claude chooses the task; Codex clicks/types in the background without taking over your mouse.

It has two parts: the plugin, installed in Claude Code, and a local helper (a per-user LaunchAgent) that talks to Codex. Until the helper is installed, bridge calls cannot reach Codex, while the route (on by default) still blocks Claude's own desktop tools.

## Requirements

- macOS.
- The [ChatGPT desktop app](https://openai.com/chatgpt/download/) with Computer Use turned on in Codex. The helper runs on the Node.js bundled with it.
- Claude Code; see the version in the [root README](../../README.md#install).

## Install

One command installs the plugin and the helper, and also updates both later:

```sh
curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh -s -- --only codex-computer-use
```

Add `--check` after `--only codex-computer-use` for a dry run that changes nothing. Then start a new Claude Code session, or run `/reload-plugins`, and check it with `/codex-cu status`, which should report `Helper: <version> running`.

Step by step instead:

1. In Claude Code:

   ```text
   /plugin marketplace add anderson-spider/claude-mods
   /plugin install codex-computer-use@spider-claude-mods
   ```

2. From a clone of the repository, install the helper:

   ```sh
   plugins/codex-computer-use/helper/install.sh
   ```

The helper goes to `~/.claude/mcp/codex-cu` and starts at login. Rerun the install after updating the plugin so the helper matches it. `install.sh --check` only checks the prerequisites. Neither script edits Claude settings.

To remove it, run `~/.claude/mcp/codex-cu/uninstall.sh`: it unloads the LaunchAgent and keeps the code, approvals and logs. Then `/plugin uninstall codex-computer-use@spider-claude-mods`.

## Troubleshooting

- `/codex-cu status` says `Helper: not reachable`: the helper is missing or stopped. Rerun the install command above; it prints what is missing, such as the ChatGPT app.
- The plugin starts with the route on, so Claude's own desktop tools stay blocked while the helper is down. `/codex-cu off` gives them back until the helper works.

## Use

```text
/codex-cu on | off | status
/codex-cu forget
/codex-cu forget <app>
/codex-cu auto-approve on | off
```

While on, native desktop control uses `mcp__codex-computer-use__codex_cu`; Claude's desktop tools are blocked. Browsers, CLIs and purpose-built tools remain available. A new or reset Codex session must start with one documented entry call on its own, such as `cua.getState()` or `cua.getApp(...)`; Claude reads the documentation that call returns before further actions.

New apps ask in a band: **This session**, **Always** or **No**. Auto-approve defaults off; organization/safety blocks remain in force when it is on. A refusal is final for that caller. Questions expire five minutes from before entering the queue, including queue time; failures/timeouts do not approve. `forget` ends this session's Codex sessions and drops its app answers; `forget <app>` removes always-allow in both the helper and Codex.

Each Claude session/subagent gets a persistent Codex session. App ownership lasts two minutes after its last use, and `/codex-cu status` lists only apps still held. Literal `cua.getApp(...)` names are checked before calls; an app reached through a variable is owned only after its first reported result. Read and act in one call to avoid Codex's stale-state refusal. These ownership checks are not an isolation sandbox.

## Privacy

- **Read:** the newest Codex `unified-computer-use` bundle's `.mcp.json` to launch `cua_repl` with the desktop surface. Environment values are not printed.
- **Sent:** requested screen/app content passes through the computer-use server to Codex; the helper keeps none of that content.
- **Saved:** helper `state/approvals.json` and `state/helper.log` record always-allow apps and approval choices/bundle ids. Codex saves its own `ComputerUseAppApprovals.json`; the helper only removes from that file, while Codex handles additions.
- **Local access:** helper directories are 0700 and its Unix socket is 0600 under `run/helper.sock`. These protect against other local users, not processes running as you.

## Tests

Plugin tests use the test host and injected clocks; helper tests use fake dependencies, an isolated installation and a fake MCP server. They cover routing, approvals/deadlines, ownership, protocol contracts and installer flags without touching installed run/state directories. No end-to-end run of the real desktop-control runtime is established by these tests.

For the module map and check commands, see [AGENTS.md](AGENTS.md).

## Credits

Inspired by [claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads) by Prompt Advisers (MIT). The idea of routing Claude's desktop control through Codex computer use, the `/codex-cu` command and the guidance this plugin gives Claude for driving Codex follow that project; the code here was written separately.
