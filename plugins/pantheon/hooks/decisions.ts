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
  reason: string
}

const MANIFESTS = new Set(['package.json', 'plugin.json', 'marketplace.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'])

const SENSITIVE_NAME = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock.*|Cargo\.lock)$/

/** Workflow, migration, manifest and lockfile paths: only the person may relax these. */
function sensitivePath(ctx: EditContext): boolean {
  const path = ctx.path.replace(/\\/g, '/')
  const name = path.split('/').pop() ?? ''
  return /(^|\/)\.github\/workflows\//.test(path)
    || /(^|\/)(migrations|migrate)(\/|$)/.test(path)
    || MANIFESTS.has(name)
    || SENSITIVE_NAME.test(name)
    || name.endsWith('.lock')
}

/** Local size and path rules; nothing leaves the machine. */
export function rulesVerdict(ctx: EditContext): Verdict {
  const verdict = (action: Verdict['action'], reason: string): Verdict => ({ action, reason })
  if (sensitivePath(ctx)) {
    return verdict('ask', 'Sensitive workflow, migration, manifest or lockfile; ask before applying.')
  }
  const known = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0
  const total = known(ctx.linesAdded) && known(ctx.linesRemoved) ? ctx.linesAdded + ctx.linesRemoved : undefined
  // A Write leaves the removed count unknown; what is known is still a lower bound on the change.
  const floor = (known(ctx.linesAdded) ? ctx.linesAdded : 0) + (known(ctx.linesRemoved) ? ctx.linesRemoved : 0)
  if (ctx.files > 3 || floor > 100) {
    return verdict('deny', 'Large or multi-file change; delegate to developer.')
  }
  if (total === undefined) return verdict('ask', 'Changed line counts are unknown; ask before applying.')
  if (ctx.files === 1 && total <= 5) return verdict('allow', 'Tiny single-file change.')
  if (['.md', '.mdx', '.txt', '.rst'].includes(ctx.ext) && total <= 20) {
    return verdict('allow', 'Small documentation change.')
  }
  return verdict('ask', 'Local rules cannot establish that the change is trivial; ask before applying.')
}
