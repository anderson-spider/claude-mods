// What one turn did, read from the thread's notifications: the answer, the files it changed, the commands it ran and
// whether the turn ended. Pure: no I/O. Only counts, statuses and paths are kept, never a command's output.

const KEEP_FILES = 100
const KEEP_COMMANDS = 50

export const createCollector = () => {
  const state = { texts: [], files: [], commands: [], declined: 0, done: undefined, error: undefined }

  return {
    feed(method, params) {
      if (method === 'item/completed' && params?.item) {
        const item = params.item

        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          state.texts.push(item.text)
        } else if (item.type === 'fileChange') {
          const paths = Array.isArray(item.changes) ? item.changes.map(change => String(change?.path ?? '')) : []

          if (item.status === 'declined') {
            state.declined++
          }

          if (state.files.length < KEEP_FILES) {
            state.files.push({ status: String(item.status ?? ''), paths })
          }
        } else if (item.type === 'commandExecution') {
          if (item.status === 'declined') {
            state.declined++
          }

          if (state.commands.length < KEEP_COMMANDS) {
            state.commands.push({
              command: String(item.command ?? ''),
              status: String(item.status ?? ''),
              exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
            })
          }
        }
      }

      if (method === 'turn/completed' && params?.turn) {
        state.done = String(params.turn.status ?? 'completed')
        state.error = params.turn.error ? String(params.turn.error.message ?? 'the turn failed') : undefined
      }
    },
    get finished() {
      return state.done !== undefined
    },
    /** The final answer is the last agent message of the turn: earlier ones narrate the work. */
    result() {
      return {
        turn: state.done ?? 'running',
        text: state.texts.at(-1) ?? '',
        files: state.files,
        commands: state.commands,
        declined: state.declined,
        error: state.error,
      }
    },
  }
}
