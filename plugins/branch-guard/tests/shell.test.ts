import { expect, test } from 'claude-code/testing'

import { enter, locate, parse, resolve } from '../hooks/shell'

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
