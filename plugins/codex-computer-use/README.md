# codex-computer-use

Control native Mac apps through Codex computer use, bundled with the ChatGPT desktop app. Claude chooses the task; Codex clicks/types in the background without taking over your mouse.

```text
/plugin install codex-computer-use --marketplace anderson-spider/claude-mods
```

## Setup

Requires macOS and the ChatGPT app with Codex Computer Use enabled. From a repository checkout:

```sh
plugins/codex-computer-use/helper/install.sh
```

This installs the helper at `~/.claude/mcp/codex-cu` and loads its LaunchAgent; rerun after helper updates. `--check` checks prerequisites without installing. For removal, run `plugins/codex-computer-use/helper/uninstall.sh` with no arguments: it removes the LaunchAgent and retains code, approvals and logs. Neither script edits Claude settings.

## Use

```text
/codex-cu on | off | status
/codex-cu forget
/codex-cu forget <app>
/codex-cu auto-approve on | off
```

While on, native desktop control uses `mcp__codex-computer-use__codex_cu`; Claude's desktop tools are blocked. Browsers, CLIs and purpose-built tools remain available. The bridge returns its current API documentation on the first entry call: Claude reads that before further actions.

New apps ask in a band: **This session**, **Always** or **No**. Auto-approve defaults off; organization/safety blocks remain in force when it is on. A refusal is final for that caller. Questions expire five minutes from before entering the queue, including queue time; failures/timeouts do not approve. `forget` clears this session's answers; `forget <app>` removes always-allow in both the helper and Codex.

Each Claude session/subagent gets a persistent Codex session. App ownership lasts two minutes after its last use. Literal `cua.getApp(...)` names are checked before calls; an app reached through a variable is owned only after its first reported result. Read and act in one call to avoid Codex's stale-state refusal. These ownership checks are not an isolation sandbox.

## Privacy

- **Read:** the newest Codex `unified-computer-use` bundle's `.mcp.json` to launch `cua_repl` with the desktop surface. Environment values are not printed.
- **Sent:** requested screen/app content passes through the computer-use server to Codex; the helper keeps none of that content.
- **Saved:** helper `state/approvals.json` and `state/helper.log` record always-allow apps and approval choices/bundle ids. Codex saves its own `ComputerUseAppApprovals.json`; the helper only removes from that file, while Codex handles additions.
- **Local access:** helper directories are 0700 and its Unix socket is 0600 under `run/helper.sock`. These protect against other local users, not processes running as you.

## Tests

Plugin tests use the test host and injected clocks; helper tests use fake dependencies, an isolated installation and a fake MCP server. They cover routing, approvals/deadlines, ownership, protocol contracts and installer flags without touching installed run/state directories. No end-to-end run of the real desktop-control runtime is established by these tests.

For the module map and check commands, see [AGENTS.md](AGENTS.md).
