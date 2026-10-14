// gitlab_user: who the token belongs to, or a user of the remote's host by username.
import type { McpToolInputs } from 'claude-code'
import { InputError, json, str, type Ctx } from './context'

export type UserInput = { [K in keyof McpToolInputs['mcp__gitlab__gitlab_user']]?: unknown }

type User = { id: number; username: string; name?: string; state?: string; web_url?: string; bot?: boolean }

const USERNAME = /^[\w.-]{1,255}$/

export const userView = (u: User) => ({ id: u.id, username: u.username, name: u.name, state: u.state, bot: u.bot || undefined, url: u.web_url })

/** The token's own user without a username (or with `@me`), else the user with that username. */
export async function user(ctx: Ctx, input: UserInput): Promise<string> {
  const given = str(input.username)?.trim().replace(/^@/, '')
  if (given === undefined || given === 'me') return json(userView((await ctx.api.root('/user')) as User))
  if (!USERNAME.test(given)) throw new InputError('username is a GitLab username (letters, digits, _, . and -).')
  const found = (await ctx.api.root('/users', { username: given })) as User[]
  const match = Array.isArray(found) ? found[0] : undefined
  if (!match) throw new InputError(`No GitLab user named ${given} on this host.`)
  return json(userView(match))
}
