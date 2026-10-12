# Upstream

Vendored from a fork of ccmproxy.

- Upstream: https://github.com/jclab-joseph/claude-code-model-proxy, commit `1125881` (`docs: lead with the /etc/hosts setup and show the model picker`).
- Fork: `andersonsilva/hardening`, commit `267fe57` (`chore: pin Go with mise and drop the license file`), taken with `git archive`.
- Left out of the copy: `.github/`, `run.sh`, `docs/` and the fork's `mise.toml` (Go is pinned in the repository's root `mise.toml`).
- Go module path unchanged: `github.com/jclab-joseph/claude-code-model-proxy`.
