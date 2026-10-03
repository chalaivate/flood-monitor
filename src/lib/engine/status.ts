import type {
  FreeboardThresholds,
  Level,
  RainThresholds,
  Reading,
  Station,
  StationStatus,
} from '../types'
import { LEVEL_ORDER } from '../types'
import { isStale } from '../time'

/** Road flood depth thresholds in cm (water on the road surface). */
export const ROAD_FLOOD_CM = { watch: 5, warning: 15, critical: 30 } as const

export function maxLevel(levels: Level[]): Level {
  let best: Level = 'unknown'
  for (const l of levels) if (LEVEL_ORDER[l] > LEVEL_ORDER[best]) best = l
  return best
}

export function compareLevel(a: Level, b: Level): number {
  return LEVEL_ORDER[a] - LEVEL_ORDER[b]
}

/** Smaller freeboard (water closer to the bank) ⇒ higher severity. */
export function freeboardLevel(freeboard: number | null | undefined, t: FreeboardThresholds): Level {
  if (freeboard === null || freeboard === undefined || !Number.isFinite(freeboard)) return 'unknown'
  if (freeboard < t.critical) return 'critical'
  if (freeboard < t.warning) return 'warning'
  if (freeboard < t.watch) return 'watch'
  return 'normal'
}

/** Freeboard (m) at which a level starts; used for hysteresis when stepping down. */
export function freeboardThresholdFor(level: Level, t: FreeboardThresholds): number | null {
  if (level === 'critical') return t.critical
  if (level === 'warning') return t.warning
  if (level === 'watch') return t.watch
  return null
}

export function rainLevel(mm: number | null | undefined, t: RainThresholds): Level {
  if (mm === null || mm === undefined || !Number.isFinite(mm) || mm < 0) return 'unknown'
  if (mm >= t.critical) return 'critical'
  if (mm >= t.warning) return 'warning'
  if (mm >= t.watch) return 'watch'
  return 'normal'
}

export function roadFloodLevel(cm: number | null | undefined): Level {
  if (cm === null || cm === undefined || !Number.isFinite(cm) || cm < 0) return 'unknown'
  if (cm >= ROAD_FLOOD_CM.critical) return 'critical'
  if (cm >= ROAD_FLOOD_CM.warning) return 'warning'
  if (cm >= ROAD_FLOOD_CM.watch) return 'watch'
  return 'normal'
}

/** TMD 24h rainfall class (Thai label). */
export function rainClassTh(mm: number | null | undefined): string {
  if (mm === null || mm === undefined || !Number.isFinite(mm)) return 'ไม่มีข้อมูล'
  if (mm < 0.1) return 'ไม่มีฝน'
  if (mm <= 10) return 'ฝนเล็กน้อย'
  if (mm <= 35) return 'ฝนปานกลาง'
  if (mm <= 90) return 'ฝนหนัก'
  return 'ฝนหนักมาก'
}

/**
 * Water-level change in cm over roughly the last hour, from ascending history.
 * Uses the reading closest to (latest − 60 min) within a 40–100 minute window,
 * normalised to cm per hour. Returns null when there is not enough history.
 */
export function trendCmPerHour(history: Reading[]): number | null {
  const pts = history
    .filter((r) => typeof r.waterLevel === 'number' && Number.isFinite(r.waterLevel))
    .map((r) => ({ t: Date.parse(r.observedAt), v: r.waterLevel as number }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  const last = pts[pts.length - 1]
  if (!last) return null
  const target = last.t - 60 * 60_000
  let best: { t: number; v: number } | null = null
  for (const p of pts) {
    const ageMin = (last.t - p.t) / 60_000
    if (ageMin < 40 || ageMin > 100) continue
    if (!best || Math.abs(p.t - target) < Math.abs(best.t - target)) best = p
  }
  if (!best) return null
  const hours = (last.t - best.t) / 3_600_000
  const cm = ((last.v - best.v) * 100) / hours
  return Math.round(cm * 10) / 10
}

export interface StatusOptions {
  now: Date
  staleMinutes: number
  freeboard: FreeboardThresholds
  rain: RainThresholds
  /** Ascending history for trend calculation (optional). */
  history?: Reading[]
  distanceKm?: number | null
}

/** Compute the display/alert status of one station from its latest reading. */
export function stationStatus(station: Station, reading: Reading | null, opts: StatusOptions): StationStatus {
  const stale = !reading || isStale(reading.observedAt, opts.now, opts.staleMinutes)
  let level: Level = 'unknown'
  if (reading && !stale) {
    if (station.kind === 'rain') level = rainLevel(reading.rain24h, opts.rain)
    else if (station.kind === 'roadflood') level = roadFloodLevel(reading.roadFloodCm)
    else if (station.kind === 'pump') level = 'unknown'
    else {
      level = freeboardLevel(reading.freeboard, opts.freeboard)
      // A dubious bank height alone must not raise warning/critical.
      if (station.bankUncertain && LEVEL_ORDER[level] > LEVEL_ORDER.watch) level = 'watch'
    }
  }
  const trend =
    !stale && opts.history && (station.kind === 'canal' || station.kind === 'river')
      ? trendCmPerHour(opts.history)
      : null
  return {
    station,
    reading,
    level,
    stale,
    trendCmPerHour: trend,
    distanceKm: opts.distanceKm ?? null,
  }
}
