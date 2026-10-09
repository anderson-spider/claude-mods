export type EditContext = {
  tool: string
  path: string
  ext: string
  linesAdded?: number
  linesRemoved?: number
  files: number
}

export type Verdict = {
  action: 'allow' | 'ask' | 'deny'
  source: 'jev' | 'rules'
  score?: number
  reason: string
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export const ALLOW_THRESHOLD = 0.85
export const DENY_THRESHOLD = 0.30

export function rulesVerdict(ctx: EditContext): Verdict {
  const verdict = (action: Verdict['action'], reason: string): Verdict => ({ action, source: 'rules', reason })
  const path = ctx.path.replace(/\\/g, '/')
  const name = path.split('/').pop() ?? ''
  if (/(^|\/)\.github\/workflows\//.test(path)
    || /(^|\/)(migrations|migrate)(\/|$)/.test(path)
    || /^(package\.json|plugin\.json|marketplace\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock.*|Cargo\.lock)$/.test(name)
    || name.endsWith('.lock')) {
    return verdict('ask', 'Sensitive workflow, migration, manifest or lockfile; ask before applying.')
  }
  const known = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0
  const total = known(ctx.linesAdded) && known(ctx.linesRemoved) ? ctx.linesAdded + ctx.linesRemoved : undefined
  if (ctx.files > 3 || (total !== undefined && total > 100)) {
    return verdict('deny', 'Large or multi-file change; delegate to the executor.')
  }
  if (total === undefined) return verdict('ask', 'Changed line counts are unknown; ask before applying.')
  if (ctx.files === 1 && total <= 5) return verdict('allow', 'Tiny single-file change.')
  if (['.md', '.mdx', '.txt', '.rst'].includes(ctx.ext) && total <= 20) {
    return verdict('allow', 'Small documentation change.')
  }
  return verdict('ask', 'Local rules cannot establish that the change is trivial; ask before applying.')
}

export async function decide(
  fetch: Fetch,
  key: string | undefined,
  ctx: EditContext,
  opts?: { timeoutMs?: number },
): Promise<Verdict> {
  const fallback = (reason: string): Verdict => {
    const verdict = rulesVerdict(ctx)
    return { ...verdict, reason: `${reason} Using local rules: ${verdict.reason}` }
  }
  if (!key) return fallback('No API key configured.')

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = Symbol('timeout')
  try {
    const deadline = new Promise<typeof timeout>(resolve => {
      timer = setTimeout(() => resolve(timeout), opts?.timeoutMs ?? 3_000)
    })
    const response = await Promise.race([
      fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'typesafe/jev-1.13',
          // Explicit selection keeps content-bearing extra properties out of the request.
          state: {
            tool: ctx.tool, path: ctx.path, ext: ctx.ext,
            linesAdded: ctx.linesAdded, linesRemoved: ctx.linesRemoved, files: ctx.files,
            caller: 'main orchestrator session',
          },
          questions: { trivial: {
            type: 'noul',
            instructions: 'Is this code edit small and trivial enough for the orchestrator to apply directly, without delegating to a specialist?',
            criteria: {
              true: 'Tiny, mechanical, single-file change such as a typo, a one-line fix or a doc tweak.',
              false: 'Substantial, risky or multi-file change that should be delegated to an executor.',
            },
          } },
        }),
      }),
      deadline,
    ])
    if (response === timeout) return fallback('Decision request timed out.')
    if (response.status !== 200) return fallback(`Decision request returned HTTP ${response.status}.`)
    let score: unknown
    try {
      score = JSON.parse(response.text)?.answers?.trivial?.noul
    } catch {
      return fallback('Malformed decision response.')
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      return fallback('Malformed decision score; expected a number from 0 to 1.')
    }
    const action = score >= ALLOW_THRESHOLD ? 'allow' : score <= DENY_THRESHOLD ? 'deny' : 'ask'
    const reason = action === 'allow' ? 'Jev classified this edit as trivial.'
      : action === 'deny' ? 'Jev classified this edit as substantial; delegate to the executor.'
      : 'Jev score is between the decision thresholds; ask before applying.'
    return { action, source: 'jev', score, reason }
  } catch {
    return fallback('Decision request failed.')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
