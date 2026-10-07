/**
 * Runs `task` after the ones queued before it: requests share the plugin's
 * tab, so they take turns. `ahead` says how many wait in front.
 */
export function taskQueue(): <T>(task: () => Promise<T>, ahead?: (count: number) => void) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return (task, ahead) => {
    ahead?.(pending)
    pending++
    const run = tail.then(task, task).finally(() => {
      pending--
    })
    tail = run.catch(() => undefined)
    return run
  }
}
