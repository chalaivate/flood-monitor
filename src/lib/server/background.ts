import { after } from 'next/server'
import { log, type Logger } from './log'

// Work that should not delay an HTTP response.

/**
 * Run `task` after the response has been sent, via Next.js `after()` (which keeps a
 * serverless function alive for it, within the route's maxDuration). Outside a Next.js
 * request scope (unit tests, scripts) `after()` throws, and the task runs detached
 * instead. Failures are logged, never thrown.
 */
export function runAfterResponse(name: string, task: () => Promise<unknown>, logger: Logger = log): void {
  const run = async () => {
    try {
      await task()
    } catch (err) {
      logger(`[${name}] background task failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    }
  }
  try {
    after(run)
  } catch {
    void run()
  }
}
