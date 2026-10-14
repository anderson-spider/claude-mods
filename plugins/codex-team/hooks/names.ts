import { SLUG } from './roles'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Lossless, case-sensitive base conversion, not a hash. The leading digit preserves leading zeroes. */
export function workspaceToken(workspace: string): string | undefined {
  if (!/^w[0-9A-Za-z]{1,7}$/.test(workspace)) return undefined
  let value = BigInt(1)
  for (const char of workspace.slice(1)) value = value * BigInt(62) + BigInt(BASE62.indexOf(char))
  const token = value.toString(36)
  return token.length <= 8 ? token : undefined
}

export function taskSlug(name: string | undefined): string | undefined {
  const slug = name?.match(/^(?:dev|architect|analyst)-(.+)$/)?.[1]
  return slug && SLUG.test(slug) ? slug : undefined
}

export const isTeamName = (name: string | undefined): boolean => name === 'analyst' || name === 'architect' || taskSlug(name) !== undefined

/** One role letter + at most eight workspace digits + '-' + the complete 22-character slug fits Herdr. */
export function effectiveName(name: string, workspace: string): string | undefined {
  const token = workspaceToken(workspace)
  if (!token || !isTeamName(name)) return undefined
  const role = name === 'analyst' || name.startsWith('analyst-') ? 'n' : name === 'architect' || name.startsWith('architect-') ? 'a' : 'd'
  const slug = taskSlug(name)
  return `${role}${token}${slug ? `-${slug}` : ''}`
}

/** Only this workspace's exact namespace maps back to the lead's logical names. */
export function logicalName(name: string | undefined, workspace: string): string | undefined {
  const token = workspaceToken(workspace)
  const match = name?.match(/^([nad])([a-z0-9]+)(?:-(.+))?$/)
  if (!token || !match || match[2] !== token) return undefined
  const role = match[1] === 'n' ? 'analyst' : match[1] === 'a' ? 'architect' : 'dev'
  const logical = `${role}${match[3] ? `-${match[3]}` : ''}`
  return isTeamName(logical) ? logical : undefined
}
