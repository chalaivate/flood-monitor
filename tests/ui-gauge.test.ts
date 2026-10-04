import { describe, expect, it } from 'vitest'
import { freeboardGauge, gaugeAngle, metresTh, rainGauge } from '@/lib/ui/gauge'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'

describe('freeboardGauge', () => {
  it('lays out critical → warning → watch → normal from −0.2 to 1.5 m', () => {
    const g = freeboardGauge(1.19, DEFAULT_FREEBOARD)
    expect(g.min).toBe(-0.2)
    expect(g.max).toBe(1.5)
    expect(g.segments).toEqual([
      { from: -0.2, to: 0.1, level: 'critical' },
      { from: 0.1, to: 0.3, level: 'warning' },
      { from: 0.3, to: 0.6, level: 'watch' },
      { from: 0.6, to: 1.5, level: 'normal' },
    ])
  })
  it('extends the top for large freeboard (rounded up to 0.5 m)', () => {
    expect(freeboardGauge(2.05, DEFAULT_FREEBOARD).max).toBe(2.5)
    expect(freeboardGauge(null, DEFAULT_FREEBOARD).max).toBe(1.5)
  })
  it('segments stay contiguous and ordered for custom thresholds', () => {
    const g = freeboardGauge(0.4, { watch: 1, warning: 0.5, critical: 0.2 })
    for (let i = 1; i < g.segments.length; i++) expect(g.segments[i]!.from).toBe(g.segments[i - 1]!.to)
    expect(g.segments.at(-1)!.to).toBe(g.max)
  })
  it('drops empty segments when a threshold falls outside the range', () => {
    const g = freeboardGauge(0.5, { watch: 0.6, warning: 0.3, critical: -0.5 })
    expect(g.segments.map((s) => s.level)).toEqual(['warning', 'watch', 'normal'])
  })
})

describe('rainGauge', () => {
  it('shows TMD bands with a visible critical band', () => {
    const g = rainGauge(20.6, DEFAULT_RAIN)
    expect(g.min).toBe(0)
    expect(g.max).toBe(180)
    expect(g.segments.map((s) => [s.level, s.from, s.to])).toEqual([
      ['normal', 0, 35.1],
      ['watch', 35.1, 90.1],
      ['warning', 90.1, 150],
      ['critical', 150, 180],
    ])
  })
  it('grows for extreme totals', () => {
    expect(rainGauge(260, DEFAULT_RAIN).max).toBe(300)
  })
})

describe('gaugeAngle', () => {
  it('maps min→180°, max→0° and clamps', () => {
    expect(gaugeAngle(-0.2, -0.2, 1.5)).toBe(180)
    expect(gaugeAngle(1.5, -0.2, 1.5)).toBe(0)
    expect(gaugeAngle(5, -0.2, 1.5)).toBe(0)
    expect(gaugeAngle(-3, -0.2, 1.5)).toBe(180)
    expect(gaugeAngle(0.65, -0.2, 1.5)).toBeCloseTo(90)
  })
  it('formats metres', () => {
    expect(metresTh(1.194)).toBe('1.19 ม.')
    expect(metresTh(null)).toBe('-')
  })
})
