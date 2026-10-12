// Types of settings.mjs, for the plugin's TypeScript tests.

export const HEADER: string
export const MARK: string
export const STATE_VERSION: number

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type SettingsObject = { [key: string]: Json }

export type ModelRow = { id: string; label?: string; description?: string; behavesAs?: string }
export type PickerRow = { model: string; label: string; description: string; behavesAs?: string }

export type InstallState = {
  v: number
  baseUrl: string
  /** The current base URL first, then the earlier ones; absent in a state an older install wrote. */
  baseUrls?: string[]
  envCreated: boolean
  headersExisted: boolean
  toolSearch: { present: true; value: Json } | { present: false }
  pickerCreated: boolean
  optionsCreated: boolean
  models: string[]
  /** settings.json did not exist before install; absent in a state an older install wrote. */
  fileCreated?: boolean
}

export type StatusReply =
  | { kind: 'ok'; version: string; codexLogin: boolean; models: string[] }
  | { kind: 'forbidden' }
  | { kind: 'host' }
  | { kind: 'foreign'; reason: string }

export function isLoopbackHttp(url: unknown): boolean
export function isOurHeader(line: string): boolean
export function isMarked(row: unknown): boolean
export function pickerRows(models: unknown): { rows: PickerRow[]; error?: undefined } | { error: string; rows?: undefined }
export function checkEnv(env: unknown): string | undefined
export function settingsRefusal(settings: unknown, baseUrl: string | undefined, prior?: unknown): string | undefined
export function planInstall(
  settings: unknown,
  env: unknown,
  models: unknown,
  prior?: unknown,
  fileExisted?: boolean,
): { settings: SettingsObject; state: InstallState; error?: undefined } | { error: string; settings?: undefined; state?: undefined }
export function planUninstall(
  settings: unknown,
  state?: unknown,
): { settings: SettingsObject; remove: boolean; error?: undefined } | { error: string; settings?: undefined; remove?: undefined }
export function readStatusReply(status: number, text: string): StatusReply
export function maskedSettings<T>(settings: T): T
export function ownerRefusal(path: string, ownerUid: number | undefined, userUid: number): string | undefined
export function masked(text: string, secret: string): string
export function secretOf(headerLine: string): string
