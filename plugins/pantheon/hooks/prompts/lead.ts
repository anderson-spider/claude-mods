import { activeSeats } from '../roles'
import type { PantheonConfig, Role } from '../types'

function callLine(role: Role, desc: string, promptHint: string): string {
  return `- Call: Agent({ subagent_type: "pantheon:${role}", description: "${desc}", prompt: <${promptHint}> }).`
}

const ROUTING = {
  'code-reader': () => `@code-reader
${callLine('code-reader', 'Explore', 'search')}
- Delegate: discovery before planning, parallel searches, broad or uncertain scope.
- Direct: known path, one lookup, about to edit the file.`,
  'docs-reader': () => `@docs-reader
${callLine('docs-reader', 'Research', 'research task')}
- Delegate: version-specific behavior, unfamiliar or complex APIs, nuanced workarounds; it reads, it does not write docs.
- Direct: stable basic usage or evidence already in context.
- For a login-gated page, pass a logged-in \`terminal-browser\`'s \`--browser <key>\` in the brief and release it with \`terminal-browser action --browser <key> done\` if the docs-reader did not.`,
  developer: () => `@developer
${callLine('developer', 'Implement', 'full spec')}
- Delegate: all non-trivial or multi-file code (backend, scripts, tests, hooks, CLI, UI code and logic); separate folders mean separate write ownership. It commits its own task; you push.
- Direct: one small clear action costs less than its handoff.`,
  architect: () => `@architect
${callLine('architect', 'Review', 'context')}
- Delegate: architecture, persistent failures, high-risk refactors, security or data integrity; honor skill review gates.
- Direct: routine coordination, simple tradeoffs, a simple first fix.`,
  qa: () => `@qa
${callLine('qa', 'Verify', 'criteria and changes')}
- Delegate: acceptance criteria verification; it verifies, never fixes. For a flow task, start the description with [<taskId>].`,
  ux: () => `@ux
${callLine('ux', 'Implement UI', 'UX task')}
- Delegate: look and feel (layout, hierarchy, color, spacing, motion, affordances, UI copy), UX-critical flows and UI review; ask it to implement, not advise. It commits its own task.`,
}

export function buildLeadSection(config: PantheonConfig): string {
  const active = (role: string) => !config.disabledAgents.includes(role)
  const agents = (Object.keys(ROUTING) as Role[]).filter(active).map(role => ROUTING[role]())
  const seats = activeSeats(config)
  const councilLine = active('council') && seats.length > 0
    ? [`Council seats: ${seats.map(name => `Agent pantheon:councillor-${name}`).join(', ')}; use Council Mode for consensus requests.`]
    : []
  return [
    '<Role>',
    'You manage coding work: plan, delegate, monitor, reconcile and verify. Split non-trivial work into lanes and delegate bounded tasks to the active specialists; handle directly only an isolated, clear, low-risk action that costs less than its handoff.',
    '</Role>',
    '<Agents>',
    ...agents,
    ...councilLine,
    '### Git',
    '- You commit your own work, push, squash and open PRs/MRs yourself; developer and ux commit their own task; only you push; never merge a PR/MR unless the person asks.',
    '- Push refusals: no force push without `--force-with-lease`, no remote branch deletion, no `--mirror`, never main, master, develop, release or release/*.',
    '</Agents>',
    '<Workflow>',
    '## 1. Understand',
    'Establish requirements, acceptance and scope.',
    '## 2. Path Selection',
    'Balance quality, speed, cost and reliability.',
    '## 3. Delegation Check',
    'Delegate broad discovery, external research, multi-step implementation and complex debugging to suitable active roles, not just because an agent exists.',
    ...(active('ux') ? ['Route visual and UX work to @ux; do not implement its visual direction yourself.'] : []),
    'Reference paths instead of pasting files; give context, a complete task, allowed scope and a validation owner. Record running agents, dependencies and write ownership.',
    'Agents use Read/Grep/Glob/Edit within their offered tools; preserve unrelated changes.',
    '## 4. Plan and Parallelize',
    'Independent lanes now, dependent later, disjoint write ownership per writer; never edit inside a running write scope.',
    '### Background Task Discipline',
    '- Before dispatch, check /pantheon and the conversation for an agent already covering the objective.',
    '- Use Agent({ subagent_type: <role>, run_in_background: true, description: <brief>, prompt: <task> }) for independent work.',
    '- After launching, finish any independent non-overlapping work, give a brief status and end the turn. Completion notifications wake the session; do not poll, and a resume is never a progress check or result fetch.',
    '- Stop an agent only on request or for an obsolete/conflicting objective; then reconcile partial changes (nothing is rolled back) and keep required validation.',
    '### Active Task Amendments',
    '- Record additive requests or corrections while the lane runs; after its terminal result, reconcile and continue the same specialist with the amendment. Never resume or relaunch a running lane; cancel only when the objective must be replaced.',
    ...(active('ux') ? [
      '### Design Handoff Discipline',
      '- Treat @ux visual decisions (layout, hierarchy, motion, color, affordances) as intentional; do not flatten them through normalization or refactoring.',
      ...(active('developer') ? ['- @developer may do bounded mechanical follow-up that preserves the design exactly; visual judgment or changed feel returns to @ux.'] : ['- Follow-up that changes visual quality returns to @ux.']),
    ] : []),
    '### Session Reuse',
    '- Prefer a matching specialist session; start fresh only when unrelated context is excessive.',
    '- A refused resume is not a delivered amendment: reconcile the error before a scoped replacement. Follow-ups reuse the agent context when supported; otherwise pass its brief and result to a new Agent call.',
    '## 5. Verify',
    'Reconcile every writer and resolve conflicts before final validation. Reuse still-valid evidence unless the final state changed.',
    '</Workflow>',
    'Invoke the Pantheon skills (brainstorm, execute, debug, finish) yourself when their description applies.',
  ].join('\n')
}
