import type {
  DashboardSnapshot,
  FreeboardThresholds,
  Level,
  RadarImage,
  RainThresholds,
  Reading,
  SituationLine,
  SourceHealth,
  StationStatus,
  WeatherNow,
} from '../types'
import { LEVEL_LABEL_TH, LEVEL_ORDER } from '../types'
import { nearest } from '../geo'
import type { LatestRow } from '../store/types'
import { d1, distanceTh, waterLineTh } from './format'
import { maxLevel, rainClassTh, stationStatus } from './status'

export interface SnapshotPlace {
  label: string
  lat: number
  lng: number
  radiusKm: number
  maxStations: number
  freeboard: FreeboardThresholds
  rain: RainThresholds
  rapidRiseCm: number
}

export interface SnapshotInput {
  place: SnapshotPlace
  latest: LatestRow[]
  /** Ascending history for water stations (for trends); keyed by station id. */
  history: Record<string, Reading[]>
  weather: WeatherNow | null
  radar: RadarImage[]
  sources: SourceHealth[]
  lastIngestAt: string | null
  pollMinutes: number
  staleMinutes: number
  now: Date
}

/** How many rain gauges contribute to the "max of nearest" rain figure. */
export const RAIN_NEAREST_N = 3
/** Rain gauges further than this are ignored even if the place radius is larger. */
export const RAIN_MAX_KM = 15
export const ROAD_FLOOD_MAX = 5

/** Stations whose readings we need history for (nearest water stations of a place). */
export function nearestWaterStationIds(latest: LatestRow[], place: SnapshotPlace): string[] {
  return nearest(
    latest.filter((r) => r.station.kind === 'canal' || r.station.kind === 'river'),
    (r) => r.station,
    place,
    { radiusKm: place.radiusKm, limit: place.maxStations },
  ).map((n) => n.item.station.id)
}

export function buildSnapshot(input: SnapshotInput): DashboardSnapshot {
  const { place, now } = input
  const opts = { now, staleMinutes: input.staleMinutes, freeboard: place.freeboard, rain: place.rain }

  const pick = (kinds: string[], radiusKm: number, limit: number) =>
    nearest(
      input.latest.filter((r) => kinds.includes(r.station.kind)),
      (r) => r.station,
      place,
      { radiusKm, limit },
    )

  const water: StationStatus[] = pick(['canal', 'river'], place.radiusKm, place.maxStations).map(({ item, distanceKm }) =>
    stationStatus(item.station, item.reading, { ...opts, history: input.history[item.station.id], distanceKm }),
  )

  const rain: StationStatus[] = pick(['rain'], Math.max(place.radiusKm, RAIN_MAX_KM), RAIN_NEAREST_N).map(
    ({ item, distanceKm }) => stationStatus(item.station, item.reading, { ...opts, distanceKm }),
  )

  const roadFlood: StationStatus[] = pick(['roadflood'], place.radiusKm, ROAD_FLOOD_MAX).map(({ item, distanceKm }) =>
    stationStatus(item.station, item.reading, { ...opts, distanceKm }),
  )

  let rainMax24h: DashboardSnapshot['rainMax24h'] = null
  for (const r of rain) {
    const mm = r.reading?.rain24h
    if (r.stale || mm === null || mm === undefined || !Number.isFinite(mm)) continue
    if (!rainMax24h || mm > rainMax24h.valueMm) {
      rainMax24h = { valueMm: mm, station: r.station, distanceKm: r.distanceKm ?? 0, level: r.level }
    }
  }

  const lines: SituationLine[] = []
  for (const w of water) lines.push({ level: w.level, text: waterLineTh(w, now), stationId: w.station.id })
  for (const f of roadFlood) {
    const cm = f.reading?.roadFloodCm
    if (f.stale || cm === null || cm === undefined || cm <= 0) continue
    lines.push({
      level: f.level,
      text: `น้ำท่วมถนน ${f.station.name}: ${Math.round(cm)} ซม. (${distanceTh(f.distanceKm)})`,
      stationId: f.station.id,
    })
  }
  if (rainMax24h) {
    lines.push({
      level: rainMax24h.level,
      text: `ฝน 24 ชม. (สูงสุดใน ${rain.length} สถานีรอบบ้าน): ${d1(rainMax24h.valueMm)} มม. (${rainClassTh(rainMax24h.valueMm)}) ที่ ${rainMax24h.station.name} (${distanceTh(rainMax24h.distanceKm)})`,
      stationId: rainMax24h.station.id,
    })
  }

  const contributing: Level[] = [
    ...water.map((w) => w.level),
    ...roadFlood.map((f) => f.level),
    ...(rainMax24h ? [rainMax24h.level] : []),
  ]
  const level = maxLevel(contributing)
  const headline = headlineTh(level, water, roadFlood, rainMax24h)

  lines.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level])

  return {
    generatedAt: now.toISOString(),
    place: {
      label: place.label,
      lat: place.lat,
      lng: place.lng,
      radiusKm: place.radiusKm,
      maxStations: place.maxStations,
      freeboard: place.freeboard,
      rain: place.rain,
      rapidRiseCm: place.rapidRiseCm,
    },
    overall: { level, headline, lines },
    water,
    rain,
    rainMax24h,
    roadFlood,
    weather: input.weather,
    radar: input.radar,
    sources: input.sources,
    lastIngestAt: input.lastIngestAt,
    pollMinutes: input.pollMinutes,
  }
}

function headlineTh(
  level: Level,
  water: StationStatus[],
  roadFlood: StationStatus[],
  rainMax: DashboardSnapshot['rainMax24h'],
): string {
  if (level === 'unknown') {
    return water.length === 0 ? 'ไม่พบจุดวัดระดับน้ำในรัศมีที่กำหนด' : 'ไม่มีข้อมูลล่าสุดจากจุดวัดรอบบ้าน'
  }
  if (level === 'normal') return LEVEL_LABEL_TH.normal
  const parts: string[] = []
  const nearBank = water.filter((w) => LEVEL_ORDER[w.level] >= LEVEL_ORDER.watch).length
  if (nearBank > 0) parts.push(`น้ำใกล้ตลิ่ง ${nearBank} จุด`)
  const roads = roadFlood.filter((f) => LEVEL_ORDER[f.level] >= LEVEL_ORDER.watch).length
  if (roads > 0) parts.push(`น้ำท่วมถนน ${roads} จุด`)
  if (rainMax && LEVEL_ORDER[rainMax.level] >= LEVEL_ORDER.watch) parts.push(rainClassTh(rainMax.valueMm))
  return parts.length ? `${LEVEL_LABEL_TH[level]} — ${parts.join(' · ')}` : LEVEL_LABEL_TH[level]
}
