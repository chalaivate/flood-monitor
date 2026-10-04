import { describe, expect, it } from 'vitest'
import {
  bkkShort,
  freeboardDomain,
  hourlyRows,
  linePath,
  linearScale,
  nearestIndex,
  niceDomain,
  niceStep,
  niceTicks,
  seriesPoints,
  stepDecimals,
  timeTicks,
  timeTickStep,
  unionTimes,
  valueAt,
} from '@/lib/ui/chart'
import { DEFAULT_FREEBOARD } from '@/lib/types'

const H = 3_600_000
const T0 = Date.parse('2026-10-01T04:35:00Z') // 11:35 Bangkok

describe('scales and ticks', () => {
  it('linearScale maps domain to range (inverted y works)', () => {
    const y = linearScale([0, 2], [200, 0])
    expect(y(0)).toBe(200)
    expect(y(1)).toBe(100)
    expect(y(2)).toBe(0)
  })
  it('niceStep picks 1/2/5 × 10^k', () => {
    expect(niceStep(1, 5)).toBe(0.2)
    expect(niceStep(1.3, 5)).toBe(0.2)
    expect(niceStep(0.4, 5)).toBe(0.1)
    expect(niceStep(150, 5)).toBe(20)
    expect(niceStep(200, 5)).toBe(50)
  })
  it('niceTicks covers the range with exact decimals', () => {
    expect(niceTicks(0.5, 1.2, 4)).toEqual([0.6, 0.8, 1, 1.2])
    expect(niceTicks(0.5, 1.2, 5)).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2])
    expect(niceTicks(-0.2, 1.5, 5)).toEqual([0, 0.5, 1, 1.5])
    expect(niceTicks(1, 1)).toEqual([1])
    expect(niceTicks(NaN, 1)).toEqual([])
  })
  it('stepDecimals gives label precision for a step', () => {
    expect(stepDecimals(0.2)).toBe(1)
    expect(stepDecimals(0.05)).toBe(2)
    expect(stepDecimals(0.25)).toBe(2)
    expect(stepDecimals(5)).toBe(0)
  })
  it('niceDomain rounds outward and pads a flat range', () => {
    expect(niceDomain(0.53, 1.18)).toEqual([0.5, 1.2])
    const [a, b] = niceDomain(1, 1)
    expect(a).toBeLessThan(1)
    expect(b).toBeGreaterThan(1)
  })
})

describe('freeboardDomain', () => {
  it('always includes the watch threshold', () => {
    const [lo, hi] = freeboardDomain([1.05, 1.19], DEFAULT_FREEBOARD)
    expect(lo).toBeLessThanOrEqual(0.6)
    expect(hi).toBeGreaterThanOrEqual(1.19)
  })
  it('includes lower thresholds only when the data approach them', () => {
    expect(freeboardDomain([0.8, 1.2], DEFAULT_FREEBOARD)[0]).toBeGreaterThan(0.3)
    expect(freeboardDomain([0.35, 0.9], DEFAULT_FREEBOARD)[0]).toBeLessThanOrEqual(0.3)
    expect(freeboardDomain([0.15, 0.9], DEFAULT_FREEBOARD)[0]).toBeLessThanOrEqual(0.1)
  })
  it('handles water above the bank and empty input', () => {
    expect(freeboardDomain([-0.12, 0.4], DEFAULT_FREEBOARD)[0]).toBeLessThan(-0.12)
    const [lo, hi] = freeboardDomain([], DEFAULT_FREEBOARD)
    expect(lo).toBeLessThan(hi)
  })
})

describe('time ticks (Bangkok)', () => {
  it('aligns to 00/06/12/18 Bangkok and labels midnight with the date', () => {
    const ticks = timeTicks(T0, T0 + 48 * H, 6)
    expect(ticks[0]!.label).toBe('12:00')
    const midnight = ticks.find((t) => t.major)!
    expect(midnight.label).toBe('2 ต.ค.')
    expect(new Date(midnight.t).toISOString()).toBe('2026-10-01T17:00:00.000Z')
    expect(ticks).toHaveLength(8)
  })
  it('picks a coarser step on narrow plots', () => {
    expect(timeTickStep(48 * H, 800)).toBe(6)
    expect(timeTickStep(48 * H, 300)).toBe(12)
    expect(timeTickStep(48 * H, 120)).toBe(24)
  })
  it('formats Bangkok short time', () => {
    expect(bkkShort(T0)).toBe('01/10 11:35')
  })
})

describe('series helpers', () => {
  const pts = seriesPoints([
    { t: new Date(T0 + 20 * 60_000).toISOString(), freeboard: 1.1 },
    { t: new Date(T0).toISOString(), freeboard: 1.0 },
    { t: 'garbage', freeboard: 2 },
    { t: new Date(T0 + 10 * 60_000).toISOString(), freeboard: null },
    { t: new Date(T0 + 4 * H).toISOString(), freeboard: 1.3 },
  ])
  it('keeps finite points sorted by time', () => {
    expect(pts.map((p) => p.v)).toEqual([1.0, 1.1, 1.3])
  })
  it('breaks the line across gaps longer than 90 minutes', () => {
    const d = linePath(pts, (t) => (t - T0) / 60_000, (v) => v * 100)
    expect(d).toBe('M0.0,100.0L20.0,110.0M240.0,130.0')
  })
  it('finds the nearest point and respects the tolerance', () => {
    expect(nearestIndex(pts, T0 + 12 * 60_000)).toBe(1)
    expect(nearestIndex([], T0)).toBe(-1)
    expect(valueAt(pts, T0 + 2 * H)).toBeNull()
    expect(valueAt(pts, T0 + 25 * 60_000)?.v).toBe(1.1)
  })
  it('unions times and buckets the table by hour (newest first, last value wins)', () => {
    const other = [{ t: T0 + 5 * 60_000, v: 0.5 }]
    expect(unionTimes([pts, other])).toHaveLength(4)
    const rows = hourlyRows([pts, other])
    expect(rows[0]!.values).toEqual([1.3, null])
    const first = rows[rows.length - 1]!
    expect(first.values[1]).toBe(0.5)
  })
})
