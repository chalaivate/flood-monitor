import type { AppConfig } from '../config'
import { buildSnapshot, nearestWaterStationIds, type SnapshotPlace } from '../engine/snapshot'
import { META_LAST_INGEST, dashboardUrl, placeToSnapshotPlace } from '../pipeline'
import { radarImages } from '../radar'
import type { Store } from '../store/types'
import { formatShortBkk } from '../time'
import type { DashboardSnapshot, Place } from '../types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN, LEVEL_LABEL_TH } from '../types'
import { PLACE_DEFAULTS } from './validation'
import { cachedWeather } from './weather-cache'

// Snapshot assembly shared by /api/snapshot and the chat bots' "สถานะ" replies.

/** History window used for trends (needs ≥ 60 min plus slack). */
export const SNAPSHOT_HISTORY_MIN = 120

export function adHocPlace(
  config: AppConfig,
  q: { lat?: number; lng?: number; label?: string | null; radiusKm?: number; maxStations?: number },
): SnapshotPlace {
  return {
    label: q.label?.trim() || (q.lat === undefined ? config.DEFAULT_LABEL : 'ตำแหน่งที่เลือก'),
    lat: q.lat ?? config.DEFAULT_LAT,
    lng: q.lng ?? config.DEFAULT_LNG,
    radiusKm: q.radiusKm ?? PLACE_DEFAULTS.radiusKm,
    maxStations: q.maxStations ?? PLACE_DEFAULTS.maxStations,
    freeboard: { ...DEFAULT_FREEBOARD },
    rain: { ...DEFAULT_RAIN },
    rapidRiseCm: PLACE_DEFAULTS.rapidRiseCm,
  }
}

export interface LoadSnapshotOptions {
  now?: Date
  fetch?: typeof fetch
  /** Skip the weather call (chat replies). */
  weather?: boolean
}

export async function loadSnapshot(
  store: Store,
  config: AppConfig,
  place: SnapshotPlace,
  opts: LoadSnapshotOptions = {},
): Promise<DashboardSnapshot> {
  const now = opts.now ?? new Date()
  const latest = await store.latest()
  const ids = nearestWaterStationIds(latest, place, now)
  const since = new Date(now.getTime() - SNAPSHOT_HISTORY_MIN * 60_000).toISOString()
  const [history, weather, sources, lastIngestAt] = await Promise.all([
    store.history(ids, since),
    opts.weather === false ? Promise.resolve(null) : cachedWeather(place.lat, place.lng, { fetch: opts.fetch }),
    store.listSourceHealth(),
    store.getMeta(META_LAST_INGEST),
  ])
  return buildSnapshot({
    place,
    latest,
    history,
    weather,
    radar: radarImages(),
    sources,
    lastIngestAt,
    pollMinutes: config.POLL_MINUTES,
    staleMinutes: config.STALE_MINUTES,
    now,
  })
}

/** Plain-text situation summary for LINE / Telegram ("สถานะ"). */
export function situationText(place: Place, snap: DashboardSnapshot, config: AppConfig, maxLines = 6): string {
  const out = [`สถานการณ์ล่าสุด: ${place.label}`, `ระดับ: ${snap.overall.headline || LEVEL_LABEL_TH[snap.overall.level]}`]
  const lines = snap.overall.lines.slice(0, maxLines)
  for (const l of lines) out.push(`• ${l.text}`)
  if (snap.overall.lines.length > lines.length) out.push(`• และอีก ${snap.overall.lines.length - lines.length} รายการ`)
  out.push(`ข้อมูลล่าสุด ${formatShortBkk(snap.lastIngestAt)} น.`)
  const url = dashboardUrl(config, place)
  if (url) out.push(url)
  return out.join('\n')
}

/** Status replies for every place linked to a chat target. */
export async function statusForTargets(
  store: Store,
  config: AppConfig,
  places: Place[],
  opts: LoadSnapshotOptions = {},
): Promise<string[]> {
  const texts: string[] = []
  for (const place of places) {
    const snap = await loadSnapshot(store, config, placeToSnapshotPlace(place), { ...opts, weather: false })
    texts.push(situationText(place, snap, config))
  }
  return texts
}
