// gitlab_label: the project's labels (its own and its groups'), and creating one. Deleting a label is not offered.
import type { McpToolInputs } from 'claude-code'
import { GitlabError } from './api'
import { InputError, clip, items, json, more, need, paging, str, type Ctx } from './context'

export type LabelAction = McpToolInputs['mcp__gitlab__gitlab_label']['action']
export type LabelInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_label']]?: unknown }

type Label = { id: number; name: string; color?: string; description?: string | null }

export const DEFAULT_COLOR = '#428BCA'
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export const labelView = (l: Label) => ({ name: l.name, color: l.color, description: l.description || undefined })

/** The label named exactly `name`, or undefined. GitLab's search matches substrings, so the exact name is picked here. */
export async function findLabel(ctx: Ctx, name: string): Promise<Label | undefined> {
  const found = (await ctx.api.get('/labels', { search: name, per_page: 100 })) as Label[]
  return (Array.isArray(found) ? found : []).find((l) => l.name === name)
}

/** The label, created with `color` (and `description`) when the project has none of that name; `existing` says which. */
export async function ensureLabel(ctx: Ctx, name: string, color = DEFAULT_COLOR, description?: string): Promise<{ label: Label; existing: boolean }> {
  const found = await findLabel(ctx, name)
  if (found) return { label: found, existing: true }
  try {
    const label = (await ctx.api.send('POST', '/labels', { name, color, ...(description ? { description } : {}) })) as Label
    return { label, existing: false }
  } catch (err) {
    // created meanwhile (or GitLab's search missed it): answer with the one that is there
    if (err instanceof GitlabError && err.status === 409) {
      const again = await findLabel(ctx, name)
      if (again) return { label: again, existing: true }
    }
    throw err
  }
}

/**
 * Checks that every label an MR is about to get exists. With `create`, the missing ones are created first with the
 * default colour; without it, the call is refused naming them, so GitLab never creates one silently in its grey.
 */
export async function requireLabels(ctx: Ctx, names: string[], create: boolean): Promise<void> {
  const missing: string[] = []
  for (const name of new Set(names)) if (!(await findLabel(ctx, name))) missing.push(name)
  if (missing.length === 0) return
  if (!create) {
    throw new InputError(
      `The project has no label ${missing.join(', ')}. Pass createMissingLabels: true to create ${missing.length > 1 ? 'them' : 'it'}, or create ${missing.length > 1 ? 'them' : 'it'} with gitlab_label create.`,
    )
  }
  for (const name of missing) await ensureLabel(ctx, name)
}

export async function label(ctx: Ctx, input: LabelInput): Promise<string> {
  switch (input.action as LabelAction) {
    case 'list': {
      const page = await ctx.api.page('/labels', { search: str(input.search), ...paging(input, 100) })
      return clip(json({ labels: items<Label>(page).map(labelView), ...more(page) }), 'pass search to read fewer labels')
    }
    case 'create': {
      const name = need(str(input.name), 'create needs a name.').trim()
      const color = str(input.color)?.trim() ?? DEFAULT_COLOR
      if (!COLOR.test(color)) throw new InputError('color must be a hex colour like #428BCA.')
      const description = typeof input.description === 'string' ? input.description : undefined
      const { label, existing } = await ensureLabel(ctx, name, color, description)
      return json({ ...labelView(label), existing })
    }
    default:
      throw new InputError(`Unknown action: ${String(input.action)}.`)
  }
}
