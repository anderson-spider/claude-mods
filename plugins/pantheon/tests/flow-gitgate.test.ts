import { expect, test } from 'claude-code/testing'
import { classifyGitCommand, gitAllowed } from '../hooks/flow/gitgate'
import type { GitActor } from '../hooks/flow/gitgate'

const all = () => true
const only = (...paths: string[]) => (path: string) => paths.includes(path)
const verdictOf = (actor: GitActor, command: string, owns: (path: string) => boolean = all) => gitAllowed(actor, command, owns)
const reasonOf = (actor: GitActor, command: string, owns: (path: string) => boolean = all) => {
  const verdict = verdictOf(actor, command, owns)
  return verdict.allow ? '' : verdict.reason
}

type Row = [actor: GitActor, command: string, owns?: (path: string) => boolean]

const allowed: Row[] = [
  ['developer', 'GIT_PAGER=cat git log'],
  ['developer', 'LC_ALL=C git status'],
  ['developer', 'TZ=UTC git log -1'],
  ['developer', 'export CI=1; npm test && git add a.ts && git commit -m x -- a.ts', only('a.ts')],
  ['developer', 'export CI=1 FOO=bar && git status'],
  ['developer', 'readonly X=1; git status'],
  ['lead', 'GIT_SSH_COMMAND=x git push'],
  ['lead', 'GIT_TRACE=1 git push origin feature/x'],
  ['lead', 'git ls-files | xargs rm'],
  ['lead', 'git ls-files | xargs -n1 wc -l'],
  ['lead', 'git diff | while read l; do echo $l; done'],
  ['lead', 'bash < <(date)'],
  ['lead', 'gh run watch 1'],
  ['lead', 'gh run view 1'],
  ['lead', 'glab ci trace'],
  ['lead', 'glab ci view'],
  ['git', 'git config user.name x'],
  ['git', 'git config --get alias.p'],
  ['git', 'git -c user.name=x commit -m y'],
  ['git', 'git bisect start'],
  ['git', 'git bisect run make test'],
  ['git', 'git rebase --exec="make test" main'],
  ['git', 'git pull --ff-only'],
  ['git', 'gh pr view 2'],
  ['lead', 'sudo -- git push'],
  ['lead', 'env -- git push'],
  ['lead', 'exec -a x git push'],
  ['lead', 'git push origin feature'],
  ['lead', 'git push --force-with-lease origin feature'],
  ['lead', 'git push --force-with-lease --force-if-includes origin feature'],
  ['lead', 'git push -u origin HEAD'],
  ['lead', 'git push origin HEAD:feature'],
  ['lead', 'git-push origin x'],
  ['lead', 'git config user.name'],
  ['lead', 'diff <(git show a) <(git show b)'],
  ['lead', 'git log | bash -c "wc -l"'],
  ['lead', 'HUSKY=0 npm test'],
  ['lead', 'function f { git push; }; f'],
  ['lead', 'gh pr view 3'],
  ['lead', 'gh pr list --state open'],
  ['lead', 'gh pr checks'],
  ['lead', 'gh api repos/x/y'],
  ['lead', 'gh api -X GET repos/x/y'],
  ['lead', 'glab mr view 4'],
  ['lead', 'glab-work ci status'],
  ['lead', 'gh status'],
  ['developer', 'gh pr diff 1'],
  ['architect', 'gh pr view 2'],
  ['git', 'gh pr create --fill'],
  ['git', 'glab mr create --push'],
  ['git', 'gh repo sync'],
  ['git', 'git rebase -x "make test" main'],
  ['developer', 'git --no-pager log'],
  ['developer', 'git -P diff'],
  ['developer', 'git mv a.ts b.ts', only('a.ts', 'b.ts')],
  ['developer', 'git rm --cached a.ts', only('a.ts')],
  ['developer', 'git rm -- a.ts', only('a.ts')],
  ['developer', 'git restore a.ts', only('a.ts')],
  ['developer', 'git restore --staged a.ts', only('a.ts')],
  ['developer', 'git restore -S -W -- a.ts', only('a.ts')],
  ['developer', 'git check-attr -a a.ts'],
  ['developer', 'git var GIT_AUTHOR_IDENT'],
  ['developer', 'git config user.name'],
  ['developer', 'export NODE_ENV=test && npm test'],
  ['lead', 'git push'],
  ['lead', 'git push origin andersonsilva/x'],
  ['lead', 'git push --force-with-lease'],
  ['lead', 'git status'],
  ['lead', 'git fetch origin'],
  ['lead', 'git diff --stat HEAD~1'],
  ['lead', 'git log --oneline | head -5'],
  ['lead', 'git branch --show-current'],
  ['lead', 'git branch'],
  ['lead', 'git tag -l'],
  ['lead', 'git stash list'],
  ['lead', 'git worktree list'],
  ['lead', 'git config --get user.name'],
  ['lead', 'git --version'],
  ['lead', 'cd x && git push'],
  ['lead', 'ls && echo "git commit -m x"'],
  ['lead', 'npm test'],
  ['lead', 'FOO=1 git push'],
  ['lead', 'git -C ../other push'],
  ['lead', 'git -c color.ui=never status'],
  ['lead', 'bash -c "git push"'],
  ['developer', 'git add a.ts', only('a.ts')],
  ['developer', 'git add -- a.ts b.ts', only('a.ts', 'b.ts')],
  ['developer', 'git commit -m x a', only('a')],
  ['developer', 'git commit -m "feat(x): y [T1]" -- a.ts', only('a.ts')],
  ['developer', 'git commit -m "title" -m "body" -- a.ts b.ts', only('a.ts', 'b.ts')],
  ['developer', 'git add a && git commit -m x -- a', only('a')],
  ['developer', 'git add a.ts && git commit -m "x -- not a path" -- a.ts', only('a.ts')],
  ['developer', "git commit -m 'a -- b' -- a.ts", only('a.ts')],
  ['developer', 'git -C pkg add a.ts', only('pkg/a.ts')],
  ['developer', 'git add ./a.ts', only('a.ts')],
  ['developer', 'git status --short'],
  ['developer', 'git diff HEAD'],
  ['developer', 'git log -3 && git show HEAD && git rev-parse HEAD'],
  ['developer', 'git ls-files | grep x'],
  ['developer', 'git blame a.ts'],
  ['developer', 'git grep -n foo'],
  ['developer', 'echo hi; ls'],
  ['ux', 'git add ui/a.tsx', only('ui/a.tsx')],
  ['ux', 'git commit -m "feat(ui): x [T2]" -- ui/a.tsx', only('ui/a.tsx')],
  ['developer', 'git commit -m "$(cat <<\'EOF\'\nfeat(x): it\'s (fine\n\nbody\nEOF\n)" -- a.ts', only('a.ts')],
  ['git', 'git checkout -b andersonsilva/x'],
  ['git', 'git rebase origin/main'],
  ['git', 'git commit -am "x"'],
  ['git', 'git stash push -u -m tag'],
  ['git', 'git worktree add ../x'],
  ['git', 'git status'],
  ['git', 'eval "$X git push"'],
  ['architect', 'git status'],
  ['architect', 'git diff main...HEAD && git log -5'],
  ['code-reader', 'git grep foo'],
  ['docs-reader', 'git show HEAD:README.md'],
  ['architect', 'cat README.md'],
]

test('allows what each actor may run', () => {
  for (const [actor, command, owns] of allowed) {
    const verdict = verdictOf(actor, command, owns)
    expect(verdict.allow).toBe(true)
    if (!verdict.allow) throw new Error(`${actor}: ${command}: ${verdict.reason}`)
  }
})

const denied: Array<[...Row, reason: RegExp]> = [
  // M1 (second review): refspecs
  ['lead', "git push origin 'refs/heads/*:refs/heads/*'", all, /`\*`/],
  ['lead', 'git push origin "feature/*"', all, /`\*`/],
  ['lead', 'git push origin HEAD:heads/main', all, /protected branch `main`/],
  ['lead', 'git push origin HEAD:refs/main', all, /protected branch `main`/],
  ['lead', 'git push origin HEAD:refs/heads/master', all, /protected branch `master`/],
  // M2: the git role stays off pushing, merging and hidden programs
  ['git', 'gh pr merge 3', all, /Merging/],
  ['git', 'glab mr merge 3', all, /Merging/],
  ['git', 'gh api -X PUT repos/o/r/pulls/3/merge', all, /Merging/],
  ['git', 'glab-work api --method PUT projects/1/merge_requests/3/merge', all, /Merging/],
  ['git', 'gh repo delete x --yes', all, /Deleting a repository/],
  ['git', 'glab repo delete x', all, /Deleting a repository/],
  ['git', 'git config alias.p push', all, /Do not write `alias.p`/],
  ['git', 'git config --global alias.p "!git push"', all, /Do not write/],
  ['git', 'git config remote.origin.push x', all, /Do not write/],
  ['git', 'git config push.default current', all, /Do not write/],
  ['git', 'git config core.hooksPath /x', all, /Do not write/],
  ['git', 'git config core.sshCommand x', all, /Do not write/],
  ['git', 'git config remote.origin.receivepack x', all, /Do not write/],
  ['git', 'git config remote.origin.uploadpack x', all, /Do not write/],
  ['git', 'git config --unset alias.p', all, /Do not write/],
  ['git', 'git -c core.hooksPath=/x commit -m y', all, /override/],
  ['git', 'git -c push.default=x status', all, /override/],
  ['git', 'git -c remote.origin.receivepack=x fetch', all, /override/],
  ['git', 'git --config-env=core.sshCommand=ENV fetch', all, /override/],
  ['git', 'git fetch --upload-pack=x origin', all, /another program/],
  ['git', 'git clone --upload-pack x url', all, /another program/],
  ['git', 'git ls-remote --upload-pack=/x origin', all, /another program/],
  ['git', 'git pull --receive-pack=x', all, /another program/],
  ['git', 'git lfs pull', all, /not a built-in/],
  ['git', 'git p origin x', all, /not a built-in/],
  ['git', 'git rebase -x "$CMD" main', all, /literal command/],
  ['git', 'git rebase -x ./run.sh main', all, /literal command/],
  ['git', 'git rebase --exec=bash main', all, /literal command/],
  ['git', 'git rebase -x "bash x.sh" main', all, /literal command/],
  ['git', 'git bisect run sh -c "git push"', all, /bisect run/],
  // M3 (second review): environment and exports
  ['developer', 'GIT_DIR=/x git status', all, /environment/],
  ['developer', 'GIT_CONFIG_COUNT=1 git status', all, /environment/],
  ['developer', 'GIT_SSH_COMMAND=x git add a.ts', only('a.ts'), /environment/],
  ['developer', 'LC_ALL=C git add a.ts', only('a.ts'), /environment/],
  ['developer', 'export $(cat .env); git status', all, /environment/],
  ['developer', 'readonly HUSKY=0; git status', all, /environment/],
  ['developer', 'local GIT_DIR=x; git status', all, /environment/],
  ['lead', 'GIT_DIR=/x git push', all, /GIT_DIR/],
  ['lead', 'GIT_CONFIG_COUNT=1 git push', all, /GIT_CONFIG/],
  ['lead', 'export $(cat .env) && git push', all, /cannot read/],
  // Lows: pipes into things that run text, forge writes
  ['lead', 'echo git push | xargs sh -c', all, /hidden/],
  ['lead', 'echo git push | xargs -I{} sh -c "{}"', all, /hidden/],
  ['lead', 'echo git push | xargs -n1 env', all, /hidden/],
  ['lead', 'echo git push | sh -c "$(cat)"', all, /hidden/],
  ['lead', 'echo git push | while read c; do $c; done', all, /hidden/],
  ['lead', 'echo git push | while read c; do eval "$c"; done', all, /hidden/],
  ['lead', 'echo git push | while read c; do sh -c "$c"; done', all, /hidden/],
  ['lead', 'bash < <(echo git push)', all, /hidden/],
  ['lead', 'sh < <(echo "git push")', all, /hidden/],
  ['lead', 'source /dev/stdin < <(echo git push)', all, /hidden/],
  ['lead', 'gh run cancel 1', all, /changes state on the forge/],
  ['lead', 'gh workflow run x', all, /changes state on the forge/],
  // H1: hooks skipped or the repository swapped through the environment or -c
  ['developer', 'FOO=1 git add a.ts', only('a.ts'), /environment/],
  ['developer', 'env FOO=1 git add a.ts', only('a.ts'), /environment/],
  ['developer', 'env -i HUSKY=0 git commit -m x -- a.ts', only('a.ts'), /environment/],
  ['developer', 'HUSKY=0 git commit -m x -- a.ts', only('a.ts'), /environment/],
  ['developer', 'export HUSKY=0 && git commit -m x -- a.ts', only('a.ts'), /environment/],
  ['developer', 'declare -x GIT_DIR=/x; git status', all, /environment/],
  ['developer', 'HUSKY=0; git commit -m x -- a.ts', only('a.ts'), /environment/],
  ['developer', 'SKIP=lint git commit -m x -- a.ts', only('a.ts'), /environment/],
  ['developer', 'bash -c "HUSKY=0 git commit -m x -- a.ts"', only('a.ts'), /environment/],
  ['developer', 'HUSKY=0 bash -c "git commit -m x -- a.ts"', only('a.ts'), /environment/],
  ['developer', 'git -c core.hooksPath=/dev/null commit -m x -- a.ts', only('a.ts'), /only `-C`/],
  ['developer', 'git -ccore.x=1 status', all, /only `-C`/],
  ['developer', 'git --config-env=core.x=Y status', all, /only `-C`/],
  ['developer', 'git --exec-path=/x status', all, /only `-C`/],
  ['developer', 'git --work-tree=/x status', all, /only `-C`/],
  ['developer', 'git --no-optional-locks status', all, /only `-C`/],
  ['ux', 'git -c x=y add ui/a.tsx', only('ui/a.tsx'), /only `-C`/],
  ['lead', 'HUSKY=0 git push', all, /hook-skip/],
  ['lead', 'env GIT_DIR=/x git push', all, /GIT_/],
  ['lead', 'export GIT_DIR=/x && git push', all, /GIT_/],
  ['lead', 'HUSKY=0; git push', all, /hook-skip/],
  ['lead', 'git -c push.default=x push', all, /-c/],
  ['lead', 'git --config-env=a=B push', all, /-c/],
  // H2: wrapper options
  ['lead', 'sudo -- git commit -m x', all, /`git` role/],
  ['lead', 'env -- git commit -m x', all, /`git` role/],
  ['lead', 'command -- git commit -m x', all, /`git` role/],
  ['lead', 'nohup -- git commit -m x', all, /`git` role/],
  ['lead', 'time -- git commit -m x', all, /`git` role/],
  ['lead', 'exec -a name git commit -m x', all, /`git` role/],
  ['lead', 'env -S "git commit -m x"', all, /`git` role/],
  ['lead', 'env --split-string="git commit -m x"', all, /`git` role/],
  ['lead', 'env -iS"git commit -m x"', all, /`git` role/],
  ['lead', 'env -S "$X git push"', all, /hidden/],
  ['developer', 'env -C sub git add a.ts', only('a.ts'), /literally/],
  ['developer', 'env --chdir=sub git add a.ts', only('a.ts'), /literally/],
  ['developer', 'sudo -D sub git add a.ts', only('a.ts'), /literally/],
  ['developer', 'env -S "git push"', all, /`git` role/],
  // M1: pipes and process substitution into a shell
  ['lead', 'echo git push | sh', all, /hidden/],
  ['lead', 'echo git push | bash', all, /hidden/],
  ['lead', 'echo git push | sudo bash', all, /hidden/],
  ['lead', 'echo git push | zsh -s', all, /hidden/],
  ['lead', 'echo git push | source /dev/stdin', all, /hidden/],
  ['lead', 'git log | bash', all, /hidden/],
  ['lead', 'bash <(echo git push)', all, /hidden/],
  ['lead', 'source <(echo "git push")', all, /hidden/],
  ['lead', 'bash "$(echo git push)"', all, /hidden/],
  ['lead', 'bash <(git commit -m x)', all, /`git` role/],
  // M2: functions and brace expansion
  ['developer', 'function f { git push; }; f', all, /`git` role/],
  ['developer', 'f() { git push; }; f', all, /`git` role/],
  ['lead', 'function f() { git reset --hard; }; f', all, /`git` role/],
  ['lead', 'f() { git commit -m x; }; f', all, /`git` role/],
  ['lead', '{git,push} origin x', all, /hidden/],
  ['lead', '{git,commit} -m x', all, /hidden/],
  // M3: PR/MR work
  ['lead', 'gh pr create --fill', all, /PR\/MR work goes to the git role/],
  ['lead', 'gh pr merge 4', all, /PR\/MR work/],
  ['lead', 'gh pr close 4', all, /PR\/MR work/],
  ['lead', 'gh pr edit 4 --title x', all, /PR\/MR work/],
  ['lead', 'gh pr ready 4', all, /PR\/MR work/],
  ['lead', 'gh pr review 4 --approve', all, /PR\/MR work/],
  ['lead', 'glab mr merge 3', all, /PR\/MR work/],
  ['lead', 'glab mr create --push', all, /PR\/MR work/],
  ['lead', 'glab-work mr create', all, /PR\/MR work/],
  ['lead', 'glab-personal mr approve 3', all, /PR\/MR work/],
  ['lead', 'gh repo sync', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh repo create x', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh repo delete x --yes', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh repo fork', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh release create v1', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh release delete v1', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh api -X POST repos/x/issues', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh api --method DELETE repos/x', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh api repos/x -f title=y', all, /changes state on the forge; route it to the git role/],
  ['lead', 'gh api repos/x -F a=b', all, /changes state on the forge; route it to the git role/],
  ['lead', 'glab api projects/1 --raw-field a=b', all, /changes state on the forge; route it to the git role/],
  ['lead', 'git status && gh pr create', all, /PR\/MR work/],
  ['lead', 'bash -c "gh pr merge 1"', all, /PR\/MR work/],
  ['lead', 'sudo gh pr merge 1', all, /PR\/MR work/],
  ['developer', 'gh pr create', all, /PR\/MR work/],
  ['ux', 'glab mr merge 1', all, /PR\/MR work/],
  ['architect', 'gh pr create', all, /PR\/MR work/],
  ['code-reader', 'gh pr comment 1 -b x', all, /PR\/MR work/],
  // M4: globs in a dev pathspec
  ['developer', 'git add src/*.ts', all, /explicitly/],
  ['developer', 'git add "a?.ts"', all, /explicitly/],
  ['developer', 'git add "a[1].ts"', all, /explicitly/],
  ['developer', 'git commit -m x -- "src/*"', all, /explicitly/],
  ['developer', 'git commit -m x "a?.ts"', all, /explicitly/],
  // M7: the lead's push
  ['lead', 'git push -f', all, /Forced/],
  ['lead', 'git push --force origin x', all, /Forced/],
  ['lead', 'git push --forc origin x', all, /Forced/],
  ['lead', 'git push origin +x', all, /Forced/],
  ['lead', 'git push origin +x:y', all, /Forced/],
  ['lead', 'git push -fu origin x', all, /Forced/],
  ['lead', 'git push origin x --delete', all, /Deleting/],
  ['lead', 'git push --del origin x', all, /Deleting/],
  ['lead', 'git push -d origin x', all, /Deleting/],
  ['lead', 'git push origin :x', all, /Deleting/],
  ['lead', 'git push --prune origin x', all, /Deleting/],
  ['lead', 'git push --mirror', all, /mirror/],
  ['lead', 'git push --all', all, /every branch/],
  ['lead', 'git push --no-verify', all, /no-verify/],
  ['lead', 'git push --no-verif origin x', all, /no-verify/],
  ['lead', 'git push origin main', all, /protected branch `main`/],
  ['lead', 'git push origin master', all, /protected branch `master`/],
  ['lead', 'git push origin HEAD:main', all, /protected branch `main`/],
  ['lead', 'git push -u origin HEAD:refs/heads/develop', all, /protected branch `develop`/],
  ['lead', 'git push --repo=origin main', all, /protected branch/],
  ['lead', 'git push origin x main', all, /protected branch/],
  ['lead', 'git fetch && git push origin main', all, /protected branch/],
  ['lead', 'git-push -f origin x', all, /Forced/],
  // L1: what devs may do beyond add and commit
  ['developer', 'git mv a.ts b.ts', only('a.ts'), /`b.ts`/],
  ['developer', 'git mv a.ts b.ts', only('b.ts'), /`a.ts`/],
  ['developer', 'git mv -f a.ts b.ts', only('a.ts', 'b.ts'), /not allowed/],
  ['developer', 'git rm -r dir', only('dir'), /not allowed/],
  ['developer', 'git rm -f a.ts', only('a.ts'), /not allowed/],
  ['developer', 'git rm b.ts', only('a.ts'), /`b.ts`/],
  ['developer', 'git rm', all, /explicit paths/],
  ['developer', 'git restore .', all, /explicitly/],
  ['developer', 'git restore b.ts', only('a.ts'), /`b.ts`/],
  ['developer', 'git restore --source=HEAD~1 a.ts', only('a.ts'), /not allowed/],
  ['developer', 'git restore -p a.ts', only('a.ts'), /not allowed/],
  ['developer', 'git restore --staged', all, /explicit paths/],
  ['developer', 'git config user.name x', all, /`git` role/],
  ['developer', 'git config --unset user.name', all, /`git` role/],
  // L2: no editor
  ['developer', 'git commit -e -m x -- a.ts', only('a.ts'), /editor/],
  ['developer', 'git commit --edit -m x -- a.ts', only('a.ts'), /editor/],
  // L3: the git role cannot push through an alias, rebase --exec or submodule foreach
  ['git', 'git -c alias.p=push p', all, /aliases/],
  ['git', 'git -c alias.p="!git push" p origin x', all, /aliases/],
  ['git', 'git --config-env=alias.p=ENV p', all, /aliases/],
  ['git', 'git rebase -x "git push" main', all, /rebase/],
  ['git', 'git rebase -i --exec="git push origin x" main', all, /rebase/],
  ['git', 'git rebase --exe "git push" main', all, /rebase/],
  ['git', 'git submodule foreach "git push"', all, /submodule foreach/],
  ['lead', 'git -c alias.p=push p', all, /hidden/],
  // L4: git-<verb> forms
  ['lead', 'git-commit -m x', all, /`git` role/],
  ['lead', '/usr/lib/git-core/git-checkout main', all, /`git` role/],
  ['developer', 'git-push', all, /`git` role/],
  ['developer', 'git-rebase main', all, /`git` role/],
  ['git', 'git-push origin x', all, /lead pushes/],
  ['git', '/usr/libexec/git-core/git-push origin x', all, /lead pushes/],
  ['lead', 'git commit -m x', all, /`git` role/],
  ['lead', 'git checkout main', all, /`git` role/],
  ['lead', 'git switch -c x', all, /`git` role/],
  ['lead', 'git worktree add ../x', all, /`git` role/],
  ['lead', 'git stash', all, /`git` role/],
  ['lead', 'git stash push', all, /`git` role/],
  ['lead', 'git reset --hard', all, /`git` role/],
  ['lead', 'git rebase main', all, /`git` role/],
  ['lead', 'git merge x', all, /`git` role/],
  ['lead', 'git cherry-pick abc', all, /`git` role/],
  ['lead', 'git add a', all, /`git` role/],
  ['lead', 'git restore a', all, /`git` role/],
  ['lead', 'git revert HEAD', all, /`git` role/],
  ['lead', 'git pull', all, /`git` role/],
  ['lead', 'git clean -fd', all, /`git` role/],
  ['lead', 'git tag v1', all, /`git` role/],
  ['lead', 'git branch -D x', all, /`git` role/],
  ['lead', 'git branch new-one', all, /`git` role/],
  ['lead', 'git apply --index p.diff', all, /`git` role/],
  ['lead', 'git am p.mbox', all, /`git` role/],
  ['lead', 'git push && git checkout main', all, /`git` role/],
  ['lead', 'git status; git commit -m x', all, /`git` role/],
  ['lead', 'echo $(git reset --hard)', all, /`git` role/],
  ['lead', 'cd x && git -C y commit -m z', all, /`git` role/],
  ['lead', 'sudo -u me git commit -m x', all, /`git` role/],
  ['lead', 'bash -c "git checkout main"', all, /`git` role/],
  ['lead', 'git -c alias.p=push p', all, /hidden/],
  ['lead', 'eval "git $VERB"', all, /hidden/],
  ['lead', 'xargs git checkout < list', all, /hidden/],
  ['lead', 'ssh host git push', all, /hidden/],
  ['developer', 'git add b.ts', only('a.ts'), /not one of your task's files/],
  ['developer', 'git add a.ts b.ts', only('a.ts'), /`b.ts`/],
  ['developer', 'git commit -m x -- a.ts b.ts', only('a.ts'), /`b.ts`/],
  ['developer', 'git add a.ts && git commit -m x -- b.ts', only('a.ts'), /`b.ts`/],
  ['developer', 'git -C pkg add a.ts', only('a.ts'), /`pkg\/a.ts`/],
  ['developer', 'git add -A', all, /not allowed/],
  ['developer', 'git add --all', all, /not allowed/],
  ['developer', 'git add -u', all, /not allowed/],
  ['developer', 'git add .', all, /explicitly/],
  ['developer', 'git add ./', all, /explicitly/],
  ['developer', 'git add -- .', all, /explicitly/],
  ['developer', 'git add :/', all, /explicitly/],
  ['developer', 'git add src/', all, /explicitly/],
  ['developer', 'git add src/.', all, /explicitly/],
  ['developer', 'git add a/..', all, /explicitly/],
  ['developer', 'git add ../x.ts', all, /explicitly/],
  ['developer', 'git add "*"', all, /explicitly/],
  ['developer', 'git add', all, /explicit paths/],
  ['developer', 'git add -p a.ts', all, /not allowed/],
  ['developer', 'git add $FILE', all, /literally/],
  ['developer', 'cd sub && git add a.ts', all, /literally/],
  ['developer', 'git commit -m x', all, /name your task's paths/i],
  ['developer', 'git add a && git commit -m x', only('a'), /name your task's paths/i],
  ['developer', 'git commit -m "feat(x): y [T1]"', all, /git commit -m <msg> -- <paths>/],
  ['developer', 'git commit -a -m x', all, /stages everything/],
  ['developer', 'git commit -am x', all, /stages everything/],
  ['developer', 'git commit --all -m x', all, /stages everything/],
  ['developer', 'git commit --amend -m x', all, /history/],
  ['developer', 'git commit --no-verify -m x', all, /hooks/],
  ['developer', 'git commit -n -m x', all, /hooks/],
  ['developer', 'git commit -nm x', all, /hooks/],
  ['developer', 'git commit --amen -m x', all, /not allowed/],
  ['developer', 'git commit -F msg.txt', all, /not allowed/],
  ['developer', 'git commit -m x .', all, /explicitly/],
  ['developer', 'git commit -m x -- src/', all, /explicitly/],
  ['developer', 'git push', all, /`git` role/],
  ['developer', 'git add a.ts && git push', only('a.ts'), /`git` role/],
  ['developer', 'git rebase main', all, /`git` role/],
  ['developer', 'git reset HEAD a', all, /`git` role/],
  ['developer', 'git merge x', all, /`git` role/],
  ['developer', 'git checkout -- a.ts', all, /`git` role/],
  ['developer', 'git switch main', all, /`git` role/],
  ['developer', 'git stash', all, /`git` role/],
  ['developer', 'git worktree add x', all, /`git` role/],
  ['developer', 'git --git-dir=/x/.git status', all, /worktree/],
  ['developer', 'bash -c \'git push\'', all, /`git` role/],
  ['developer', 'bash -c "$CMD git push"', all, /hidden/],
  ['developer', 'eval "git $X"', all, /hidden/],
  ['developer', 'sh -c "$1"; xargs git add < files', all, /hidden/],
  ['ux', 'git add -A', all, /not allowed/],
  ['ux', 'git push', all, /`git` role/],
  ['developer', 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', all, /AI attribution/],
  ['developer', 'git commit -m "feat: x" -m "Co-authored-by: Codex <codex@openai.com>"', all, /AI attribution/],
  ['developer', 'git commit -m "feat: x" -m "Generated with Claude Code"', all, /AI attribution/],
  ['developer', 'git commit -m "Generated with Codex"', all, /AI attribution/],
  ['developer', 'git commit -m "feat: x 🤖"', all, /AI attribution/],
  ['developer', 'git commit --message="x" --trailer "Co-Authored-By: Some AI <a@b.c>"', all, /AI attribution/],
  ['developer', 'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"', all, /AI attribution/],
  ['architect', 'git commit -m x', all, /read-only/],
  ['architect', 'git add a', all, /read-only/],
  ['architect', 'git push', all, /read-only/],
  ['architect', 'git checkout main', all, /read-only/],
  ['code-reader', 'git stash', all, /read-only/],
  ['docs-reader', 'git status && git reset --hard', all, /read-only/],
  ['architect', 'eval "$X git push"', all, /hidden/],
  ['git', 'git push', all, /lead pushes/],
  ['git', 'git push origin x', all, /lead pushes/],
  ['git', 'git status && git push --force-with-lease', all, /lead pushes/],
  ['git', 'cd x && git -C y push', all, /lead pushes/],
  ['git', 'bash -c "git push"', all, /lead pushes/],
]

test('denies with a reason that names where to go', () => {
  for (const [actor, command, owns, reason] of denied) {
    const verdict = verdictOf(actor, command, owns)
    if (verdict.allow) throw new Error(`${actor}: ${JSON.stringify(command)} was allowed`)
    expect(verdict.reason).toMatch(reason)
  }
})

test('the strictest segment of a compound command decides', () => {
  expect(reasonOf('lead', 'git push && git commit -m x')).toMatch(/commit/)
  expect(reasonOf('lead', 'git commit -m x || git push')).toMatch(/commit/)
  expect(reasonOf('lead', 'git status | cat; git push; git switch x')).toMatch(/switch/)
  expect(reasonOf('lead', '(git push) && { git reset --hard; }')).toMatch(/reset/)
  expect(reasonOf('lead', 'echo `git stash`')).toMatch(/stash/)
  expect(reasonOf('developer', 'git add a && git commit -m x -- a && git push', only('a'))).toMatch(/push/)
})

test('classifies segments with verb, paths, messages and state', () => {
  const found = classifyGitCommand('FOO=1 git -C pkg commit -m "one" --message=two -- a.ts ./b.ts && git status')
  expect(found.opaque).toBe(false)
  expect(found.segments.length).toBe(2)
  const [commit, status] = found.segments
  expect(commit.verb).toBe('commit')
  expect(commit.paths).toEqual(['pkg/a.ts', 'pkg/b.ts'])
  expect(commit.message).toEqual(['one', 'two'])
  expect(commit.changesState).toBe(true)
  expect(commit.global).toEqual(['-C', 'pkg'])
  expect(status.verb).toBe('status')
  expect(status.changesState).toBe(false)
})

test('quotes keep their text: a `--` or a git verb inside a message is not parsed', () => {
  const found = classifyGitCommand(`git commit -m 'fix: a -- b && git push' -- a.ts`)
  expect(found.segments.length).toBe(1)
  expect(found.segments[0].paths).toEqual(['a.ts'])
  expect(found.segments[0].message).toEqual(['fix: a -- b && git push'])
  expect(classifyGitCommand('echo "git push" && grep git file').segments).toEqual([])
})

test('a commit message in a heredoc inside a substitution is read whole', () => {
  const found = classifyGitCommand(`git commit -m "$(cat <<'EOF'\nfeat: it's (odd\nEOF\n)" -- a.ts`)
  expect(found.segments.length).toBe(1)
  expect(found.segments[0].paths).toEqual(['a.ts'])
  expect(found.segments[0].message?.[0]).toMatch(/it's \(odd/)
})

test('read-only forms of mixed verbs stay read-only and the writing ones do not', () => {
  const changes = (command: string) => classifyGitCommand(command).segments[0].changesState
  for (const command of ['git branch', 'git branch -a', 'git branch --list "x*"', 'git branch -vv', 'git tag', 'git tag -l "v*"', 'git stash show', 'git remote -v', 'git remote get-url origin', 'git config -l', 'git submodule status', 'git reflog', 'git notes list', 'git apply --check p', 'git fetch', 'git']) {
    expect(changes(command)).toBe(false)
  }
  for (const command of ['git branch -d x', 'git branch -m a b', 'git branch x', 'git tag v1', 'git tag -a v1 -m x', 'git tag -d v1', 'git remote add x y', 'git config user.name x', 'git submodule update', 'git reflog expire --all', 'git stash drop', 'git pull', 'git frobnicate']) {
    expect(changes(command)).toBe(true)
  }
})

test('wrappers, openers and options before git are looked through', () => {
  for (const command of ['sudo git commit -m x', 'sudo -u me git commit -m x', 'env -i FOO=1 git commit -m x', 'time git commit -m x', 'exec git commit -m x', 'if true; then git commit -m x; fi', '/usr/bin/git commit -m x', 'nohup git commit -m x']) {
    expect(reasonOf('lead', command)).toMatch(/commit/)
  }
  expect(classifyGitCommand('command -v git').segments).toEqual([])
})

test('a hidden git is opaque, a visible one inside bash -c or eval is read', () => {
  expect(classifyGitCommand('eval "git push"').segments[0].verb).toBe('push')
  expect(classifyGitCommand('bash -lc "git status && git commit -m x"').segments.map(segment => segment.verb)).toEqual(['status', 'commit'])
  expect(classifyGitCommand('bash -c "$X"').opaque).toBe(false)
  for (const command of ['eval "$X git push"', 'echo a | xargs git add', 'find . -exec git rm {} +', 'ssh host "git push"', "su -c 'git reset --hard'", '$(which git) push', 'git -c alias.x=push x', 'timeout 5 git push']) {
    expect(classifyGitCommand(command).opaque).toBe(true)
  }
  expect(classifyGitCommand('find . -name "*.git"').opaque).toBe(false)
})

test('a cd earlier on the line makes a dev path unverifiable but not the lead push', () => {
  expect(classifyGitCommand('cd x && git add a').segments[0].uncertain).toBe(true)
  expect(classifyGitCommand('git add a').segments[0].uncertain).toBe(false)
  expect(verdictOf('lead', 'cd x && git push').allow).toBe(true)
})

test('without a git role the lead does what git does, except unsafe pushes and hidden git', () => {
  const lead = (command: string) => gitAllowed('lead', command, all, { gitRole: false })
  for (const command of ['git commit -m x', 'git checkout -b x', 'git rebase main', 'git stash', 'git worktree add ../x', 'gh pr create --fill', 'gh release create v1', 'git push origin feature', 'git rebase -x make main']) {
    const verdict = lead(command)
    if (!verdict.allow) throw new Error(`${command}: ${verdict.reason}`)
  }
  const refused: Array<[string, RegExp]> = [
    ['git push -f', /Forced/],
    ['glab mr merge 3', /Merging/],
    ['gh repo delete x', /Deleting a repository/],
    ['git config alias.p push', /Do not write/],
    ['git lfs pull', /not a built-in/],
    ['git push origin main', /protected branch/],
    ['git push --delete origin x', /Deleting/],
    ['HUSKY=0 git push', /hook-skip/],
    ['git -c alias.p=push p', /aliases/],
    ['git rebase -x "git push" main', /rebase/],
    ['eval "$X git push"', /hidden/],
  ]
  for (const [command, reason] of refused) {
    const verdict = lead(command)
    if (verdict.allow) throw new Error(`${command} was allowed`)
    expect(verdict.reason).toMatch(reason)
  }
  // The default keeps the git role in charge, and devs are not changed by the option.
  expect(gitAllowed('lead', 'git commit -m x', all, { gitRole: true }).allow).toBe(false)
  expect(gitAllowed('lead', 'git commit -m x', all).allow).toBe(false)
  expect(gitAllowed('developer', 'git commit -m x', all, { gitRole: false }).allow).toBe(false)
  expect(gitAllowed('developer', 'gh pr create', all, { gitRole: false }).allow).toBe(false)
})

test('classifies gh and glab calls apart from git', () => {
  const found = classifyGitCommand('gh pr view 3 && glab-work mr create --push && gh api repos/x -X GET')
  expect(found.segments).toEqual([])
  expect(found.forges.map(forge => [forge.tool, forge.changesState])).toEqual([['gh', false], ['glab-work', true], ['gh', false]])
})

test('assignments and exports are reported per segment and for the line', () => {
  const found = classifyGitCommand('export A=1 B; HUSKY=0; FOO=1 env BAR=2 git status')
  expect(found.envSets).toEqual(['HUSKY'])
  expect(classifyGitCommand('export $(cat .env); export CI=1').envSets).toEqual(['?'])
  expect(found.segments[0].assigns).toEqual(['FOO', 'BAR'])
  expect(classifyGitCommand('git-push origin x').segments[0].verb).toBe('push')
})

test('the protected branches are a parameter: exact names and prefix patterns', () => {
  const push = (command: string, names?: string[]) => gitAllowed('lead', command, all, names === undefined ? {} : { protected: names })
  expect(push('git push origin release/1.2').allow).toBe(true)
  expect(push('git push origin develop', ['main']).allow).toBe(true)
  for (const command of ['git push origin release/1.2', 'git push origin HEAD:refs/heads/release/2', 'git push origin HEAD:heads/release/x']) {
    const verdict = push(command, ['main', 'release/*'])
    if (verdict.allow) throw new Error(`${command} was allowed`)
    expect(verdict.reason).toMatch(/protected branch `release\//)
  }
  expect(push('git push origin release', ['release/*']).allow).toBe(true)
  expect(push('git push origin feature/release/1', ['release/*']).allow).toBe(true)
  expect(push('git push origin release', ['release']).allow).toBe(false)
  expect(push('git push origin main', ['release/*']).allow).toBe(true)
})
