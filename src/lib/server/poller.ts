import { catalogDue, isCameraSourceId, publicCatalog, refreshCameraCatalogs, type CameraCatalogReport } from '../cameras/catalog'
import type { AppConfig } from '../config'
import { fetchPolitely, runAlerts, runIngest, type AlertReport, type CycleDeps, type IngestReport } from '../pipeline'
import { redactSecrets } from '../sources/cameras/common'
import type { CameraCatalogAdapter } from '../sources/cameras/types'
import type { SourceAdapter } from '../sources/types'
import type { CameraCatalog, CameraSourceId, SourceFetchResult, SourceId } from '../types'
import type { Logger } from './log'

// Polling loop shared by worker/poll.ts, the embedded worker (instrumentation) and
// /api/cron/poll. Alerts run only where RUN_ALERTS=1 so exactly one process owns them.

export interface CycleSummary {
  ingest: IngestReport
  /** null when RUN_ALERTS=0 in this process. */
  alerts: AlertReport | null
  pruned: number
  /** Camera catalogue refreshes (empty unless the cycle ran with `cameras: true`). */
  cameras: CameraCatalogReport[]
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
  /**
   * Also refresh the CCTV camera catalogues that are due (CCTV_SOURCES), after alerts and
   * pruning so they never delay them. Opt-in: the long-running pollers pass true. Failures are
   * recorded per source and never fail the cycle.
   */
  cameras?: boolean
}

/** ingest → alerts (if enabled) → prune readings older than HISTORY_HOURS → camera catalogues (opt-in). */
export async function runPollCycle(deps: CycleDeps, opts: PollCycleOptions = {}): Promise<CycleSummary> {
  const started = Date.now()
  const ingest = await runIngest(deps)
  if (opts.signal?.aborted) {
    deps.log?.('[poll] shutting down: alerts and pruning skipped for this cycle')
    return { ingest, alerts: null, pruned: 0, cameras: [], allFailed: ingest.results.every((r) => !r.ok), durationMs: Date.now() - started }
  }
  const alerts = deps.config.RUN_ALERTS === '1' ? await runAlerts(deps) : null
  const pruned = await pruneOldReadings(deps)
  const cameras =
    opts.cameras && !opts.signal?.aborted
      ? await refreshCameraCatalogs({ store: deps.store, config: deps.config, fetch: deps.fetch, now: deps.now, log: deps.log, signal: opts.signal })
      : []
  return {
    ingest,
    alerts,
    pruned,
    cameras,
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
  const refreshed = s.cameras.filter((c) => !c.skipped)
  const cams = refreshed.length ? `, camera lists: ${refreshed.map((c) => `${c.source} ${c.ok ? c.count : 'failed'}`).join(', ')}` : ''
  return `cycle done in ${(s.durationMs / 1000).toFixed(1)}s: ${ok}/${s.ingest.results.length} sources ok, ${inserted} new readings, ${alerts}, pruned ${s.pruned}${cams}`
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
  /**
   * Camera catalogue adapters to fetch when due and push with the readings. Only the public
   * camera fields are sent: upstream refs (stream addresses) never leave this machine.
   */
  cameraSources?: CameraCatalogAdapter[]
  /** Schedule kept across cycles (the relay has no store); defaults to a per-process one. */
  cameraState?: RelayCameraState
}

export interface RelaySummary {
  ok: boolean
  results: { source: SourceId; ok: boolean; stations: number; readings: number; error?: string }[]
  /** Camera lists fetched (or re-sent) this cycle. */
  cameras: { source: CameraSourceId; ok: boolean; count: number; error?: string }[]
  inserted: number | null
  error?: string
  allFailed: boolean
}

interface RelayCameraEntry {
  lastAttemptAt: string | null
  /** fetchedAt of the last list fetched here. */
  lastSuccessAt: string | null
  failures: number
  /** Fetched but not yet accepted by the server (re-sent next cycle). */
  pending: CameraCatalog | null
}

/** In-memory schedule of the camera lists a relay pushes (one per worker process). */
export type RelayCameraState = Map<CameraSourceId, RelayCameraEntry>

export function createRelayCameraState(): RelayCameraState {
  return new Map()
}

/**
 * Schedule only (timestamps and counters, never camera lists or refs), so `--relay --once` runs
 * started by a task scheduler do not refetch the lists every time. A list fetched but not yet
 * delivered is forgotten, so the next run fetches it again.
 */
export function serializeRelayCameraState(state: RelayCameraState): string {
  const out: Record<string, { lastAttemptAt: string | null; lastSuccessAt: string | null; failures: number }> = {}
  for (const [source, e] of state) out[source] = { lastAttemptAt: e.lastAttemptAt, lastSuccessAt: e.pending ? null : e.lastSuccessAt, failures: e.failures }
  return JSON.stringify(out)
}

export function parseRelayCameraState(text: string | null): RelayCameraState {
  const state = createRelayCameraState()
  let raw: unknown
  try {
    raw = text ? JSON.parse(text) : null
  } catch {
    return state
  }
  if (!raw || typeof raw !== 'object') return state
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  for (const [source, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCameraSourceId(source) || !v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    const failures = typeof e.failures === 'number' && Number.isInteger(e.failures) && e.failures >= 0 ? Math.min(e.failures, 100) : 0
    state.set(source, { lastAttemptAt: iso(e.lastAttemptAt), lastSuccessAt: iso(e.lastSuccessAt), failures, pending: null })
  }
  return state
}

const defaultRelayCameraState = createRelayCameraState()

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function errText(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timeout' : err.message
  return String(err)
}

export function ingestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/ingest`
}

interface RelayCameraBatch {
  catalogs: CameraCatalog[]
  failures: { source: CameraSourceId; error: string; attemptedAt: string }[]
  report: RelaySummary['cameras']
}

/** A camera list fetch in relay mode must finish within this. */
const CATALOG_RELAY_DEADLINE_MS = 120_000

/** Fetch the camera lists that are due (in-memory schedule); keep unsent ones for the next push. */
async function relayCameraCatalogs(opts: RelayOptions, now: Date): Promise<RelayCameraBatch> {
  const batch: RelayCameraBatch = { catalogs: [], failures: [], report: [] }
  const state = opts.cameraState ?? defaultRelayCameraState
  const adapters = (opts.cameraSources ?? []).filter((a) => a.id !== 'demo-cam')
  await Promise.all(
    adapters.map(async (a) => {
      let st = state.get(a.id)
      if (!st) state.set(a.id, (st = { lastAttemptAt: null, lastSuccessAt: null, failures: 0, pending: null }))
      const due = catalogDue({
        source: a.id,
        refreshHours: a.refreshHours,
        thaiIpOnly: a.thaiIpOnly,
        fetchedAt: st.lastSuccessAt,
        local: true,
        lastAttemptAt: st.lastAttemptAt,
        failures: st.failures,
        now,
      })
      let error: string | undefined
      if (due) {
        st.lastAttemptAt = now.toISOString()
        try {
          const result = await a.fetchCatalog({
            fetch: opts.fetch,
            now,
            timeoutMs: opts.config.FETCH_TIMEOUT_MS,
            sleep: opts.sleep,
            signal: AbortSignal.timeout(CATALOG_RELAY_DEADLINE_MS),
          })
          // Public fields only: the refs stay here (the receiving server cannot use them).
          st.pending = publicCatalog(result)
          st.lastSuccessAt = result.fetchedAt
          st.failures = 0
          opts.log(`[relay] ${a.id} camera list: ${st.pending.cameras.length} camera(s)`)
        } catch (err) {
          st.failures++
          error = redactSecrets(errText(err))
          batch.failures.push({ source: a.id, error, attemptedAt: now.toISOString() })
          opts.log(`[relay] ${a.id} camera list FAILED: ${error}`)
        }
      }
      // An earlier list the server has not accepted yet is sent again.
      if (st.pending) batch.catalogs.push(st.pending)
      if (due || st.pending) batch.report.push({ source: a.id, ok: !error, count: st.pending?.cameras.length ?? 0, ...(error ? { error } : {}) })
    }),
  )
  return batch
}

/** Fetch Thai-only sources locally and push them to `<baseUrl>/api/ingest`. */
export async function runRelayCycle(opts: RelayOptions): Promise<RelaySummary> {
  const now = opts.now?.() ?? new Date()
  // Same politeness as runIngest: sources on one upstream host (all bma-* live on
  // weather.bangkok.go.th, whose WAF bans bursts) run one after another. Camera lists come
  // from other hosts and are fetched alongside.
  const [settled, cams] = await Promise.all([
    fetchPolitely(opts.sources, (s) => s.fetch({ fetch: opts.fetch, now, timeoutMs: opts.config.FETCH_TIMEOUT_MS, sleep: opts.sleep })),
    relayCameraCatalogs(opts, now),
  ])
  const results: SourceFetchResult[] = []
  const failures: { source: SourceId; error: string; attemptedAt: string }[] = []
  const summary: RelaySummary = { ok: false, results: [], cameras: cams.report, inserted: null, allFailed: true }
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
  const body = JSON.stringify({
    results,
    failures,
    ...(cams.catalogs.length ? { cameraCatalogs: cams.catalogs } : {}),
    ...(cams.failures.length ? { cameraFailures: cams.failures } : {}),
  })
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
          const answer = JSON.parse(text) as { inserted?: number; cameras?: { source?: string; saved?: boolean; warning?: string | null }[] }
          summary.inserted = answer.inserted ?? null
          for (const c of Array.isArray(answer.cameras) ? answer.cameras : []) {
            if (c && c.saved === false && c.warning) opts.log(`[relay] server kept its ${String(c.source)} camera list: ${String(c.warning).slice(0, 200)}`)
          }
        } catch {
          summary.inserted = null
        }
        // Delivered: the server decides whether to keep each list.
        const state = opts.cameraState ?? defaultRelayCameraState
        for (const cat of cams.catalogs) {
          const st = state.get(cat.source)
          if (st?.pending === cat) st.pending = null
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
