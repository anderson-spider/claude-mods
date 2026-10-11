import { describe, expect, test } from 'claude-code/testing'
import { WRITE_LANE_PINS, buildArgv, tomlString } from '../hooks/codex/argv'
import { parseCodexModels } from '../hooks/codex/models'
import { CODEX_LANES, isCodexRole, isWriteRole, outputName } from '../hooks/codex/roles'
import { SPECIALISTS } from '../hooks/agents'
import type { CodexRole } from '../hooks/codex/types'

const ROLES: CodexRole[] = ['code-reader', 'research', 'designer', 'developer', 'tester', 'architect']
const DEV = 'developer_instructions="be brief"'
const APPROVALS = ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']
const base = { rolePrompt: 'be brief', approvals: false, skipGitCheck: false }
const PINS = ['-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false']
const pins = (role: CodexRole) => (isWriteRole(role) ? PINS : [])
const SESS = '00000000-0000-4000-8000-000000000001'

describe('codex argv per role', () => {
  const sandbox: Record<CodexRole, string> = {
    'code-reader': 'read-only', research: 'read-only', architect: 'read-only',
    developer: 'workspace-write', designer: 'workspace-write', tester: 'workspace-write',
  }
  for (const role of ROLES) {
    test(`${role}, approvals off`, () => {
      expect(buildArgv({ ...base, role })).toEqual(['codex', 'exec', '--json', '-s', sandbox[role], '-c', DEV, ...pins(role), '-'])
    })
    test(`${role}, approvals on`, () => {
      expect(buildArgv({ ...base, role, approvals: true })).toEqual([
        'codex', 'exec', '--json', '-s', sandbox[role], '-c', DEV, ...APPROVALS, ...pins(role), '-',
      ])
    })
  }
})

describe('codex argv options', () => {
  test('model only when given', () => {
    expect(buildArgv({ ...base, role: 'developer' })).not.toContain('-m')
    expect(buildArgv({ ...base, role: 'developer', model: 'gpt-x' })).toEqual([
      'codex', 'exec', '--json', '-s', 'workspace-write', '-c', DEV, ...PINS, '-m', 'gpt-x', '-',
    ])
  })

  test('an empty model emits no -m', () => {
    expect(buildArgv({ ...base, role: 'developer', model: '' })).toEqual(buildArgv({ ...base, role: 'developer' }))
  })

  test('output is refused for a role without an output file', () => {
    for (const role of ['code-reader', 'developer', 'designer', 'tester'] as const) {
      expect(() => buildArgv({ ...base, role, output: '/tmp/x' })).toThrow('no output file')
    }
    for (const role of ['architect', 'research'] as const) {
      expect(buildArgv({ ...base, role, output: 'o.md' })).toContain('-o')
    }
  })

  test('output adds -o before the prompt marker', () => {
    expect(buildArgv({ ...base, role: 'architect', output: '.crew/reviews/x.md' })).toEqual([
      'codex', 'exec', '--json', '-s', 'read-only', '-c', DEV, '-o', '.crew/reviews/x.md', '-',
    ])
  })

  test('write roles pin the workspace-write keys the person\'s config could widen; read roles get none', () => {
    expect(WRITE_LANE_PINS).toEqual(PINS)
    for (const role of ROLES) {
      const argv = buildArgv({ ...base, role, approvals: true })
      expect(argv.some(a => a.startsWith('sandbox_workspace_write.'))).toBe(isWriteRole(role))
      // No web_search key: Codex's own default applies to every role.
      expect(argv.some(a => a.startsWith('web_search'))).toBe(false)
    }
  })

  test('resume comes after every option and before the prompt marker', () => {
    expect(buildArgv({
      ...base, role: 'research', approvals: true, model: 'm', output: 'o.md', skipGitCheck: true, resume: SESS,
    })).toEqual([
      'codex', 'exec', '--json', '-s', 'read-only', '-c', DEV, ...APPROVALS, '-m', 'm',
      '-o', 'o.md', '--skip-git-repo-check', 'resume', SESS, '-',
    ])
  })

  test('resume alone', () => {
    expect(buildArgv({ ...base, role: 'developer', resume: SESS })).toEqual([
      'codex', 'exec', '--json', '-s', 'workspace-write', '-c', DEV, ...PINS, 'resume', SESS, '-',
    ])
  })

  test('a resume id that is not a UUID is refused: no flag or --last reaches argv', () => {
    for (const resume of ['--last', '--dangerously-bypass-approvals-and-sandbox', '-c', 'abc', '', `${SESS} `, `${SESS}\n-`]) {
      expect(() => buildArgv({ ...base, role: 'developer', resume })).toThrow('UUID')
    }
  })

  test('--skip-git-repo-check only for a read-only role', () => {
    for (const role of ROLES) {
      const argv = buildArgv({ ...base, role, skipGitCheck: true })
      expect(argv.includes('--skip-git-repo-check')).toBe(!isWriteRole(role))
      expect(buildArgv({ ...base, role })).not.toContain('--skip-git-repo-check')
    }
  })

  test('an unknown role is refused', () => {
    expect(() => buildArgv({ ...base, role: 'lead' as CodexRole })).toThrow('Unknown role')
    expect(() => buildArgv({ ...base, role: '__proto__' as CodexRole })).toThrow('Unknown role')
    expect(() => buildArgv({ ...base, role: 'toString' as CodexRole })).toThrow('Unknown role')
  })

  test('an unknown sandbox is refused', () => {
    const lane = CODEX_LANES.developer
    const original = lane.sandbox
    try {
      ;(lane as { sandbox: string }).sandbox = 'danger-full-access'
      expect(() => buildArgv({ ...base, role: 'developer' })).toThrow('Unknown sandbox')
    } finally {
      lane.sandbox = original
    }
  })

  test('the role prompt is escaped in the argv', () => {
    const argv = buildArgv({ ...base, role: 'developer', rolePrompt: 'line1\nsay "hi" \\ done' })
    expect(argv).toContain('developer_instructions="line1\\u000asay \\"hi\\" \\\\ done"')
  })
})

describe('tomlString', () => {
  test('plain text is only quoted', () => {
    expect(tomlString('hello world')).toBe('"hello world"')
    expect(tomlString('')).toBe('""')
  })

  test('backslash and quote', () => {
    expect(tomlString('a\\b')).toBe('"a\\\\b"')
    expect(tomlString('say "x"')).toBe('"say \\"x\\""')
    expect(tomlString('\\"')).toBe('"\\\\\\""')
  })

  test('control characters become \\uXXXX', () => {
    expect(tomlString('a\nb')).toBe('"a\\u000ab"')
    expect(tomlString('a\r\nb')).toBe('"a\\u000d\\u000ab"')
    expect(tomlString('a\tb')).toBe('"a\\u0009b"')
    expect(tomlString('\u0000\u001f')).toBe('"\\u0000\\u001f"')
    expect(tomlString('a\u007fb')).toBe('"a\\u007fb"')
  })

  test('multi-line prompt with quotes yields a single-line string', () => {
    const out = tomlString('# Role\n\n- "quote" it\n- path C:\\x\n')
    expect(out).toBe('"# Role\\u000a\\u000a- \\"quote\\" it\\u000a- path C:\\\\x\\u000a"')
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  test('non-ASCII text stays as it is', () => {
    expect(tomlString('café ✓')).toBe('"café ✓"')
  })
})

describe('roles', () => {
  test('sandbox per lane', () => {
    expect(ROLES.filter(isWriteRole).sort()).toEqual(['designer', 'developer', 'tester'])
    for (const role of ['code-reader', 'research', 'architect'] as const) expect(CODEX_LANES[role].sandbox).toBe('read-only')
  })

  test('output paths', () => {
    expect(CODEX_LANES.architect.output?.('plan-1')).toBe('.crew/reviews/plan-1.md')
    expect(CODEX_LANES.research.output?.('docs-1')).toBe('.crew/research/docs-1.md')
    for (const role of ['code-reader', 'developer', 'designer', 'tester'] as const) {
      expect(CODEX_LANES[role].output).toBeUndefined()
    }
  })

  test('isCodexRole', () => {
    for (const role of ROLES) expect(isCodexRole(role)).toBe(true)
    for (const v of ['lead', '', 'constructor', 'toString', 'crew:developer', 1, null, undefined]) expect(isCodexRole(v)).toBe(false)
  })
})

describe('outputName', () => {
  const safe = /^[a-z0-9]+(-[a-z0-9]+)*$/

  test('a slug of the description, then the job id', () => {
    expect(outputName('Review the Login flow', 'job-ab12')).toBe('review-the-login-flow-job-ab12')
  })

  test('never holds a slash or dots', () => {
    for (const d of ['../../etc/passwd', '/abs/path', 'a/b\\c', '..', '.hidden', 'x\u0000y', 'a b\nc', '"; rm -rf /']) {
      const name = outputName(d, 'job-1')
      expect(name).toMatch(safe)
      expect(name).not.toContain('..')
      expect(name).not.toContain('/')
    }
    expect(outputName('../../etc/passwd', 'job-1')).toBe('etc-passwd-job-1')
  })

  test('an unsafe job id is sanitized too', () => {
    const name = outputName('x', '../../evil/id')
    expect(name).toMatch(safe)
    expect(name).toBe('x-evil-id')
  })

  test('falls back when nothing safe is left', () => {
    expect(outputName('', 'job-1')).toBe('job-1')
    expect(outputName('日本語', 'job-1')).toBe('job-1')
    expect(outputName('..', '')).toBe('job')
    expect(outputName('///', '...')).toBe('job')
  })

  test('the description slug is capped at 40 characters and the job id is never cut', () => {
    const name = outputName('a'.repeat(500), 'cx-mv45ftfc-ek3yw')
    expect(name).toBe(`${'a'.repeat(40)}-cx-mv45ftfc-ek3yw`)
    expect(name).toMatch(safe)
  })

  test('a hostile job id is bounded at 64 characters', () => {
    expect(outputName('x', 'b'.repeat(500))).toBe(`x-${'b'.repeat(64)}`)
  })

  test('a real-shaped 17-character job id survives whole', () => {
    expect(outputName('Review the plan', 'cx-mv45ftfc-ek3yw')).toBe('review-the-plan-cx-mv45ftfc-ek3yw')
    expect(outputName('', 'cx-mv45ftfc-ek3yw')).toBe('cx-mv45ftfc-ek3yw')
  })

  test('truncation leaves no trailing dash', () => {
    expect(outputName(`${'a'.repeat(39)} tail`, 'j')).toBe(`${'a'.repeat(39)}-j`)
  })
})

describe('parseCodexModels', () => {
  test('parses a list', () => {
    expect(parseCodexModels('developer=gpt-x, architect=gpt-y')).toEqual({
      models: { developer: 'gpt-x', architect: 'gpt-y' }, errors: [],
    })
  })

  test('trims and ignores empties', () => {
    expect(parseCodexModels('  developer = gpt-x ,, ,\n tester=m.1:2  ,')).toEqual({
      models: { developer: 'gpt-x', tester: 'm.1:2' }, errors: [],
    })
    expect(parseCodexModels('')).toEqual({ models: {}, errors: [] })
    expect(parseCodexModels('  , ')).toEqual({ models: {}, errors: [] })
  })

  test('rejects unknown roles and keeps the valid ones', () => {
    const r = parseCodexModels('lead=gpt-x, developer=gpt-y, constructor=m')
    expect(r.models).toEqual({ developer: 'gpt-y' })
    expect(r.errors).toHaveLength(2)
  })

  test('rejects bad model ids', () => {
    for (const bad of ['developer=--dangerously-bypass-approvals-and-sandbox', 'developer=-m', 'developer=.x', 'developer=_x', 'developer=:x', 'developer=', 'developer=a b', 'developer=a/b', 'developer=$(x)', `developer=${'a'.repeat(65)}`, 'developer="x"']) {
      const r = parseCodexModels(bad)
      expect(r.models).toEqual({})
      expect(r.errors).toHaveLength(1)
    }
    expect(parseCodexModels(`developer=${'a'.repeat(64)}`).models).toEqual({ developer: 'a'.repeat(64) })
  })

  test('an entry without = is an error', () => {
    const r = parseCodexModels('developer')
    expect(r.models).toEqual({})
    expect(r.errors).toHaveLength(1)
  })

  test('the last entry for a role wins', () => {
    expect(parseCodexModels('developer=a, developer=b').models).toEqual({ developer: 'b' })
  })

  test('never throws on a non-string', () => {
    for (const v of [undefined, null, 5, {}, []]) expect(parseCodexModels(v)).toEqual({ models: {}, errors: [] })
  })

  test('a prototype key is not a role', () => {
    const r = parseCodexModels('__proto__=gpt-x')
    expect(r.errors).toHaveLength(1)
    expect(Object.keys(r.models)).toEqual([])
  })
})

// Independent verification: edge cases for the lanes, approval flags, TOML strings, argv order, output names and models.

/** A strict TOML basic-string reader (TOML 1.0 section "String"): throws on anything a TOML parser refuses. */
function readTomlBasic(src: string): string {
  if (src.length < 2 || src[0] !== '"' || src[src.length - 1] !== '"') throw new Error('not a basic string')
  let out = ''
  for (let i = 1; i < src.length - 1; i++) {
    const ch = src[i] ?? ''
    const code = ch.charCodeAt(0)
    if (ch === '"') throw new Error(`unescaped quote at ${i}`)
    if ((code <= 0x1f && ch !== '\t') || code === 0x7f) throw new Error(`raw control U+${code.toString(16)} at ${i}`)
    if (ch !== '\\') { out += ch; continue }
    const esc = src[++i] ?? ''
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
    if (esc in simple) { out += simple[esc]; continue }
    const width = esc === 'u' ? 4 : esc === 'U' ? 8 : 0
    if (!width) throw new Error(`bad escape \\${esc}`)
    const hex = src.slice(i + 1, i + 1 + width)
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) throw new Error('bad unicode escape')
    const cp = parseInt(hex, 16)
    if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) throw new Error('not a scalar value')
    out += String.fromCodePoint(cp)
    i += width
  }
  return out
}

// `output` goes only to a role whose lane has an output file; the others refuse it.
const optsAll = (role: CodexRole) => ({ model: 'gpt-x', ...(CODEX_LANES[role].output ? { output: 'o.md' } : {}), resume: SESS, approvals: true, skipGitCheck: true })

describe('verify C1: the lane alone picks the sandbox', () => {
  const expected: Record<CodexRole, string> = {
    'code-reader': 'read-only', research: 'read-only', architect: 'read-only',
    developer: 'workspace-write', designer: 'workspace-write', tester: 'workspace-write',
  }
  for (const role of ROLES) {
    test(`${role}: one -s, the lane's, whatever else the call carries`, () => {
      for (const extra of [{}, optsAll(role)]) {
        const hostile = { ...base, ...extra, role, sandbox: 'danger-full-access', dangerouslyBypass: true } as unknown as Parameters<typeof buildArgv>[0]
        const argv = buildArgv(hostile)
        expect(argv.filter(a => a === '-s')).toHaveLength(1)
        expect(argv[argv.indexOf('-s') + 1]).toBe(expected[role])
        expect(argv.some(a => a.includes('danger-full-access') || a.startsWith('--dangerously') || a === '--yolo')).toBe(false)
      }
    })
  }

  test('a role without a lane output cannot be handed one, even among hostile extras', () => {
    for (const role of ROLES.filter(r => CODEX_LANES[r].output === undefined)) {
      for (const output of ['o.md', '/etc/passwd', '../../x', '']) {
        const call = { ...base, ...optsAll(role), role, output, sandbox: 'danger-full-access' } as unknown as Parameters<typeof buildArgv>[0]
        expect(() => buildArgv(call)).toThrow('no output file')
      }
    }
  })

  test('no role can slip a config key in through an extra field', () => {
    for (const role of ROLES) {
      const call = { ...base, role, webSearch: { key: 'sandbox_mode', value: '"danger-full-access"' } } as unknown as Parameters<typeof buildArgv>[0]
      expect(buildArgv(call).some(a => a.includes('sandbox_mode'))).toBe(false)
    }
  })
})

describe('verify C2: approval flags', () => {
  for (const role of ROLES) {
    test(`${role}: exact pair when on, absent when off`, () => {
      const on = buildArgv({ ...base, ...optsAll(role), role, approvals: true })
      const at = on.indexOf('approval_policy="on-request"')
      expect(on.slice(at - 1, at + 3)).toEqual(APPROVALS)
      expect(on.filter(a => a.includes('approval'))).toEqual(['approval_policy="on-request"', 'approvals_reviewer="auto_review"'])
      const off = buildArgv({ ...base, ...optsAll(role), role, approvals: false })
      expect(off.some(a => a.includes('approval'))).toBe(false)
      expect(off.filter(a => a === '-c').length).toBe(on.filter(a => a === '-c').length - 2)
    })
  }
})

describe('verify C3: tomlString reads back through a strict TOML reader', () => {
  const allControls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\u007f'
  const prompts = SPECIALISTS.map(s => s.prompt).join('\n\n')
  const big = prompts.repeat(Math.ceil(5120 / prompts.length))
  const inputs: Record<string, string> = {
    quotes: 'say "hi", \'single\', """triple"""',
    backslashes: 'C:\\path\\ \\u0041 \\n \\\\ \\',
    newlines: 'a\nb\r\nc\r',
    tabs: 'a\tb\t\tc',
    nul: 'a\u0000b',
    del: 'a\u007fb',
    allControls,
    emoji: 'rocket 🚀 dev 👩‍💻 café ✓ 日本語',
    lineSeparators: 'a\u2028b\u2029c\u0085d',
    empty: '',
    big5k: big,
  }
  for (const s of SPECIALISTS) inputs[`prompt:${s.name}`] = s.prompt

  for (const [name, value] of Object.entries(inputs)) {
    test(name, () => {
      const encoded = tomlString(value)
      expect(readTomlBasic(encoded)).toBe(value)
      expect(/[\u0000-\u0008\u000a-\u001f\u007f]/.test(encoded)).toBe(false)
    })
  }

  test('the 5 KB prompt is really over 5 KB and survives as one argv element', () => {
    expect(big.length).toBeGreaterThanOrEqual(5120)
    const argv = buildArgv({ ...base, role: 'architect', rolePrompt: big })
    const dev = argv[argv.indexOf('-c') + 1] ?? ''
    expect(dev.startsWith('developer_instructions="')).toBe(true)
    expect(readTomlBasic(dev.slice('developer_instructions='.length))).toBe(big)
  })

  test('the reader itself refuses what TOML refuses', () => {
    for (const bad of ['"a"b"', '"a\nb"', '"a\\qb"', '"\\ud800"', 'abc', '"\u007f"']) {
      expect(() => readTomlBasic(bad)).toThrow()
    }
  })
})

describe('verify C4: argv order', () => {
  const optionsBeforeResume = ['--json', '-s', '-c', '-m', '-o', '--skip-git-repo-check']
  for (const role of ROLES) {
    test(`${role}: every option before resume <id>, then -`, () => {
      const argv = buildArgv({ ...base, ...optsAll(role), role })
      expect(argv.slice(0, 2)).toEqual(['codex', 'exec'])
      expect(argv[argv.length - 1]).toBe('-')
      expect(argv.filter(a => a === '-')).toHaveLength(1)
      const r = argv.indexOf('resume')
      expect(argv.slice(r, r + 2)).toEqual(['resume', SESS])
      expect(r).toBe(argv.length - 3)
      for (const flag of optionsBeforeResume) {
        const last = argv.lastIndexOf(flag)
        if (last !== -1) expect(last < r).toBe(true)
      }
      expect(argv.includes('--skip-git-repo-check')).toBe(!isWriteRole(role))
      expect(argv.filter(a => a === '-m')).toHaveLength(1)
    })
    test(`${role}: no -m, -o, resume or skip flag unless asked`, () => {
      const argv = buildArgv({ ...base, role })
      for (const a of ['-m', '-o', 'resume', '--skip-git-repo-check']) expect(argv).not.toContain(a)
    })
  }

  test('the lane output paths go with architect and research only', () => {
    for (const role of ROLES) {
      const out = CODEX_LANES[role].output?.(outputName('x', 'j'))
      const argv = buildArgv({ ...base, role, ...(out ? { output: out } : {}) })
      expect(argv.includes('-o')).toBe(role === 'architect' || role === 'research')
    }
  })
})

describe('verify C5: outputName on hostile input', () => {
  const hostile = [
    '../../etc/passwd', '..', '.', '-', '--yolo', '-rf', '', ' ', '\t\n', '日本語', '\u202e..', 'Ａ／．．', '\u0000',
    'İstanbul', 'straße', '\u212a', 'x'.repeat(10240), '../'.repeat(3500), '-'.repeat(10240), '🚀/🚀', 'a\\..\\b',
  ]
  test('never /, .., empty, a leading or trailing dash, or over the bound', () => {
    for (const d of hostile) for (const j of [...hostile, 'job-1']) {
      const name = outputName(d, j)
      expect(name.length > 0).toBe(true)
      expect(name.includes('/') || name.includes('..') || name.startsWith('-') || name.endsWith('-')).toBe(false)
      expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)).toBe(true)
      expect(name.length <= 40 + 1 + 64).toBe(true)
    }
  })

  test('the lane paths built from it stay in their folder', () => {
    for (const d of hostile) {
      expect(CODEX_LANES.architect.output?.(outputName(d, '../x'))).toMatch(/^\.crew\/reviews\/[a-z0-9-]+\.md$/)
      expect(CODEX_LANES.research.output?.(outputName(d, '../x'))).toMatch(/^\.crew\/research\/[a-z0-9-]+\.md$/)
    }
  })
})

describe('verify C6: parseCodexModels never throws and never pollutes', () => {
  test('hostile text', () => {
    const inputs = [
      '', '   ', '\n\n', ',,,', '=', '=x', 'developer==x', 'developer=a=b', '__proto__=x', 'constructor=x', 'hasOwnProperty=x',
      'toString=x', 'valueOf=x', ' __proto__ = gpt-x , developer=ok', 'x'.repeat(100000), 'developer=\u0000', 'developer=gpt\u202ex',
      'DEVELOPER=gpt-x', 'crew:developer=gpt-x',
    ]
    for (const text of inputs) {
      const r = parseCodexModels(text)
      expect(Object.getPrototypeOf(r.models)).toBe(Object.prototype)
      for (const k of Object.keys(r.models)) expect(isCodexRole(k)).toBe(true)
      for (const v of Object.values(r.models)) expect(/^[A-Za-z0-9][\w.:-]{0,63}$/.test(v as string)).toBe(true)
    }
    expect(({} as Record<string, unknown>).x).toBe(undefined)
    expect(parseCodexModels(' __proto__ = gpt-x , developer=ok')).toEqual({ models: { developer: 'ok' }, errors: ['"__proto__": unknown role'] })
    expect(parseCodexModels('DEVELOPER=gpt-x').models).toEqual({})
  })

  test('non-strings, including one whose toString throws', () => {
    const throwing = { toString() { throw new Error('boom') } }
    for (const v of [undefined, null, 0, true, {}, [], throwing, () => 'developer=x', Symbol('s')]) {
      expect(parseCodexModels(v)).toEqual({ models: {}, errors: [] })
    }
  })

  test('duplicates: the last valid one wins and an invalid later one does not erase it', () => {
    expect(parseCodexModels('developer=a\ndeveloper=b, developer=c').models).toEqual({ developer: 'c' })
    const r = parseCodexModels('developer=a, developer=bad id')
    expect(r.models).toEqual({ developer: 'a' })
    expect(r.errors).toHaveLength(1)
  })
})
