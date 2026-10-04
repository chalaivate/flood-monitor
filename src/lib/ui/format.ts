import type { SourceHealth, Station, StationStatus } from '../types'
import { trendTh } from '../engine/format'
import { formatAgeTh, minutesBetween } from '../time'

export type TrendDir = 'up' | 'down' | 'flat'

/** Water-level trend for display. Rising water means freeboard is shrinking. */
export function trendInfo(cmPerHour: number | null | undefined): { dir: TrendDir; text: string } | null {
  const text = trendTh(cmPerHour)
  if (!text || cmPerHour === null || cmPerHour === undefined) return null
  if (Math.abs(cmPerHour) < 1) return { dir: 'flat', text }
  return { dir: cmPerHour > 0 ? 'up' : 'down', text }
}

/** "ห่างตลิ่ง 1.19 ม." / "สูงกว่าตลิ่ง 0.05 ม." / "" */
export function freeboardTh(fb: number | null | undefined): string {
  if (fb === null || fb === undefined || !Number.isFinite(fb)) return ''
  return fb < 0 ? `สูงกว่าตลิ่ง ${(-fb).toFixed(2)} ม.` : `ห่างตลิ่ง ${fb.toFixed(2)} ม.`
}

export function ageTh(iso: string | null | undefined, nowMs: number): string {
  return formatAgeTh(iso, new Date(nowMs))
}

/** Short station label for gauges: shortName, else the name without the "ปตร." prefix. */
export function stationShort(s: Pick<Station, 'name' | 'shortName'>): string {
  if (s.shortName && s.shortName.trim()) return s.shortName.trim()
  return s.name.replace(/^ปตร\.\s*/, '').trim()
}

/** The ingest worker missed at least three polls. */
export function isIngestStale(lastIngestAt: string | null | undefined, pollMinutes: number, nowMs: number): boolean {
  if (!lastIngestAt) return true
  const mins = minutesBetween(lastIngestAt, new Date(nowMs))
  return !Number.isFinite(mins) || mins > 3 * Math.max(1, pollMinutes)
}

/** Sources whose newest observation is older than this answer "200 OK" but deliver frozen data. */
export const SOURCE_FROZEN_MIN = 180

/**
 * Sources that answered but whose newest observation is older than SOURCE_FROZEN_MIN
 * (e.g. a mirror stuck on an old snapshot). Failed sources are covered by the ingest banner.
 */
export function frozenSources(sources: SourceHealth[], nowMs: number): { source: SourceHealth; minutes: number }[] {
  const out: { source: SourceHealth; minutes: number }[] = []
  for (const h of sources) {
    if (!h.latestObservationAt) continue
    const minutes = minutesBetween(h.latestObservationAt, new Date(nowMs))
    if (Number.isFinite(minutes) && minutes > SOURCE_FROZEN_MIN) out.push({ source: h, minutes })
  }
  return out
}

/** Newest observedAt across the snapshot's water stations (ISO) or null. */
export function newestObservation(list: StationStatus[]): string | null {
  let best: string | null = null
  for (const s of list) {
    const t = s.reading?.observedAt
    if (t && (!best || Date.parse(t) > Date.parse(best))) best = t
  }
  return best
}

/** "1 ชม. 20 นาที" style duration for banners. */
export function durationTh(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'ไม่ถึง 1 นาที'
  const m = Math.round(minutes)
  if (m < 60) return `${m} นาที`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} ชม. ${m % 60} นาที` : `${h} ชม.`
  return `${Math.round(h / 24)} วัน`
}

/** "13.72000, 100.70000" */
export function coordsTh(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
}
