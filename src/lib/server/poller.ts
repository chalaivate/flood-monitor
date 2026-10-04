import type { AppConfig } from '../config'
import { fetchPolitely, runAlerts, runIngest, type AlertReport, type CycleDeps, type IngestReport } from '../pipeline'
import type { SourceAdapter } from '../sources/types'
import type { SourceFetchResult, SourceId } from '../types'
import type { Logger } from './log'

// Polling loop shared by worker/poll.ts, the embedded worker (instrumentation) and
// /api/cron/poll. Alerts run only where RUN_ALERTS=1 so exactly one process owns them.

export interface CycleSummary {
  ingest: IngestReport
  /** null when RUN_ALERTS=0 in this process. */
  alerts: AlertReport | null
  pruned: number
  /** Every enabled source failed (or none is enabled). */
  allFailed: boolean
  durationMs: number
}

/** Delete readings older than HISTORY_HOURS; returns how many were removed. */
export function pruneOldReadings(deps: Pick<CycleDeps, 'store' | 'config' | 'now'>): Promise<number> {
  const now = deps.now?.() ?? new Date()
  return deps.store.pruneReadings(new Date(now.getTime() - deps.config.HISTORY_HOURS * 3_600_000).toISOString())
}

export interface PollCycleOptions {
  /**
   * Aborted when the process is shutting down. Checked after the ingest: alert evaluation
   * is not *started* then, so a shutdown never cuts it off half-way (messages sent but
   * their state not saved ⇒ repeated after the restart, alerts lock left held). The next
   * cycle after the restart evaluates the same readings.
   */
  signal?: AbortSignal
}

/** ingest → alerts (if enabled) → prune readings older than HISTORY_HOURS. */
export async function runPollCycle(deps: CycleDeps, opts: PollCycleOptions = {}): Promise<CycleSummary> {
  const started = Date.now()
  const ingest = await runIngest(deps)
  if (opts.signal?.aborted) {
    deps.log?.('[poll] shutting down: alerts and pruning skipped for this cycle')
    return { ingest, alerts: null, pruned: 0, allFailed: ingest.results.every((r) => !r.ok), durationMs: Date.now() - started }
  }
  const alerts = deps.config.RUN_ALERTS === '1' ? await runAlerts(deps) : null
  const pruned = await pruneOldReadings(deps)
  return {
    ingest,
    alerts,
    pruned,
    allFailed: ingest.results.every((r) => !r.ok),
    durationMs: Date.now() - started,
  }
}

/** Lowest poll interval accepted; anything below is raised to it. */
export const MIN_POLL_MINUTES = 1
/** Below this, BMA's WAF (weather.bangkok.go.th) may start refusing the server's IP. */
export const RECOMMENDED_MIN_POLL_MINUTES = 5

/**
 * Poll interval in ms from POLL_MINUTES, never below MIN_POLL_MINUTES (0, a negative or a
 * non-numeric value would otherwise poll every second). Logs a warning below the
 * recommended minimum. Shared by worker/poll.ts and the embedded worker.
 */
export function pollIntervalMs(pollMinutes: number, log?: Logger): number {
  const minutes = Number.isFinite(pollMinutes) ? Math.max(MIN_POLL_MINUTES, pollMinutes) : MIN_POLL_MINUTES
  if (log && minutes !== pollMinutes) log(`[poll] POLL_MINUTES=${pollMinutes} is not allowed; polling every ${minutes} min`)
  if (log && minutes < RECOMMENDED_MIN_POLL_MINUTES) {
    log(`[poll] WARNING: POLL_MINUTES=${minutes} is below the recommended ${RECOMMENDED_MIN_POLL_MINUTES} min; upstream servers may block frequent requests`)
  }
  return minutes * 60_000
}

export function summarize(s: CycleSummary): string {
  const ok = s.ingest.results.filter((r) => r.ok).length
  const inserted = s.ingest.results.reduce((n, r) => n + r.inserted, 0)
  const alerts = s.alerts ? `${s.alerts.events.length} alert(s) for ${s.alerts.places} place(s)` : 'alerts disabled'
  return `cycle done in ${(s.durationMs / 1000).toFixed(1)}s: ${ok}/${s.ingest.results.length} sources ok, ${inserted} new readings, ${alerts}, pruned ${s.pruned}`
}

// --- loop ---------------------------------------------------------------------------

export interface LoopHandle {
  /** Stop scheduling; resolves after the in-flight cycle (if any) finishes. */
  stop(): Promise<void>
  /** Resolves when the loop has fully stopped. */
  readonly done: Promise<void>
}

export interface LoopOptions {
  intervalMs: number
  log: Logger
  /** Injectable sleep; must resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * Run `task` now, then again `intervalMs` after each run *started* (never
 * overlapping; a slow run just delays the next one). `task` gets a signal that is
 * aborted by stop(), so a long run can skip work it should not start any more.
 */
export function startLoop(task: (signal: AbortSignal) => Promise<void>, opts: LoopOptions): LoopHandle {
  const ctrl = new AbortController()
  const sleep = opts.sleep ?? abortableSleep
  const done = (async () => {
    while (!ctrl.signal.aborted) {
      const started = Date.now()
      try {
        await task(ctrl.signal)
      } catch (err) {
        opts.log(`[poll] cycle crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      }
      if (ctrl.signal.aborted) break
      await sleep(Math.max(1000, opts.intervalMs - (Date.now() - started)), ctrl.signal)
    }
  })()
  return {
    done,
    async stop() {
      ctrl.abort()
      await done
    },
  }
}

// --- relay mode -----------------------------------------------------------------------

export interface RelayOptions {
  baseUrl: string
  token: string
  config: AppConfig
  /** Adapters to run locally (normally the Thai-IP-only ones). */
  sources: SourceAdapter[]
  fetch: typeof fetch
  log: Logger
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** Delays before each POST retry. */
  retryDelaysMs?: number[]
}

export interface RelaySummary {
  ok: boolean
  results: { source: SourceId; ok: boolean; stations: number; readings: number; error?: string }[]
  inserted: number | null
  error?: string
  allFailed: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function errText(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timeout' : err.message
  return String(err)
}

export function ingestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/ingest`
}

/** Fetch Thai-only sources locally and push them to `<baseUrl>/api/ingest`. */
export async function runRelayCycle(opts: RelayOptions): Promise<RelaySummary> {
  const now = opts.now?.() ?? new Date()
  // Same politeness as runIngest: sources on one upstream host (all bma-* live on
  // weather.bangkok.go.th, whose WAF bans bursts) run one after another.
  const settled = await fetchPolitely(opts.sources, (s) =>
    s.fetch({ fetch: opts.fetch, now, timeoutMs: opts.config.FETCH_TIMEOUT_MS, sleep: opts.sleep }),
  )
  const results: SourceFetchResult[] = []
  const failures: { source: SourceId; error: string; attemptedAt: string }[] = []
  const summary: RelaySummary = { ok: false, results: [], inserted: null, allFailed: true }
  settled.forEach((res, i) => {
    const src = opts.sources[i]!
    if (res.status === 'fulfilled') {
      results.push(res.value)
      summary.results.push({ source: src.id, ok: true, stations: res.value.stations.length, readings: res.value.readings.length })
      opts.log(`[relay] ${src.id}: ${res.value.stations.length} stations, ${res.value.readings.length} readings`)
    } else {
      const error = errText(res.reason)
      failures.push({ source: src.id, error, attemptedAt: new Date().toISOString() })
      summary.results.push({ source: src.id, ok: false, stations: 0, readings: 0, error })
      opts.log(`[relay] ${src.id} FAILED: ${error}`)
    }
  })

  const url = ingestUrl(opts.baseUrl)
  const body = JSON.stringify({ results, failures })
  const delays = opts.retryDelaysMs ?? [5_000, 15_000, 30_000]
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    let retryable = true
    try {
      const res = await opts.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.max(30_000, opts.config.FETCH_TIMEOUT_MS)),
      })
      const text = await res.text().catch(() => '')
      if (res.ok) {
        try {
          summary.inserted = (JSON.parse(text) as { inserted?: number }).inserted ?? null
        } catch {
          summary.inserted = null
        }
        summary.ok = true
        summary.error = undefined
        break
      }
      retryable = res.status === 429 || res.status >= 500
      summary.error = `ingest HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
    } catch (err) {
      summary.error = `ingest request failed: ${errText(err)}`
    }
    const delay = delays[attempt]
    if (!retryable || delay === undefined) break
    opts.log(`[relay] ${summary.error}; retrying in ${Math.round(delay / 1000)}s`)
    await sleep(delay)
  }
  if (summary.ok) opts.log(`[relay] pushed ${results.length} result(s) → ${summary.inserted ?? '?'} new readings`)
  else opts.log(`[relay] push FAILED: ${summary.error}`)
  summary.allFailed = !summary.ok || results.length === 0
  return summary
}
