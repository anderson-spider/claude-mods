import type { PantheonConfig } from '../types'

export function buildSuperpowersBlock(config: PantheonConfig): string {
  const active = (role: string) => !config.disabledAgents.includes(role)
  const mappings: string[] = []
  const codexFixer = config.agents.fixer.engine === 'codex'
  const codexOracle = config.agents.oracle.engine === 'codex'
  const reviewer = codexOracle
    ? 'delegate({ agent: "oracle", model: <skill-selected model>, prompt: <review brief and review package path> })'
    : 'Agent with pantheon:oracle'
  if (active('fixer')) mappings.push(codexFixer
    ? '- implementer (subagent-driven-development): delegate({ agent: "fixer", model: <skill-selected model>, prompt: <skill brief> }).'
    : '- implementer (subagent-driven-development): Agent({ subagent_type: "pantheon:fixer", model: <skill-selected model>, prompt: <skill brief>, description: "Implement task" }).')
  if (active('designer')) mappings.push(config.agents.designer.engine === 'codex'
    ? '- UI implementer: delegate({ agent: "designer", model: <skill-selected model>, prompt: <skill brief> }).'
    : '- UI implementer: Agent({ subagent_type: "pantheon:designer", model: <skill-selected model>, prompt: <skill brief>, description: "Implement UI task" }).')
  if (active('oracle')) mappings.push(
    `- Task reviewer and re-reviewer (subagent-driven-development): ${reviewer}; one dispatch per gate, including the scripts/review-package file.`,
    `- Final branch code reviewer (subagent-driven-development, requesting-code-review): ${reviewer}, a separate dispatch from the task review.`,
  )
  return [
    '## Superpowers Integration',
    'Only when a skill requires dispatch: use these role mappings while preserving its steps, gates, model choice, prompt and report format. This block does not itself trigger a skill or dispatch.',
    ...mappings,
    '- dispatching-parallel-agents: several delegate/Agent calls in the same message, selecting an active role for each task.',
    '- A disabled role has no mapping; use the standard Agent tool for that skill dispatch.',
    '- executing-plans is an explicit exception to general delegation: execute inline in the main agent; do not convert its implementation steps into dispatches.',
    '- Pass the skill-selected model through model on delegate or Agent. A skill-defined report format overrides the role default.',
    ...(active('oracle') ? [`- Reviewers receive a review package file: scripts/review-package for SDD, or an orchestrator-generated file with diff and BASE/HEAD SHAs for requesting-code-review. ${codexOracle ? 'The Codex reviewer receives the review package path through the prompt and may read it with shell.' : 'The native reviewer has no Bash.'}`] : []),
    ...(active('fixer') ? [
      ...(codexFixer ? [
        '- Keep one Codex implementer session per task: continue a terminal job with resume: <jobId>. If reuse is unavailable, follow the skill fallback with a new implementer given the brief, report and findings.',
        '- Codex .git is read-only: the implementer changes code, tests and reports; the orchestrator commits, records the SHA, then generates the review package. Record BASE before dispatch; HEAD is that commit.',
      ] : [
        '- The implementer does not commit; the orchestrator commits, records the SHA, then generates the review package. Record BASE before dispatch; HEAD is that commit.',
      ]),
      '- Tell the implementer in its dispatch prompt: no commit is expected; absence of a commit is not a reason to report BLOCKED.',
    ] : []),
  ].join('\n')
}
