import { expect, test } from 'claude-code/testing'
import { declaresOption, parseEnvFile, resolveKey, trustedHome } from '../hooks/key'
import type { KeyIo } from '../hooks/key'

// Key-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const k = (name: string) => ['key-', name, '-0123456789'].join('')

function io(over: { env?: Record<string, string>; project?: Record<string, unknown>; local?: Record<string, unknown>; settingsFail?: boolean; file?: string; home?: string | undefined }): KeyIo {
  return {
    env: async name => over.env?.[name],
    settingsEnv: async source => {
      if (over.settingsFail) throw new Error('unreadable')
      return source === 'project' ? over.project : over.local
    },
    read: async path => {
      if (over.file === undefined || path !== `${over.home ?? '/home/u'}/.jev-router.env`) throw new Error('ENOENT')
      return over.file
    },
    home: async () => ('home' in over ? over.home : '/home/u'),
  }
}

test('TYPESAFE_API_KEY is read before JEV_API_KEY, the file and the option', async () => {
  const both = io({ env: { TYPESAFE_API_KEY: k('ts'), JEV_API_KEY: k('jev') }, file: `JEV_API_KEY=${k('file')}` })
  expect(await resolveKey(both, k('opt'))).toMatchObject({ key: k('ts'), source: 'env' })
  expect(await resolveKey(io({ env: { JEV_API_KEY: ` ${k('jev')} ` } }))).toMatchObject({ key: k('jev'), source: 'env' })
})

test('the file comes next, then the option', async () => {
  const file = `# jev-router\nexport JEV_API_KEY="${k('file')}"\nOTHER=1\n`
  expect(await resolveKey(io({ file }), k('opt'))).toMatchObject({ key: k('file'), source: 'file' })
  expect(await resolveKey(io({}), k('opt'))).toEqual({ key: k('opt'), source: 'option', home: '/home/u' })
  expect(await resolveKey(io({}), '  ')).toEqual({ home: '/home/u' })
  expect(await resolveKey(io({ home: undefined, file: `JEV_API_KEY=${k('file')}` }))).toEqual({})
})

test('an environment key that the repository settings declare is ignored, the others still count', async () => {
  const fromRepo = io({ env: { TYPESAFE_API_KEY: k('repo'), JEV_API_KEY: k('user') }, project: { TYPESAFE_API_KEY: k('repo') } })
  expect(await resolveKey(fromRepo)).toMatchObject({ key: k('user'), source: 'env' })

  const local = io({ env: { JEV_API_KEY: k('repo') }, local: { JEV_API_KEY: k('repo') } })
  expect(await resolveKey(local)).toEqual({ home: '/home/u' })
})

test('when the settings cannot be read there is no key at all: no environment, no file, no option', async () => {
  const failing = io({ env: { JEV_API_KEY: k('env') }, settingsFail: true, file: `JEV_API_KEY=${k('file')}` })
  expect(await resolveKey(failing, k('opt'))).toEqual({})
  expect(await trustedHome(failing)).toBeUndefined()
})

test('a HOME the repository settings declare is not trusted: the key file is not read', async () => {
  const file = `JEV_API_KEY=${k('file')}`
  expect(await resolveKey(io({ file, project: { HOME: '/home/u' } }))).toEqual({})
  expect(await resolveKey(io({ file, local: { HOME: '/elsewhere' } }), k('opt'))).toEqual({ key: k('opt'), source: 'option' })
  expect(await trustedHome(io({ project: { HOME: '/home/u' } }))).toBeUndefined()
  // Declared elsewhere in the env block, HOME is still the user's.
  expect(await resolveKey(io({ file, project: { OTHER: '1' } }))).toMatchObject({ key: k('file'), source: 'file' })
})

test('a relative or empty HOME is not trusted: the key file is not read', async () => {
  for (const home of ['.', 'repo', '', '  ', '~']) {
    expect(await resolveKey(io({ home, file: `JEV_API_KEY=${k('file')}` }))).toEqual({})
    expect(await trustedHome(io({ home }))).toBeUndefined()
  }
  expect(await trustedHome(io({ home: '/home/u/' }))).toBe('/home/u')
})

test('dotenv parsing: export, quotes, comments and unrelated lines', () => {
  expect(parseEnvFile("export A=1\nB='two words'\nC=\"x\" # c\nD=plain # tail\n#E=no\nnot a pair\n\nF = spaced ")).toEqual({
    A: '1',
    B: 'two words',
    C: 'x',
    D: 'plain',
    F: 'spaced',
  })
})

test('a repository declares the option under crew or crew@marketplace, any value', () => {
  expect(declaresOption({ crew: { options: { jevRouting: true } } }, 'crew', 'jevRouting')).toBe(true)
  expect(declaresOption({ 'crew@spider-claude-mods': { options: { jevRouting: false } } }, 'crew', 'jevRouting')).toBe(true)
  expect(declaresOption({ crew: { options: {} }, other: { options: { jevRouting: true } } }, 'crew', 'jevRouting')).toBe(false)
  expect(declaresOption({ crewx: { options: { jevRouting: true } } }, 'crew', 'jevRouting')).toBe(false)
  expect(declaresOption(undefined, 'crew', 'jevRouting')).toBe(false)
})

test('the trusted home comes out with the key, from the same scan, and only when it is trusted', async () => {
  expect(await resolveKey(io({ env: { TYPESAFE_API_KEY: k('ts') } }))).toEqual({ key: k('ts'), source: 'env', home: '/home/u' })
  // No key, still a home: redaction does not depend on having one.
  expect(await resolveKey(io({}))).toEqual({ home: '/home/u' })
  // Declared by the repository or relative: none.
  expect(await resolveKey(io({ env: { TYPESAFE_API_KEY: k('ts') }, project: { HOME: '/home/u' } }))).toEqual({ key: k('ts'), source: 'env' })
  expect(await resolveKey(io({ env: { TYPESAFE_API_KEY: k('ts') }, home: '.' }))).toEqual({ key: k('ts'), source: 'env' })
})
