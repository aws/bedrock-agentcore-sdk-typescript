/**
 * Poll a condition function until it returns `true` or the timeout expires.
 *
 * @param condition - Async function that returns `true` when done. Throwing is treated as "not done yet" when `swallowErrors` is true.
 * @param opts - Polling options
 * @returns `true` if the condition was met, `false` if timed out (only when `timeoutErrorMessage` is not set)
 * @throws Error with `timeoutErrorMessage` if provided and timeout expires
 */
export async function pollUntil(
  condition: () => Promise<boolean>,
  opts: {
    maxWaitSeconds: number
    pollIntervalMs: number
    timeoutErrorMessage?: string
    shouldSwallowError?: (err: unknown) => boolean
  }
): Promise<boolean> {
  const deadline = Date.now() + opts.maxWaitSeconds * 1000
  while (Date.now() < deadline) {
    try {
      if (await condition()) return true
    } catch (err) {
      if (!opts.shouldSwallowError?.(err)) throw err
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, opts.pollIntervalMs))
  }
  if (opts.timeoutErrorMessage) throw new Error(opts.timeoutErrorMessage)
  return false
}
