import { expect, test } from 'claude-code/testing'
import { createRoleCache, GIT_READS, readOnlyGit, refusal, shellWords } from '../hooks/guard'

test('one read-only git command passes, with -C, --no-pager, quoted patterns and quoted revisions', () => {
  expect(GIT_READS).toEqual(['status', 'log', 'diff', 'show', 'merge-base', 'ls-files', 'blame', 'rev-parse'])
  for (const command of [
    'git status', 'git status --short', '  git log --oneline -20 -- hooks/register.tsx ', 'git log -S"needle" --format=%h', "git log --grep='fix: a; b | c'",
    'git diff main...HEAD', 'git diff --stat', 'git diff --cached', 'git show HEAD~1:README.md', "git show 'HEAD@{1}'", 'git merge-base origin/main HEAD',
    'git ls-files --others --exclude-standard', 'git blame -L 10,20 hooks/roles.ts', 'git rev-parse --abbrev-ref HEAD', 'git -C /repo/checkout log -1',
    'git --no-pager diff', "git log -- '*.ts'", 'git log --format="%an \\"x\\""', 'git diff --no-ext-diff', 'git log --oneline',
  ]) expect(readOnlyGit(command)).toBe(true)
})
test('anything else is refused: other programs and subcommands, chains, redirection, substitution, unquoted globs and braces, writing options', () => {
  for (const command of [
    '', 'ls', 'cat README.md', 'gitk', 'GIT_DIR=x git log', 'git', 'git commit -m x', 'git stash', 'git checkout main', 'git reset --hard', 'git push', 'git branch -D x',
    'git log; rm -rf /', 'git log && git push', 'git log | head', 'git log > out.txt', 'git log < in', 'git log &', 'git log $(echo x)', 'git log `id`',
    'git log "$HOME"', 'git log "`id`"', 'git log $HOME', 'git log -- *.ts', 'git log -- a?', 'git log -- [ab]', 'git show HEAD@{1}', 'git log --outp{ut=x,}',
    'git log\nrm x', 'git log # note', "git log 'unclosed", 'git log "unclosed', 'git log \\', 'git log (x)',
    'git diff --output=x', 'git diff --output x', 'git log --outp=x', 'git diff --ext-diff', 'git diff --ext', 'git show --output-indicator-new=+',
    'git -c core.pager=sh log', 'git --exec-path=/x log', 'git -C', 'git --git-dir=/x log', 'git -p log',
  ]) expect(readOnlyGit(command)).toBe(false)
})
test('shell words are read as the shell would, quotes joined and escapes kept literal', () => {
  expect(shellWords(`git log --grep='a b'"c d" x\\ y ''`)).toEqual(['git', 'log', '--grep=a bc d', 'x y', ''])
  expect(shellWords('git log "a\\$b" "c\\d"')).toEqual(['git', 'log', 'a$b', 'c\\d'])
  expect(shellWords('git log "a$b"')).toBeNull()
})
test('the refusal names the role and the commands it may run', () => {
  expect(refusal('analyst')).toBe("spider-team: the analyst runs only read-only git commands (git status, log, diff, show, merge-base, ls-files, blame, rev-parse), one command at a time, with no pipes, redirection, substitution or unquoted wildcards or braces: quote patterns and revisions such as 'HEAD@{1}'. --output and --ext-diff are refused.")
})
test('the role cache keeps the newest ids and drops the oldest past its limit', () => {
  const cache = createRoleCache(2)
  cache.set('a', 'analyst'); cache.set('b', null); cache.set('a', 'analyst'); cache.set('c', 'reviewer')
  expect([cache.has('a'), cache.has('b'), cache.get('c'), cache.get('a'), cache.size]).toEqual([true, false, 'reviewer', 'analyst', 2])
})
