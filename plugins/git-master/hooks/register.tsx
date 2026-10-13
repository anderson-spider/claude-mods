import type { Register } from 'claude-code'
import { GIT_MASTER } from './agent'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.agent.register({ ...GIT_MASTER, tools: [...GIT_MASTER.tools] })
    return next(e)
  })
}
