import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bankFrom, bmaCanalSource, displayNameTh, parseBmaCanal, validThresholds, waterLevelFrom } from '@/lib/sources/bma-canal'

const rows = JSON.parse(readFileSync(new URL('./fixtures/bma-canal.json', import.meta.url), 'utf8'))
// Fixture captured 2026-09-28 11:38 ICT.
const NOW = new Date('2026-09-28T04:38:00.000Z')

describe('BMA canal parser', () => {
  const out = parseBmaCanal(rows, NOW)
  const byCode = new Map(out.stations.map((s) => [s.code, s]))
  const reading = (code: string) => out.readings.find((r) => r.stationId === `canal:${code}`)

  it('normalises stations with shared canal ids and display names', () => {
    expect(out.stations).toHaveLength(rows.length)
    const gate = byCode.get('WL.PWT.03')!
    expect(gate.id).toBe('canal:WL.PWT.03')
    expect(gate.name).toBe('ปตร. คลองประเวศบุรีรมย์ ตอนวัดกระทุ่มเสือปลา')
    expect(gate.bankLevel).toBe(1.05)
    expect(gate.province).toBe('กรุงเทพมหานคร')
  })

  it('computes freeboard from the lower bank and keeps BMA status as text', () => {
    const r = reading('WL.PWT.03')!
    expect(r.waterLevel).toBe(0.73)
    expect(r.freeboard).toBe(0.32)
    expect(r.officialStatus).toBe('วิกฤต')
    expect(r.observedAt).toBe('2026-09-28T04:35:00.000Z')
  })

  it('treats placeholder banks/thresholds and sentinels as missing', () => {
    const ypn = byCode.get('WL.YPN.01')!
    expect(ypn.bankLevel).toBeNull()
    expect(ypn.officialWarning).toBeNull()
    expect(reading('WL.YPN.01')!.freeboard).toBeNull()
    // cm-scale thresholds on system-3 gauges are rejected
    expect(byCode.get('WL.MKT.02')!.officialCritical).toBeNull()
    // exact −2.00 dropout → no reading
    expect(reading('WL.TNG.01')).toBeUndefined()
    // negative MSL levels are valid
    expect(reading('WL.NBN.01')!.waterLevel).toBe(-4.25)
  })

  it('flags water above the bank as negative freeboard', () => {
    expect(reading('WL.PNM.01')!.freeboard).toBe(-0.39)
  })

  it('helpers behave', () => {
    expect(displayNameTh('จุดวัดคลองแสนแสบ  ตอนสำนักงานเขตบางกะปิ')).toBe('คลองแสนแสบ ตอนสำนักงานเขตบางกะปิ')
    expect(bankFrom(0.15, 2.8)).toEqual({ bank: 0.15, uncertain: true })
    expect(bankFrom(2.5, 2.6)).toEqual({ bank: 2.5, uncertain: false })
    expect(bankFrom(0, null)).toEqual({ bank: null, uncertain: false })
    expect(validThresholds(-0.2, 0)).toEqual({ warning: null, critical: null })
    expect(validThresholds(2.14, 2.68)).toEqual({ warning: 2.14, critical: 2.68 })
    expect(validThresholds(0.5, 0.4)).toEqual({ warning: null, critical: null })
    expect(waterLevelFrom(-99)).toBeNull()
    expect(waterLevelFrom('0.84')).toBe(0.84)
  })

  it('discards far-future timestamps and clamps small skews', () => {
    const future = parseBmaCanal(
      [
        { ...rows[0], water_code: 'WL.X.01', site_timestamp: `/Date(${NOW.getTime() + 60 * 60_000})/` },
        { ...rows[0], water_code: 'WL.X.02', site_timestamp: `/Date(${NOW.getTime() + 5 * 60_000})/` },
      ],
      NOW,
    )
    expect(future.readings.map((r) => r.stationId)).toEqual(['canal:WL.X.02'])
    expect(future.readings[0]!.observedAt).toBe(NOW.toISOString())
  })
})

describe('BMA canal adapter', () => {
  it('POSTs the form body with browser headers and retries after a 403 with cookies', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let n = 0
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/water')) return new Response('ok', { headers: { 'set-cookie': 'cf=abc; Path=/' } })
      n++
      if (n === 1) return new Response('blocked', { status: 403 })
      return new Response(JSON.stringify(rows), { status: 200 })
    }) as unknown as typeof fetch
    const res = await bmaCanalSource.fetch({ fetch: fakeFetch, now: NOW, timeoutMs: 1000, sleep: async () => {} })
    expect(res.stations.length).toBe(rows.length)
    const posts = calls.filter((c) => c.url.endsWith('/GoogleMap'))
    expect(posts).toHaveLength(2)
    expect(posts[0]!.init?.method).toBe('POST')
    expect(posts[0]!.init?.body).toBe('payload=')
    expect((posts[1]!.init?.headers as Record<string, string>).Cookie).toBe('cf=abc')
  })
})
