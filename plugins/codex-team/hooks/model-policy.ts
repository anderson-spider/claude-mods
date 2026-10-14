// Model permission is independent of Jev access. Host options and reads are injected.
import { isAstra } from './roles'

export type ModelPolicyIo = {
  /** Missing files are undefined; unreadable settings reject. */
  settings: (source: 'project' | 'local') => Promise<{ pluginConfigs?: unknown } | undefined>
}

export const ASTRA_REFUSAL = 'codex-team: Astra is not allowed by the plugin configuration; nothing was started.'
export const modelAllowed = (model: string, allowAstra: boolean): boolean => !isAstra(model) || allowAstra

/** Only the effective true option permits Astra; repository declarations and unreadable settings fail closed. */
export async function resolveAllowAstra(io: ModelPolicyIo, option: unknown): Promise<boolean> {
  if (option !== true) return false
  try {
    for (const source of ['project', 'local'] as const) {
      const configs = (await io.settings(source))?.pluginConfigs
      if (configs === undefined) continue
      if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return false
      for (const [id, config] of Object.entries(configs)) {
        if (id !== 'codex-team' && !id.startsWith('codex-team@')) continue
        const options = (config as { options?: unknown } | null)?.options
        if (options && typeof options === 'object' && Object.hasOwn(options, 'allowAstra')) return false
      }
    }
    return true
  } catch { return false }
}
