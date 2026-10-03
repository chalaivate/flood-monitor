import type { FreeboardThresholds, HistoryPoint } from '../types'

// Pure helpers for the hand-written SVG charts: scales, ticks, domains, paths,
// nearest-point lookup and the table-view bucketing. Bangkok is UTC+7 with no DST,
// so time ticks are aligned with a fixed offset.

export const BKK_OFFSET_MS = 7 * 3_600_000
const HOUR = 3_600_000

export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] }

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale
  f.domain = domain
  f.range = range
  return f
}

/** Step of 1, 2 or 5 × 10^k that yields roughly `count` intervals. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1
  const raw = span / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const m = raw / pow
  // Same error thresholds as d3-array's tickIncrement (√50, √10, √2).
  const nice = m >= 7.0710678 ? 10 : m >= 3.1622777 ? 5 : m >= 1.4142136 ? 2 : 1
  return Number((nice * pow).toPrecision(12))
}

/** Decimals needed to print every multiple of `step` exactly (0.2 → 1, 0.05 → 2, 5 → 0). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0
  for (let d = 0; d <= 6; d++) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d
  }
  return 6
}

function roundTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  return Number(v.toFixed(decimals))
}

/** Clean tick values covering [lo, hi] (inclusive), about `count` intervals. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi === lo) return [roundTo(lo, 0.01)]
  const step = niceStep(hi - lo, count)
  const start = Math.ceil(lo / step - 1e-9) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 1e-6; v += step) out.push(roundTo(v, step))
  return out
}

/** Expand [lo, hi] outward to multiples of a nice step. */
export function niceDomain(lo: number, hi: number, count = 5): [number, number] {
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi - lo < 1e-9) {
    lo -= 0.1
    hi += 0.1
  }
  const step = niceStep(hi - lo, count)
  return [roundTo(Math.floor(lo / step + 1e-9) * step, step), roundTo(Math.ceil(hi / step - 1e-9) * step, step)]
}

/**
 * Y domain for freeboard lines. Always includes the data and the "watch" threshold
 * (so the reader sees how far the water is from the first warning line); lower
 * thresholds join the domain only when the data come near them. Rounded to 0.1 m.
 */
export function freeboardDomain(values: number[], t: FreeboardThresholds): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return [Math.floor((t.critical - 0.1) * 10) / 10, Math.ceil((t.watch + 0.4) * 10) / 10]
  let lo = Math.min(...finite)
  let hi = Math.max(...finite)
  lo = Math.min(lo, t.watch)
  if (lo < t.warning + 0.1) lo = Math.min(lo, t.warning)
  if (lo < t.critical + 0.1) lo = Math.min(lo, t.critical)
  const pad = Math.max(0.02, (hi - lo) * 0.06)
  lo -= pad
  hi += pad
  return [Math.floor(lo * 10 + 1e-9) / 10, Math.ceil(hi * 10 - 1e-9) / 10]
}

export interface TimeTick {
  t: number
  /** "06:00" or, at Bangkok midnight, "3 ต.ค." */
  label: string
  /** true at Bangkok midnight (rendered stronger). */
  major: boolean
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** Bangkok wall-clock parts of an epoch-ms instant. */
export function bkkParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const d = new Date(ms + BKK_OFFSET_MS)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "03/10 11:35" (Bangkok). */
export function bkkShort(ms: number): string {
  const p = bkkParts(ms)
  return `${pad2(p.d)}/${pad2(p.mo + 1)} ${pad2(p.h)}:${pad2(p.mi)}`
}

/** "11:35" (Bangkok). */
export function bkkTime(ms: number): string {
  const p = bkkParts(ms)
  return `${pad2(p.h)}:${pad2(p.mi)}`
}

/** "3 ต.ค." (Bangkok). */
export function bkkDayMonth(ms: number): string {
  const p = bkkParts(ms)
  return `${p.d} ${TH_MONTHS[p.mo]}`
}

/** Ticks every `stepHours` aligned to Bangkok wall-clock (00, 06, 12, 18 for 6 h). */
export function timeTicks(t0: number, t1: number, stepHours = 6): TimeTick[] {
  if (!(t1 > t0)) return []
  const step = stepHours * HOUR
  const first = Math.ceil((t0 + BKK_OFFSET_MS) / step) * step - BKK_OFFSET_MS
  const out: TimeTick[] = []
  for (let t = first; t <= t1; t += step) {
    const p = bkkParts(t)
    const major = p.h === 0 && p.mi === 0
    out.push({ t, major, label: major ? bkkDayMonth(t) : `${pad2(p.h)}:${pad2(p.mi)}` })
  }
  return out
}

/** Pick a tick step so labels do not collide at a given plot width (≈ 56 px per label). */
export function timeTickStep(spanMs: number, widthPx: number): number {
  const hours = spanMs / HOUR
  const maxLabels = Math.max(2, Math.floor(widthPx / 56))
  for (const s of [1, 2, 3, 6, 12, 24, 48]) if (hours / s <= maxLabels) return s
  return 72
}

export interface XY {
  t: number
  v: number
}

/** Numeric, finite, time-sorted points for one field of a history series. */
export function seriesPoints(points: HistoryPoint[] | undefined, field: 'freeboard' | 'waterLevel' | 'rain24h' = 'freeboard'): XY[] {
  if (!points) return []
  const out: XY[] = []
  for (const p of points) {
    const v = p[field]
    const t = Date.parse(p.t)
    if (typeof v === 'number' && Number.isFinite(v) && Number.isFinite(t)) out.push({ t, v })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * SVG path for a line, broken into separate sub-paths where consecutive points are
 * further apart than `maxGapMs` (sensor outage) so we never draw invented data.
 */
export function linePath(points: XY[], x: (t: number) => number, y: (v: number) => number, maxGapMs = 90 * 60_000): string {
  let d = ''
  let prev: XY | null = null
  for (const p of points) {
    const cmd = !prev || p.t - prev.t > maxGapMs ? 'M' : 'L'
    d += `${cmd}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
    prev = p
  }
  return d
}

/** Index of the point whose time is nearest to `t` (binary search). -1 for empty input. */
export function nearestIndex(points: XY[], t: number): number {
  if (points.length === 0) return -1
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid]!.t < t) lo = mid
    else hi = mid
  }
  const a = points[lo]!
  const b = points[hi]!
  return Math.abs(a.t - t) <= Math.abs(b.t - t) ? lo : hi
}

/** Nearest point within `toleranceMs` of `t`, else null. */
export function valueAt(points: XY[], t: number, toleranceMs = 45 * 60_000): XY | null {
  const i = nearestIndex(points, t)
  if (i < 0) return null
  const p = points[i]!
  return Math.abs(p.t - t) <= toleranceMs ? p : null
}

/** Sorted union of all timestamps across series (for the crosshair snap). */
export function unionTimes(series: XY[][]): number[] {
  const set = new Set<number>()
  for (const s of series) for (const p of s) set.add(p.t)
  return [...set].sort((a, b) => a - b)
}

/**
 * Table-view rows: one row per Bangkok hour (newest first), taking the last value of
 * each series inside that hour. Hours where no series has data are skipped.
 */
export function hourlyRows(series: XY[][]): { t: number; values: (number | null)[] }[] {
  const buckets = new Map<number, (number | null)[]>()
  series.forEach((s, si) => {
    for (const p of s) {
      const hourStart = Math.floor(p.t / HOUR) * HOUR
      let row = buckets.get(hourStart)
      if (!row) {
        row = series.map(() => null)
        buckets.set(hourStart, row)
      }
      row[si] = p.v // ascending input ⇒ last write wins = latest in the hour
    }
  })
  return [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([t, values]) => ({ t, values }))
}
