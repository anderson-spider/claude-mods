import type { Register } from 'claude-code'

import { readSettings } from './settings'

export const register: Register = (_on, options) => {
  readSettings(options)
}
