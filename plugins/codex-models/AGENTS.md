# codex-models

Offers OpenAI Codex models in Claude Code through a local proxy: Claude Code reaches it with `ANTHROPIC_BASE_URL`; the proxy routes Codex model ids to the Codex backend (ChatGPT login) and passes everything else to api.anthropic.com unchanged.

- `proxy/` is a vendored, hardened fork of ccmproxy (Go, module path as upstream); `proxy/UPSTREAM.md` names the origin. Its tests run with `go -C plugins/codex-models/proxy test ./...`.
- `hooks/register.tsx` is the one hooks module; `/codex-models:status` is answered by `command.run`, and `commands/status.md` is only its fallback body. `session.start` checks the proxy once (1.5 s, only for a loopback `ANTHROPIC_BASE_URL`) and logs a line naming the case and `~/.claude/codex-models/uninstall.sh`. `hooks/status.ts` is pure (network and timer injected).
- `install.sh` and `uninstall.sh` change `~/.claude/settings.json` only through `install/cli.mjs` (files, preflight) and `install/settings.mjs` (pure merge and unmerge); both are copied to `~/.claude/codex-models/`. Install writes the settings only after the running proxy passed the preflight; uninstall takes them out before stopping the LaunchAgent. `tests/scripts/install.test.mjs` runs both scripts with `node --test` against a temporary HOME.
- The Go version is pinned once, in the root `mise.toml`.
