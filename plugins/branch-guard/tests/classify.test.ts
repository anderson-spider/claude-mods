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
