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
  ['developer', 'LC_ALL=C git status'],
  ['developer', 'TZ=UTC git log -1'],
  ['developer', 'export CI=1; npm test && git add a.ts && git commit -m x -- a.ts', only('a.ts')],
  ['developer', 'export CI=1 FOO=bar && git status'],
  ['developer', 'readonly X=1; git status'],
  ['lead', 'GIT_TRACE=1 git push origin feature/x'],
  ['lead', 'LC_ALL=C git log'],
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
  // What is not git work is not routed to the git role: issues, runs, workflows, CI.
  ['lead', 'gh run cancel 1'],
  ['lead', 'gh run rerun 1'],
  ['lead', 'gh workflow run x'],
  ['lead', 'gh issue comment 1 -b x'],
  ['lead', 'gh issue create --title x'],
  ['lead', 'glab issue note 3 -m x'],
  ['lead', 'gh repo clone o/r'],
  ['lead', 'gh api -X GET repos/x -f per_page=5'],
  // Wrappers that run a command: it is read as if typed on the line.
  ['lead', 'timeout 5 git push origin feature/x'],
  ['lead', 'timeout -k 5 30 git status'],
  ['lead', 'nice -n 10 git log'],
  ['lead', 'ionice -c 2 git status'],
  ['lead', 'stdbuf -oL git log'],
  ['lead', 'setsid git status'],
  // Only what xargs and find run counts, not a word that says git.
  ['lead', 'find . -name "*.ts" | xargs grep -l git'],
  ['lead', 'find ~/src/git -type f'],
  ['lead', 'find . -name "*.sh" -exec wc -l {} +'],
  // A `git` that is a name, not a command: a reader's text, a package, a path, a word with no verb after it.
  ['lead', 'echo git push origin main'],
  ['lead', 'grep -r git push.txt'],
  ['lead', 'ls ~/src/git'],
  ['lead', 'brew install git curl'],
  ['qa', 'pytest -k git tests/'],
  ['qa', 'npm test -- git'],
  ['developer', 'cd git && ls'],
  // The wrappers that run the command after them are read through.
  ['lead', 'caffeinate git push origin feature/x'],
  ['lead', 'caffeinate -t 60 git push origin feature/x'],
  ['lead', 'gtimeout 10 git push origin feature/x'],
  ['lead', 'arch -arm64 git status'],
  // What the review of the git role asked to keep out is only the writes; reading and the documented commands pass.
  ['lead', 'gh alias list'],
  ['git', 'gh alias list'],
  ['git', 'gh extension list'],
  ['git', 'gh api graphql -f query="query { viewer { login } }"'],
  ['git', 'gh issue comment 1 -b x'],
  ['git', 'git worktree add -b andersonsilva/x ../x'],
  ['lead', 'git push -o ci.skip origin feature/x'],
  // Final review: glab's own names, what is read, and a git that is only mentioned
  ['lead', 'glab mr ls'],
  ['lead', 'glab mr show 5'],
  ['lead', 'glab project view'],
  ['lead', 'glab pipeline list'],
  ['git', 'glab mr unapprove 5'],
  ['git', 'glab mr new --fill'],
  ['lead', 'gh discussion list'],
  ['lead', 'gh codespace list'],
  ['lead', 'gh cs view'],
  ['git', 'gh codespace list'],
  ['lead', 'echo "git push origin main"'],
  ['lead', 'grep "git push" README.md'],
  ['lead', 'man git'],
  ['lead', 'cat .gitignore'],
  ['qa', 'jest -t "does not run git"'],
  ['qa', 'jira create --summary "Update git config docs"'],
  ['qa', "sed 's/git push/git pull/' notes.txt"],
  // Last round: names that only look like git, and git that is only mentioned
  ['lead', 'echo "nixpkgs#git"'],
  ['lead', 'grep -rn "#git" .'],
  ['lead', 'git log --oneline'],
  ['git', 'gh pr create --title "feat: git gate"'],
  ['lead', 'nix build nixpkgs#git'],
  ['lead', 'nix profile install nixpkgs#git'],
  ['lead', 'nix run nixpkgs#hello'],
  ['lead', 'bash -c "echo hi"'],
  ['lead', 'fish -c "echo hi"'],
  ['lead', 'pwsh -Command "Get-ChildItem"'],
  ['lead', 'pwsh -ExecutionPolicy Bypass -File build.ps1'],
  // The shell family, closed structurally: what is not a command line passes
  ['lead', 'pwsh -Command "Get-ChildItem"'],
  ['lead', 'fish -c "echo hi"'],
  ['lead', 'bash -c "echo git"'],
  ['lead', 'echo git push'],
  ['lead', 'nu -c "ls"'],
  ['lead', 'nu -e "ls | length"'],
  ['lead', 'zsh -c "make test"'],
  ['lead', 'bash push.sh'],
  ['lead', 'claude plugin test plugins/pantheon'],
  ['lead', 'npm run build'],
  ['lead', 'pwsh -NoProfile -ExecutionPolicy Bypass -Command "Get-Content ~/.gitconfig"'],
  ['lead', 'pwsh -Command "git status"'],
  ['developer', 'pwsh -File build.ps1'],
  // A comment ends the line's words.
  ['developer', 'git commit -m x -- a.ts # then push', only('a.ts')],
  ['developer', 'git add a.ts # not a path: b.ts', only('a.ts')],
  ['lead', 'git status # git push origin main'],
  ['lead', 'echo done #; git commit -m x'],
  ['lead', 'git -c color.ui=never -c core.quotepath=false -c advice.detachedHead=false status'],
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
  ['git', 'git -c user.name=x -c user.email=y@z.io commit -m w'],
  ['git', 'git branch -f feature main'],
  ['git', 'git tag -f v1 main'],
  ['git', 'gh api repos/o/r/branches'],
  ['git', 'gh api -X GET repos/o/r/git/refs -f per_page=5'],
  ['git', 'git rebase --exec="make test" main'],
  ['git', 'git switch -c andersonsilva/x && git commit -m y'],
  ['architect', 'git status'],
  ['architect', 'git diff main...HEAD && git log -5'],
  ['code-reader', 'git grep foo'],
  ['docs-reader', 'git show HEAD:README.md'],
  ['architect', 'cat README.md'],
]

test('allows what each actor may run', () => {
  const wrong: string[] = []
  for (const [actor, command, owns] of allowed) {
    const verdict = verdictOf(actor, command, owns)
    if (!verdict.allow) wrong.push(`${actor}: ${JSON.stringify(command)} was denied: ${verdict.reason}`)
  }
  expect(wrong).toEqual([])
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
  // Review: the shell's own syntax, option prefixes and hidden git
  ['lead', 'git push --rep=origin main', all, /protected branch `main`/],
  ['lead', 'git push --rep origin main', all, /protected branch `main`/],
  ['lead', 'git push --repo origin release/1.2', all, /protected branch `release\/1.2`/],
  ['lead', 'git push\ngit push origin main # deploy', all, /protected branch `main`/],
  ['lead', 'git status # note\ngit push origin main', all, /protected branch `main`/],
  ['lead', 'git push --receive-pack=x origin feature', all, /receiving side/],
  ['lead', 'git push --exec=x origin feature', all, /receiving side/],
  ['lead', 'git push --rec=x origin feature', all, /receiving side/],
  ['lead', 'git push --ex=x origin feature', all, /receiving side/],
  ['git', 'eval "$X git push"', all, /hidden/],
  ['git', 'P=push; git $P origin main', all, /hidden/],
  ['lead', 'P=push; git $P origin main', all, /hidden/],
  ['git', 'X="git push origin main"; eval "$X"', all, /hidden/],
  ['lead', 'X="git push origin main"; eval "$X"', all, /hidden/],
  ['developer', 'X="git push origin main"; bash -c "$X"', all, /hidden/],
  ['git', 'CMD="git push origin main"; $CMD', all, /hidden/],
  ['git', 'echo "git push origin main" | sh', all, /hidden/],
  ['git', 'echo git push | xargs sh -c', all, /hidden/],
  ['git', 'xargs git push < refs', all, /hidden/],
  ['lead', 'echo a | xargs -n1 timeout 5 git push', all, /hidden/],
  ['lead', 'find . -execdir sh -c "git push" \\;', all, /hidden/],
  ['git', 'ssh host git push', all, /hidden/],
  // Second review: a command that runs another command hides the git it runs
  ['lead', 'op run -- git push origin main', all, /hidden/],
  ['lead', 'mise exec -- git push origin main', all, /hidden/],
  ['lead', 'xcrun git push origin main', all, /hidden/],
  ['lead', 'flock /tmp/l git push origin main', all, /hidden/],
  ['lead', 'unbuffer git push origin main', all, /hidden/],
  ['git', 'op run -- git commit -m x', all, /hidden/],
  ['developer', 'op run -- gh pr merge 1', all, /hidden/],
  ['qa', 'op run -- git log', all, /hidden/],
  ['lead', 'caffeinate git push origin main', all, /protected branch `main`/],
  ['lead', 'gtimeout 10 git push origin main', all, /protected branch `main`/],
  ['lead', 'arch -arm64 git push origin main', all, /protected branch `main`/],
  ['lead', 'caffeinate gh pr merge 1', all, /PR\/MR work/],
  // Second review: aliases and extensions, push options, and what the git role may still do through the forge
  ['lead', 'gh alias set mm "pr merge --admin"', all, /changes state on the forge/],
  ['git', 'gh alias set mm "pr merge --admin"', all, /Aliases and extensions/],
  ['git', 'gh alias import aliases.yml', all, /Aliases and extensions/],
  ['git', 'glab alias set mm "mr merge"', all, /Aliases and extensions/],
  ['git', 'gh extension install o/x', all, /Aliases and extensions/],
  ['git', 'gh mm 1', all, /not a `gh` or `glab` command/],
  ['git', 'glab-work frobnicate', all, /not a `gh` or `glab` command/],
  ['lead', 'gh mm 1', all, /changes state on the forge/],
  ['lead', 'git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds origin feat', all, /merge_request/],
  ['lead', 'git push --push-option=merge_request.target=main origin feat', all, /merge_request/],
  ['lead', 'git push --push-opt merge_request.merge origin feat', all, /merge_request/],
  ['lead', 'git push -omerge_request.merge_when_pipeline_succeeds origin feat', all, /merge_request/],
  ['developer', 'git push -o merge_request.merge origin feat', all, /`git` role/],
  ['git', 'git update-ref --stdin', all, /update-ref --stdin/],
  ['git', 'git worktree add -B main ../x', all, /protected branch/],
  ['git', 'git worktree add -b release/1.2 ../x', all, /protected branch/],
  ['git', 'gh api graphql -F query=@q.graphql', all, /cannot be checked/],
  ['git', 'gh api graphql -f query=@q.graphql', all, /cannot be checked/],
  ['git', 'gh api graphql --input q.json', all, /cannot be checked/],
  ['git', 'gh repo sync --force', all, /repo sync --force/],
  ['git', 'gh repo sync o/r --forc', all, /repo sync --force/],
  ['git', 'gh api -X PUT repos/o/r/rulesets/1 -f enforcement=disabled', all, /Changing branches/],
  ['git', 'gh api -X PUT repos/o/r/branches/main/protection -f x=y', all, /Changing branches/],
  ['git', 'git config include.path ../x', all, /Do not write/],
  ['git', 'git config includeIf.gitdir:/x/.path ../y', all, /Do not write/],
  ['git', 'git config --add includeIf.onbranch:main.path ../y', all, /Do not write/],
  // Final review: glab's aliases are the command they stand for
  ['git', 'glab mr accept 5', all, /Merging/],
  ['git', 'glab-work mr accept 5 --squash', all, /Merging/],
  ['lead', 'glab mr accept 5', all, /PR\/MR work/],
  ['lead', 'glab mr del 5', all, /PR\/MR work/],
  ['lead', 'glab mr open 5', all, /PR\/MR work/],
  ['lead', 'glab mr comment 5 -m x', all, /PR\/MR work/],
  ['lead', 'gh co 5', all, /PR\/MR work/],
  ['lead', 'glab project delete o/r --yes', all, /changes state on the forge/],
  ['qa', 'glab project delete o/r --yes', all, /changes state on the forge/],
  ['git', 'glab project delete o/r --yes', all, /Deleting a repository/],
  ['git', 'glab repo delete o/r --yes', all, /Deleting a repository/],
  ['git', 'glab repo transfer o/r --target-namespace x', all, /settings, name, owner/],
  ['git', 'glab project update --default-branch x', all, /settings, name, owner/],
  ['git', 'glab repo mirror o/r', all, /settings, name, owner/],
  ['git', 'gh repo edit --default-branch x', all, /settings, name, owner/],
  ['git', 'gh repo archive o/r --yes', all, /settings, name, owner/],
  // Final review: shells beyond sh and bash, and strings that are command lines
  ['lead', 'fish -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'fish --command "git push origin main"', all, /protected branch `main`/],
  ['lead', 'tcsh -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'csh -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'nu -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'xonsh -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'ash -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'pwsh -Command "git push origin main"', all, /protected branch `main`/],
  ['lead', 'pwsh -c "git push origin main"', all, /protected branch `main`/],
  ['lead', 'powershell -command "git push origin main"', all, /protected branch `main`/],
  ['lead', 'powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==', all, /hidden/],
  ['git', 'fish -c "git push origin x"', all, /lead pushes/],
  ['lead', 'nix-shell --run "git push origin main"', all, /hidden/],
  ['lead', 'nix-shell --run "cd x && git push origin main"', all, /hidden/],
  ['lead', 'nix develop -c git push origin main', all, /hidden/],
  ['lead', 'nix develop --command "git push origin main"', all, /hidden/],
  ['lead', 'docker exec c sh -c "git push origin main"', all, /hidden/],
  ['lead', 'docker run --rm alpine/git push origin main', all, /hidden/],
  ['lead', 'kubectl exec pod -- git push origin main', all, /hidden/],
  ['git', 'nix-shell --run "git commit -m x"', all, /hidden/],
  ['qa', 'nix-shell --run "git log"', all, /hidden/],
  // Last round: other names of the same option, and a flake reference that is git
  ['lead', 'pwsh -ec ZwBpAHQA', all, /hidden/],
  ['lead', 'pwsh -e ZwBpAHQA', all, /hidden/],
  ['lead', 'pwsh -enc ZwBpAHQA', all, /hidden/],
  ['lead', 'powershell -EncodedCommand ZwBpAHQA', all, /hidden/],
  ['git', 'pwsh -ExecutionPolicy Bypass -ec ZwBpAHQA', all, /hidden/],
  ['lead', 'nu --commands "git push origin main"', all, /protected branch `main`/],
  ['lead', 'nu --commands="git push origin main"', all, /protected branch `main`/],
  ['lead', 'pwsh -CommandWithArgs "git push origin main"', all, /protected branch `main`/],
  ['lead', 'pwsh -commandwithargs "git push origin main"', all, /protected branch `main`/],
  ['lead', 'pwsh -cwa "git push origin main"', all, /protected branch `main`/],
  ['lead', 'pwsh -comm "git push origin main"', all, /protected branch `main`/],
  ['lead', 'fish -C "git push origin main"', all, /protected branch `main`/],
  ['lead', 'fish --init-command "git push origin main"', all, /protected branch `main`/],
  ['lead', 'fish --init-command="git push origin main"', all, /protected branch `main`/],
  ['lead', 'fish -C "git status" -c "git push origin main"', all, /protected branch `main`/],
  ['git', 'fish -C "git push origin x"', all, /lead pushes/],
  ['lead', 'nix run nixpkgs#git -- push origin main', all, /hidden/],
  ['lead', 'nix run nixpkgs#git push origin main', all, /hidden/],
  ['lead', 'nix run github:o/r#git -- push origin main', all, /hidden/],
  ['lead', 'nix shell nixpkgs#git -c git push origin main', all, /hidden/],
  ['lead', 'nix run nixpkgs#gh -- pr merge 1', all, /hidden/],
  ['git', 'nix run nixpkgs#git -- commit -m x', all, /hidden/],
  ['qa', 'nix run nixpkgs#git -- log', all, /hidden/],
  ['lead', 'nix-shell --run "nix run nixpkgs#git -- push origin main"', all, /hidden/],
  // Final review: gh codespace runs commands on another machine
  ['lead', 'gh codespace ssh -- git push origin main', all, /changes state on the forge/],
  ['lead', 'gh cs ssh -c x -- git push origin main', all, /changes state on the forge/],
  ['lead', 'gh codespace cp a remote:b', all, /changes state on the forge/],
  ['git', 'gh codespace ssh -- git push origin main', all, /another machine/],
  ['git', 'gh cs ssh -- git status', all, /another machine/],
  ['git', 'gh codespace cp a remote:b', all, /another machine/],
  // Review: the forge API can move a branch or write a commit on one
  ['git', 'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/main -f sha=x', all, /Changing branches/],
  ['git', 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=x', all, /Changing branches/],
  ['git', 'gh api --method PUT repos/o/r/contents/a.txt -f branch=main', all, /Changing branches/],
  ['git', 'gh api -X POST repos/o/r/branches/main/rename -f new_name=x', all, /Changing branches/],
  ['git', 'glab api -X POST projects/1/repository/branches -f branch=x', all, /Changing branches/],
  ['git', 'glab api --method POST projects/1/repository/commits -f branch=main', all, /Changing branches/],
  ['git', 'gh api -X POST repos/o/r/merges -f base=main -f head=x', all, /Merging/],
  ['git', 'gh api --meth PUT repos/o/r/pulls/3/merge', all, /Merging/],
  ['git', 'gh api graphql -f query="mutation { createRef(input: {}) { clientMutationId } }"', all, /Changing branches/],
  ['lead', 'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/main', all, /changes state on the forge/],
  // Review: -c, the environment, command URLs and pack options hand git a program
  ['lead', 'git -c core.pager="sh -c x" log', all, /-c core\.pager/],
  ['lead', 'git -c core.editor=x status', all, /-c core\.editor/],
  ['lead', 'git -c credential.helper="!x" fetch', all, /-c credential\.helper/],
  ['lead', 'git --config-env=core.pager=P log', all, /-c core\.pager/],
  ['lead', 'git -c "$X" log', all, /-c <not literal>/],
  ['lead', 'git -c color.ui=never -c core.pager=x log', all, /-c core\.pager/],
  ['git', 'git -c core.editor=vim commit -m x', all, /override `core\.editor`/],
  ['git', 'git -c user.name=a -c core.pager=x log', all, /override `core\.pager`/],
  ['developer', 'git -c core.pager=x log', all, /only `-C`/],
  ['lead', 'GIT_PAGER=x git log', all, /Do not set environment/],
  ['lead', 'PAGER="sh -c x" git log', all, /Do not set environment/],
  ['lead', 'EDITOR=x git log', all, /Do not set environment/],
  ['lead', 'HOME=/tmp/h git status', all, /Do not set environment/],
  ['lead', 'XDG_CONFIG_HOME=/x git status', all, /Do not set environment/],
  ['lead', 'GIT_ASKPASS=x git fetch', all, /Do not set environment/],
  ['lead', 'GIT_EXTERNAL_DIFF=x git diff', all, /Do not set environment/],
  ['lead', 'export GIT_SSH_COMMAND=x; git fetch', all, /Do not set environment/],
  ['lead', 'export $(cat .env); git status', all, /Do not set environment/],
  ['git', 'GIT_SSH_COMMAND=x git fetch', all, /Do not set environment/],
  ['lead', 'GIT_SSH_COMMAND=x git push', all, /GIT_/],
  ['developer', 'GIT_PAGER=cat git log', all, /environment/],
  ['lead', 'git fetch "ext::sh -c id"', all, /ext::/],
  ['git', 'git clone fd::17 x', all, /ext::/],
  ['git', 'git remote add x "ext::sh -c id"', all, /ext::/],
  ['lead', 'git fetch --upload-pack="sh -c x" origin', all, /another program/],
  ['lead', 'git ls-remote --upload-pack=x .', all, /another program/],
  ['developer', 'git fetch --exec=x', all, /another program/],
  // Review: configuration writes with another word first, and branches or refs by protected name
  ['git', 'git config set alias.p push', all, /Do not write `alias.p`/],
  ['git', 'git config --file /x/cfg remote.origin.push y', all, /Do not write `remote.origin.push`/],
  ['git', 'git config --blob HEAD:x url.x.insteadOf y', all, /Do not write `url.x.insteadOf`/],
  ['git', 'git config url.git@x:.insteadOf y', all, /Do not write/],
  ['git', 'git config branch.main.merge refs/heads/x', all, /Do not write/],
  ['git', 'git config core.pager "sh -c x"', all, /Do not write/],
  ['git', 'git config credential.helper "!x"', all, /Do not write/],
  ['git', 'git config remote.origin.mirror true', all, /Do not write/],
  ['git', 'git branch -D main', all, /protected branch/],
  ['git', 'git branch -d release/1.2', all, /protected branch/],
  ['git', 'git branch -m main old', all, /protected branch/],
  ['git', 'git branch -m old develop', all, /protected branch/],
  ['git', 'git branch -f main HEAD~1', all, /protected branch/],
  ['git', 'git branch --delete master', all, /protected branch/],
  ['git', 'git update-ref refs/heads/main abc123', all, /protected branch/],
  ['git', 'git update-ref -d refs/heads/release/1', all, /protected branch/],
  ['git', 'git tag -d main', all, /protected branch/],
  ['git', 'git tag -f release HEAD', all, /protected branch/],
  ['git', 'git checkout -B main origin/x', all, /protected branch/],
  ['git', 'git switch -C release/1.2', all, /protected branch/],
  ['git', 'git checkout -b develop', all, /protected branch/],
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
  const wrong: string[] = []
  for (const [actor, command, owns, reason] of denied) {
    const verdict = verdictOf(actor, command, owns)
    if (verdict.allow) wrong.push(`${actor}: ${JSON.stringify(command)} was allowed`)
    else if (!reason.test(verdict.reason)) wrong.push(`${actor}: ${JSON.stringify(command)} was denied with ${JSON.stringify(verdict.reason)}, not ${reason}`)
  }
  expect(wrong).toEqual([])
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
  for (const command of ['eval "$X git push"', 'echo a | xargs git add', 'find . -exec git rm {} +', 'ssh host "git push"', "su -c 'git reset --hard'", '$(which git) push', 'git -c alias.x=push x', 'X="git push"; eval "$X"', 'CMD="git push"; $CMD origin x']) {
    expect(classifyGitCommand(command).opaque, command).toBe(true)
  }
  for (const command of ['find . -name "*.git"', 'find ~/src/git', 'find . | xargs grep -l git', 'eval "$(ssh-agent -s)"', 'timeout 5 git push', '$HOME/bin/tool && echo git']) {
    expect(classifyGitCommand(command).opaque, command).toBe(false)
  }
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
  expect(push('git push origin release/1.2').allow).toBe(false)
  expect(push('git push origin HEAD:release').allow).toBe(false)
  expect(push('git push origin feature/release-notes').allow).toBe(true)
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

test('an unquoted # that starts a word comments out the rest of the line', () => {
  const words = (command: string) => classifyGitCommand(command).segments.map(segment => segment.positional)
  expect(words('git push origin # deploy')).toEqual([['origin']])
  expect(words('git commit -m x -- a.ts # c')).toEqual([['a.ts']])
  expect(classifyGitCommand('git commit -m x -- a.ts # c').segments[0]?.paths).toEqual(['a.ts'])
  // Not a comment: inside a word, a quote or an expansion.
  expect(words('git push origin feature#1')).toEqual([['origin', 'feature#1']])
  expect(words('git push origin "# x"')).toEqual([['origin', '# x']])
  expect(words('git push origin \\#x')).toEqual([['origin', '#x']])
  expect(words('git log -n ${#X}')).toEqual([['${#X}']])
  // The newline ends the comment, so what follows is a command again.
  expect(words('git status # a\ngit push origin main')).toEqual([[], ['origin', 'main']])
  expect(words('git status # git push origin main')).toEqual([[]])
  // A `)` in a comment closes no substitution.
  expect(classifyGitCommand('echo $(git status # )\n)').segments.map(segment => segment.verb)).toEqual(['status'])
})

test('timeout, nice, ionice, stdbuf and setsid run the command after them', () => {
  for (const command of ['timeout 5 git commit -m x', 'timeout -k 5 30 git commit -m x', 'nice git commit -m x', 'nice -n 10 git commit -m x', 'ionice -c 2 -n 7 git commit -m x', 'stdbuf -oL git commit -m x', 'setsid git commit -m x', 'nohup timeout 5 git commit -m x']) {
    expect(reasonOf('lead', command), command).toMatch(/commit/)
  }
  expect(classifyGitCommand('timeout 10 bash <<EOF\ngit push origin main\nEOF').segments.map(segment => segment.verb)).toEqual(['push'])
})

test('the reason names the forge command, never its arguments', () => {
  const reason = reasonOf('lead', 'gh pr create --title "SECRET-TITLE" --body "tok_abc123" --repo https://u:pw@h/x')
  expect(reason).toContain('gh pr create')
  for (const leak of ['SECRET-TITLE', 'tok_abc123', 'u:pw']) expect(reason).not.toContain(leak)
  expect(reasonOf('lead', 'gh api -X POST repos/x/issues -f token=abc')).not.toContain('abc')
})

test('a commit\'s text is -m and --message only', () => {
  const found = classifyGitCommand('git commit --author "A [T1]" --trailer "Refs: [T1]" -m "one" --mess=two -- a.ts')
  expect(found.segments[0]?.text).toEqual(['one', 'two'])
  expect(found.segments[0]?.message).toEqual(['A [T1]', 'Refs: [T1]', 'one', 'two'])
})

test('git takes option prefixes, so the scan reads a prefixed option\'s value as a value', () => {
  const push = classifyGitCommand('git push --rep origin main').segments[0]
  expect(push?.positional).toEqual(['main'])
  expect(classifyGitCommand('git push --repo origin main').segments[0]?.positional).toEqual(['main'])
})

test('without a git role the lead is held to the protected branches by name too', () => {
  const lead = (command: string) => gitAllowed('lead', command, all, { gitRole: false })
  for (const command of ['git branch -D main', 'git update-ref refs/heads/release/1 abc', 'git tag -d release', 'git checkout -B develop x', 'git config set alias.p push']) {
    expect(lead(command).allow, command).toBe(false)
  }
  for (const command of ['git branch -D feature', 'git branch -f feature main', 'git tag -d v1', 'git checkout -b feature/x']) {
    expect(lead(command).allow, command).toBe(true)
  }
})

test('the separator before each git command is reported', () => {
  const befores = (command: string) => classifyGitCommand(command).segments.map(segment => segment.before)
  expect(befores('git switch x && git push')).toEqual(['', '&&'])
  expect(befores('git switch x || git push')).toEqual(['', '||'])
  expect(befores('git switch x; git push')).toEqual(['', ';'])
  expect(befores('git switch x\ngit push')).toEqual(['', '\n'])
  expect(befores('git log | head -1 && git push')).toEqual(['', '&&'])
})

test('the push options of a push are its -o and --push-option values', () => {
  const options = (command: string) => classifyGitCommand(command).segments[0]?.pushOptions
  expect(options('git push -o a -o b origin x')).toEqual(['a', 'b'])
  expect(options('git push --push-option=c -oD origin x')).toEqual(['c', 'D'])
  expect(options('git push origin x')).toEqual([])
  expect(options('git log -o x')).toEqual([])
})

test('glab\'s aliases are read as the command they stand for', () => {
  const forge = (command: string) => classifyGitCommand(command).forges[0]
  expect([forge('glab mr accept 5')?.group, forge('glab mr accept 5')?.action]).toEqual(['mr', 'merge'])
  expect([forge('glab mr unapprove 5')?.group, forge('glab mr unapprove 5')?.action]).toEqual(['mr', 'revoke'])
  expect([forge('glab project delete o/r')?.group, forge('glab project delete o/r')?.action]).toEqual(['repo', 'delete'])
  expect([forge('glab-work pipe list')?.group]).toEqual(['ci'])
  expect([forge('gh co 5')?.group, forge('gh co 5')?.action]).toEqual(['pr', 'checkout'])
  expect(forge('gh cs ssh')?.group).toBe('codespace')
  // gh's own `project` is Projects, not the repository.
  expect(forge('gh project list')?.group).toBe('project')
  expect(forge('gh project list')?.changesState).toBe(false)
})

test('a shell that has no -c contract is read wherever its command line stands, for every actor', () => {
  const spellings = [
    'pwsh -Command git push origin main',
    'pwsh -c git push origin main',
    'pwsh --command "git push origin main"',
    'pwsh --c "git push origin main"',
    'pwsh --cwa "git push origin main"',
    'pwsh -cwa "git push origin main"',
    'pwsh /Command "git push origin main"',
    'pwsh /c "git push origin main"',
    'pwsh -CommandWithArgs "git push origin main"',
    'pwsh -NoProfile -Command:"git push origin main"',
    'pwsh -File build.ps1 "git push origin main"',
    'pwsh --ec ZwBpAHQA',
    'pwsh /ec ZwBpAHQA',
    'pwsh -EncodedCommand ZwBpAHQA',
    'pwsh -encodedcommand=ZwBpAHQA',
    'pwsh -e ZwBpAHQA',
    'powershell /Command git push origin main',
    'PWSH.EXE -Command git push origin main',
    'env pwsh -c git push origin main',
    '/usr/local/microsoft/powershell/7/pwsh -Command "git push origin main"',
    'nu -e "git push origin main"',
    'nu --execute "git push origin main"',
    'nu -c "git push origin main"',
    'nu --commands "git push origin main"',
    'nu --execute="git push origin main"',
    'fish -c "git push origin main"',
    'fish -C "git push origin main"',
    'fish --init-command "git push origin main"',
    'fish -c "cd x && git push origin main"',
    'xonsh -c "git push origin main"',
    'elvish -c "git push origin main"',
    'tcsh -c "git push origin main"',
    'csh -c "git push origin main"',
    'fish -c unknownflag git push origin main',
  ]
  const wrong: string[] = []

  for (const command of spellings) {
    for (const actor of ['lead', 'git', 'developer'] as const) {
      if (verdictOf(actor, command).allow) wrong.push(`${actor}: ${command}`)
    }
  }

  expect(wrong).toEqual([])
})

test('a shell that has no -c contract keeps a literal git read for what it is', () => {
  // The string is read like `bash -c` reads one: the push is judged as any other, so feature is fine and main is not.
  expect(verdictOf('lead', 'pwsh --c "git push origin feature/x:feature/x"').allow).toBe(true)
  expect(reasonOf('lead', 'pwsh --c "git push origin main"')).toMatch(/protected branch `main`/)
  expect(reasonOf('lead', 'nu -e "git commit -m x"')).toMatch(/`git` role/)
  // An encoded command and an unquoted git cannot be read.
  expect(reasonOf('lead', 'pwsh --ec ZwBpAHQA')).toMatch(/hidden/)
  expect(reasonOf('lead', 'pwsh -Command git push origin feature/x')).toMatch(/hidden/)
})

// What passes for git must not pass for the forge: gh, glab, hub and lab are named like git by every check that hides one.
const FORGE_BEHIND_SOMETHING = [
  'echo 1 | xargs gh pr merge',
  'gh pr list --json number -q ".[0].number" | xargs gh pr merge',
  'echo 1 | xargs glab mr merge',
  'echo pr merge 1 | xargs gh',
  'xargs -n1 gh api -X PUT < endpoints',
  'find . -exec gh pr merge 1 \\;',
  'printf "gh pr merge 1" | bash',
  'echo "glab mr merge 1" | zsh',
  'source <(echo gh pr merge 1)',
  'bash < <(echo gh pr merge 1)',
  'watch -n 999 gh pr merge 1',
  'parallel gh pr merge ::: 1',
  'script -q /dev/null gh pr merge 1',
  'trap "gh pr merge 1" EXIT',
  'coproc gh pr merge 1',
  'nohup gh pr merge 1',
  'timeout 5 gh pr merge 1',
  'stdbuf -oL gh pr merge 1',
  'ionice -c 2 gh pr merge 1',
  'setsid gh pr merge 1',
  'caffeinate gh pr merge 1',
  'op run -- gh pr merge 1',
  'echo "hub merge https://github.com/o/r/pull/1" | sh',
  'echo "lab mr merge 1" | bash',
  'xargs -n1 hub push origin main',
  'GH pr merge 1',
  // Unquoted, in another case, with a `.exe` or a path: the same text, whatever the tool is called.
  'echo hub merge https://github.com/o/r/pull/1 | sh',
  'echo hub api -X PUT repos/o/r/pulls/1/merge | sh',
  'echo hub push origin main | sh',
  'echo lab mr merge 1 | bash -s',
  'echo lab mr merge 1 | source /dev/stdin',
  'bash < <(echo lab mr merge 1)',
  'bash < <(echo GH pr merge 1)',
  '. <(echo Lab mr merge 1)',
  'echo GH pr merge 1 | sh',
  'echo gh.exe pr merge 1 | sh',
  'echo GLAB mr merge 1 | sh',
  'echo Git push origin main | sh',
  'echo git.exe push origin main | sh',
  'echo "HUB.EXE merge https://github.com/o/r/pull/1" | sh',
  'echo /usr/local/bin/hub push origin main | sh',
  'xargs GH pr merge',
  'find . -exec Hub.exe push \\;',
  'op run -- hub api -X PUT repos/o/r/pulls/1/merge',
  'op run -- lab mr merge 1',
  'mise exec -- hub merge https://github.com/o/r/pull/1',
  'ssh host hub push origin main',
  'docker exec c hub push origin main',
  'nix-shell --run "hub push origin main"',
  'fish hub push origin main',
  // Behind another command, hub and lab are the tool before a verb of theirs, a group and its action, or an api call.
  'op run -- hub push origin main',
  'mise exec -- hub api -X DELETE repos/o/r',
  'op run -- hub api repos/o/r/pulls/1/merge',
  'op run -- hub pr checkout 5',
  'op run -- hub release create v1',
  'op run -- hub rebase origin/main',
  'op run -- lab mr create',
  'nix-shell --run "lab mr merge 1"',
  // Fed to a shell, the text is the command: hub and lab count before an option or any verb.
  'echo "lab -R x mr merge 1" | sh',
  'echo hub -C . push origin main | sh',
  'echo hub branch -D main | sh',
  'bash < <(echo hub reset --hard)',
  'source <(echo lab -R x mr merge 1)',
]

test('a forge merge behind xargs, find, a pipe into a shell, a feed or a runner is denied for every actor', () => {
  const wrong: string[] = []

  for (const command of FORGE_BEHIND_SOMETHING) {
    for (const [actor, opts] of [['lead', {}], ['lead', { gitRole: false }], ['git', {}], ['developer', {}]] as const) {
      if (gitAllowed(actor, command, all, opts).allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}`)
    }
  }

  expect(wrong).toEqual([])
})

test('a reader that only names the forge, and the ordinary work around it, still pass', () => {
  const ordinary: Array<[GitActor, string]> = [
    ['lead', 'echo gh pr merge'], ['lead', 'echo "glab mr merge 1"'], ['lead', 'grep -rn gh .'], ['lead', 'man gh'], ['lead', 'cat .github/workflows/ci.yml'],
    ['lead', 'ls hub'], ['lead', 'echo lab'], ['lead', 'cd ~/src/hub && make'], ['lead', 'gh pr view 1'], ['lead', 'gh pr checks'],
    ['lead', 'gh issue list'], ['lead', 'glab mr list'], ['lead', 'git status'], ['lead', 'npm test'], ['lead', 'make'],
    ['lead', 'git push -u origin andersonsilva/foo:andersonsilva/foo'], ['lead', 'gh pr list --json number | jq length'],
    ['developer', 'git add -- a.ts && git commit -m "feat: x [T1]" -- a.ts'], ['git', 'gh pr create --fill'], ['git', 'gh pr view 1 --json title'],
    ['qa', 'gh pr view 1'], ['qa', 'echo gh pr merge | cat'],
  ]
  const wrong: string[] = []

  for (const [actor, command] of ordinary) {
    const verdict = gitAllowed(actor, command, only('a.ts'))
    if (!verdict.allow) wrong.push(`${actor}: ${command}: ${verdict.reason}`)
  }

  expect(wrong).toEqual([])
})

test('a word that is not literal in a forge call that changes state is not checked: the git role is refused it', () => {
  const calls = [
    `Q='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'; gh api graphql -f query="$Q"`,
    'gh api graphql -f query="$(cat q.graphql)"',
    'E=repos/o/r/pulls/1/merge; gh api -X PUT "$E"',
    'gh api -X PUT repos/o/r/pulls/1/mer$X',
    'gh pr $A 1',
    'gh pr merge "$N"',
    'glab mr "$ACTION" 1',
    'gh repo edit "$R" --default-branch main',
  ]
  const wrong: string[] = []

  for (const command of calls) {
    for (const [actor, opts] of [['lead', {}], ['lead', { gitRole: false }], ['git', {}], ['developer', {}]] as const) {
      if (gitAllowed(actor, command, all, opts).allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}`)
    }
  }

  expect(wrong).toEqual([])
  expect(reasonOf('git', 'gh api -X PUT "$E"')).toMatch(/not literal.*rewrite it as a literal command/)
})

test('a word that is not literal in a call that is a read whatever it holds is fine', () => {
  for (const command of ['gh pr view "$N"', 'gh pr list --search "$Q"', 'gh pr checks "$N"', 'gh issue view "$N"', 'gh repo view "$R"', 'glab mr view "$N"', 'gh api "$E"', 'gh api -X GET "$E"', 'gh pr diff "$N" --name-only']) {
    const verdict = gitAllowed('git', command, all)
    if (!verdict.allow) throw new Error(`${command}: ${verdict.reason}`)
  }

  // The same word where a write is: refused.
  for (const command of ['gh pr checkout "$N"', 'gh api "$E" -f x=y', 'gh api -X POST "$E"']) {
    expect(gitAllowed('git', command, all).allow, command).toBe(false)
  }
})

// `hub` and `lab` are also what a service, a package, a host and a Jupyter command are called: named behind another command, they
// are the tool only before a verb or a group of theirs, never before an option or an everyday word.
const NAMES_THAT_ARE_NOT_THE_TOOL = [
  'jupyter lab --no-browser',
  'uv run jupyter lab --ip 0.0.0.0',
  'npm run lab -- --watch',
  'kubectl logs -n hub -f mypod',
  'docker compose logs hub -f',
  'docker run --name hub -p 4444:4444 selenium/hub',
  'docker run --rm lab --help',
  './scripts/run.sh lab -v',
  'pnpm --filter hub add lodash',
  'yarn workspace hub add react',
  'brew info hub --json',
  'jupyter lab',
  'jupyter lab extension list',
  'jupyter lab build',
  'jupyter lab clean',
  'ls ~/src/hub',
  'cd lab',
  'pnpm --filter hub test',
  'ssh server docker logs hub',
  'ssh lab uptime',
  'watch -n 5 kubectl get pods -n lab',
  'docker compose up -d hub',
  'kubectl exec -it hub -- sh',
  'helm upgrade --install hub jupyterhub/jupyterhub',
  'rsync -a src/ lab:/srv/data',
  // A service or a script named like a verb or a group of theirs, right after the name.
  'docker compose up hub api',
  'docker compose restart hub api',
  'docker compose logs hub api',
  'docker compose up -d hub api worker',
  'docker compose build lab api',
  'docker compose exec hub api ls /app',
  'kubectl rollout restart deployment/hub api',
  'make lab release',
  'yarn workspace hub create',
  'nx run hub api',
  'python manage.py lab sync',
  'ssh lab repo sync',
  'pnpm --filter hub project',
  'pnpm --filter hub pull',
  'pnpm --filter hub apply',
  'echo hub | tee /tmp/x',
  'echo "see the hub" | sh',
  'make lab',
]

test('hub and lab named as a service, a package or a host are not the tool, for any actor', () => {
  const wrong: string[] = []

  for (const command of NAMES_THAT_ARE_NOT_THE_TOOL) {
    for (const [actor, opts] of [['developer', {}], ['lead', {}], ['lead', { gitRole: false }], ['git', {}], ['qa', {}]] as const) {
      const verdict = gitAllowed(actor, command, only('a.ts'), opts)
      if (!verdict.allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}: ${verdict.reason}`)
    }
  }

  expect(wrong).toEqual([])
})

test('a GraphQL query read from a file or stdin is refused for the git role however the field is spelled', () => {
  const reads = [
    'gh api graphql -F query=@q.graphql',
    'gh api graphql -Fquery=@q.graphql',
    'gh api graphql -Fquery=@-',
    'gh api graphql -fquery=@q.graphql',
    'gh api graphql -iFquery=@q',
    'gh api graphql -XPOST -Fquery=@q.graphql',
    'gh api graphql --field query=@q.graphql',
    'gh api graphql --field=query=@q.graphql',
    'gh api graphql --raw-field=query=@q.graphql',
    'gh api graphql --fie query=@q.graphql',
    'gh api graphql --input q.json',
    'gh api graphql --inp q.json',
    'hub api graphql -Fquery=@q.graphql',
    'glab api graphql -Fquery=@q.graphql',
  ]

  for (const command of reads) {
    expect(reasonOf('git', command), command).toMatch(/read from a file or stdin cannot be checked/)
    expect(gitAllowed('lead', command, all, { gitRole: false }).allow, command).toBe(false)
  }

  // A query written on the command line is read as a query.
  expect(gitAllowed('git', 'gh api graphql -f query="{ viewer { login } }" -X GET', all).allow).toBe(true)
  expect(reasonOf('git', 'gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"')).toMatch(/Changing branches/)
})

test('the GraphQL endpoint is read as the API reads it: a slash, a host, a query string or another case do not hide it', () => {
  const calls = [
    `gh api /graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'`,
    `gh api https://api.github.com/graphql -f query='mutation { x }'`,
    `gh api GraphQL -f query='mutation { x }'`,
    `gh api graphql/ -f query='mutation { x }'`,
    `gh api graphql?x=1 -f query='mutation { x }'`,
    'gh api /graphql -F query=@m.graphql',
    'gh api https://api.github.com/graphql -F query=@-',
    'gh api https://ghe.example.com/api/graphql --input q.json',
    `hub api /graphql -f query='mutation { x }'`,
    'hub api https://api.github.com/graphql -Fquery=@m.graphql',
    `glab api /graphql -f query='mutation { x }'`,
    `glab api https://gitlab.com/api/graphql -f query='mutation { x }'`,
    'glab api https://gitlab.com/api/graphql -F query=@m.graphql',
  ]
  const wrong: string[] = []

  for (const command of calls) {
    for (const [actor, opts] of [['git', {}], ['lead', { gitRole: false }]] as const) {
      if (gitAllowed(actor, command, all, opts).allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}`)
    }
  }

  expect(wrong).toEqual([])
  // The refs, merges and branches endpoints are read the same way.
  expect(reasonOf('git', 'gh api /repos/o/r/pulls/1/merge -X PUT')).toMatch(/Merging/)
  expect(reasonOf('git', 'gh api https://api.github.com/repos/o/r/git/refs -X POST -f ref=refs/heads/main')).toMatch(/Changing branches/)
  // A query written on the command line is a query.
  expect(gitAllowed('git', `gh api /graphql -f query='{ viewer { login } }'`, all).allow).toBe(true)
})

test('hub pr list and hub pr show read; hub pr merge and hub merge <url> are a PR merge', () => {
  for (const actor of ['lead', 'git', 'developer', 'qa'] as const) {
    for (const command of ['hub pr list', 'hub pr list -s open', 'hub pr show 5']) {
      const verdict = gitAllowed(actor, command, all)
      if (!verdict.allow) throw new Error(`${actor}: ${command}: ${verdict.reason}`)
    }
  }

  expect(reasonOf('git', 'hub pr merge 5')).toMatch(/Merging/)
  expect(reasonOf('lead', 'hub pr merge 5')).toMatch(/PR\/MR work/)
  expect(reasonOf('git', 'hub merge https://github.com/o/r/pull/1')).toMatch(/Merging/)
  expect(reasonOf('lead', 'hub merge https://github.com/o/r/pull/1')).toMatch(/PR\/MR work/)

  const forge = classifyGitCommand('hub pr list').forges[0]
  expect([forge?.tool, forge?.group, forge?.action, forge?.changesState]).toEqual(['hub', 'pr', 'list', false])
})

// The git role's central job: a title, a body, notes or a label that a command builds is free text, and says nothing about what the call does.
const FREE_TEXT_FROM_A_COMMAND = [
  'gh pr create --title "feat: x" --body "$(cat <<\'EOF\'\n## Summary\n- one\n\nCloses #1\nEOF\n)"',
  'gh pr create -t "$(git log -1 --format=%s)" -b "$(git log -1 --format=%b)"',
  'gh pr create --base "$BASE" --title x --body y',
  'glab mr create --title x --description "$(cat d.md)" --assignee @me --label feature',
  'gh pr edit 12 --body "$(cat b.md)"',
  'gh pr comment 12 --body "$(cat c.md)"',
  'gh pr review 1 --approve --body "$MSG"',
  'gh release create v1 --notes "$(cat n.md)"',
  'gh pr create --title="$T" --body="$(cat b.md)"',
  'gh pr create -t"$T" -b"$B"',
  'gh pr create --fill --body-file "$F"',
  'glab mr create --fill --title "$(git log -1 --format=%s)" --target-branch main',
]

test('a value that is not literal in a free-text option does not stop the git role from opening or editing a PR/MR', () => {
  const wrong: string[] = []

  for (const command of FREE_TEXT_FROM_A_COMMAND) {
    for (const [actor, opts] of [['git', {}], ['lead', { gitRole: false }]] as const) {
      const verdict = gitAllowed(actor, command, all, opts)
      if (!verdict.allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}: ${verdict.reason}`)
    }

    // The lead with the git role routes it; the read-only roles and the developer never made PRs.
    expect(gitAllowed('lead', command, all).allow, command).toBe(false)
    expect(gitAllowed('developer', command, all).allow, command).toBe(false)
  }

  expect(wrong).toEqual([])
})

test('a word that is not literal anywhere else in a forge call that changes state is still refused to the git role', () => {
  const calls = [
    'gh pr checkout "$N"',
    'gh pr merge "$N"',
    'gh pr create -d "$N"',
    'gh pr edit 12 --body "$(cat b.md)" "$N"',
    'gh pr merge --body "$X" "$N"',
    'gh pr create --title x --body y "$N"',
    'gh pr create --title x -- "$N"',
    'gh pr create --title x --repo "$R"',
    'gh pr create -m "$X"',
    'gh pr create --bod "$X" "$N"',
    'gh pr edit "$N" --body x',
    // An unquoted value is split by the shell: it is not one word, so it can carry an action or `--force`.
    'gh repo sync -b {main,--force}',
    'gh repo sync -b $B',
    'gh pr --title $T',
    'gh pr --subject {x,merge,1}',
    'glab mr --message {x,merge,1}',
    'gh pr create --body $(cat b.md)',
    'gh pr create --body `cat b.md`',
    'gh pr create --title=$T',
    'gh pr create -t$T',
    'gh pr create -b {main,--force}',
    'gh pr create --title "x"$T',
    // Inside double quotes `$@` and an array still become one word per element.
    'set -- main --force; gh repo sync -b "$@"',
    'A=(main --force); gh repo sync -b "${A[@]}"',
    'gh repo sync -b "$*"',
    'gh repo sync -b "${A[*]}"',
    'gh pr create --title "$@"',
    'gh pr $A 1',
    'gh pr "$A" 1',
    'gh api -X PUT "$E"',
    'gh api graphql -f query="$Q"',
    'gh api repos/o/r/issues -f title="$T"',
  ]
  const wrong: string[] = []

  for (const command of calls) {
    for (const [actor, opts] of [['git', {}], ['lead', { gitRole: false }]] as const) {
      if (gitAllowed(actor, command, all, opts).allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}`)
    }
  }

  expect(wrong).toEqual([])
  expect(reasonOf('git', 'gh pr edit 12 --body "$(cat b.md)" "$N"')).toMatch(/not literal.*rewrite it as a literal command/)
})

test('an option before the action moves it: the CLI skips the option and its next word', () => {
  const hidden = [
    'gh pr -t x merge 1',
    'gh pr --subject x merge 1',
    'glab mr -t x merge 1',
    'gh -t issue pr merge 1',
    'gh -t api pr merge 1',
    'gh pr -t view merge 1',
    'gh repo -t x sync --force',
  ]
  const wrong: string[] = []

  for (const command of hidden) {
    for (const [actor, opts] of [['git', {}], ['lead', { gitRole: false }], ['lead', {}], ['developer', {}], ['qa', {}]] as const) {
      if (gitAllowed(actor, command, all, opts).allow) wrong.push(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}`)
    }
  }

  expect(wrong).toEqual([])
  expect(reasonOf('git', 'gh pr -t x merge 1')).toMatch(/option before the action/)
  // The merge written first, with the repository option the group has, is the merge.
  expect(reasonOf('git', 'gh pr --repo o/r merge 1')).toMatch(/Merging/)
  expect(reasonOf('lead', 'gh pr --repo o/r merge 1')).toMatch(/PR\/MR work/)

  // Options after the action, and the group's own `-R`/`--repo` before it, are the ordinary call.
  for (const command of ['gh pr create --title x --body y', 'gh pr view 12 --json title', 'gh pr -R o/r view 12', 'gh pr --repo o/r view 12', 'gh pr --repo=o/r view 12', 'gh -R o/r pr view 12', 'gh pr list --search "$Q"']) {
    const verdict = gitAllowed('git', command, all)
    if (!verdict.allow) throw new Error(`${command}: ${verdict.reason}`)
  }

  // With no word after the option there is no action to move: the version flags are read-only for everyone.
  for (const command of ['gh pr view 12 --json title', 'gh pr -R o/r view 12', 'gh pr --repo o/r view 12', 'gh --version', 'glab --version', 'glab -v', 'gh version', 'gh --help', 'gh pr --help']) {
    for (const [actor, opts] of [['lead', {}], ['lead', { gitRole: false }], ['git', {}], ['developer', {}], ['qa', {}]] as const) {
      const verdict = gitAllowed(actor, command, all, opts)
      if (!verdict.allow) throw new Error(`${actor}${opts.gitRole === false ? ' (no git role)' : ''}: ${command}: ${verdict.reason}`)
    }
  }
})

test('hub and lab are gh and glab: the same verdicts, and hub push is a push', () => {
  expect(reasonOf('lead', 'hub push origin main')).toMatch(/protected branch `main`/)
  expect(reasonOf('lead', 'hub push --force origin feature/x')).toMatch(/Forced/)
  expect(verdictOf('lead', 'hub push origin feature/x:feature/x').allow).toBe(true)
  expect(reasonOf('git', 'hub push origin feature/x:feature/x')).toMatch(/lead pushes/)
  expect(reasonOf('developer', 'hub push origin feature/x')).toMatch(/`git` role/)
  expect(reasonOf('git', 'hub merge https://github.com/o/r/pull/1')).toMatch(/Merging/)
  expect(reasonOf('lead', 'hub merge https://github.com/o/r/pull/1')).toMatch(/PR\/MR work/)
  expect(reasonOf('git', 'hub api -X PUT repos/o/r/pulls/1/merge')).toMatch(/Merging/)
  expect(reasonOf('git', 'hub api -X POST repos/o/r/git/refs -f ref=refs/heads/main')).toMatch(/Changing branches/)
  expect(reasonOf('lead', 'hub api -X PUT repos/o/r/pulls/1/merge')).toMatch(/changes state on the forge/)
  expect(reasonOf('lead', 'hub pull-request -m x')).toMatch(/PR\/MR work/)
  expect(reasonOf('git', 'lab mr merge 1')).toMatch(/Merging/)
  expect(reasonOf('git', 'lab mr accept 1')).toMatch(/Merging/)
  expect(reasonOf('lead', 'lab mr merge 1')).toMatch(/PR\/MR work/)
  expect(reasonOf('git', 'lab project delete o/r')).toMatch(/Deleting a repository/)
  for (const [actor, command] of [['lead', 'hub ci-status'], ['lead', 'hub api repos/o/r'], ['lead', 'lab mr list'], ['git', 'hub pull-request -m x'], ['lead', 'hub log -1']] as const) {
    const verdict = gitAllowed(actor, command, all)
    if (!verdict.allow) throw new Error(`${actor}: ${command}: ${verdict.reason}`)
  }

  const forge = classifyGitCommand('hub pull-request -m x').forges[0]
  expect([forge?.tool, forge?.group, forge?.action]).toEqual(['hub', 'pr', 'create'])
  expect(classifyGitCommand('hub push origin main').segments[0]?.verb).toBe('push')
})
