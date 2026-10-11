import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'

const kinds = (command: string) => classify(command).map(risk => risk.kind)
test('classify names commits and plain pushes, and leaves force pushes alone', () => {
  expect(kinds('ls -la && git status')).toEqual([])
  expect(kinds('git log --oneline')).toEqual([])
  expect(kinds('echo "git commit -m x"')).toEqual([])

  expect(kinds('git commit -m x')).toEqual(['commit'])
  expect(kinds('git commit -am "fix: the thing" && git push origin main')).toEqual(['commit', 'publish'])
  expect(kinds('git commit -n -m x')).toEqual(['commit'])
  expect(kinds('git commit --amend --no-edit')).toEqual(['commit'])
  expect(kinds('git commit -m "$(cat <<\'EOF\'\nfix: the thing\n\nbody\nEOF\n)"')).toEqual(['commit'])
  expect(kinds('git push')).toEqual(['publish'])
  expect(kinds('git push -u origin main')).toEqual(['publish'])
  expect(kinds('git push origin HEAD:main')).toEqual(['publish'])
  expect(kinds('git push origin :main')).toEqual(['publish'])
  expect(kinds('git push --all')).toEqual(['publish'])

  expect(kinds('git commit --dry-run')).toEqual([])
  expect(kinds('git push --dry-run origin main')).toEqual([])
  expect(kinds('git push -f')).toEqual([])
  expect(kinds('git push --force-with-lease origin main')).toEqual([])
  expect(kinds('git push origin +main')).toEqual([])
  expect(kinds('git push --tags')).toEqual([])
  expect(kinds('git push origin tag v1.2.0')).toEqual([])
  expect(kinds('git push origin refs/tags/v1.2.0')).toEqual([])
})

test('classify sees through brace groups, subshells and the keywords of if', () => {
  expect(kinds('{ git commit -m x; }')).toEqual(['commit'])
  expect(kinds('{ git push origin main; }')).toEqual(['publish'])
  expect(kinds('{ git commit -m x; } 2>&1')).toEqual(['commit'])
  expect(kinds('( git commit -m x )')).toEqual(['commit'])
  expect(kinds('(git commit -m x)')).toEqual(['commit'])
  expect(kinds('if true; then git commit -m x; fi')).toEqual(['commit'])
  expect(kinds('if git commit -m x; then echo ok; else git push origin main; fi')).toEqual(['commit', 'publish'])
  expect(kinds('{ ls; }')).toEqual([])
  expect(classify('{ git commit -m x; }')).toEqual(classify('git commit -m x'))
})

test('classify reads redirections as redirections, not refspecs', () => {
  for (const tail of ['&> log', '> log 2>&1', '>log', '2>/dev/null', '>> log', '&>> log']) {
    expect(classify(`git push origin main ${tail}`)).toMatchObject([{ kind: 'publish', remote: 'origin', refspecs: ['main'] }])
  }

  expect(classify('git push origin main 2>&1 | tail')).toMatchObject([{ refspecs: ['main'] }])
  expect(kinds('git commit -m x > log')).toEqual(['commit'])
  expect(kinds('echo ">"')).toEqual([])
  expect(classify('git push ">" main')).toMatchObject([{ remote: '>', refspecs: ['main'] }])
})

test('classify keeps a push that mixes a tag and a branch', () => {
  expect(classify('git push origin tag v1 main')).toEqual([
    { dir: '.', isElsewhere: false, kind: 'publish', remote: 'origin', refspecs: ['main'], isAllRefs: false, hasUnknownRef: false },
  ])
  expect(classify('git push origin v1.2 main')).toEqual([
    { dir: '.', isElsewhere: false, kind: 'publish', remote: 'origin', refspecs: ['v1.2', 'main'], isAllRefs: false, hasUnknownRef: false },
  ])
})

test('classify follows cd, git -C and the branch a checkout leaves active', () => {
  expect(classify('cd web && git commit -m x')[0]).toMatchObject({ kind: 'commit', dir: 'web' })
  expect(classify('git -C ../other commit -m x')[0]).toMatchObject({ kind: 'commit', dir: '../other' })
  expect(classify('git --git-dir /x/.git commit -m x')[0]).toMatchObject({ kind: 'commit', isElsewhere: true })
  expect(classify('cd "$X" && git commit -m x')[0]).toMatchObject({ isAdrift: true })
  expect(classify('git add -A && git commit -m x')[0]).toMatchObject({ stagesFirst: true })
  expect(classify('git commit -m x src/a.ts')[0]).toMatchObject({ hasPathspec: true })
  expect(classify('git commit -m "src/a.ts"')[0]).toMatchObject({ hasPathspec: false })

  expect(classify('git checkout -b andersonsilva/x && git commit -m x')[0]).toMatchObject({ branchAfter: 'andersonsilva/x' })
  expect(classify('git switch -c andersonsilva/x && git commit -m x')[0]).toMatchObject({ branchAfter: 'andersonsilva/x' })
  expect(classify('git checkout main && git commit -m x')[0]).toMatchObject({ branchAfter: 'main' })
  expect(classify('git switch - && git commit -m x')[0]).toMatchObject({ branchAfter: 'unknown' })
  expect(classify('git checkout -b x || true; git commit -m x')[0]).toMatchObject({ branchAfter: 'unknown' })
  expect(classify('git checkout -- src/a.ts && git commit -m x')[0]).not.toHaveProperty('branchAfter')
  expect(classify('git checkout src/a.ts && git commit -m x')[0]).not.toHaveProperty('branchAfter')
})

test('classify keeps push refspecs and tags as today', () => {
  const base = { dir: '.', isElsewhere: false, kind: 'publish', isAllRefs: false, hasUnknownRef: false }

  expect(classify('git push origin HEAD:main')).toEqual([{ ...base, remote: 'origin', refspecs: ['HEAD:main'] }])
  expect(classify('git push --tags')).toEqual([])
  expect(classify('git push origin v1.2')).toEqual([{ ...base, remote: 'origin', refspecs: ['v1.2'] }])
  expect(classify('git push -u origin feature')).toEqual([{ ...base, remote: 'origin', refspecs: ['feature'] }])
  expect(classify('git -C ../other push')).toEqual([{ ...base, dir: '../other', refspecs: [] }])
})

test('classify treats a heredoc body as data and the rest of the line and what follows it as commands', () => {
  expect(kinds('cat <<EOF\ngit commit -m x\nEOF')).toEqual([])
  expect(kinds('cat <<EOF > f\nhello\nEOF\ngit commit -m x')).toEqual(['commit'])
  expect(kinds('cat <<-EOF\n\tgit commit -m x\n\tEOF')).toEqual([])
  expect(kinds('cat <<-EOF\n\tgit commit -m x\n\tEOF\ngit push origin main')).toEqual(['publish'])
  expect(kinds("cat <<'EOF'\ngit commit -m x\nEOF")).toEqual([])
  expect(kinds('cat <<"EOF"\ngit push origin main\nEOF')).toEqual([])
  expect(kinds('cat <<EOF\ngit commit -m x')).toEqual([])
  expect(kinds('cat <<< "hi"; git commit -m x')).toEqual(['commit'])
  expect(kinds('git commit -F - <<EOF\nmessage\nEOF')).toEqual(['commit'])
  expect(kinds('echo "<<EOF"; git commit -m x')).toEqual(['commit'])
})

test('classify does not read a shift inside arithmetic as a heredoc', () => {
  expect(kinds('x=$((1<<2))\ngit commit -m x')).toEqual(['commit'])
  expect(kinds('(( y = 1<<2 ))\ngit commit -m x')).toEqual(['commit'])
  expect(kinds('x=$(( (1<<2) + 1 ))\ngit commit -m x')).toEqual(['commit'])
})

test('classify sees through case arms and still reads subshells', () => {
  expect(kinds('case $x in a) git commit -m x ;; esac')).toEqual(['commit'])
  expect(kinds('case $x in (a) git commit -m x ;; esac')).toEqual(['commit'])
  expect(classify('case $x in a|b) git push origin main ;; esac')).toMatchObject([
    { kind: 'publish', remote: 'origin', refspecs: ['main'] },
  ])
  expect(kinds('case $x in a) ls ;; b) git commit -m x ;& c) git push origin main ;;& esac')).toEqual(['commit', 'publish'])
  expect(kinds('case $x in git) ls ;; esac')).toEqual([])
  expect(classify('case $x in cd) ls ;; b) git commit -m x ;; esac')[0]).not.toHaveProperty('isAdrift')
  expect(kinds('(git commit -m x)')).toEqual(['commit'])
})

test('classify reads a heredoc or here-string body fed to a shell or ssh as commands', () => {
  expect(kinds("git commit -m \"$(cat <<'EOF'\ndon't\nEOF\n)\" && git push origin main")).toEqual(['commit', 'publish'])
  expect(kinds('bash <<EOF\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(classify("sudo bash <<'EOF'\ngit push origin main\nEOF")).toMatchObject([{ kind: 'publish', refspecs: ['main'] }])
  expect(kinds('env FOO=1 sh <<-EOF\n\tgit commit -m x\n\tEOF')).toEqual(['commit'])
  expect(kinds('/bin/zsh <<EOF\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds('/usr/bin/env bash <<"EOF"\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds("ssh -p 22 host <<'EOF'\ngit push origin main\nEOF")).toEqual(['publish'])
  expect(kinds("bash <<< 'git commit -m x'")).toEqual(['commit'])
  expect(kinds('bash <<EOF && ls\ngit commit -m x\nEOF')).toEqual(['commit'])
})

test('classify keeps a heredoc body as data for other commands, and when the shell has its own script', () => {
  expect(kinds('cat <<EOF\ngit commit -m x\nEOF')).toEqual([])
  expect(kinds('python <<EOF\ngit commit\nEOF')).toEqual([])
  expect(kinds("bash -c 'echo hi' <<EOF\ngit commit -m x\nEOF")).toEqual([])
  expect(kinds('bash script.sh <<EOF\ngit commit -m x\nEOF')).toEqual([])
  expect(kinds("ssh host 'ls' <<EOF\ngit commit -m x\nEOF")).toEqual([])
  expect(kinds('echo $((1<<2)) && git status')).toEqual([])
})

test('classify reads a shell body through wrapper options and through a pipe', () => {
  for (const head of ['sudo -u root bash', 'sudo -E -u deploy sh', 'sudo --user=root bash', 'env -i PATH=/bin bash', 'env -u HOME bash', 'nohup bash', 'exec bash']) {
    expect(kinds(`${head} <<EOF\ngit commit -m x\nEOF`)).toEqual(['commit'])
  }

  expect(kinds('cat <<EOF | bash\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds("cat <<'EOF' | sudo sh\ngit commit -m x\nEOF")).toEqual(['commit'])
  expect(kinds('cat <<EOF | ssh host\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<EOF | grep x\ngit commit -m x\nEOF')).toEqual([])
  expect(kinds("cat <<EOF | ssh host 'ls'\ngit commit -m x\nEOF")).toEqual([])
})

test('classify checks the whole pipeline and over-holds on an unknown wrapper option', () => {
  expect(kinds('cat <<EOF | tee x | bash\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<EOF | tee x | grep y\ngit commit -m x\nEOF')).toEqual([])
  expect(kinds('sudo --chroot=/x bash <<EOF\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds('sudo -X foo bash <<EOF\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds('sudo -X foo cat <<EOF\ngit commit -m x\nEOF')).toEqual([])
})

test('classify reads a shell body when the shell has valued options but no script', () => {
  for (const head of ['bash -o pipefail', 'bash -O extglob', 'bash +o history', 'bash --rcfile x', 'bash --init-file x', 'sh -o errexit']) {
    expect(kinds(`${head} <<EOF\ngit commit -m x\nEOF`)).toEqual(['commit'])
  }

  expect(kinds('bash script.sh <<EOF\ngit commit -m x\nEOF')).toEqual([])
  expect(kinds("bash -o pipefail -c 'echo hi' <<EOF\ngit commit -m x\nEOF")).toEqual([])
  expect(kinds('bash -o pipefail script.sh <<EOF\ngit commit -m x\nEOF')).toEqual([])
})

test('classify reads a shell body when a combined option cluster ends in a valued one', () => {
  for (const head of ['bash -eo pipefail', 'sh -xo errexit', 'bash -euxo pipefail', 'bash +eo pipefail']) {
    expect(kinds(`${head} <<EOF\ngit commit -m x\nEOF`)).toEqual(['commit'])
  }

  expect(kinds('bash -eo pipefail script.sh <<EOF\ngit commit -m x\nEOF')).toEqual([])
})

test('classify sees git commands inside command substitutions', () => {
  expect(kinds('echo $(git commit -m x)')).toEqual(['commit'])
  expect(classify('echo `git push origin main`')).toMatchObject([{ kind: 'publish', refspecs: ['main'] }])
  expect(kinds('x="$(git commit -m x)"')).toEqual(['commit'])
  expect(kinds('x=$(git commit -m x)')).toEqual(['commit'])
  expect(kinds('echo "a `git commit -m x` b"')).toEqual(['commit'])
  expect(kinds('echo $(echo $(git commit -m x))')).toEqual(['commit'])
  expect(classify('diff <(git push origin main) f')).toMatchObject([{ kind: 'publish', refspecs: ['main'] }])
  expect(kinds('tee >(git commit -m x)')).toEqual(['commit'])
  expect(kinds('echo $(git commit -m x')).toEqual(['commit'])
  expect(kinds('echo `git commit -m x')).toEqual(['commit'])

  expect(kinds("echo '$(git commit -m x)'")).toEqual([])
  expect(kinds('echo $((1<<2))')).toEqual([])
  expect(kinds('echo $(ls)')).toEqual([])
})

test('classify reads substitutions in heredoc bodies unless the delimiter is quoted', () => {
  expect(kinds('cat <<EOF\n$(git commit -m x)\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<"EOF"\n$(git commit -m x)\nEOF')).toEqual([])
  expect(kinds("cat <<'EOF'\n$(git commit -m x)\nEOF")).toEqual([])
  expect(kinds('bash <<EOF\ngit commit -m x\nEOF')).toEqual(['commit'])
})

test('classify closes a substitution after a case arm and keeps each one at its place', () => {
  expect(kinds('echo $(case a in a) git commit -m x;; esac)')).toEqual(['commit'])
  expect(kinds('x=$(case $y in (a|b) git push origin main ;; esac)')).toEqual(['publish'])
  expect(kinds('echo $(case a in a) ls;; b) git commit -m x;; esac) && ls')).toEqual(['commit'])

  expect(classify('echo $(git commit -m x); cd /tmp')).toMatchObject([{ kind: 'commit', dir: '.' }])
  expect(classify('cd /a && echo $(git commit -m x)')).toMatchObject([{ kind: 'commit', dir: '/a' }])
  expect(classify('echo $(cd /tmp); git commit -m x')).toMatchObject([{ kind: 'commit', dir: '.' }])
})

test('classify keeps the substitutions in every alternative of a case pattern', () => {
  expect(kinds('case a in $(git commit -m x)) ls;; esac')).toEqual(['commit'])
  expect(kinds('case a in a|$(git commit -m x)) ls;; esac')).toEqual(['commit'])
  expect(kinds('case a in (x|$(git commit -m x)) ls;; esac')).toEqual(['commit'])
  expect(kinds('case a in b) ls;; a|`git commit -m x`) ls;; esac')).toEqual(['commit'])
})

test('classify skips assignments, wrapper names and openers before the command, but not wrapper options or paths', () => {
  expect(kinds('FOO=1 git commit -m x')).toEqual(['commit'])
  expect(kinds('FOO=1 BAR=2 git push origin main')).toEqual(['publish'])
  expect(kinds('sudo git commit -m x')).toEqual(['commit'])
  expect(kinds('env FOO=1 git commit -m x')).toEqual(['commit'])
  expect(kinds('time nohup git push origin main')).toEqual(['publish'])
  expect(kinds('command git commit -m x')).toEqual(['commit'])
  expect(kinds('exec git commit -m x')).toEqual(['commit'])
  expect(kinds('sudo FOO=1 env git commit -m x')).toEqual(['commit'])
  expect(kinds('! git commit -m x')).toEqual(['commit'])
  expect(kinds('while sudo git push origin main; do ls; done')).toEqual(['publish'])
  expect(kinds('/usr/bin/git commit -m x')).toEqual(['commit'])
  expect(kinds('FOO=1 /usr/bin/git push origin main')).toEqual(['publish'])

  // A wrapper's option is the first word `bare` leaves, so what follows it is not seen as `git`.
  expect(kinds('sudo -u root git commit -m x')).toEqual([])
  expect(kinds('env -i git commit -m x')).toEqual([])
  // A wrapper given by path is not skipped either.
  expect(kinds('/usr/bin/sudo git commit -m x')).toEqual([])
  expect(kinds('/usr/bin/env FOO=1 git commit -m x')).toEqual([])
  // Only a command word counts: `git` as an argument is not a command.
  expect(kinds('echo git commit -m x')).toEqual([])
  expect(kinds('sudo')).toEqual([])
  expect(kinds('FOO=1')).toEqual([])
})

test('classify keeps cd and the branch state across the prefix words `bare` skips', () => {
  expect(classify('FOO=1 cd web && git commit -m x')[0]).toMatchObject({ kind: 'commit', dir: 'web' })
  expect(classify('sudo cd web && git commit -m x')[0]).toMatchObject({ kind: 'commit', dir: 'web' })
  expect(classify('sudo git checkout main && sudo git commit -m x')[0]).toMatchObject({ branchAfter: 'main' })
})

test('classify reads the line after a heredoc whose delimiter is quoted in the middle, escaped or spaced', () => {
  expect(kinds('cat <<E"O"F\ngit commit -m x\nEOF\ngit push origin main')).toEqual(['publish'])
  expect(kinds('cat <<\\EOF\ngit commit -m x\nEOF\ngit push origin main')).toEqual(['publish'])
  expect(kinds('cat <<"END OF"\ngit commit -m x\nEND\nEND OF\ngit push origin main')).toEqual(['publish'])
  expect(kinds('cat << EOF\ngit commit -m x\nEOF\ngit push origin main')).toEqual(['publish'])
  // Quoting any part of the delimiter keeps the body unexpanded, so its substitutions do not run.
  expect(kinds('cat <<E"O"F\n$(git commit -m x)\nEOF')).toEqual([])
  expect(kinds('cat <<\\EOF\n$(git commit -m x)\nEOF')).toEqual([])
  expect(kinds("cat << 'EOF'\n$(git commit -m x)\nEOF")).toEqual([])
  expect(kinds('cat << EOF\n$(git commit -m x)\nEOF')).toEqual(['commit'])
})

test('classify ends the heredoc delimiter at an operator and keeps classifying the rest of the line', () => {
  expect(kinds('cat <<EOF; git commit -m x\nbody\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<EOF&&git push origin main\nbody\nEOF')).toEqual(['publish'])
  expect(kinds('cat <<EOF|bash\ngit commit -m x\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<EOF>out\ngit commit -m x\nEOF\ngit push origin main')).toEqual(['publish'])
  expect(kinds('(cat <<EOF)\ngit commit -m x\nEOF\ngit push origin main')).toEqual(['publish'])
})

test('classify drops the body of each heredoc of a line, and swallows the rest when one never closes', () => {
  expect(kinds('cat <<A <<B\ngit commit -m 1\nA\ngit commit -m 2\nB\ngit push origin main')).toEqual(['publish'])
  expect(kinds('cat <<-A <<B\n\tgit commit -m 1\n\tA\ngit commit -m 2\nB\ngit push origin main')).toEqual(['publish'])
  expect(kinds('cat <<EOF\nEOF\ngit commit -m x')).toEqual(['commit'])
  expect(kinds('cat <<A <<B\ngit commit -m 1\nA\ngit commit -m 2')).toEqual([])
  expect(kinds('cat <<A <<B\ngit commit -m 1')).toEqual([])
  // Both bodies are commands for a shell, in order, and the line after them is read too.
  expect(kinds('bash <<A <<B\ngit commit -m 1\nA\ngit push origin main\nB\ngit commit -m 2')).toEqual(['commit', 'publish', 'commit'])
  // A body that holds a `)` does not close the substitution that holds the heredoc.
  expect(kinds('echo $(cat <<EOF\n)\ngit commit -m x\nEOF\n) && git push origin main')).toEqual(['publish'])
  expect(kinds('echo $(cat <<-EOF\n\t)\n\tEOF\n) && git push origin main')).toEqual(['publish'])
  expect(kinds('echo $(cat <<EOF\n$(git commit -m x)\nEOF\n)')).toEqual(['commit'])
})

test('classify ends a backtick substitution at an unescaped backtick and reads the nested one and the line after it', () => {
  expect(kinds('echo `ls` && git push origin main')).toEqual(['publish'])
  expect(kinds('echo `git commit -m x` && git push origin main')).toEqual(['commit', 'publish'])
  expect(kinds('echo `echo \\`git commit -m x\\``')).toEqual(['commit'])
  expect(kinds('echo `echo \\\\` && git commit -m x')).toEqual(['commit'])
  // A `)` inside backticks does not close the `$(…)` around them.
  expect(kinds('echo $(echo `echo )` && git commit -m x) && git push origin main')).toEqual(['commit', 'publish'])
  // A backtick in the body of a heredoc: read when the delimiter is unquoted, unless a backslash escapes it.
  expect(kinds('cat <<EOF\n`git commit -m x`\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<EOF\n\\`git commit -m x\\`\nEOF')).toEqual([])
  expect(kinds("cat <<'EOF'\n`git commit -m x`\nEOF")).toEqual([])
  expect(kinds('cat <<EOF\n`echo \\`git commit -m x\\``\nEOF')).toEqual(['commit'])
  expect(kinds('cat <<EOF\n`git commit -m x')).toEqual(['commit'])
})
