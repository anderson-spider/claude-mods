# codex-models

Offers OpenAI Codex models in Claude Code through a local proxy: Claude Code reaches it with `ANTHROPIC_BASE_URL`; the proxy routes Codex model ids to the Codex backend (ChatGPT login) and passes everything else to api.anthropic.com unchanged.

- `proxy/` is a vendored, hardened fork of ccmproxy (Go, module path as upstream); `proxy/UPSTREAM.md` names the origin. Its tests run with `go -C plugins/codex-models/proxy test ./...`.
- `hooks/register.tsx` is the one hooks module; `/codex-models:status` is answered by `command.run`, and `commands/status.md` is only its fallback body.
- The Go version is pinned once, in the root `mise.toml`.
