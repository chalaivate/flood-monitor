import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  makeThaiwaterRainSource,
  makeThaiwaterWaterlevelSource,
  parseCanalWaterlevel,
  parseFloodRoad,
  parseRain24,
  parseWaterlevel,
  riverBank,
  rowsOf,
  thaiwaterTime,
} from '@/lib/sources/thaiwater'

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))
// Captures from 2026-09-28 12:19 ICT.
const NOW = new Date('2026-09-28T05:19:00.000Z')

describe('ThaiWater waterlevel_load', () => {
  const out = parseWaterlevel(rowsOf(load('thaiwater-waterlevel.json'), 'waterlevel_data'), NOW)
  const reading = (id: number) => out.readings.find((r) => r.stationId === `thaiwater-wl:${id}`)
  it('parses MSL levels (including > 10 m upcountry) and freeboard from min_bank', () => {
    expect(reading(1)!.waterLevel).toBe(2.74)
    expect(reading(1)!.freeboard).toBe(-0.54) // BKK021 over bank, situation_level 5
    expect(reading(2781)!.waterLevel).toBe(122.97)
    expect(reading(2781)!.freeboard).toBe(4.95)
    expect(reading(1)!.observedAt).toBe('2026-09-28T05:00:00.000Z')
  })
  it('treats min_bank/ground_level = 0 sentinels as unknown bank', () => {
    const egat = out.stations.find((s) => s.id === 'thaiwater-wl:700559')!
    expect(egat.bankLevel).toBeNull()
    expect(reading(700559)!.freeboard).toBeNull()
    expect(riverBank({ min_bank: 0, ground_level: 0, left_bank: 0, right_bank: 0 })).toBeNull()
  })
  it('keeps stale-but-recent readings (stale logic decides later) and labels the agency', () => {
    expect(reading(3)).toBeDefined() // BKK009 ~18 h old: kept, the stale rule decides later
    expect(reading(49)).toBeUndefined() // CPY012 > 72 h old: dropped at parse time
    expect(out.stations.find((s) => s.id === 'thaiwater-wl:2599')!.agency).toBe('ชป. via ThaiWater')
    expect(out.stations.find((s) => s.id === 'thaiwater-wl:1')!.kind).toBe('canal')
  })
  it('fetches per province by default and the national feed with "all"', async () => {
    const urls: string[] = []
    const fake = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(url.includes('waterlevel_load') ? load('thaiwater-waterlevel.json') : { result: 'OK', data: [] }))
    }) as unknown as typeof fetch
    await makeThaiwaterWaterlevelSource('10,12').fetch({ fetch: fake, now: NOW, timeoutMs: 1000, sleep: async () => {} })
    await makeThaiwaterWaterlevelSource('all').fetch({ fetch: fake, now: NOW, timeoutMs: 1000, sleep: async () => {} })
    expect(urls).toEqual([
      'https://api-v3.thaiwater.net/api/v1/thaiwater30/provinces/waterlevel?province_code=10',
      'https://api-v3.thaiwater.net/api/v1/thaiwater30/provinces/waterlevel?province_code=12',
      'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load',
    ])
  })
})

describe('ThaiWater rain', () => {
  const out = parseRain24(rowsOf(load('thaiwater-rain24h.json')), NOW)
  it('merges BMA gauges onto rain:RF.* ids and keeps absent rain_1h as unknown', () => {
    expect(out.stations.map((s) => s.id)).toContain('rain:RF.DMG.01')
    const tmd = out.readings.find((r) => r.stationId === 'thaiwater-rain:3712')!
    expect(tmd.rain24h).toBe(21.2)
    expect(tmd.rain1h).toBeNull()
    const zero = out.readings.find((r) => r.stationId === 'thaiwater-rain:4')!
    expect(zero.rain24h).toBe(0)
  })
  it('reads the Bangkok province feed (TMD Bang Na agromet station)', async () => {
    const fake = (async () => new Response(JSON.stringify(load('thaiwater-provinces-rain24.json')))) as unknown as typeof fetch
    const res = await makeThaiwaterRainSource('10').fetch({ fetch: fake, now: new Date('2026-09-26T06:00:00Z'), timeoutMs: 1000, sleep: async () => {} })
    const bangna = res.stations.find((s) => s.code === '48453')!
    expect(bangna.name).toBe('กรุงเทพฯ บางนา สกษ.')
    expect(res.readings.find((r) => r.stationId === bangna.id)!.rain24h).toBe(188.7)
  })
})

describe('ThaiWater BMA mirrors', () => {
  it('canal_waterlevel shares canal:<code> ids, drops dead stations and sentinels', () => {
    const out = parseCanalWaterlevel(load('thaiwater-canal.json'), NOW)
    expect(out.stations.map((s) => s.id)).toEqual(['canal:WL.PWT.03', 'canal:WL.SSB.07', 'canal:WL.NBI.01', 'canal:WL.KJN.02'])
    expect(out.stations[0]!.name).toBe('ปตร. คลองประเวศบุรีรมย์ ตอนวัดกระทุ่มเสือปลา')
    expect(out.readings.map((r) => r.stationId)).toEqual(['canal:WL.PWT.03', 'canal:WL.SSB.07'])
    expect(out.readings[0]!.freeboard).toBe(0.32)
  })
  it('flood_road shares road:<code> ids and labels tunnels', () => {
    const out = parseFloodRoad(load('thaiwater-floodroad.json'), NOW)
    expect(out.readings.find((r) => r.stationId === 'road:FL.WTL.04')!.roadFloodCm).toBe(44.6)
    expect(out.stations.find((s) => s.id === 'road:TN.BKA.01')!.name).toBe('อุโมงค์ อ.ทหารราบ 11')
    expect(out.readings.some((r) => r.stationId === 'road:FL.SLG.01')).toBe(false)
  })
  it('rejects error bodies and bad timestamps', () => {
    expect(() => rowsOf({ result: 'OK', data: '422: No station id' })).toThrow(/unexpected response shape: 422/)
    expect(thaiwaterTime('2026-09-28 13:00', NOW)).toBeNull() // 41 min ahead
    expect(thaiwaterTime('2026-09-28 12:25', NOW)).toBe(NOW.toISOString()) // small skew clamped
    expect(thaiwaterTime('2019-04-02 10:00', NOW)).toBeNull()
  })
})
