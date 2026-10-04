import { getConfig } from '../config'
import { logChannelConfigWarnings } from '../notify'
import { backgroundTasksSettled, runningBackgroundTasks } from './background'
import { startEmbeddedWorker, stopEmbeddedWorker } from './embedded-worker'
import { log as defaultLog, type Logger } from './log'

// Server process lifecycle, called from src/instrumentation.ts (Node.js runtime only):
// startup checks, the embedded worker, and a graceful shutdown on SIGTERM / SIGINT.
//
// Next.js handles SIGTERM itself and exits as soon as HTTP requests are drained, without
// waiting for the embedded poller: a `docker stop` landing during alert delivery left the
// alerts lock held and re-sent messages after the restart. With NEXT_MANUAL_SIG_HANDLE
// set (the Docker image sets it; it must be a real environment variable, not in .env)
// Next.js registers no signal handlers and this module owns the shutdown.

/**
 * How long a shutdown waits for the poll cycle in flight and running background tasks.
 * Keep it below the container's stop timeout (docker-compose.yml: stop_grace_period 30s).
 */
export const SHUTDOWN_GRACE_MS = 25_000

/** Exit codes like Next.js' own handler: 128 + signal number. */
const EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const
export type ShutdownSignal = keyof typeof EXIT_CODE

export interface DrainDeps {
  graceMs?: number
  stopWorker?: () => Promise<void>
  waitBackground?: () => Promise<void>
}

/**
 * Stop the embedded poller and wait for its in-flight cycle and for running background
 * tasks (ingest alerts and pruning), at most `graceMs`. True when everything finished.
 */
export async function drain(deps: DrainDeps = {}): Promise<boolean> {
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS
  const stopWorker = deps.stopWorker ?? stopEmbeddedWorker
  const waitBackground = deps.waitBackground ?? backgroundTasksSettled
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs)
  })
  // Running background tasks are collected once the poller has stopped, so tasks that
  // requests started in the meantime (the server still serves) are waited for too.
  const work = Promise.allSettled([stopWorker()])
    .then(() => waitBackground())
    .then(
      () => true as const,
      () => true as const,
    )
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown
  listenerCount?(signal: ShutdownSignal): number
}

export interface ShutdownOptions extends DrainDeps {
  /** Where signals come from (tests pass an EventEmitter). */
  proc?: SignalSource
  exit?: (code: number) => void
  log?: Logger
}

const g = globalThis as typeof globalThis & { __floodShutdownInstalled?: boolean }

/**
 * Handle SIGTERM / SIGINT: stop the poller, wait (bounded) for the current cycle and
 * background tasks, then exit. A second signal exits at once. Installed once per process;
 * returns false when it already was. Only call this when NEXT_MANUAL_SIG_HANDLE is set,
 * otherwise Next.js' own handler exits without waiting for us.
 */
export function installShutdownHandlers(opts: ShutdownOptions = {}): boolean {
  if (g.__floodShutdownInstalled) return false
  g.__floodShutdownInstalled = true
  const proc = opts.proc ?? process
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const log = opts.log ?? defaultLog
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS
  if ((proc.listenerCount?.('SIGTERM') ?? 0) > 0) {
    // Next.js decides before it loads .env files: NEXT_MANUAL_SIG_HANDLE in .env comes
    // too late, and its own handler will exit without waiting for us.
    log(
      '[shutdown] WARNING: another SIGTERM handler is already registered (Next.js?): set NEXT_MANUAL_SIG_HANDLE in the ' +
        'process environment (Dockerfile / docker-compose.yml / service unit), not in .env',
    )
  }
  let stopping = false
  const onSignal = (signal: ShutdownSignal) => {
    if (stopping) {
      log(`[shutdown] ${signal} again, exiting now`)
      exit(EXIT_CODE[signal])
      return
    }
    stopping = true
    const tasks = runningBackgroundTasks()
    log(
      `[shutdown] ${signal} received: stopping the poller` +
        (tasks > 0 ? ` and waiting for ${tasks} background task(s)` : '') +
        ` (at most ${Math.round(graceMs / 1000)} s)`,
    )
    void drain({ ...opts, graceMs }).then((clean) => {
      log(clean ? '[shutdown] done' : '[shutdown] grace period over, exiting with work still running')
      exit(EXIT_CODE[signal])
    })
  }
  proc.on('SIGTERM', () => onSignal('SIGTERM'))
  proc.on('SIGINT', () => onSignal('SIGINT'))
  return true
}

/** For tests. */
export function __resetShutdownForTests(): void {
  g.__floodShutdownInstalled = undefined
}

/**
 * Called once per server start (instrumentation register()). Never throws: a bad
 * configuration is logged here and reported again by the API routes that need it.
 */
export function onServerStart(env: Record<string, string | undefined> = process.env, opts: ShutdownOptions = {}): void {
  const log = opts.log ?? defaultLog
  try {
    logChannelConfigWarnings(getConfig(), log)
  } catch (err) {
    log(`[config] invalid configuration: ${err instanceof Error ? err.message : String(err)}`)
  }
  const embedded = env.EMBEDDED_WORKER === '1'
  if (env.NEXT_MANUAL_SIG_HANDLE) installShutdownHandlers(opts)
  else if (embedded) {
    log(
      '[embedded-worker] NEXT_MANUAL_SIG_HANDLE is not set: on SIGTERM the server exits without waiting for the poll cycle in flight' +
        ' (set NEXT_MANUAL_SIG_HANDLE=true in the environment, not in .env)',
    )
  }
  // Do not await the first cycle: register() must finish before requests are served.
  if (embedded) void startEmbeddedWorker()
}
