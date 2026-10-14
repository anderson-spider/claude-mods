import { expect, test } from 'claude-code/testing'
import { offText, parseTokens, resolveToken, type Off, type TokenIo } from '../hooks/tokens'

const OPTION = 'gitlab.com=glpat-personal, gitlab.example.com=glpat-work'

test('parseTokens reads host=token pairs separated by commas or whitespace, hosts case-insensitive', () => {
  expect(parseTokens(` GitLab.com=glpat-a\ngitlab.example.com:8443=glpat-b `)).toEqual({
    tokens: new Map([
      ['gitlab.com', 'glpat-a'],
      ['gitlab.example.com:8443', 'glpat-b'],
    ]),
  })
})

test('parseTokens tells an absent option from a malformed one', () => {
  expect(parseTokens(undefined)).toEqual({ off: 'no-tokens' })
  expect(parseTokens(' , ')).toEqual({ off: 'no-tokens' })
  for (const bad of [5, 'glpat-only', '=glpat-x', 'gitlab.com=', 'gitlab.com=a=b', 'a b.com=x', 'h=x,h=y', 'h/x=t']) {
    expect(parseTokens(bad), String(bad)).toEqual({ off: 'bad-tokens' })
  }
})

const io = (sources: Partial<Record<'project' | 'local', { pluginConfigs?: unknown }>> = {}): TokenIo => ({
  settings: async (source) => sources[source],
})

test('resolveToken picks the token of the remote host only', async () => {
  expect(await resolveToken(io(), OPTION, 'gitlab.example.com')).toEqual({ token: 'glpat-work' })
  expect(await resolveToken(io(), OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  expect(await resolveToken(io(), OPTION, 'gitlab.other.org')).toEqual({ off: 'no-host' })
})

test('resolveToken refuses tokens the repository declares, and unreadable settings', async () => {
  const declared = { pluginConfigs: { 'gitlab@spider-claude-mods': { options: { tokens: 'x' } } } }
  expect(await resolveToken(io({ project: declared }), OPTION, 'gitlab.com')).toEqual({ off: 'repo-tokens' })
  expect(await resolveToken(io({ local: declared }), OPTION, 'gitlab.com')).toEqual({ off: 'repo-tokens' })
  expect(await resolveToken(io({ project: { pluginConfigs: { gitlabx: { options: { tokens: 'x' } } } } }), OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  expect(await resolveToken({ settings: () => Promise.reject(new Error('x')) }, OPTION, 'gitlab.com')).toEqual({ off: 'unreadable' })
})

test('every refusal names the option or the settings, never a token, and no-host names the host to add', () => {
  for (const off of ['no-tokens', 'bad-tokens', 'no-host', 'unreadable', 'repo-tokens'] as Off[]) {
    expect(offText(off, 'gitlab.other.org')).toMatch(/tokens option/)
    expect(offText(off, 'gitlab.other.org')).not.toContain('glpat')
  }
  expect(offText('no-host', 'gitlab.other.org')).toContain('Add gitlab.other.org=<token>')
})
