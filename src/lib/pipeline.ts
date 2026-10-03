import type { AppConfig } from './config'
import { evaluateAlerts } from './engine/alerts'
import { buildSnapshot, nearestWaterStationIds, type SnapshotPlace } from './engine/snapshot'
import type { ChannelSender, NotifyMessage } from './notify/types'
import { SOURCE_PRIORITY } from './sources'
import type { SourceAdapter } from './sources/types'
import type { Store } from './store/types'
import type { AlertEvent, Place, SourceFetchResult, SourceHealth } from './types'

export interface CycleDeps {
  store: Store
  config: AppConfig
  sources: SourceAdapter[]
  senders: ChannelSender[]
  fetch: typeof fetch
  now?: () => Date
  log?: (msg: string) => void
}

export interface IngestReport {
  results: { source: string; ok: boolean; stations: number; readings: number; inserted: number; error?: string; warnings: string[] }[]
}

export interface AlertReport {
  places: number
  events: { placeId: string; title: string; delivered: number; failed: number }[]
}

export const META_LAST_INGEST = 'lastIngestAt'
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
  const existing = new Map((await store.listStations()).map((s) => [s.id, s]))
  const incomingPriority = SOURCE_PRIORITY[result.source] ?? 0
  const upserts = result.stations.filter((s) => {
    const prev = existing.get(s.id)
    return !prev || (SOURCE_PRIORITY[prev.source] ?? 0) <= incomingPriority
  })
  await store.upsertStations(upserts)
  return store.insertReadings(result.readings)
}

function latestObservation(result: SourceFetchResult): string | null {
  let max: string | null = null
  for (const r of result.readings) if (!max || r.observedAt > max) max = r.observedAt
  return max
}

/**
 * Run fetches so that sources on the same upstream host go one after another (BMA's WAF bans
 * bursts), while different hosts proceed in parallel. Results keep the input order.
 */
export async function fetchPolitely<S extends { id: string }, T>(
  sources: S[],
  run: (s: S) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(sources.length)
  const groups = new Map<string, number[]>()
  sources.forEach((s, i) => {
    const host = s.id.split('-')[0]!
    groups.set(host, [...(groups.get(host) ?? []), i])
  })
  await Promise.all(
    [...groups.values()].map(async (idxs) => {
      for (const i of idxs) {
        try {
          out[i] = { status: 'fulfilled', value: await run(sources[i]!) }
        } catch (reason) {
          out[i] = { status: 'rejected', reason }
        }
      }
    }),
  )
  return out
}

/** Fetch every enabled source, store stations/readings and record per-source health. */
export async function runIngest(deps: CycleDeps): Promise<IngestReport> {
  const now = deps.now?.() ?? new Date()
  const report: IngestReport = { results: [] }
  const settled = await fetchPolitely(deps.sources, (s) =>
    s.fetch({ fetch: deps.fetch, now, timeoutMs: deps.config.FETCH_TIMEOUT_MS }),
  )
  const healthBefore = new Map((await deps.store.listSourceHealth()).map((h) => [h.source, h]))
  for (let i = 0; i < deps.sources.length; i++) {
    const src = deps.sources[i]!
    const res = settled[i]!
    const attemptAt = new Date().toISOString()
    if (res.status === 'fulfilled') {
      let inserted = 0
      try {
        inserted = await storeSourceResult(deps.store, res.value)
      } catch (err) {
        deps.log?.(`[ingest] ${src.id} store failed: ${errorText(err)}`)
      }
      const health: SourceHealth = {
        source: src.id,
        ok: true,
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        error: null,
        stationCount: res.value.stations.length,
        latestObservationAt: latestObservation(res.value),
      }
      await deps.store.setSourceHealth(health)
      report.results.push({
        source: src.id,
        ok: true,
        stations: res.value.stations.length,
        readings: res.value.readings.length,
        inserted,
        warnings: res.value.warnings,
      })
      deps.log?.(`[ingest] ${src.id}: ${res.value.stations.length} stations, ${inserted} new readings`)
    } else {
      const prev = healthBefore.get(src.id)
      const error = errorText(res.reason)
      await deps.store.setSourceHealth({
        source: src.id,
        ok: false,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        error: src.thaiIpOnly && /timeout|ECONNRESET|ETIMEDOUT|fetch failed|403/i.test(error)
          ? `${error} (แหล่งข้อมูลนี้รับเฉพาะ IP ในประเทศไทย)`
          : error,
        stationCount: prev?.stationCount ?? 0,
        latestObservationAt: prev?.latestObservationAt ?? null,
      })
      report.results.push({ source: src.id, ok: false, stations: 0, readings: 0, inserted: 0, error, warnings: [] })
      deps.log?.(`[ingest] ${src.id} FAILED: ${error}`)
    }
  }
  await deps.store.setMeta(META_LAST_INGEST, now.toISOString())
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

/** Evaluate alert rules for every watched place and dispatch notifications. */
export async function runAlerts(deps: CycleDeps): Promise<AlertReport> {
  const now = deps.now?.() ?? new Date()
  const places = await deps.store.listPlaces()
  const report: AlertReport = { places: places.length, events: [] }
  if (places.length === 0) return report

  const latest = await deps.store.latest()
  const sinceIso = new Date(now.getTime() - TREND_WINDOW_MIN * 60_000).toISOString()

  for (const place of places) {
    try {
      const sp = placeToSnapshotPlace(place)
      const ids = nearestWaterStationIds(latest, sp)
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
      const prev = await deps.store.getAlertStates(place.id)
      const out = evaluateAlerts({
        place,
        water: snap.water,
        roadFlood: snap.roadFlood,
        rainMax24h: snap.rainMax24h,
        prev,
        now,
        dashboardUrl: dashboardUrl(deps.config, place),
      })
      if (out.event) {
        const event: AlertEvent = { ...out.event, id: crypto.randomUUID() }
        const delivered = await deliverEvent(deps, place, event)
        await deps.store.appendAlertEvent(delivered)
        const ok = delivered.deliveries?.filter((d) => d.ok).length ?? 0
        report.events.push({
          placeId: place.id,
          title: event.title,
          delivered: ok,
          failed: (delivered.deliveries?.length ?? 0) - ok,
        })
        deps.log?.(`[alerts] ${place.label}: ${event.title} → ${ok} delivered`)
      }
      // Save states after delivery so a crash mid-send re-evaluates next cycle.
      await deps.store.setAlertStates(out.states)
    } catch (err) {
      deps.log?.(`[alerts] place ${place.id} failed: ${errorText(err)}`)
    }
  }
  await deps.store.setMeta(META_LAST_ALERTS, now.toISOString())
  return report
}

/** One full poll: ingest → alerts → prune old readings. */
export async function runCycle(deps: CycleDeps): Promise<{ ingest: IngestReport; alerts: AlertReport; pruned: number }> {
  const ingest = await runIngest(deps)
  const alerts = await runAlerts(deps)
  const now = deps.now?.() ?? new Date()
  const pruned = await deps.store.pruneReadings(new Date(now.getTime() - deps.config.HISTORY_HOURS * 3_600_000).toISOString())
  return { ingest, alerts, pruned }
}
