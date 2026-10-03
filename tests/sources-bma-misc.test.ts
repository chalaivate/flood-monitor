import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bmaRainSource, parseBmaPump, parseBmaRain, parseBmaRoadFlood, roadDepthFrom } from '@/lib/sources/bma-misc'

// Rain/road fixtures hold real values captured by a Thai relay (2026-09-28..10-02),
// re-keyed to the raw BMA field names; the pump fixture is a raw capture (2026-09-28).
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))
const NOW = new Date('2026-10-02T03:20:00.000Z')

describe('BMA rain', () => {
  const out = parseBmaRain(load('bma-rain.json'), NOW)
  it('keeps every gauge as a station but drops offline readings', () => {
    expect(out.stations).toHaveLength(5)
    expect(out.readings.map((r) => r.stationId)).not.toContain('rain:RF.PYT.02')
    const tlc = out.readings.find((r) => r.stationId === 'rain:RF.TLC.03')!
    expect(tlc.rain24h).toBe(92)
    expect(tlc.rain1h).toBe(48)
    expect(out.stations[0]!.kind).toBe('rain')
  })
  it('POSTs to the rain endpoint', async () => {
    let seen: { url: string; method?: string } | null = null
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = { url, method: init?.method }
      return new Response(JSON.stringify(load('bma-rain.json')))
    }) as unknown as typeof fetch
    const res = await bmaRainSource.fetch({ fetch: fakeFetch, now: NOW, timeoutMs: 1000, sleep: async () => {} })
    expect(seen).toEqual({ url: 'https://weather.bangkok.go.th/rain/PageMap/GetDataForUpdate', method: 'POST' })
    expect(res.readings.length).toBe(4)
  })
})

describe('BMA road flood', () => {
  const out = parseBmaRoadFlood(load('bma-roadflood.json'), NOW)
  it('maps status text to depth and skips offline sensors', () => {
    const byId = new Map(out.readings.map((r) => [r.stationId, r]))
    expect(byId.get('road:FL.WTL.04')?.roadFloodCm).toBe(44.6)
    expect(byId.get('road:FL.CTC.04')?.roadFloodCm).toBe(0)
    expect(byId.has('road:FL.BKP.03')).toBe(false)
  })
  it('keys tunnels by direction', () => {
    const ids = out.stations.map((s) => s.id)
    expect(ids).toContain('road:TN.BKA.01:ขาเข้า')
    expect(ids).toContain('road:TN.BKA.01:ขาออก')
    expect(out.stations.find((s) => s.id === 'road:TN.BKA.01:ขาออก')!.name).toBe('อุโมงค์ อ.ทหารราบ 11 (ขาออก)')
  })
  it('helper', () => {
    expect(roadDepthFrom('น้ำท่วม', '20')).toBe(20)
    expect(roadDepthFrom('ปกติ', 33)).toBe(0)
    expect(roadDepthFrom('ขัดข้อง', 33)).toBe('offline')
    expect(() => parseBmaRoadFlood([], NOW)).toThrow()
  })
})

describe('BMA pump stations', () => {
  const out = parseBmaPump(load('bma-pump.json'), new Date('2026-09-28T04:38:00Z'))
  it('joins metadata, counts running pumps and skips offline RTUs', () => {
    const r = out.readings.find((x) => x.stationId === 'bma-pump:ST.BKP.02')!
    expect(r.pumpsRunning).toBe(3)
    expect(r.pumpsTotal).toBe(4)
    expect(r.waterLevel).toBe(-1.31)
    expect(out.readings.some((x) => x.stationId === 'bma-pump:ST.BKP.06')).toBe(false)
    // LastPump row without a waterTbl entry still becomes a station
    expect(out.stations.some((s) => s.id === 'bma-pump:ST.BSU.01')).toBe(true)
  })
})
