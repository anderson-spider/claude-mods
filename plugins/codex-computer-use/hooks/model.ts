// The wire contract with the codex-cu helper: the routes it serves, the choices
// it takes and every reply it sends, as helper/helper.mjs and helper/lib/hub.mjs
// build them. Types and constants only. This file is the only description of the
// reply shapes; helper/test/contract.mjs pins the routes and choices on both sides.

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

/** A route the helper serves. */
export type Route = (typeof ROUTES)[keyof typeof ROUTES]

/** The person's answers to an approval question, as `/approve` takes them. */
export const CHOICES = ['session', 'always', 'deny'] as const

export type Choice = (typeof CHOICES)[number]

export type AppRef = { bundleId: string; displayName: string; canAlways?: boolean }

export type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string }

/** Replies a `/call` can end in, besides `ok`. */
export type Held =
  | { status: 'needs_approval'; app: AppRef }
  | { status: 'denied'; app: AppRef }
  | { status: 'busy'; app: AppRef; owner: string; idleSeconds?: number }
  | { status: 'full'; message: string }

/** What the helper answers when something went wrong, plus `unreachable` when nothing listens. */
export type Failure =
  | { status: 'error'; message: string; notes?: string[] }
  | { status: 'unreachable'; message: string }

export type CallReply = { status: 'ok'; isError: boolean; content: ContentBlock[]; notes?: string[] }
export type ResetReply = { status: 'ok'; message: string }
export type ReleaseReply = { status: 'ok'; ended: string[] }
export type ForgetReply = { status: 'ok'; bundleId: string; helper: boolean; codex?: 'removed' | 'absent' | 'missing' }
export type SettingsReply = { status: 'ok'; settings: { autoApprove: boolean; always: string[] } }
export type ApproveReply = { status: 'ok' }

/** `/status` has no `status` field: it answers the helper's own report. */
export type StatusReply = {
  status?: undefined
  version?: string
  pid?: number
  callers?: { caller: string; apps: string[]; isFresh?: boolean; idleSeconds?: number }[]
  /** Who holds each app now, by bundle id. */
  owners?: Record<string, { owner: string; idleSeconds: number }>
  settings?: { autoApprove: boolean; always: string[] }
}

/** What a `/call` answers: a result, or why there is none. */
export type CallResult = CallReply | Held | Failure

/** What each route answers, plus `unreachable` when nothing listens: a new route's reply is written here once. */
export type RouteReplies = {
  [ROUTES.call]: CallResult
  [ROUTES.reset]: ResetReply | Failure
  [ROUTES.approve]: ApproveReply | Failure
  [ROUTES.release]: ReleaseReply | Failure
  [ROUTES.settings]: SettingsReply | Failure
  [ROUTES.forget]: ForgetReply | Failure
  [ROUTES.status]: StatusReply | Failure
}
