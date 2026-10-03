import { createHash } from 'node:crypto'
import type { AppConfig } from './config'
import { evaluateAlerts } from './engine/alerts'
import { buildSnapshot, nearestWaterStationIds, type SnapshotPlace } from './engine/snapshot'
import type { ChannelSender, NotifyMessage } from './notify/types'
import { SOURCE_PRIORITY } from './sources'
import { HttpError } from './sources/http'
import type { SourceAdapter } from './sources/types'
import type { Store } from './store/types'
import type { AlertEvent, Place, SourceFetchResult } from './types'

export interface CycleDeps {
  store: Store
  config: AppConfig
  sources: SourceAdapter[]
  senders: ChannelSender[]
  fetch: typeof fetch
  now?: () => Date
  log?: (msg: string) => void
  /** Ingest deadline override (e.g. a serverless maxDuration budget). */
  deadlineMs?: number
}

export interface IngestReport {
  results: { source: string; ok: boolean; stations: number; readings: number; inserted: number; error?: string; warnings: string[] }[]
}

export interface AlertReport {
  places: number
  /** true when another process held the alerts lease and this run did nothing. */
  skipped?: boolean
  events: { placeId: string; title: string; delivered: number; failed: number }[]
}

export const META_LAST_INGEST = 'lastIngestAt'
export const META_LAST_INGEST_ATTEMPT = 'lastIngestAttemptAt'
export const META_LAST_ALERTS = 'lastAlertsAt'

/** History window used for trend calculation (needs ≥ 60 min plus slack). */
const TREND_WINDOW_MIN = 120

function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timeout' : err.message
  return String(err)
}

/**
 * Persist one source result (used by the poller and by the relay ingest endpoint).
 * Station metadata from a lower-priority source never overwrites a higher-priority one
 * (e.g. the ThaiWater mirror must not replace BMA's own bank heights), but its readings
 * are always stored — duplicates of (station, time) are ignored by the store.
 */
export async function storeSourceResult(store: Store, result: SourceFetchResult): Promise<number> {
  const existing = await store.stationSources(result.stations.map((s) => s.id))
  const incomingPriority = SOURCE_PRIORITY[result.source] ?? 0
  const upserts = result.stations.filter((s) => {
    const prevSource = existing.get(s.id)
    return !prevSource || (SOURCE_PRIORITY[prevSource as keyof typeof SOURCE_PRIORITY] ?? 0) <= incomingPriority
  })
  await store.upsertStations(upserts)
  return store.insertReadings(result.readings)
}

function latestObservation(result: SourceFetchResult): string | null {
  let max: string | null = null
  for (const r of result.readings) if (!max || r.observedAt > max) max = r.observedAt
  return max
}

/** Thrown for sources skipped because their host refused us earlier in the cycle. */
export class HostBackoffError extends Error {
  constructor(host: string, reason: string) {
    super(`ข้ามการดึงจาก ${host} ในรอบนี้ (${reason})`)
    this.name = 'HostBackoffError'
  }
}

export function hostOf(sourceId: string): string {
  return sourceId.split('-')[0]!
}

/** A WAF refusal (429 rate limit, or 403 after the warm-up retry) means: stop hitting this host. */
export function isHostRefusal(err: unknown): number | null {
  return err instanceof HttpError && (err.status === 429 || err.status === 403) ? err.status : null
}

export interface PoliteOptions<S, T> {
  /** Called as soon as each source settles (store it right away). */
  onSettled?: (source: S, result: PromiseSettledResult<T>, index: number) => Promise<void>
  /** Hosts to skip entirely this cycle, with the reason shown in source health. */
  skipHosts?: Map<string, string>
}

/**
 * Run fetches so that sources on the same upstream host go one after another (BMA's WAF bans
 * bursts), while different hosts proceed in parallel. After a 429/403 from a host its remaining
 * sources are skipped for this cycle. Results keep the input order.
 */
export async function fetchPolitely<S extends { id: string }, T>(
  sources: S[],
  run: (s: S) => Promise<T>,
  opts: PoliteOptions<S, T> = {},
): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(sources.length)
  const groups = new Map<string, number[]>()
  sources.forEach((s, i) => {
    const host = hostOf(s.id)
    groups.set(host, [...(groups.get(host) ?? []), i])
  })
  await Promise.all(
    [...groups.entries()].map(async ([host, idxs]) => {
      let refusal: string | null = opts.skipHosts?.get(host) ?? null
      for (const i of idxs) {
        let res: PromiseSettledResult<T>
        if (refusal) {
          res = { status: 'rejected', reason: new HostBackoffError(host, refusal) }
        } else {
          try {
            res = { status: 'fulfilled', value: await run(sources[i]!) }
          } catch (reason) {
            res = { status: 'rejected', reason }
            const status = isHostRefusal(reason)
            if (status) refusal = `ต้นทางตอบ HTTP ${status}`
          }
        }
        out[i] = res
        if (opts.onSettled) {
          try {
            await opts.onSettled(sources[i]!, res, i)
          } catch {
            // bookkeeping errors must not stop the other sources
          }
        }
      }
    }),
  )
  return out
}

/** After a 429 the whole host is left alone for this long (meta key `backoff:<host>`). */
export const RATE_LIMIT_BACKOFF_MIN = 30
/** Default ingest deadline: never longer than this, and never longer than 80% of the poll period. */
export const INGEST_DEADLINE_MAX_MS = 240_000

/**
 * Fetch every enabled source and store each one as soon as it answers (a slow upstream never
 * delays the others), within a cycle deadline; record per-source health.
 */
export async function runIngest(deps: CycleDeps): Promise<IngestReport> {
  const now = deps.now?.() ?? new Date()
  const report: IngestReport = { results: [] }
  const healthBefore = new Map((await deps.store.listSourceHealth()).map((h) => [h.source, h]))
  const deadlineMs = deps.deadlineMs ?? Math.max(30_000, Math.min(deps.config.POLL_MINUTES * 60_000 * 0.8, INGEST_DEADLINE_MAX_MS))
  const signal = AbortSignal.timeout(deadlineMs)

  // Hosts still cooling down after a 429 in an earlier cycle.
  const skipHosts = new Map<string, string>()
  for (const host of new Set(deps.sources.map((s) => hostOf(s.id)))) {
    const until = await deps.store.getMeta(`backoff:${host}`)
    if (until && Date.parse(until) > now.getTime()) skipHosts.set(host, `พักการดึงหลังโดนจำกัดอัตรา ถึง ${until}`)
  }

  let stored = 0
  await fetchPolitely(
    deps.sources,
    (s) => s.fetch({ fetch: deps.fetch, now, timeoutMs: deps.config.FETCH_TIMEOUT_MS, signal }),
    {
      skipHosts,
      onSettled: async (src, res) => {
        const attemptAt = new Date().toISOString()
        const prev = healthBefore.get(src.id)
        if (res.status === 'fulfilled') {
          try {
            const inserted = await storeSourceResult(deps.store, res.value)
            stored++
            await deps.store.setSourceHealth({
              source: src.id,
              ok: true,
              lastAttemptAt: attemptAt,
              lastSuccessAt: attemptAt,
              error: res.value.warnings.length ? `บางส่วนล้มเหลว: ${res.value.warnings.slice(0, 3).join('; ')}` : null,
              stationCount: res.value.stations.length,
              latestObservationAt: latestObservation(res.value) ?? prev?.latestObservationAt ?? null,
            })
            report.results.push({
              source: src.id,
              ok: true,
              stations: res.value.stations.length,
              readings: res.value.readings.length,
              inserted,
              warnings: res.value.warnings,
            })
            deps.log?.(`[ingest] ${src.id}: ${res.value.stations.length} stations, ${inserted} new readings`)
            return
          } catch (err) {
            res = { status: 'rejected', reason: new Error(`store failed: ${errorText(err)}`) }
          }
        }
        const error = errorText(res.reason)
        if (isHostRefusal(res.reason) === 429) {
          await deps.store.setMeta(`backoff:${hostOf(src.id)}`, new Date(now.getTime() + RATE_LIMIT_BACKOFF_MIN * 60_000).toISOString())
        }
        await deps.store.setSourceHealth({
          source: src.id,
          ok: false,
          lastAttemptAt: attemptAt,
          lastSuccessAt: prev?.lastSuccessAt ?? null,
          error:
            src.thaiIpOnly && /timeout|ECONNRESET|ETIMEDOUT|fetch failed|403/i.test(error)
              ? `${error} (แหล่งข้อมูลนี้รับเฉพาะ IP ในประเทศไทย)`
              : error,
          stationCount: prev?.stationCount ?? 0,
          latestObservationAt: prev?.latestObservationAt ?? null,
        })
        report.results.push({ source: src.id, ok: false, stations: 0, readings: 0, inserted: 0, error, warnings: [] })
        deps.log?.(`[ingest] ${src.id} FAILED: ${error}`)
      },
    },
  )
  // lastIngestAt means "fresh data arrived", so the stale banner fires when every source fails.
  if (stored > 0) await deps.store.setMeta(META_LAST_INGEST, now.toISOString())
  await deps.store.setMeta(META_LAST_INGEST_ATTEMPT, now.toISOString())
  return report
}

export function placeToSnapshotPlace(place: Place): SnapshotPlace {
  return {
    label: place.label,
    lat: place.lat,
    lng: place.lng,
    radiusKm: place.radiusKm,
    maxStations: place.maxStations,
    freeboard: place.freeboard,
    rain: place.rain,
    rapidRiseCm: place.rapidRiseCm,
  }
}

export function dashboardUrl(config: AppConfig, place: Place): string | undefined {
  if (!config.PUBLIC_BASE_URL) return undefined
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/?place=${encodeURIComponent(place.id)}`
}

/** Deliver one event to every verified channel of its place. Removes channels reported gone. */
export async function deliverEvent(deps: CycleDeps, place: Place, event: AlertEvent): Promise<AlertEvent> {
  const channels = (await deps.store.listChannels(place.id)).filter((c) => c.verified)
  const msg: NotifyMessage = {
    title: event.title,
    body: event.body,
    level: event.level,
    url: dashboardUrl(deps.config, place),
    tag: `place-${place.id}`,
  }
  const deliveries: NonNullable<AlertEvent['deliveries']> = []
  for (const ch of channels) {
    const sender = deps.senders.find((s) => s.type === ch.type)
    if (!sender || !sender.isConfigured(deps.config)) {
      deliveries.push({ channelId: ch.id, type: ch.type, ok: false, error: 'channel not configured on server' })
      continue
    }
    try {
      const res = await sender.send(ch, msg, { config: deps.config, fetch: deps.fetch })
      deliveries.push({ channelId: ch.id, type: ch.type, ok: res.ok, error: res.error ?? null })
      if (res.gone) {
        await deps.store.deleteChannel(ch.id)
        deps.log?.(`[notify] removed gone ${ch.type} channel ${ch.id}`)
      }
    } catch (err) {
      deliveries.push({ channelId: ch.id, type: ch.type, ok: false, error: errorText(err) })
    }
  }
  return { ...event, deliveries }
}

/** Lease name/TTL that makes alert evaluation single-flight across processes. */
export const ALERTS_LOCK = 'alerts'
export const ALERTS_LOCK_TTL_MS = 5 * 60_000
/** When every channel of a place fails, re-raise the same findings this many more cycles. */
export const MAX_DELIVERY_RETRIES = 3

/** Fallback when the store's lease is unavailable (e.g. the Supabase locks migration was not run). */
let localAlertsBusy = false

async function acquireAlertsLease(deps: CycleDeps, owner: string): Promise<'store' | 'local' | null> {
  try {
    return (await deps.store.tryLock(ALERTS_LOCK, owner, ALERTS_LOCK_TTL_MS)) ? 'store' : null
  } catch (err) {
    // Fail open: a broken lease may cost a duplicate message across processes, never every alert.
    deps.log?.(`[alerts] WARNING alerts lease unavailable (${errorText(err)}); using an in-process lock. Run every file in supabase/migrations.`)
    if (localAlertsBusy) return null
    localAlertsBusy = true
    return 'local'
  }
}

/**
 * Fingerprint of the place settings that alert states depend on. States saved under other
 * settings (e.g. by a cycle that raced a PATCH of location or thresholds) count as absent.
 */
export function alertSettingsKey(p: Place): string {
  const parts = [p.lat, p.lng, p.radiusKm, p.maxStations, p.rapidRiseCm, p.notifyMinLevel,
    p.freeboard.watch, p.freeboard.warning, p.freeboard.critical, p.rain.watch, p.rain.warning, p.rain.critical]
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16)
}

/** Evaluate alert rules for every watched place and dispatch notifications. */
export async function runAlerts(deps: CycleDeps): Promise<AlertReport> {
  const now = deps.now?.() ?? new Date()
  const places = await deps.store.listPlaces()
  const report: AlertReport = { places: places.length, events: [] }
  if (places.length === 0) return report

  // Embedded worker, relay ingest and cron can overlap: only one may evaluate and send.
  const owner = `${process.pid}:${crypto.randomUUID()}`
  const lease = await acquireAlertsLease(deps, owner)
  if (!lease) {
    deps.log?.('[alerts] skipped: another process is evaluating alerts')
    return { ...report, skipped: true }
  }
  try {
    const latest = await deps.store.latest()
    const sinceIso = new Date(now.getTime() - TREND_WINDOW_MIN * 60_000).toISOString()

    for (const place of places) {
      try {
        const sp = placeToSnapshotPlace(place)
        const ids = nearestWaterStationIds(latest, sp, now)
        const history = await deps.store.history(ids, sinceIso)
        const snap = buildSnapshot({
          place: sp,
          latest,
          history,
          weather: null,
          radar: [],
          sources: [],
          lastIngestAt: null,
          pollMinutes: deps.config.POLL_MINUTES,
          staleMinutes: deps.config.STALE_MINUTES,
          now,
        })
        const fp = alertSettingsKey(place)
        // States without a fingerprint predate it: keep them so a deploy does not re-alert everyone.
        const prev = (await deps.store.getAlertStates(place.id)).filter((st) => st.settings === undefined || st.settings === fp)
        const out = evaluateAlerts({
          place,
          water: snap.water,
          roadFlood: snap.roadFlood,
          rainMax24h: snap.rainMax24h,
          rain: snap.rain,
          prev,
          now,
          dashboardUrl: dashboardUrl(deps.config, place),
        })
        let statesToSave = out.states
        if (out.event) {
          const event: AlertEvent = { ...out.event, id: crypto.randomUUID() }
          const delivered = await deliverEvent(deps, place, event)
          await deps.store.appendAlertEvent(delivered)
          const attempted = delivered.deliveries?.length ?? 0
          const ok = delivered.deliveries?.filter((d) => d.ok).length ?? 0
          report.events.push({ placeId: place.id, title: event.title, delivered: ok, failed: attempted - ok })
          deps.log?.(`[alerts] ${place.label}: ${event.title} → ${ok}/${attempted} delivered`)

          // Every channel failed (provider outage, network): keep the previous state for the
          // keys in this message so the next cycle raises it again, a few times at most.
          const retryKey = `alertRetry:${place.id}`
          const retries = Number((await deps.store.getMeta(retryKey)) ?? 0) || 0
          if (attempted > 0 && ok === 0 && retries < MAX_DELIVERY_RETRIES) {
            const findingKeys = new Set(out.findings.map((f) => f.key))
            statesToSave = out.states.filter((st) => !findingKeys.has(st.key))
            await deps.store.setMeta(retryKey, String(retries + 1))
            deps.log?.(`[alerts] ${place.label}: delivery failed on every channel, will retry (${retries + 1}/${MAX_DELIVERY_RETRIES})`)
          } else if (retries > 0) {
            await deps.store.setMeta(retryKey, '0')
          }
        }
        // Save states after delivery so a crash mid-send re-evaluates next cycle.
        await deps.store.setAlertStates(statesToSave.map((st) => ({ ...st, settings: fp })))
      } catch (err) {
        deps.log?.(`[alerts] place ${place.id} failed: ${errorText(err)}`)
      }
    }
    await deps.store.setMeta(META_LAST_ALERTS, now.toISOString())
    return report
  } finally {
    if (lease === 'local') localAlertsBusy = false
    else await deps.store.unlock(ALERTS_LOCK, owner).catch(() => undefined)
  }
}

/** One full poll: ingest → alerts → prune old readings. */
export async function runCycle(deps: CycleDeps): Promise<{ ingest: IngestReport; alerts: AlertReport; pruned: number }> {
  const ingest = await runIngest(deps)
  const alerts = await runAlerts(deps)
  const now = deps.now?.() ?? new Date()
  const pruned = await deps.store.pruneReadings(new Date(now.getTime() - deps.config.HISTORY_HOURS * 3_600_000).toISOString())
  return { ingest, alerts, pruned }
}
