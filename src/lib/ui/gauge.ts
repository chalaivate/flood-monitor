import type { FreeboardThresholds, Level, RainThresholds } from '../types'

// Pure math for the semicircular gauges (freeboard and 24 h rain). No React here so
// the segment layout is unit-testable.

export interface LevelSegment {
  from: number
  to: number
  level: Exclude<Level, 'unknown'>
}

export interface GaugeSpec {
  min: number
  max: number
  segments: LevelSegment[]
}

/** Lowest freeboard shown on the gauge (water 20 cm above the bank). */
export const FREEBOARD_GAUGE_MIN = -0.2
/** Default top of the freeboard gauge in metres. */
export const FREEBOARD_GAUGE_MAX = 1.5

function niceCeil(v: number, step: number): number {
  return Math.ceil(v / step - 1e-9) * step
}

/**
 * Freeboard gauge: low freeboard (danger) on the left, plenty of freeboard on the right.
 * Range is −0.2 m … max(1.5 m, value rounded up to 0.5 m).
 * Segments: critical [min, critical) · warning [critical, warning) · watch [warning, watch) · normal [watch, max].
 */
export function freeboardGauge(value: number | null | undefined, t: FreeboardThresholds): GaugeSpec {
  const min = FREEBOARD_GAUGE_MIN
  const v = typeof value === 'number' && Number.isFinite(value) ? value : null
  const max = v !== null && v > FREEBOARD_GAUGE_MAX ? niceCeil(v, 0.5) : FREEBOARD_GAUGE_MAX
  const clampT = (x: number) => Math.min(max, Math.max(min, x))
  const crit = clampT(t.critical)
  const warn = clampT(Math.max(t.warning, t.critical))
  const watch = clampT(Math.max(t.watch, t.warning, t.critical))
  const segments: LevelSegment[] = [
    { from: min, to: crit, level: 'critical' as const },
    { from: crit, to: warn, level: 'warning' as const },
    { from: warn, to: watch, level: 'watch' as const },
    { from: watch, to: max, level: 'normal' as const },
  ].filter((s) => s.to - s.from > 1e-9)
  return { min, max, segments }
}

/**
 * 24 h rain gauge: 0 mm on the left. Bands follow the TMD-based thresholds
 * (normal < watch ≤ warning ≤ critical). The range extends past `critical`
 * (default 150 → 180 mm) so the critical band is visible, and grows with extreme totals.
 */
export function rainGauge(valueMm: number | null | undefined, t: RainThresholds): GaugeSpec {
  const min = 0
  const v = typeof valueMm === 'number' && Number.isFinite(valueMm) ? valueMm : 0
  const max = Math.max(niceCeil(t.critical * 1.2, 10), v > t.critical * 1.2 ? niceCeil(v, 50) : 0)
  const segments: LevelSegment[] = [
    { from: 0, to: t.watch, level: 'normal' as const },
    { from: t.watch, to: t.warning, level: 'watch' as const },
    { from: t.warning, to: t.critical, level: 'warning' as const },
    { from: t.critical, to: max, level: 'critical' as const },
  ]
    .map((s) => ({ ...s, from: Math.max(min, s.from), to: Math.min(max, s.to) }))
    .filter((s) => s.to - s.from > 1e-9)
  return { min, max, segments }
}

/** Needle angle in degrees for a value: min → 180° (left), max → 0° (right), clamped. */
export function gaugeAngle(value: number, min: number, max: number): number {
  const span = max - min || 1
  const t = (Math.min(max, Math.max(min, value)) - min) / span
  return 180 - t * 180
}

/** "1.19 ม." / "-0.05 ม." (two decimals, metres). */
export function metresTh(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return `${v.toFixed(2)} ม.`
}
