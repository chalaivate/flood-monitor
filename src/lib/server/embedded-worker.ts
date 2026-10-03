import { getConfig } from '../config'
import { getSenders } from '../notify'
import { getSources } from '../sources'
import { getStore } from '../store'
import { log } from './log'
import { runPollCycle, startLoop, summarize, type LoopHandle } from './poller'

// Poller running inside the Next.js server process (all-in-one Docker,
// EMBEDDED_WORKER=1). Started from src/instrumentation.ts.

/** First retry after a failed start; doubles per failure up to RETRY_MAX_MS. */
export const RETRY_INITIAL_MS = 30_000
export const RETRY_MAX_MS = 5 * 60_000

export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.max(0, failures - 1))
}

export interface EmbeddedWorkerOptions {
  /** Timer used to schedule a retry (tests inject a fake). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const g = globalThis as typeof globalThis & {
  __floodEmbeddedWorker?: Promise<LoopHandle | null>
  __floodEmbeddedWorkerRetry?: { handle: unknown; clear: (handle: unknown) => void }
  __floodEmbeddedWorkerFailures?: number
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms)
  // A pending retry must not keep the process alive on shutdown.
  t.unref?.()
  return t
}
const defaultClearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)

async function startOnce(): Promise<LoopHandle> {
  const config = getConfig()
  const store = await getStore()
  const sources = getSources(config)
  const deps = { store, config, sources, senders: getSenders(), fetch: globalThis.fetch.bind(globalThis), log }
  log(
    `[embedded-worker] polling ${sources.map((s) => s.id).join(', ') || '(no sources)'} every ${config.POLL_MINUTES} min` +
      ` (store=${config.STORE}, alerts=${config.RUN_ALERTS === '1' ? 'on' : 'off'}, data=${config.DATA_MODE})`,
  )
  return startLoop(
    async () => {
      log(summarize(await runPollCycle(deps)))
    },
    { intervalMs: config.POLL_MINUTES * 60_000, log },
  )
}

/**
 * Start once per process (instrumentation can run again after dev HMR). Never throws.
 * When the start fails (e.g. the store cannot be opened yet) the cached promise is
 * cleared and a retry is scheduled with backoff: 30 s, doubling up to 5 min.
 */
export function startEmbeddedWorker(opts: EmbeddedWorkerOptions = {}): Promise<LoopHandle | null> {
  if (g.__floodEmbeddedWorker) return g.__floodEmbeddedWorker
  // A manual start supersedes a scheduled retry.
  if (g.__floodEmbeddedWorkerRetry) {
    g.__floodEmbeddedWorkerRetry.clear(g.__floodEmbeddedWorkerRetry.handle)
    g.__floodEmbeddedWorkerRetry = undefined
  }
  const setTimer = opts.setTimer ?? defaultSetTimer
  const clearTimer = opts.clearTimer ?? defaultClearTimer
  const attempt: Promise<LoopHandle | null> = startOnce().then(
    (handle) => {
      g.__floodEmbeddedWorkerFailures = 0
      return handle
    },
    (err: unknown) => {
      const failures = (g.__floodEmbeddedWorkerFailures ?? 0) + 1
      g.__floodEmbeddedWorkerFailures = failures
      const delay = retryDelayMs(failures)
      log(
        `[embedded-worker] failed to start: ${err instanceof Error ? err.message : String(err)}; retrying in ${Math.round(delay / 1000)} s`,
      )
      // Forget the failed attempt so the retry (or another caller) can start afresh.
      if (g.__floodEmbeddedWorker === attempt) g.__floodEmbeddedWorker = undefined
      const handle = setTimer(() => {
        g.__floodEmbeddedWorkerRetry = undefined
        void startEmbeddedWorker(opts)
      }, delay)
      g.__floodEmbeddedWorkerRetry = { handle, clear: clearTimer }
      return null
    },
  )
  g.__floodEmbeddedWorker = attempt
  return attempt
}
