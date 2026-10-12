import { expect, test } from 'claude-code/testing'
import { decide, ROUTING_OFF_REASON, type Quota } from '../hooks/quota'
import { quotaView } from '../hooks/hud/quota-view'
import { cardRow, cardRowSegs, fitSegs, seg, segsText, segsWidth } from '../hooks/hud/layout'
import { parsePlan } from '../hooks/hud/plan'
import {
  MAX_AGENTS,
  TEXT_CELLS,
  agentCompleted,
  agentDenied,
  agentSpawned,
  agentTool,
  askOpened,
  consultStarted,
  defaultSession,
  denyLine,
  parseVerdict,
  promptLine,
} from '../hooks/hud/state'
import { cellWidth, cleanControls, fit, oneLine, truncate } from '../hooks/hud/width'

const T0 = Date.parse('2026-10-12T12:00:00Z')
const hasControl = (text: string) => cleanControls(text) !== text

// ------------------------------------------------------------------ F1: control characters

test('F1: a multi-line command in a card row stays one row of exactly the width, with no control character', () => {
  for (const w of [20, 52, 56]) {
    for (const text of ['Bash cat <<EOF\nsecret\nEOF', 'a\tb', 'cr\rlf', '\x1b[31mred\x1b[0m', 'x y\u0085z', '\x00\x07bell']) {
      const row = cardRow(text, w)
      expect(cellWidth(row)).toBe(w)
      expect(hasControl(row)).toBe(false)
      const segs = cardRowSegs([seg(text, 'ok'), seg(text)], w)
      expect(segsWidth(segs)).toBe(w)
      expect(hasControl(segsText(segs))).toBe(false)
      expect(hasControl(fit(text, w, 'right'))).toBe(false)
      expect(cellWidth(fit(text, w, 'right'))).toBe(w)
    }
  }
  // text that fits is cleaned too, not passed through
  expect(truncate('a\nb', 10)).toBe('a b')
  expect(segsText(fitSegs([seg('a\tb')], 5))).toBe('a b  ')
  expect(cleanControls('a\x1bb')).toBe('a b')
})

test('F1: oneLine collapses whitespace and controls to one space', () => {
  expect(oneLine('  a \n\t b\r\nc  ')).toBe('a b c')
  expect(oneLine('x\x1b[31my')).toBe('x [31my')
  expect(oneLine('a b\u0085c d')).toBe('a b c d')
  expect(oneLine('')).toBe('')
})

test('F1: reducers store one line: tool, denial, description, consult, ask', () => {
  let list = agentSpawned([], { id: 'a', type: 'crew:developer', description: 'T1: line one\nline two\ttab', now: T0 })
  expect(list[0]?.description).toBe('T1: line one line two tab')
  expect(list[0]?.stepId).toBe('T1')
  list = agentTool(list, 'a', 'Bash cat <<EOF\nbody\nEOF')
  expect(list[0]?.lastTool).toBe('Bash cat <<EOF body EOF')
  list = agentDenied(list, 'a', 'Bash rm\n-rf /')
  expect(list[0]?.denied).toBe('Bash rm -rf /')
  const consults = consultStarted([], { id: 'c', type: 'crew:architect', description: 'T2\napproach', now: T0 })
  expect(consults[0]?.description).toBe('T2 approach')
  const s = askOpened(defaultSession(T0), { id: 'k', who: 'dev\neloper', tool: 'Bash\techo' })
  expect(s.asks[0]).toEqual({ id: 'k', who: 'dev eloper', tool: 'Bash echo' })
  expect(parseVerdict('Approve:\tfine ok').line).toBe('Approve: fine ok')
})

test('F1: plan step text and note lose tabs and controls', () => {
  const plan = parsePlan('- A1 (lead, after: —) split\tit\x1b[0m up — state: blocked (needs\tGo\x1b 1.27)')
  expect(plan.steps[0]?.text).toBe('split it [0m up')
  expect(plan.steps[0]?.note).toBe('needs Go 1.27')
  expect(hasControl(plan.steps[0]?.text ?? '')).toBe(false)
})

// ------------------------------------------------------------------ F2: secrets

const BEARER = 'Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

test('F2: tool text, denial, description, consult and verdict come out redacted', () => {
  let list = agentSpawned([], { id: 'a', type: 'crew:developer', description: `T1: call with ${GH}`, now: T0 })
  expect(list[0]?.description).not.toContain('ghp_')
  expect(list[0]?.description).toContain('[redacted]')
  list = agentTool(list, 'a', `Bash curl -H "Authorization: ${BEARER}" https://x`)
  expect(list[0]?.lastTool).not.toContain('sk-ant')
  expect(list[0]?.lastTool).toContain('[redacted]')
  list = agentTool(list, 'a', 'Bash GITHUB_TOKEN=abcd1234efgh5678ijkl git push')
  expect(list[0]?.lastTool).not.toContain('abcd1234efgh5678ijkl')
  list = agentDenied(list, 'a', `Bash export KEY=${GH}`)
  expect(list[0]?.denied).not.toContain('ghp_')
  const consults = consultStarted([], { id: 'c', type: 'crew:architect', description: `audit ${BEARER}`, now: T0 })
  expect(consults[0]?.description).not.toContain('sk-ant')
  const verdict = parseVerdict(`Fixes: the log leaks ${GH} in line 4`)
  expect(verdict.line).not.toContain('ghp_')
  expect(verdict.reason).not.toContain('ghp_')
  expect(verdict.verdict).toBe('Fixes')
  expect(askOpened(defaultSession(T0), { id: 'k', who: 'dev', tool: `Bash ${GH}` }).asks[0]?.tool).not.toContain('ghp_')
})

test('F2: redaction runs before the cut, so a token on the cap boundary does not survive as a prefix', () => {
  // The token starts 12 cells before the cap: cut first, then redact, would keep `ghp_abcdefg…` (under the 20 characters its
  // shape needs, so nothing matches it any more) and leak the prefix.
  const text = `${'x'.repeat(TEXT_CELLS - 13)} ${GH}`
  const list = agentTool(agentSpawned([], { id: 'a', type: 'crew:developer', description: 'd', now: T0 }), 'a', text)
  expect(list[0]?.lastTool).not.toContain(GH.slice(0, 8))
  expect(list[0]?.lastTool).toContain('[redacted]')
})

test('R2: a denial in the Log is redacted and one line', () => {
  const line = denyLine('developer', `Bash curl -H "Authorization: ${BEARER}"\nnext`, T0, 'crew:developer')
  expect(line.text).not.toContain('sk-ant')
  expect(line.text).toContain('[redacted]')
  expect(hasControl(line.text)).toBe(false)
  expect(line.text.startsWith('✗ denied Bash curl')).toBe(true)
})

test('R3: a prompt in the Log is redacted, one line and capped', () => {
  const esc = promptLine('fix \x1b[31mthis\x1b[0m now', T0)
  expect(hasControl(esc.text)).toBe(false)
  const big = promptLine(`${'word '.repeat(1000)}`, T0)
  expect(cellWidth(big.text)).toBeLessThanOrEqual(TEXT_CELLS)
  expect(big.text.endsWith('…')).toBe(true)
  expect(promptLine(`use ${GH}\nsecond`, T0).text).toBe('use [redacted]')
  expect(promptLine('', T0).text).toBe('')
})

test('R4: reducers collapse a run of whitespace and line breaks to one space', () => {
  const card = agentSpawned([], { id: 'a', type: 'crew:developer', description: 'a\r\n  b', now: T0 })
  expect(card[0]?.description).toBe('a b')
  expect(agentTool(card, 'a', 'a\r\n  b')[0]?.lastTool).toBe('a b')
  expect(agentDenied(card, 'a', 'a\r\n  b')[0]?.denied).toBe('a b')
  expect(consultStarted([], { id: 'c', type: 'crew:architect', description: 'a\r\n  b', now: T0 })[0]?.description).toBe('a b')
  expect(askOpened(defaultSession(T0), { id: 'k', who: 'a\r\n  b', tool: 'a\r\n  b' }).asks[0]).toEqual({ id: 'k', who: 'a b', tool: 'a b' })
  expect(parseVerdict('Approve: a\r\n  b').line).toBe('Approve: a')
  expect(parseVerdict('a   b').line).toBe('a b')
})

test('F2: stored text is capped', () => {
  const huge = `Bash cat <<EOF\n${'line of the heredoc\n'.repeat(500)}EOF`
  const list = agentTool(agentSpawned([], { id: 'a', type: 'crew:developer', description: 'x'.repeat(5000), now: T0 }), 'a', huge)
  expect(cellWidth(list[0]?.lastTool ?? '')).toBeLessThanOrEqual(TEXT_CELLS)
  expect(list[0]?.lastTool.endsWith('…')).toBe(true)
  expect(cellWidth(list[0]?.description ?? '')).toBeLessThanOrEqual(TEXT_CELLS)
})

test('F2: paths are kept (secrets only)', () => {
  const list = agentTool(agentSpawned([], { id: 'a', type: 'crew:developer', description: 'd', now: T0 }), 'a', 'Edit /Users/me/repo/internal/config/x.go')
  expect(list[0]?.lastTool).toBe('Edit /Users/me/repo/internal/config/x.go')
})

// ------------------------------------------------------------------ F3: wrapper lines

test('F3: a leading warning or agent-message line is not the verdict', () => {
  expect(parseVerdict('[review warning: the agent edited outside its lane]\nApprove: clean')).toMatchObject({ verdict: 'Approve', reason: 'clean' })
  expect(parseVerdict('<agent-message from="architect">\nFixes: races on stop')).toMatchObject({ verdict: 'Fixes', reason: 'races on stop' })
  expect(parseVerdict('[w1]\n<tag>\n\nReject: no')).toMatchObject({ verdict: 'Reject' })
  // after the hand-back header, start there
  expect(parseVerdict('Agent finished. The report follows:\n\nApprove: T1 is fine\nmore')).toMatchObject({ verdict: 'Approve', reason: 'T1 is fine' })
  expect(parseVerdict('Header line\nthe report follows:\n[warn]\nFixes: x')).toMatchObject({ verdict: 'Fixes' })
  // only wrappers: nothing to show
  expect(parseVerdict('[only a warning]')).toEqual({ line: '', verdict: null, reason: '' })
  // an ordinary first line is untouched
  expect(parseVerdict('Approve: ok')).toMatchObject({ verdict: 'Approve' })
})

// ------------------------------------------------------------------ F4: wide emoji

test('F4: colored circles and squares, mahjong and enclosed ideographs are two cells', () => {
  for (const ch of ['🟢', '🟡', '🟧', '🟫', '🀄', '🈁', '🆎', '🆑', '🈚', '🉐', '🟰', '🃏']) {
    expect(cellWidth(ch)).toBe(2)
  }
  expect(cellWidth('a🟢b')).toBe(4)
  // neighbors that are not wide stay narrow
  expect(cellWidth('🀃')).toBe(1)
  expect(cellWidth(cardRow('🟢 ok 🟧', 20))).toBe(20)
})

// ------------------------------------------------------------------ F5: ZWJ sequences

test('F5: truncate never cuts inside a ZWJ sequence', () => {
  const family = '👨‍👩‍👧'
  const cut = truncate(`${family}${family}abc`, 5)
  expect(cut).toBe(`${family}${family}…`)
  expect(cellWidth(cut)).toBeLessThanOrEqual(5)
  // every grapheme in the result is whole: no dangling joiner, no lone half
  expect(cut.includes('‍…')).toBe(false)
  for (const w of [3, 4, 5, 6, 7]) {
    const out = truncate(`${family}${family}${family}`, w)
    expect(cellWidth(out)).toBeLessThanOrEqual(w)
    expect(out.replace('…', '').split(family).join('')).toBe('')
  }
  expect(truncate('👍🏽 ok', 3)).toBe('👍🏽…')
})

// ------------------------------------------------------------------ F6: a fresh subscriber session

const NOW = Date.parse('2026-10-12T12:00:00Z')
const quota = (over: Partial<Quota> = {}): Quota => ({
  claude: null,
  codex: null,
  codexState: 'off',
  fetchedAt: null,
  codexObservedAt: null,
  claudeAt: null,
  decision: { provider: 'claude', reason: ROUTING_OFF_REASON },
  ...over,
})

test('F6: before the first measure the Claude block waits instead of claiming "no plan limits"', () => {
  const waiting = quotaView(quota(), { now: NOW, routing: false, twins: false, claudeMeasured: false })
  expect(waiting.claude.header).toBe('Claude · waiting')
  expect(cellWidth(waiting.claude.header)).toBeLessThanOrEqual(16)
  expect(waiting.claude.showResets).toBe(false)
  expect(waiting.claude.gauges.map(g => [g.label, g.pct])).toEqual([['5h', null], ['7d', null]])
  // measured and empty is API billing; an absent flag counts as measured
  expect(quotaView(quota(), { now: NOW, routing: false, twins: false, claudeMeasured: true }).claude).toMatchObject({ header: 'Claude · no plan limits', gauges: [] })
  expect(quotaView(quota(), { now: NOW, routing: false, twins: false }).claude.header).toBe('Claude · no plan limits')
  // a reading wins over the flag
  const read = quotaView(quota({ claude: { sevenDay: { percentUsed: 50 } }, claudeAt: NOW }), { now: NOW, routing: false, twins: false, claudeMeasured: false })
  expect(read.claude.header).toBe('Claude')
  expect(read.claude.gauges[1]?.pct).toBe(50)
})

// ------------------------------------------------------------------ eviction

test('eviction: finished cards go first, wherever they sit; a running card goes only when all are running', () => {
  let list = agentSpawned([], { id: 'old-running', type: 'crew:developer', description: 'x', now: T0 })
  for (let i = 1; i < MAX_AGENTS; i++) list = agentSpawned(list, { id: `a${i}`, type: 'crew:developer', description: 'x', now: T0 + i })
  // the newest card finished; the oldest is still running
  list = agentCompleted(list, { id: `a${MAX_AGENTS - 1}`, reason: 'answer', now: T0 + 100 })
  list = agentSpawned(list, { id: 'new', type: 'crew:developer', description: 'x', now: T0 + 200 })
  expect(list).toHaveLength(MAX_AGENTS)
  expect(list.some(c => c.id === 'old-running')).toBe(true)
  expect(list.some(c => c.id === `a${MAX_AGENTS - 1}`)).toBe(false)
  // all running now: only then does the oldest go
  list = agentSpawned(list, { id: 'newer', type: 'crew:developer', description: 'x', now: T0 + 300 })
  expect(list.some(c => c.id === 'old-running')).toBe(false)
  expect(list.some(c => c.id === 'newer')).toBe(true)
})

// ------------------------------------------------------------------ minor: the "off" reason

test('the not-eligible reason is a named constant the HUD compares against', () => {
  expect(decide(null, null, 'ok', false, NOW).reason).toBe(ROUTING_OFF_REASON)
  const q = quota({ decision: decide(null, null, 'ok', false, NOW) })
  expect(quotaView(q, { now: NOW, routing: true, twins: true }).favoredRow).toBeNull()
})
