import { expect, test } from 'claude-code/testing'
import { buildDagr, kindOf } from '../hooks/dagr'
import { parsePlan } from '../hooks/plan'

const NOW = '2026-10-13T20:00:00.000Z'
const plan = parsePlan(`## Steps
### Feature
- first (dev-fix, after: —) Build the feature — state: implementing
- second (analyst-fix, after: first) Document — state: verified (developer report)
### Review and release
- review (architect-fix, after: first, second) Inspect — state: blocked (lead must supply the missing requirement)
- ship (git-master, after: review) Commit — state: committed (#42)
- later (main, after: ship) More work — state: queued
- skip (analyst, after: later) Withdrawn — state: skipped
`)

test('Dagr keeps dependencies, blocked unblockers, reported receipts and only live worker locators', () => {
  const { document } = buildDagr(plan, {}, { now: NOW, pane: 'lead', agents: [{ name: 'dev-fix', workspace_id: 'w1', pane_id: 'worker' }] })
  expect(document.dagr).toBe(3)
  expect(document.run.orchestrator).toEqual({ pane: 'lead' })
  expect(document.projects).toEqual([{ id: 'T1', title: 'Feature' }, { id: 'T2', title: 'Review and release' }])
  expect(document.tasks[0]!.attempts[0]!.locator).toEqual({ pane: 'worker' })
  expect(document.tasks[0]!.attempts[0]!.liveness).toEqual({ prompt_acknowledged: false })
  expect(document.tasks[1]!.attempts[0]!.outcome).toEqual({ result: 'done', evidence: 'reported', receipt: 'developer report' })
  expect(document.tasks[2]).toMatchObject({ state: 'blocked', deps: ['first', 'second'], unblock: 'lead must supply the missing requirement', attempts: [] })
  expect(document.tasks[3]!.attempts[0]!.outcome).toMatchObject({ evidence: 'reported', receipt: '#42' })
  expect(document.tasks[4]).toMatchObject({ state: 'queued', attempts: [] })
  expect(document.tasks[5]).toMatchObject({ state: 'canceled', attempts: [] })
})

test('implementing main and git-master use the orchestrator pane while Codex agents use their own pane', () => {
  const implementing = parsePlan(`## Steps
### Work
- lead (main, after: —) Lead work — state: implementing
- ship (git-master, after: —) Ship work — state: implementing
- build (dev-fix, after: —) Build — state: implementing`)
  const { document } = buildDagr(implementing, {}, { now: NOW, pane: 'lead', agents: [
    { name: 'main', workspace_id: 'w1', pane_id: 'other-main' },
    { name: 'git-master', workspace_id: 'w1', pane_id: 'other-git-master' },
    { name: 'dev-fix', workspace_id: 'w1', pane_id: 'worker' },
  ] })
  expect(document.tasks.map(task => task.state)).toEqual(['working', 'working', 'working'])
  expect(document.tasks.map(task => task.attempts[0]!.locator)).toEqual([{ pane: 'lead' }, { pane: 'lead' }, { pane: 'worker' }])
  expect(document.events.map(event => event.actor)).toEqual(['main', 'git-master', 'dev-fix'])
})

test('implementing without a locator becomes blocked with an owner unblocker, preserving dependencies and notes', () => {
  for (const owner of ['main', 'git-master', 'dev-fix', 'analyst', 'analyst-fix', 'architect', 'architect-fix']) {
    const implementing = parsePlan(`## Steps
### Work
- ready (main, after: —) Ready — state: verified (report)
- work (${owner}, after: ready) Work — state: implementing (original note)`)
    const { document } = buildDagr(implementing, {}, { now: NOW, agents: [] })
    expect(document.tasks[1]).toMatchObject({ owner, state: 'blocked', deps: ['ready'], note: 'original note',
      unblock: `Restore a live pane for ${owner}`, attempts: [] })
    expect(document.events).toEqual([])
    if (owner !== 'main' && owner !== 'git-master') {
      const withLead = buildDagr(implementing, {}, { now: NOW, pane: 'lead', agents: [] }).document
      expect(withLead.tasks[1]!.attempts).toEqual([])
      expect(withLead.tasks[1]!.state).toBe('blocked')
      expect(JSON.stringify(withLead.tasks[1])).not.toContain('lead')
    }
  }
})

test('first-seen timestamps survive repeated projections and plan state changes without mutating the input times', () => {
  const first = buildDagr(plan, {}, { now: NOW, agents: [] })
  const later = '2026-10-13T21:00:00.000Z'
  const next = buildDagr(plan, first.times, { now: later, agents: [] })
  expect(next.times).toEqual(first.times)
  expect(next.document.generated_at).toBe(later)
  const done = parsePlan('## Steps\n### Feature\n- first (dev-fix, after: —) Build — state: verified (report)')
  const changed = buildDagr(done, first.times, { now: later, agents: [] })
  expect(changed.document.tasks[0]!.attempts[0]).toMatchObject({ started_at: NOW, ended_at: later })
  expect(first.times[JSON.stringify(['plan', 'first', 'verified'])]).toBeUndefined()
})

test('owner kinds map developer to implementation, architect to review, analyst to docs and lead or git-master to ship', () => {
  expect(['dev-fix', 'architect', 'architect-fix', 'analyst', 'analyst-fix', 'main', 'git-master'].map(kindOf)).toEqual(['impl', 'review', 'review', 'docs', 'docs', 'ship', 'ship'])
})

test('plans sharing a step id keep independent first-seen times and reuse only their own observations', () => {
  const text = '## Steps\n### Feature\n- build (main, after: —) Build — state: verified (report)'
  const firstPlan = parsePlan(text, 'first'), secondPlan = parsePlan(text, 'second')
  const first = buildDagr(firstPlan, {}, { now: NOW, agents: [] })
  const later = '2026-10-14T20:00:00.000Z'
  const second = buildDagr(secondPlan, first.times, { now: later, agents: [] })
  expect(second.document.run.started_at).toBe(later)
  expect(second.document.tasks[0]!.attempts[0]).toMatchObject({ started_at: later, ended_at: later })
  const again = buildDagr(firstPlan, second.times, { now: later, agents: [] })
  expect(again.document.tasks[0]!.attempts[0]).toMatchObject({ started_at: NOW, ended_at: NOW })
})
