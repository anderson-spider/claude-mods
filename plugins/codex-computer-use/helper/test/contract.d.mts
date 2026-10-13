export const contract: {
  routes: Readonly<Record<string, string>>
  replies: {
    ok: Readonly<Record<string, readonly string[]>>
    held: Readonly<Record<string, readonly string[]>>
    app: Readonly<Record<'needs_approval' | 'denied' | 'busy', { always: readonly string[]; sometimes: readonly string[]; read: readonly string[] }>>
  }
  choices: readonly string[]
  leaseMinutes: number
  label: string
  callers: readonly { session: string; agent?: string; caller: string }[]
  maxPart: number
  notCallers: readonly string[]
  home: readonly string[]
  socketUnderHome: string
}
