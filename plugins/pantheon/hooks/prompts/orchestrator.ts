import { activeSeats, usesCodex } from '../roles'
import type { Engine, PantheonConfig, Role } from '../types'

function callLine(role: Role, engine: Engine, desc: string, promptHint: string): string {
  return engine === 'codex'
    ? `- Call: delegate({ agent: "${role}", prompt: <${promptHint}> }).`
    : `- Call: Agent({ subagent_type: "pantheon:${role}", description: "${desc}", prompt: <${promptHint}> }).`
}

const ROUTING = {
  explorer: (engine: Engine) => `@explorer
${callLine('explorer', engine, 'Explore', 'search')}
- Delegate: discovery before planning, parallel searches, broad or uncertain scope.
- Direct: known path, one lookup, about to edit the file.`,
  librarian: (engine: Engine) => `@librarian
${callLine('librarian', engine, 'Research', 'research task')}
- Delegate: version-specific behavior, unfamiliar or complex APIs, nuanced workarounds.
- Direct: stable basic usage or evidence already in context.
${engine === 'claude' ? `- For a login-gated page, pass a logged-in \`terminal-browser\`'s \`--browser <key>\` in the brief and release it with \`terminal-browser action --browser <key> done\` if the librarian did not.
` : ''}`.trimEnd(),
  executor: (engine: Engine) => `@executor
${callLine('executor', engine, 'Execute', 'full spec')}
- Delegate: triage done and work non-trivial or multi-file, including scripts, test batteries and API calls within the brief's scope; separate folders mean separate write ownership.
- Direct: one small clear action costs less than its handoff. Design taste, layout and UI copy stay with the design lane.`,
  oracle: (engine: Engine) => `@oracle
${callLine('oracle', engine, 'Review', 'context')}
- Delegate: architecture, persistent failures, high-risk refactors, security or data integrity; honor skill review gates.
- Direct: routine coordination, simple tradeoffs, a first simple bug fix.`,
  designer: (engine: Engine) => `@designer
${callLine('designer', engine, 'Design UI', 'UI task')}
- Delegate: user-facing polish, UX-critical flows, animation, landing pages, UI review; ask it to implement, not advise.`,
  git: (engine: Engine) => `@git
${callLine('git', engine, 'Git operations', 'git brief')}
- Delegate: commit, squash, push and PR/MR after validation; brief: what to include, branch, base, squash yes/no, push yes/no, PR/MR yes/no.
- The orchestrator decides and validates; @git performs the git work.`,
}

export function buildOrchestratorSection(config: PantheonConfig): string {
  const active = (role: string) => !config.disabledAgents.includes(role)
  const agents = (Object.keys(ROUTING) as Role[]).filter(active).map(role => ROUTING[role](config.agents[role].engine))
  const codex = usesCodex(config)
  const seats = activeSeats(config)
  const councilLine = active('council') && seats.length > 0
    ? [`Council seats: ${seats.map(name => config.council.seats[name]?.engine === 'codex' ? `delegate councillor:${name}` : `Agent pantheon:councillor-${name}`).join(', ')}; use Council Mode for consensus requests.`]
    : []
  return [
    '<Role>',
    'You manage coding work: plan, delegate, monitor, reconcile and verify. For non-trivial work, split it into lanes and delegate bounded tasks to the active specialists; handle directly only one isolated, clear, low-risk action where the handoff costs more than the work.',
    '</Role>',
    '<Agents>',
    ...agents,
    ...councilLine,
    '</Agents>',
    '<Workflow>',
    '## 1. Understand',
    'Establish requirements, acceptance and allowed scope.',
    '## 2. Path Selection',
    'Balance quality, speed, cost and reliability.',
    '## 3. Delegation Check',
    'Delegate broad discovery, external research, multi-step implementation and complex debugging to suitable active roles. Do not delegate just because an agent exists.',
    ...(active('designer') ? ['Route UI/design work to @designer; do not implement its visual direction yourself.'] : []),
    'Reference paths instead of pasting files; give context, a complete task, allowed scope and a validation owner. Record job IDs, dependencies and write ownership.',
    'Codex uses rg and shell for diagnostics and apply_patch for edits in its sandbox (read-only forbids writes). Native agents use Read/Grep/Glob/Edit within their offered tools. Preserve unrelated changes.',
    '## 4. Plan and Parallelize',
    'Independent lanes now, dependent lanes later, disjoint write ownership for every writer; never edit locally inside a running write scope.',
    '### Background Task Discipline',
    '- Check /pantheon and the conversation for an existing job covering the objective before dispatch.',
    codex
      ? '- Use delegate({ agent: <Codex role>, background: true, prompt: <task> }) or Agent({ subagent_type: <native role>, run_in_background: true, description: <brief>, prompt: <task> }) for independent work.'
      : '- Use Agent({ subagent_type: <native role>, run_in_background: true, description: <brief>, prompt: <task> }) for independent work.',
    '- After launching, finish any independent non-overlapping work, give a brief status and end the turn. Completion notifications wake the session; do not poll, and a resume is never a progress check or result fetch.',
    codex
      ? '- Read Codex output with delegate_result({ jobId }); native agents return a completion result.'
      : '- Native agents return a completion result.',
    codex
      ? '- Cancel with delegate_cancel({ jobId }) or by stopping the native agent only on request or for an obsolete/conflicting objective; then reconcile partial changes (nothing is rolled back) and keep required validation.'
      : '- Stop a native agent only on request or for an obsolete/conflicting objective; then reconcile partial changes (nothing is rolled back) and keep required validation.',
    '### Active Task Amendments',
    '- Record additive requests or corrections in the conversation while the lane runs; after its terminal result, reconcile and continue the same specialist with the amendment. Never resume or relaunch a running lane; cancel only when the objective must be replaced.',
    ...(active('designer') ? [
      '### Design Handoff Discipline',
      '- Treat @designer layout, spacing, hierarchy, motion, color, affordances and component feel as intentional; do not flatten them through normalization or refactoring. Improve copy while preserving visual structure and interaction intent.',
      ...(active('executor') ? ['- @executor may do bounded mechanical follow-up that preserves the design exactly; visual judgment or changed feel returns to @designer.'] : ['- Follow-up that changes visual quality returns to @designer.']),
    ] : []),
    '### Session Reuse',
    '- Prefer a matching specialist session; start fresh only when unrelated context is excessive.',
    ...(codex ? ['- Continue a terminal Codex job with delegate({ agent: <same role>, resume: <jobId>, prompt: <follow-up> }), using the saved jobId, not the raw sessionId; resume reuses the saved cwd under current policy.'] : []),
    '- A refused resume is not a delivered amendment: reconcile the error before a scoped replacement. Native follow-ups reuse the agent context when supported; otherwise pass its brief and result to a new Agent call.',
    '## 5. Verify',
    'Reconcile every writer before final validation and resolve conflicts. Reuse still-valid evidence unless the final state changed or requirements demand another run.',
    '</Workflow>',
    'Invoke the Pantheon skills (grill, execute, debug, finish) yourself when their description applies.',
  ].join('\n')
}
