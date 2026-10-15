# Security

These plugins run code on the machine of whoever installs them: hooks modules run inside Claude Code with the user's permissions, and the codex-computer-use helper runs as a LaunchAgent. Every change merged into `main` reaches installed copies on their next update, so a vulnerability here is a vulnerability on users' machines.

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/anderson-spider/claude-mods/security/advisories/new) (Security tab, "Report a vulnerability"). Do not open a public issue or pull request for it.

Include the affected plugin and version (`version` in its `plugin.json`), the Claude Code version, what an attacker can do, and the steps or input that show it. You will get an answer in the advisory; a fix ships as a plugin version bump, and the advisory is published once installed copies can update.

## Scope

In scope: the plugins under `plugins/`, the helper under `plugins/codex-computer-use/helper/`, and the scripts under `scripts/` (including `bootstrap.sh`). Examples: a hook that sends a token or API key to a host other than its own, a tool input that escapes its path or API checks, a prompt injection that makes a plugin act without the user's request, or a helper route reachable by another local user.

Out of scope: Claude Code itself (report to Anthropic), ChatGPT, GitLab, Tailscale and the other services the plugins call, and setups that put a secret in a repository's settings, which the plugins refuse.

## Secrets

Plugins read tokens and API keys only from the user's own plugin options or environment, never from this repository. Never commit a token, key, internal host name or work data, including in tests and examples: use placeholders such as `gitlab.example.com` and `group/app`.
