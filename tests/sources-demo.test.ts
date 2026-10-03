import { describe, expect, it } from 'vitest'
import { buildSnapshot } from '@/lib/engine/snapshot'
import { DEMO_CENTER, demoCanal, demoRain, demoRoadFlood, demoWeather, stormResponse } from '@/lib/sources/demo'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN, type Reading } from '@/lib/types'

const NOW = new Date('2026-10-03T04:35:00.000Z')

describe('demo data', () => {
  it('is deterministic for a given instant', () => {
    expect(demoCanal(NOW, 1)).toEqual(demoCanal(NOW, 1))
    expect(stormResponse(NOW.getTime())).toBeGreaterThanOrEqual(0)
    expect(stormResponse(NOW.getTime())).toBeLessThanOrEqual(1)
  })
  it('produces 72h of 10-minute canal history and rain totals', () => {
    const c = demoCanal(NOW)
    const perStation = c.readings.filter((r) => r.stationId === c.stations[0]!.id)
    expect(perStation.length).toBe(72 * 6)
    expect(perStation.at(-1)!.observedAt <= NOW.toISOString()).toBe(true)
    const r = demoRain(NOW)
    expect(r.readings.every((x) => (x.rain24h ?? -1) >= 0)).toBe(true)
    expect(demoRoadFlood(NOW).readings.every((x) => (x.roadFloodCm ?? -1) >= 0)).toBe(true)
  })
  it('feeds a full dashboard snapshot around the demo centre', () => {
    const sources = [demoCanal(NOW), demoRain(NOW), demoRoadFlood(NOW)]
    const latest = sources.flatMap((s) =>
      s.stations.map((station) => {
        const rs = s.readings.filter((r) => r.stationId === station.id)
        return { station, reading: (rs.at(-1) as Reading | undefined) ?? null }
      }),
    )
    const history: Record<string, Reading[]> = {}
    for (const r of sources[0]!.readings) (history[r.stationId] ??= []).push(r)
    const snap = buildSnapshot({
      place: { ...DEMO_CENTER, radiusKm: 3, maxStations: 4, freeboard: DEFAULT_FREEBOARD, rain: DEFAULT_RAIN, rapidRiseCm: 10 },
      latest,
      history,
      weather: demoWeather(DEMO_CENTER.lat, DEMO_CENTER.lng, NOW),
      radar: [],
      sources: [],
      lastIngestAt: NOW.toISOString(),
      pollMinutes: 10,
      staleMinutes: 60,
      now: NOW,
    })
    expect(snap.water).toHaveLength(4)
    expect(snap.water.every((w) => !w.stale)).toBe(true)
    expect(snap.rainMax24h).not.toBeNull()
    expect(snap.weather?.condition).toBeTruthy()
    expect(snap.overall.level).not.toBe('unknown')
  })
})
