import { expect, test } from 'claude-code/testing'

import { bare, enter, locate, parse, resolve } from '../hooks/shell'

const texts = (command: string) => parse(command).map(one => one.words.map(word => word.text))

// The commands with words; a newline leaves an empty one behind.
const full = (command: string) => texts(command).filter(words => words.length > 0)

test('parse keeps a quoted argument as one word and splits commands on the sequence operators', () => {
  expect(texts('git commit -m "a b"')).toEqual([['git', 'commit', '-m', 'a b']])
  expect(texts('cd repo && git push')).toEqual([['cd', 'repo'], ['git', 'push']])
  expect(parse('cd repo && git push')[1]?.before).toBe('&&')
})

test('parse drops redirection operators and their targets from the words', () => {
  expect(texts('git push origin main &> log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main &>> log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main > log 2>&1')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main >log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main >> log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main 2>/dev/null')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main 2> err')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main >& log')).toEqual([['git', 'push', 'origin', 'main']])
  expect(texts('git push origin main < in')).toEqual([['git', 'push', 'origin', 'main']])
  // The redirection comes first, and `&` next to it never splits the command.
  expect(texts('>log git push origin main')).toEqual([['git', 'push', 'origin', 'main']])
  expect(parse('git push origin main 2>&1 && ls')).toHaveLength(2)
})

test('parse keeps a quoted operator as a normal word', () => {
  expect(texts('echo ">"')).toEqual([['echo', '>']])
  expect(texts("echo '2>&1' x")).toEqual([['echo', '2>&1', 'x']])
  expect(texts('git commit -m "a > b"')).toEqual([['git', 'commit', '-m', 'a > b']])
})

test('parse leaves the braces of a group as words of their commands', () => {
  expect(texts('{ git commit; }')).toEqual([['{', 'git', 'commit'], ['}']])
})

test('parse skips heredoc bodies and keeps the command line and what follows the delimiter', () => {
  expect(full('cat <<EOF\ngit commit -m x\nEOF')).toEqual([['cat']])
  expect(full('cat <<EOF > f\nhello\nEOF\ngit commit -m x')).toEqual([['cat'], ['git', 'commit', '-m', 'x']])
  expect(full('cat <<-EOF\n\tgit commit -m x\n\tEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full("cat <<'EOF'\ngit commit -m x\nEOF\nls")).toEqual([['cat'], ['ls']])
  expect(full('cat <<"EOF"\ngit commit -m x\nEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full('cat <<EOF | git commit -F -\nbody\nEOF')).toEqual([['cat'], ['git', 'commit', '-F', '-']])
  // Without a closing delimiter the body swallows the rest, as in the shell.
  expect(full('cat <<EOF\ngit commit -m x\nls')).toEqual([['cat']])
  // A delimiter with leading tabs only closes `<<-`; a longer line never closes.
  expect(full('cat <<EOF\n\tEOF\nEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full('cat <<EOF\nEOF2\nEOF\nls')).toEqual([['cat'], ['ls']])
})

test('parse keeps a shift inside $((…)) or ((…)) from opening a heredoc', () => {
  expect(full('x=$((1<<2))\nls').at(-1)).toEqual(['ls'])
  expect(full('(( y = 1<<2 ))\nls').at(-1)).toEqual(['ls'])
  expect(full('cat <<EOF\nbody\nEOF\nls').at(-1)).toEqual(['ls'])
})

test('parse reads a here-string as one word of data and a quoted << as text', () => {
  expect(texts('cat <<< hello; git commit -m x')).toEqual([['cat'], ['git', 'commit', '-m', 'x']])
  expect(texts('cat <<<hello; ls')).toEqual([['cat'], ['ls']])
  expect(texts('echo "<<EOF"\ngit commit -m x')).toEqual([['echo', '<<EOF'], ['git', 'commit', '-m', 'x']])
})

test('parse sees through case arms: patterns and terminators drop, bodies stay', () => {
  const bodies = (command: string) => texts(command).filter(words => words[0] === 'git')

  expect(bodies('case $x in a) git commit -m x ;; esac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in (a) git commit -m x ;; esac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in a|b) git push origin main ;; esac')).toEqual([['git', 'push', 'origin', 'main']])
  expect(bodies('case $x in a) ls ;; b) git commit -m x ;; esac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in a) ls ;& b) git commit -m x ;;& esac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in\n  a)\n    git commit -m x\n    ;;\n  *) ls ;;\nesac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in a) git commit -m x\nesac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in a) (git commit -m x) ;; esac')).toEqual([['git', 'commit', '-m', 'x']])
  expect(bodies('case $x in a) case $y in b) git commit -m x ;; esac ;; esac')).toEqual([['git', 'commit', '-m', 'x']])
  // The patterns are not commands and the terminators leave no empty ones behind.
  expect(texts('case $x in a|b) ls ;; (c) pwd ;& *) true ;;& esac')).toEqual([
    ['case', '$x', 'in'],
    ['ls'],
    ['pwd'],
    ['true'],
    [],
  ])
  // The pattern is not a command, and a subshell outside a case still closes normally.
  expect(texts('case $x in git) ls ;; esac').some(words => words[0] === 'git')).toBe(false)
  expect(texts('(git commit -m x)')).toEqual([[], ['git', 'commit', '-m', 'x'], []])
})

test('resolve joins a relative path to its base and an absolute path wins', () => {
  expect(resolve('/a/b', '../c')).toBe('/a/c')
  expect(resolve('/a', '/x')).toBe('/x')
})

test('enter keeps a home destination as ~ until the home is known', () => {
  expect(enter('/a', '~/x')).toBe('~/x')
})

test('locate resolves a home path from the home, or gives up without one', () => {
  expect(locate('/a', '~/repo', '/home/u')).toBe('/home/u/repo')
  expect(locate('/a', '~/repo', undefined)).toBeUndefined()
})

test('parse reads a heredoc body fed to a shell as commands and keeps one fed to cat as data', () => {
  expect(full('bash <<EOF\ngit commit -m x\nEOF')).toEqual([['bash'], ['git', 'commit', '-m', 'x']])
  expect(full('cat <<EOF\ngit commit -m x\nEOF')).toEqual([['cat']])
})

test('parse adds the commands inside substitutions after the line, and leaves the outer word unknown', () => {
  expect(parse('echo $(git commit -m x)')[0]?.words).toMatchObject([{ text: 'echo' }, { isUnknown: true }])
  expect(parse('echo $(git commit -m x)')[0]?.sub?.[0]?.words.map(word => word.text)).toEqual(['git', 'commit', '-m', 'x'])
  expect(parse('echo `git push`')[0]?.sub?.[0]?.words.map(word => word.text)).toEqual(['git', 'push'])
  expect(parse('echo "$(git push)"')[0]?.sub?.[0]?.words.map(word => word.text)).toEqual(['git', 'push'])
  expect(full("echo '$(git push)'")).toEqual([['echo', '$(git push)']])
  // Arithmetic is not a substitution: it reads as before.
  expect(full('echo $((1+2))')).toEqual([['echo', '$'], ['1+2']])
})

// The words `bare` leaves, as text, for the first command of the line.
const left = (command: string) => bare(parse(command)[0]?.words ?? []).map(word => word.text)

test('bare drops leading assignments, wrapper names and openers, and stops at the first other word', () => {
  expect(left('git commit -m x')).toEqual(['git', 'commit', '-m', 'x'])
  expect(left('FOO=1 BAR=2 git push origin main')).toEqual(['git', 'push', 'origin', 'main'])
  expect(left('sudo git commit -m x')).toEqual(['git', 'commit', '-m', 'x'])
  expect(left('env FOO=1 nohup time git commit')).toEqual(['git', 'commit'])
  expect(left('command exec git commit')).toEqual(['git', 'commit'])
  expect(left('{ git commit; }')).toEqual(['git', 'commit'])
  expect(left('! git commit')).toEqual(['git', 'commit'])
  expect(left('if git commit -m x; then ls; fi')).toEqual(['git', 'commit', '-m', 'x'])
  expect(left('while FOO=1 sudo git push')).toEqual(['git', 'push'])
  // Assignments, wrappers and openers mix in any order.
  expect(left('sudo FOO=1 { git commit')).toEqual(['git', 'commit'])
})

test('bare matches wrapper names whole and stops at a wrapper option', () => {
  // `bare` does not follow a wrapper's options: the option is the first word left.
  expect(left('sudo -u root git commit -m x')).toEqual(['-u', 'root', 'git', 'commit', '-m', 'x'])
  expect(left('env -i git commit')).toEqual(['-i', 'git', 'commit'])
  // A wrapper by path is not a wrapper name: `bare` compares the whole text.
  expect(left('/usr/bin/sudo git commit')).toEqual(['/usr/bin/sudo', 'git', 'commit'])
  expect(left('/usr/bin/env git commit')).toEqual(['/usr/bin/env', 'git', 'commit'])
  // A quoted assignment-looking word still counts as an assignment by its text.
  expect(left('"FOO=1" git commit')).toEqual(['git', 'commit'])
  expect(bare([])).toEqual([])
  expect(left('sudo')).toEqual([])
  expect(left('FOO=1')).toEqual([])
})

test('parse ends a heredoc delimiter at a quote, an escape or an operator, and keeps spaces inside quotes', () => {
  // The delimiter is the unquoted word: `E"O"F` is `EOF`, `\EOF` is `EOF`.
  expect(full('cat <<E"O"F\ngit commit -m x\nEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full('cat <<\\EOF\ngit commit -m x\nEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full("cat <<'E O F'\ngit commit -m x\nE O F\nls")).toEqual([['cat'], ['ls']])
  // Blanks between `<<` and the word are skipped, and so are the tabs of `<<-`.
  expect(full('cat << EOF\ngit commit -m x\nEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full("cat <<- 'EOF'\n\tgit commit -m x\n\tEOF\nls")).toEqual([['cat'], ['ls']])
  // The shell reads the delimiter up to the next blank or operator: what follows on the line is a command.
  expect(full('cat <<EOF; ls\nbody\nEOF')).toEqual([['cat'], ['ls']])
  expect(full('cat <<EOF|wc\nbody\nEOF')).toEqual([['cat'], ['wc']])
  expect(full('cat <<EOF&&ls\nbody\nEOF')).toEqual([['cat'], ['ls']])
  expect(full('(cat <<EOF)\nbody\nEOF\nls')).toEqual([['cat'], ['ls']])
  expect(full('cat <<EOF>out\nbody\nEOF\nls')).toEqual([['cat'], ['ls']])
  // The closing line must equal the whole delimiter.
  expect(full('cat <<A\nbody\nA B\nA\nls')).toEqual([['cat'], ['ls']])
  expect(full('cat <<"A B"\nbody\nA\nA B\nls')).toEqual([['cat'], ['ls']])
})

test('parse takes the bodies of several heredocs of one line in order and swallows the rest when one never closes', () => {
  expect(full('cat <<A <<B\none\nA\ntwo\nB\nls')).toEqual([['cat'], ['ls']])
  expect(full('cat <<-A <<B\n\tone\n\tA\ntwo\nB\nls')).toEqual([['cat'], ['ls']])
  // An empty body: the delimiter is the first line.
  expect(full('cat <<EOF\nEOF\nls')).toEqual([['cat'], ['ls']])
  // The second never closes: it runs to the end of the text, and the first still closed at its own line.
  expect(full('cat <<A <<B\none\nA\nls')).toEqual([['cat']])
  // The first never closes: the second has nothing left.
  expect(full('cat <<A <<B\nls')).toEqual([['cat']])
  // The end of the text right after the delimiter, with and without the final newline.
  expect(full('cat <<A\none\nA')).toEqual([['cat']])
  expect(full('cat <<A\none\nA\n')).toEqual([['cat']])
})

test('parse reads the bodies of two heredocs fed to a shell as commands, each at its place', () => {
  expect(full('bash <<A <<B\ngit commit -m 1\nA\ngit push origin main\nB\nls')).toEqual([
    ['bash'],
    ['git', 'commit', '-m', '1'],
    ['git', 'push', 'origin', 'main'],
    ['ls'],
  ])
})

test('parse closes a substitution at its own parenthesis, past a heredoc body, a backtick and a quote', () => {
  // A `)` in a heredoc body inside `$(…)` does not close it.
  expect(full('echo $(cat <<EOF\n)\nEOF\n) && ls')).toEqual([['echo', '$(cat <<EOF\n)\nEOF\n)'], ['ls']])
  expect(full('echo $(cat <<-EOF\n\t)\n\tEOF\n) && ls')).toEqual([['echo', '$(cat <<-EOF\n\t)\n\tEOF\n)'], ['ls']])
  // A `)` in backticks, in quotes or escaped inside `$(…)` does not close it either.
  expect(full('echo $(echo `echo )`) && ls')).toEqual([['echo', '$(echo `echo )`)'], ['ls']])
  expect(full("echo $(echo ')') && ls")).toEqual([['echo', "$(echo ')')"], ['ls']])
  expect(full('echo $(echo ")") && ls')).toEqual([['echo', '$(echo ")")'], ['ls']])
  expect(full('echo $(echo \\)) && ls')).toEqual([['echo', '$(echo \\))'], ['ls']])
})

test('parse ends a backtick substitution at the first backtick no backslash escapes, or at the end of the text', () => {
  const inner = (command: string) => parse(command)[0]?.sub?.[0]?.words.map(word => word.text)

  expect(inner('echo `git commit -m x` && ls')).toEqual(['git', 'commit', '-m', 'x'])
  expect(full('echo `git commit -m x` && ls')).toEqual([['echo', '`git commit -m x`'], ['ls']])
  // An escaped backtick is a nested one: the substitution runs on to the last, and the escapes come off.
  expect(parse('echo `echo \\`git commit -m x\\`` && ls')[0]?.sub?.[0]?.sub?.[0]?.words.map(word => word.text)).toEqual(['git', 'commit', '-m', 'x'])
  // An escaped backslash before the closing backtick closes it.
  expect(full('echo `echo \\\\` && ls')).toEqual([['echo', '`echo \\\\`'], ['ls']])
  // Never closed: it reads to the end.
  expect(inner('echo `git commit -m x')).toEqual(['git', 'commit', '-m', 'x'])
})
