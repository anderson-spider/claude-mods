// The wire contract with the codex-cu helper: the routes it serves and every
// reply it sends, as helper/helper.mjs and helper/lib/hub.mjs build them. Types
// and constants only.

/** The routes the helper serves, POSTed over its Unix socket. */
export const ROUTES = {
  call: '/call',
  reset: '/reset',
  approve: '/approve',
  release: '/release',
  settings: '/settings',
  forget: '/forget',
  status: '/status',
} as const

/** The person's answer to an approval question. */
export type Choice = 'session' | 'always' | 'deny'

export type AppRef = { bundleId: string; displayName: string; canAlways?: boolean }

export type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string }

/** Replies a `/call` can end in, besides `ok`. */
type Held =
  | { status: 'needs_approval'; app: AppRef; text?: string }
  | { status: 'denied'; app: AppRef; text?: string }
  | { status: 'busy'; app: AppRef; owner: string; idleSeconds?: number; text?: string }
  | { status: 'full'; message: string }

/** What the helper answers when something went wrong, plus `unreachable` when nothing listens. */
type Failure =
  | { status: 'error'; message: string; notes?: string[] }
  | { status: 'unreachable'; message: string }

export type CallReply = { status: 'ok'; isError: boolean; content: ContentBlock[]; notes?: string[] }
export type ResetReply = { status: 'ok'; message: string }
export type ReleaseReply = { status: 'ok'; ended: string[] }
export type ForgetReply = { status: 'ok'; bundleId: string; helper: boolean; codex?: 'removed' | 'absent' | 'missing' }
/** `/settings` answers the settings; `/approve` answers a bare `ok`. */
export type SettingsReply = { status: 'ok'; settings?: { autoApprove: boolean; always: string[] } }

/** `/status` has no `status` field: it answers the helper's own report. */
export type StatusReply = {
  status?: undefined
  version?: string
  pid?: number
  callers?: { caller: string; apps: string[] }[]
  settings?: { autoApprove: boolean; always: string[] }
}

/** Everything the helper sends, plus `unreachable` when nothing listens. */
export type Reply = CallReply | ResetReply | ReleaseReply | ForgetReply | SettingsReply | StatusReply | Held | Failure
