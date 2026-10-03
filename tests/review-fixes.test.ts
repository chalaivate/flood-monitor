import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/lib/config'
import { evaluateAlerts, MAX_BODY_CHARS, mergeFindings, type Finding } from '@/lib/engine/alerts'
import { buildSnapshot } from '@/lib/engine/snapshot'
import { stationStatus } from '@/lib/engine/status'
import type { ChannelSender, NotifyMessage } from '@/lib/notify/types'
import { fetchPolitely, META_LAST_INGEST, runAlerts, runIngest } from '@/lib/pipeline'
import { HttpError } from '@/lib/sources/http'
import { fetchProvinces, parseRain24, parseWaterlevel, rowsOf } from '@/lib/sources/thaiwater'
import type { SourceAdapter } from '@/lib/sources/types'
import { createStore } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'
import type { AlertState, Place, Reading, Station } from '@/lib/types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'

const NOW = new Date('2026-10-03T04:35:00.000Z')
const config = loadConfig({})

function place(over: Partial<Place> = {}): Place {
  return {
    id: 'p1',
    label: 'บ้าน',
    lat: 13.72,
    lng: 100.75,
    radiusKm: 5,
    maxStations: 4,
    freeboard: DEFAULT_FREEBOARD,
    rain: DEFAULT_RAIN,
    rapidRiseCm: 10,
    notifyMinLevel: 'warning',
    manageTokenHash: 'x',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  }
}

const canal = (id: string, lat: number, lng: number, bank: number): Station => ({
  id: `canal:${id}`,
  source: 'bma-canal',
  kind: 'canal',
  name: `จุดวัด ${id}`,
  shortName: id,
  lat,
  lng,
  agency: 'สำนักการระบายน้ำ กทม.',
  bankLevel: bank,
})
const rainSt = (id: string, lat: number, lng: number): Station => ({
  id: `rain:${id}`,
  source: 'bma-rain',
  kind: 'rain',
  name: id,
  lat,
  lng,
  agency: 'x',
})
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString()
const wl = (s: Station, minAgo: number, level: number): Reading => ({
  stationId: s.id,
  observedAt: at(minAgo),
  waterLevel: level,
  freeboard: Math.round(((s.bankLevel ?? 0) - level) * 100) / 100,
})

function snap(latest: { station: Station; reading: Reading | null }[], p: Place = place()) {
  return buildSnapshot({
    place: p,
    latest,
    history: {},
    weather: null,
    radar: [],
    sources: [],
    lastIngestAt: null,
    pollMinutes: 10,
    staleMinutes: 60,
    now: NOW,
  })
}

describe('alert message fixes', () => {
  it('says "ล้นตลิ่ง" instead of a negative distance in titles', () => {
    const s = canal('A', 13.721, 100.751, 1.05)
    const sn = snap([{ station: s, reading: wl(s, 5, 1.17) }])
    const out = evaluateAlerts({ place: place(), water: sn.water, roadFlood: [], rainMax24h: null, prev: [], now: NOW })
    expect(out.event!.title).toBe('วิกฤต: A ล้นตลิ่ง 0.12 ม.')
  })

  it('keeps the footer (link + disclaimer) when the body is long', () => {
    const findings: Finding[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'escalate',
      level: 'critical',
      key: `k${i}`,
      stationIds: [`s${i}`],
      title: 't',
      line: `ปตร. คลองประเวศบุรีรมย์ ตอนวัดกระทุ่มเสือปลา ${i}: น้ำ 0.99 ม. ตลิ่ง 1.05 ม. ห่างตลิ่ง 0.06 ม. ขึ้น 12 ซม./ชม. (กทม.: วิกฤต)`,
    }))
    const ev = mergeFindings(place(), findings, NOW, 'https://flood.example/?place=p1')!
    expect(ev.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 50)
    expect(ev.body).toContain('https://flood.example/?place=p1')
    expect(ev.body).toContain('ไม่ใช่ประกาศทางการ')
    expect(ev.body).toMatch(/…และอีก \d+ รายการ/)
  })

  it('does not repeat the trend in rapid-rise lines', () => {
    const s = canal('R', 13.721, 100.751, 2)
    const hist = [wl(s, 60, 1.0), wl(s, 0, 1.15)]
    const sn = buildSnapshot({
      place: place(),
      latest: [{ station: s, reading: hist[1]! }],
      history: { [s.id]: hist },
      weather: null,
      radar: [],
      sources: [],
      lastIngestAt: null,
      pollMinutes: 10,
      staleMinutes: 60,
      now: NOW,
    })
    const out = evaluateAlerts({ place: place(), water: sn.water, roadFlood: [], rainMax24h: null, prev: [], now: NOW })
    const line = out.findings.find((f) => f.kind === 'rapid_rise')!.line
    expect(line.match(/ซม\.\/ชม\./g)).toHaveLength(1)
  })
})

describe('rain state with a stale gauge', () => {
  it('does not step down (and later re-alert) when the max gauge goes stale', () => {
    const a = rainSt('A', 13.721, 100.751)
    const b = rainSt('B', 13.722, 100.752)
    const p = place({ notifyMinLevel: 'watch' })
    const run = (aAge: number, prev: AlertState[]) => {
      const sn = snap(
        [
          { station: a, reading: { stationId: a.id, observedAt: at(aAge), rain24h: 100 } },
          { station: b, reading: { stationId: b.id, observedAt: at(5), rain24h: 20 } },
        ],
        p,
      )
      return evaluateAlerts({ place: p, water: [], roadFlood: [], rainMax24h: sn.rainMax24h, rain: sn.rain, prev, now: NOW })
    }
    const c1 = run(5, [])
    expect(c1.event?.kind).toBe('rain')
    const c2 = run(95, c1.states) // A stale → max drops to 20 mm
    expect(c2.states.find((x) => x.key === 'rain')!.level).toBe('warning')
    const c3 = run(5, c2.states) // A back
    expect(c3.event).toBeNull()
  })
})

describe('station selection', () => {
  it('never lets a long-dead gauge take a slot from a live one', () => {
    const dead = canal('DEAD', 13.72, 100.75, 1)
    const live = canal('LIVE', 13.726, 100.75, 1)
    const p = place({ maxStations: 1 })
    const sn = snap(
      [
        { station: dead, reading: null },
        { station: live, reading: wl(live, 5, 0.95) },
      ],
      p,
    )
    expect(sn.water.map((w) => w.station.id)).toEqual(['canal:LIVE'])
    const out = evaluateAlerts({ place: p, water: sn.water, roadFlood: [], rainMax24h: null, prev: [], now: NOW })
    expect(out.event?.level).toBe('critical')
  })

  it('gives hourly ThaiWater feeds a longer stale allowance', () => {
    const body = JSON.parse(readFileSync(new URL('./fixtures/thaiwater-waterlevel.json', import.meta.url), 'utf8'))
    const fetched = new Date('2026-09-28T05:19:00.000Z')
    const res = parseWaterlevel(rowsOf(body, 'waterlevel_data'), fetched)
    const c12 = res.stations.find((s) => s.code === 'C.12')! // RID, stamped 11:00, fetched 12:19
    const r = res.readings.find((x) => x.stationId === c12.id)!
    expect(stationStatus(c12, r, { now: fetched, staleMinutes: 60, freeboard: DEFAULT_FREEBOARD, rain: DEFAULT_RAIN }).stale).toBe(false)
    const rain = parseRain24(rowsOf(JSON.parse(readFileSync(new URL('./fixtures/thaiwater-rain24h.json', import.meta.url), 'utf8'))), fetched)
    expect(rain.stations.every((s) => s.staleMinutes === 180)).toBe(true)
  })
})

function sender(ok: boolean): ChannelSender & { sent: NotifyMessage[] } {
  const sent: NotifyMessage[] = []
  return {
    type: 'ntfy',
    sent,
    isConfigured: () => true,
    async send(_c, msg) {
      sent.push(msg)
      await new Promise((r) => setTimeout(r, 20))
      return ok ? { ok: true } : { ok: false, error: 'HTTP 502' }
    },
  }
}

async function seeded() {
  const store = new SqliteStore(':memory:')
  const s = canal('W', 13.721, 100.751, 1)
  await store.upsertStations([s])
  await store.insertReadings([wl(s, 5, 0.75)]) // fb 0.25 → warning
  await store.createPlace(place())
  await store.addChannel({ id: 'c1', placeId: 'p1', type: 'ntfy', target: 'fm-x', verified: true, createdAt: NOW.toISOString() })
  return store
}

describe('runAlerts', () => {
  it('is single-flight: overlapping runs send one message', async () => {
    const store = await seeded()
    const snd = sender(true)
    const deps = { store, config, sources: [], senders: [snd], fetch, now: () => NOW }
    const [a, b] = await Promise.all([runAlerts(deps), runAlerts(deps)])
    expect(snd.sent).toHaveLength(1)
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1)
    store.close()
  })

  it('re-raises an alert next cycle when every channel failed, then gives up', async () => {
    const store = await seeded()
    const bad = sender(false)
    const deps = { store, config, sources: [], senders: [bad], fetch, now: () => NOW }
    await runAlerts(deps)
    await runAlerts(deps)
    expect(bad.sent).toHaveLength(2)
    const good = sender(true)
    await runAlerts({ ...deps, senders: [good] })
    expect(good.sent).toHaveLength(1)
    await runAlerts({ ...deps, senders: [good] })
    expect(good.sent).toHaveLength(1) // delivered → state saved → quiet
    store.close()
  })
})

describe('runIngest', () => {
  const failing = (id: SourceAdapter['id'], err: Error): SourceAdapter => ({
    id,
    label: 'x',
    thaiIpOnly: true,
    fetch: async () => {
      throw err
    },
  })

  it('does not advance lastIngestAt when nothing was stored', async () => {
    const store = new SqliteStore(':memory:')
    await runIngest({ store, config, sources: [failing('bma-canal', new Error('fetch failed'))], senders: [], fetch, now: () => NOW })
    expect(await store.getMeta(META_LAST_INGEST)).toBeNull()
    store.close()
  })

  it('stops hitting a host after a 429 and backs off across cycles', async () => {
    const store = new SqliteStore(':memory:')
    let rainCalls = 0
    const rain: SourceAdapter = {
      id: 'bma-rain',
      label: 'x',
      thaiIpOnly: true,
      fetch: async () => {
        rainCalls++
        return { source: 'bma-rain', stations: [], readings: [], fetchedAt: NOW.toISOString(), warnings: [] }
      },
    }
    const deps = { store, config, sources: [failing('bma-canal', new HttpError(429, 'https://weather.bangkok.go.th/x')), rain], senders: [], fetch, now: () => NOW }
    const r1 = await runIngest(deps)
    expect(rainCalls).toBe(0)
    expect(r1.results.find((r) => r.source === 'bma-rain')!.error).toContain('HTTP 429')
    await runIngest({ ...deps, sources: [rain] })
    expect(rainCalls).toBe(0) // still cooling down
    store.close()
  })

  it('stores fast sources without waiting for slow ones', async () => {
    const order: string[] = []
    await fetchPolitely(
      [{ id: 'thaiwater-canal' }, { id: 'bma-canal' }],
      async (s) => {
        if (s.id.startsWith('thaiwater')) await new Promise((r) => setTimeout(r, 60))
        return s.id
      },
      { onSettled: async (s) => void order.push(s.id) },
    )
    expect(order).toEqual(['bma-canal', 'thaiwater-canal'])
  })
})

describe('ThaiWater provinces', () => {
  it('keeps the provinces that answered when one fails', async () => {
    const fake = (async (url: string) =>
      url.includes('province_code=13')
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ result: 'OK', data: [{ id: 1 }] }))) as unknown as typeof fetch
    const res = await fetchProvinces({ fetch: fake, now: NOW, timeoutMs: 1000, sleep: async () => {} }, ['10', '13'], (c) => `/provinces/rain24?province_code=${c}`)
    expect(res.rows).toHaveLength(1)
    expect(res.warnings[0]).toContain('province 13 failed')
    await expect(
      fetchProvinces({ fetch: fake, now: NOW, timeoutMs: 1000, sleep: async () => {} }, ['13'], (c) => `/x?province_code=${c}`),
    ).rejects.toThrow()
  })
})

describe('store selection', () => {
  it('refuses demo data on a shared Supabase database', async () => {
    await expect(createStore(loadConfig({ DATA_MODE: 'fixture', STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }))).rejects.toThrow(/fixture/)
  })
})
