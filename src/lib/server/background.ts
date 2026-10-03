import { after } from 'next/server'
import { log, type Logger } from './log'

// Work that should not delay an HTTP response.

const g = globalThis as typeof globalThis & { __floodBackgroundTasks?: Set<Promise<void>> }
/** Background tasks running right now (for a graceful shutdown). */
const running = (g.__floodBackgroundTasks ??= new Set<Promise<void>>())

/**
 * Run `task` after the response has been sent, via Next.js `after()` (which keeps a
 * serverless function alive for it, within the route's maxDuration). Outside a Next.js
 * request scope (unit tests, scripts) `after()` throws, and the task runs detached
 * instead. Failures are logged, never thrown. While it runs, the task is tracked so a
 * shutdown can wait for it (backgroundTasksSettled).
 */
export function runAfterResponse(name: string, task: () => Promise<unknown>, logger: Logger = log): void {
  const run = async () => {
    const p = (async () => {
      try {
        await task()
      } catch (err) {
        logger(`[${name}] background task failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      }
    })()
    running.add(p)
    try {
      await p
    } finally {
      running.delete(p)
    }
  }
  try {
    after(run)
  } catch {
    void run()
  }
}

/** Number of background tasks running now. */
export function runningBackgroundTasks(): number {
  return running.size
}

/** Resolves when every background task running now has finished (never rejects). */
export async function backgroundTasksSettled(): Promise<void> {
  await Promise.all([...running])
}
