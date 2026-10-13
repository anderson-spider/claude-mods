export const contract: {
  routes: Readonly<Record<string, string>>
  choices: readonly string[]
  leaseMinutes: number
  label: string
  callers: readonly { session: string; agent?: string; caller: string }[]
  maxPart: number
  notCallers: readonly string[]
  home: readonly string[]
  socketUnderHome: string
}
