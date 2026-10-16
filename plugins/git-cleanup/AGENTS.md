# git-cleanup

Usage/privacy: [README.md](README.md).

- A skills-only plugin: `skills/cleanup/SKILL.md` and the manifest. No `hooks/` and no `tsconfig.json`, so `claude plugin test` and `tsc` do not apply; CI and the npm tasks skip both for it.
- The skill is user-invoked only (`disable-model-invocation: true`) and must stay repository-agnostic: no repository name, path, branch prefix or host is hard-coded. The user's own prefix, protected branches, report headings and host CLI alias come from their instructions at run time.
- Safety invariants, which an edit must keep: list before any deletion; the never-touch list (default branch, `main`, `master`, `develop`, `release`, `release/*`, `release-*`, host-protected and instruction-protected branches) is Keep and unselectable even on request; someone else's branch is only ever Ask with an item-level OK; no `--force` worktree removal or plain `--force` push; each tip is re-checked before deletion; without a way to ask, stop after the listing.
- Checks: `claude plugin validate --strict plugins/git-cleanup`; `node scripts/check-consistency.mjs`.
