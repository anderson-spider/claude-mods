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
