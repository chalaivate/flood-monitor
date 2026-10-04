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
  /**
   * With `cameras`: refresh only catalogues reachable from anywhere (adapter thaiIpOnly=false).
   * For hosts that may run outside Thailand (/api/cron/poll): a Thai-IP-only list stays in use
   * and is refreshed by the Thai worker (or relay) only.
   */
  skipThaiIpOnlyCameras?: boolean
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
      ? await refreshCameraCatalogs({
          store: deps.store,
          config: deps.config,
          fetch: deps.fetch,
          now: deps.now,
          log: deps.log,
          signal: opts.signal,
          skipThaiIpOnly: !!opts.skipThaiIpOnlyCameras,
        })
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
   * Camera catalogue adapters to fetch when due and push after the readings, in a POST of their
   * own (the readings never wait for them). Only the public camera fields are sent: upstream
   * refs (stream addresses) never leave this machine.
   */
  cameraSources?: CameraCatalogAdapter[]
  /** Schedule kept across cycles (the relay has no store); defaults to a per-process one. */
  cameraState?: RelayCameraState
  /**
   * Aborted on shutdown: a camera list fetch in progress stops (not counted as a failure) and no
   * camera POST starts. The readings of the cycle are still pushed.
   */
  signal?: AbortSignal
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
  /** fetchedAt of the last list fetched here (null once the server asks for a fresh one). */
  lastSuccessAt: string | null
  failures: number
  /** Fetched but not yet confirmed by the server (re-sent next cycle). */
  pending: CameraCatalog | null
  /** Deliveries of `pending` the server could not confirm (e.g. its store failed). */
  unconfirmed: number
  /** Lists in a row the server did not take (too small, or never confirmed): drives the refetch backoff. */
  rejected: number
  /** Last list fetched here (memory only): DWR keeps a station's last known position from it. */
  previous: CameraCatalog | null
}

/** In-memory schedule of the camera lists a relay pushes (one per worker process). */
export type RelayCameraState = Map<CameraSourceId, RelayCameraEntry>

export function createRelayCameraState(): RelayCameraState {
  return new Map()
}

function newRelayCameraEntry(): RelayCameraEntry {
  return { lastAttemptAt: null, lastSuccessAt: null, failures: 0, pending: null, unconfirmed: 0, rejected: 0, previous: null }
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
    state.set(source, { ...newRelayCameraEntry(), lastAttemptAt: iso(e.lastAttemptAt), lastSuccessAt: iso(e.lastSuccessAt), failures })
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
/** A list the server could not confirm is re-sent this many times, then refetched with backoff. */
export const RELAY_CAMERA_MAX_UNCONFIRMED = 6

/** Fetch the camera lists that are due (in-memory schedule); keep unsent ones for the next push. */
async function relayCameraCatalogs(opts: RelayOptions, now: Date): Promise<RelayCameraBatch> {
  const batch: RelayCameraBatch = { catalogs: [], failures: [], report: [] }
  const state = opts.cameraState ?? defaultRelayCameraState
  const adapters = (opts.cameraSources ?? []).filter((a) => a.id !== 'demo-cam')
  await Promise.all(
    adapters.map(async (a) => {
      let st = state.get(a.id)
      if (!st) state.set(a.id, (st = newRelayCameraEntry()))
      // A list the server has not confirmed yet is sent again rather than refetched.
      const due =
        !st.pending &&
        !opts.signal?.aborted &&
        catalogDue({
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
      let interrupted = false
      if (due) {
        const prevAttempt = st.lastAttemptAt
        st.lastAttemptAt = now.toISOString()
        const deadline = AbortSignal.timeout(CATALOG_RELAY_DEADLINE_MS)
        try {
          const result = await a.fetchCatalog({
            fetch: opts.fetch,
            now,
            timeoutMs: opts.config.FETCH_TIMEOUT_MS,
            sleep: opts.sleep,
            signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline,
            previous: st.previous,
          })
          // Public fields only: the refs stay here (the receiving server cannot use them).
          st.pending = publicCatalog(result)
          st.previous = st.pending
          st.unconfirmed = 0
          st.lastSuccessAt = result.fetchedAt
          st.failures = 0
          opts.log(`[relay] ${a.id} camera list: ${st.pending.cameras.length} camera(s)`)
        } catch (err) {
          if (opts.signal?.aborted) {
            // Shutdown, not an upstream failure: no backoff; the next run fetches it again.
            st.lastAttemptAt = prevAttempt
            interrupted = true
            opts.log(`[relay] ${a.id} camera list: interrupted by shutdown`)
          } else {
            st.failures++
            error = redactSecrets(deadline.aborted ? `camera list took longer than ${CATALOG_RELAY_DEADLINE_MS / 1000} s` : errText(err))
            batch.failures.push({ source: a.id, error, attemptedAt: now.toISOString() })
            opts.log(`[relay] ${a.id} camera list FAILED: ${error}`)
          }
        }
      }
      if (st.pending) batch.catalogs.push(st.pending)
      if ((due && !interrupted) || st.pending) batch.report.push({ source: a.id, ok: !error, count: st.pending?.cameras.length ?? 0, ...(error ? { error } : {}) })
    }),
  )
  return batch
}

/** The server's answer for one relayed list (POST /api/ingest → cameras[i]). */
interface CameraAnswer {
  source?: unknown
  saved?: unknown
  warning?: unknown
  reason?: unknown
  retry?: unknown
}

/**
 * What the relay does with each list it sent, from the server's answer: saved → done; a
 * transient server problem (retry, or no usable answer) → send it again next cycle; refused as
 * too small → fetch again with backoff (a smaller list is accepted once it keeps coming back);
 * any other refusal (server's own list is fresh, older, invalid, not enabled) → done for this
 * period. `answers` is null when the response could not be read.
 */
function settleCameraDeliveries(opts: RelayOptions, sent: CameraCatalog[], answers: CameraAnswer[] | null, now: Date): void {
  const state = opts.cameraState ?? defaultRelayCameraState
  sent.forEach((cat, i) => {
    const st = state.get(cat.source)
    if (!st || st.pending !== cat) return
    const a = answers?.[i]
    const matches = !!a && typeof a === 'object' && (a.source === cat.source || a.source === null || a.source === undefined)
    const warning = matches && typeof a.warning === 'string' ? a.warning.slice(0, 200) : null
    if (matches && a.saved === true) {
      st.pending = null
      st.unconfirmed = 0
      st.rejected = 0
      return
    }
    if (!matches || a.retry === true) {
      st.unconfirmed++
      if (st.unconfirmed < RELAY_CAMERA_MAX_UNCONFIRMED) {
        opts.log(`[relay] server did not confirm the ${cat.source} camera list${warning ? `: ${warning}` : ''}; sending it again next cycle`)
        return
      }
      opts.log(`[relay] server did not confirm the ${cat.source} camera list ${st.unconfirmed} times; fetching a new one later`)
    } else {
      opts.log(`[relay] server kept its ${cat.source} camera list${warning ? `: ${warning}` : ''}`)
      if (a.reason !== 'shrink') {
        // Done for this period (the next list is fetched when due).
        st.pending = null
        st.unconfirmed = 0
        st.rejected = 0
        return
      }
    }
    // Fetch a fresh list with backoff (1 h, 2 h, 4 h … up to a period): the server accepts a
    // smaller list once it keeps coming back, and a list it could not store is replaced.
    st.pending = null
    st.unconfirmed = 0
    st.rejected++
    st.lastSuccessAt = null
    st.lastAttemptAt = now.toISOString()
    st.failures = st.rejected
  })
}

async function postIngest(opts: RelayOptions, body: string): Promise<Response> {
  return opts.fetch(ingestUrl(opts.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(Math.max(30_000, opts.config.FETCH_TIMEOUT_MS)),
  })
}

/**
 * Push the camera lists (and list failures) in a POST of their own, once (no retries); whatever
 * the server did not confirm is sent again next cycle, up to RELAY_CAMERA_MAX_UNCONFIRMED times.
 */
async function pushCameraLists(opts: RelayOptions, cams: RelayCameraBatch, now: Date): Promise<void> {
  if (cams.catalogs.length === 0 && cams.failures.length === 0) return
  const body = JSON.stringify({
    results: [],
    failures: [],
    ...(cams.catalogs.length ? { cameraCatalogs: cams.catalogs } : {}),
    ...(cams.failures.length ? { cameraFailures: cams.failures } : {}),
  })
  let answers: CameraAnswer[] | null = null
  try {
    const res = await postIngest(opts, body)
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      opts.log(`[relay] camera lists not delivered: ingest HTTP ${res.status}`)
    } else {
      try {
        const parsed = JSON.parse(text) as { cameras?: unknown }
        if (Array.isArray(parsed.cameras)) answers = parsed.cameras as CameraAnswer[]
        else {
          // A server without camera support answers without `cameras`: nothing to wait for.
          opts.log('[relay] the server does not report on camera lists (older version?)')
          answers = cams.catalogs.map((c) => ({ source: c.source, saved: true }))
        }
      } catch {
        opts.log('[relay] camera lists: unreadable answer from the server')
      }
    }
  } catch (err) {
    opts.log(`[relay] camera lists not delivered: ${errText(err)}`)
  }
  settleCameraDeliveries(opts, cams.catalogs, answers, now)
}

/**
 * Fetch Thai-only sources locally and push them to `<baseUrl>/api/ingest`. Camera lists that are
 * due are fetched alongside but pushed afterwards in their own POST, so the readings (and the
 * server's alerts) never wait for a slow camera list.
 */
export async function runRelayCycle(opts: RelayOptions): Promise<RelaySummary> {
  const now = opts.now?.() ?? new Date()
  // Started first (other upstream hosts); never rejects.
  const camerasP = relayCameraCatalogs(opts, now)
  // Same politeness as runIngest: sources on one upstream host (all bma-* live on
  // weather.bangkok.go.th, whose WAF bans bursts) run one after another.
  const settled = await fetchPolitely(opts.sources, (s) => s.fetch({ fetch: opts.fetch, now, timeoutMs: opts.config.FETCH_TIMEOUT_MS, sleep: opts.sleep }))
  const results: SourceFetchResult[] = []
  const failures: { source: SourceId; error: string; attemptedAt: string }[] = []
  const summary: RelaySummary = { ok: false, results: [], cameras: [], inserted: null, allFailed: true }
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

  const body = JSON.stringify({ results, failures })
  const delays = opts.retryDelaysMs ?? [5_000, 15_000, 30_000]
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    let retryable = true
    try {
      const res = await postIngest(opts, body)
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

  // Camera lists after the readings. Skipped when the server is not taking readings (or on
  // shutdown): unsent lists stay pending and go out with a later cycle.
  const cams = await camerasP
  summary.cameras = cams.report
  if (summary.ok && !opts.signal?.aborted) await pushCameraLists(opts, cams, now)
  return summary
}
