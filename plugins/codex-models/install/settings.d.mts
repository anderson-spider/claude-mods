// Types of settings.mjs, for the plugin's TypeScript tests.

export const HEADER: string
export const MARK: string

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type SettingsObject = { [key: string]: Json }

export type ModelRow = { id: string; label?: string; description?: string; behavesAs?: string }
export type PickerRow = { model: string; label: string; description: string; behavesAs?: string }

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
export function settingsRefusal(settings: unknown, proxyUrl: string | undefined): string | undefined
export function planInstall(
  settings: unknown,
  env: unknown,
  models: unknown,
): { settings: SettingsObject; error?: undefined } | { error: string; settings?: undefined }
export function planUninstall(
  settings: unknown,
): { settings: SettingsObject; error?: undefined } | { error: string; settings?: undefined }
export function readStatusReply(status: number, text: string): StatusReply
export function maskedSettings<T>(settings: T): T
export function masked(text: string, secret: string): string
export function secretOf(headerLine: string): string
