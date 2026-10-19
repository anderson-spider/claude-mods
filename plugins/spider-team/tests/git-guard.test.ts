import { expect, test } from 'claude-code/testing'
import { refusedIn, refusal, segmentsOf } from '../hooks/git-guard'

test("Git's read-only forms pass wherever they sit, past global options and wrappers", () => {
  for (const line of [
    'git status --short', 'git diff --cached', 'git log --oneline -5', 'git show HEAD:a.ts', 'git blame a.ts',
    'git fetch origin', 'git --no-pager log', 'git -C sub rev-parse HEAD', 'sudo -u bob git status',
    'npm test && git diff --stat', 'git ls-files | wc -l', 'git grep -n foo', 'git config --get user.email',
    'git remote -v', 'git reflog', 'git stash list', 'git worktree list', 'git branch', 'git branch -a --show-current',
    'git branch --contains abc123', "git branch --format '%(refname)'", 'git tag -n5 --sort=-creatordate',
    'git tag --list "v*"', 'gh pr view 12', 'glab mr list', 'gh -R owner/repo pr checks 3', 'gh auth status',
    'git --git-dir=/p/.git log', 'gh --repo=o/r pr view 1', 'git diff-tree -r HEAD', 'git config user.email',
    'git symbolic-ref --short HEAD', 'git submodule status', 'gh run watch 5', 'gh search prs foo', 'git log -- a.ts',
    'git diff a..b', 'git show --stat',
    'npm run check', '',
  ])
    expect(refusedIn(line)).toBeUndefined()
})

test('any other Git subcommand is refused, wherever it sits and however it is quoted or wrapped', () => {
  expect(refusedIn('git commit -m "fix: x"')).toBe('git commit')
  expect(refusedIn('npm test && git add -A && git commit -m wip')).toBe('git add')
  expect(refusedIn('cd repo; git -C sub push origin HEAD')).toBe('git push')
  expect(refusedIn('GIT_AUTHOR_NAME=x sudo /usr/bin/git -c user.name=y commit')).toBe('git commit')
  expect(refusedIn("g''it 'push' origin")).toBe('git push')
  expect(refusedIn('ls | xargs git rm')).toBe('git rm')
  expect(refusedIn('for f in *; do git add "$f"; done')).toBe('git add')
  expect(refusedIn('git update-index --assume-unchanged a')).toBe('git update-index')
  expect(refusedIn('git p')).toBe('git p')
  expect(refusedIn('git stash pop')).toBe('git stash')
  expect(refusedIn('git branch feature')).toBe('git branch')
  expect(refusedIn('git branch -D feature')).toBe('git branch')
  expect(refusedIn('git branch --sort=-committerdate feature')).toBe('git branch')
  expect(refusedIn('git tag -a v1 -m x')).toBe('git tag')
  expect(refusedIn('git config alias.p push')).toBe('git config')
  expect(refusedIn('git remote add up url')).toBe('git remote')
  expect(refusedIn('git fetch origin main:main')).toBe('git fetch')
  expect(refusedIn('git config user.email a@b.c')).toBe('git config')
  expect(refusedIn('git symbolic-ref HEAD refs/heads/x')).toBe('git symbolic-ref')
})

test('a line that names Git, gh or glab beside a construct this check cannot read is refused whole', () => {
  expect(refusedIn('git -C $(git rev-parse --show-toplevel) commit')).toBe('git with a command substitution')
  expect(refusedIn('echo `git stash`')).toBe('git with a command substitution')
  expect(refusedIn('eval git commit')).toBe('git with eval')
  expect(refusedIn("bash <<'EOF'\ngit commit\nEOF")).toBe('git with a heredoc')
  expect(refusedIn("bash -c 'git commit -m x'")).toBe('git with a shell -c script')
  expect(refusedIn('python3 -c "import os; os.system(\'git push\')"')).toBe('git with an inline script')
  expect(refusedIn('echo $(date)')).toBeUndefined()
  expect(refusedIn("bash -c 'npm test'")).toBeUndefined()
})

test('gh and glab pass only their read verbs, so publishing and the raw API are refused', () => {
  expect(refusedIn('gh pr create --fill')).toBe('gh pr create')
  expect(refusedIn('gh -R owner/repo pr merge 12')).toBe('gh pr merge')
  expect(refusedIn('glab mr create -t x')).toBe('glab mr create')
  expect(refusedIn('gh api -X POST repos/o/r/pulls')).toBe('gh api')
  expect(refusedIn('gh pr comment 3 -b hi')).toBe('gh pr comment')
})

test('a Git word in quoted text, or a quoted path with a space, is refused too: the price of not parsing the shell', () => {
  expect(refusedIn('grep -rn "git push" docs')).toBe('git push')
  expect(refusedIn('echo git commit')).toBe('git commit')
  expect(refusedIn('git -C "my dir" status')).toBe('git dir')
})

test('the line splits at separators once quotes are dropped, and the refusal says who commits', () => {
  expect(segmentsOf('a "b; c" && d | e')).toEqual([['a', 'b'], ['c'], ['d'], ['e']])
  expect(refusal('git commit')).toContain('`git commit` is refused')
  expect(refusal('git commit')).toContain('Main commits')
})
