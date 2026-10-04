import { describe, expect, it } from 'vitest'
import { evaluateAlerts, HYSTERESIS_M } from '@/lib/engine/alerts'
import { buildSnapshot } from '@/lib/engine/snapshot'
import { freeboardLevel, rainClassTh, rainLevel, stationStatus, trendCmPerHour } from '@/lib/engine/status'
import { waterLineTh } from '@/lib/engine/format'
import { haversineKm, nearest, parseLatLng } from '@/lib/geo'
import { parseBangkokLocal, parseDotNetDate } from '@/lib/time'
import type { AlertState, Place, Reading, Station } from '@/lib/types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'

const NOW = new Date('2026-10-03T04:35:00.000Z') // 11:35 Bangkok

function canal(id: string, lat: number, lng: number, bank: number, extra: Partial<Station> = {}): Station {
  return {
    id: `bma-canal:${id}`,
    source: 'bma-canal',
    kind: 'canal',
    name: `จุดวัด ${id}`,
    shortName: `จุด ${id}`,
    lat,
    lng,
    agency: 'สำนักการระบายน้ำ กทม.',
    bankLevel: bank,
    ...extra,
  }
}

function reading(stationId: string, minutesAgo: number, waterLevel: number, bank: number | null, extra: Partial<Reading> = {}): Reading {
  return {
    stationId,
    observedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    waterLevel,
    freeboard: bank === null ? null : Math.round((bank - waterLevel) * 1000) / 1000,
    ...extra,
  }
}

const place: Place = {
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
}

describe('time', () => {
  it('parses ASP.NET dates', () => {
    expect(parseDotNetDate('/Date(1790535900000)/')).toBe('2026-09-27T19:05:00.000Z')
    expect(parseDotNetDate('nope')).toBeNull()
  })
  it('parses Bangkok local and Buddhist-era timestamps', () => {
    expect(parseBangkokLocal('28/09/2569 02:05')).toBe('2026-09-27T19:05:00.000Z')
    expect(parseBangkokLocal('2026/09/28 02:05')).toBe('2026-09-27T19:05:00.000Z')
    expect(parseBangkokLocal('2026-09-28 02:05:30')).toBe('2026-09-27T19:05:30.000Z')
    expect(parseBangkokLocal('2026-09-28T02:05:00+07:00')).toBe('2026-09-27T19:05:00.000Z')
  })
})

describe('geo', () => {
  it('computes distances and nearest within radius', () => {
    expect(haversineKm(13.7563, 100.5018, 13.7563, 100.5018)).toBe(0)
    expect(haversineKm(13.7, 100.5, 13.8, 100.5)).toBeCloseTo(11.12, 1)
    const items = [
      { id: 'a', lat: 13.72, lng: 100.76 },
      { id: 'b', lat: 13.9, lng: 100.9 },
      { id: 'c', lat: 13.721, lng: 100.751 },
    ]
    const out = nearest(items, (i) => i, { lat: 13.72, lng: 100.75 }, { radiusKm: 5, limit: 5 })
    expect(out.map((o) => o.item.id)).toEqual(['c', 'a'])
  })
  it('parses pasted coordinates and map links', () => {
    expect(parseLatLng('13.72, 100.61')).toEqual({ lat: 13.72, lng: 100.61 })
    expect(parseLatLng('https://www.google.com/maps/@13.7270,100.6440,15z')).toEqual({ lat: 13.727, lng: 100.644 })
    expect(parseLatLng('https://maps.google.com/?q=13.7,100.5')).toEqual({ lat: 13.7, lng: 100.5 })
    expect(parseLatLng('https://www.openstreetmap.org/#map=15/13.72/100.61')).toEqual({ lat: 13.72, lng: 100.61 })
    expect(parseLatLng('hello')).toBeNull()
  })
})

describe('status', () => {
  it('maps freeboard to levels', () => {
    expect(freeboardLevel(1.19, DEFAULT_FREEBOARD)).toBe('normal')
    expect(freeboardLevel(0.59, DEFAULT_FREEBOARD)).toBe('watch')
    expect(freeboardLevel(0.29, DEFAULT_FREEBOARD)).toBe('warning')
    expect(freeboardLevel(0.05, DEFAULT_FREEBOARD)).toBe('critical')
    expect(freeboardLevel(-0.2, DEFAULT_FREEBOARD)).toBe('critical')
    expect(freeboardLevel(null, DEFAULT_FREEBOARD)).toBe('unknown')
  })
  it('maps rain to TMD classes and levels', () => {
    expect(rainClassTh(0)).toBe('ไม่มีฝน')
    expect(rainClassTh(9.6)).toBe('ฝนเล็กน้อย')
    expect(rainClassTh(20.6)).toBe('ฝนปานกลาง')
    expect(rainClassTh(35.1)).toBe('ฝนหนัก')
    expect(rainClassTh(90.1)).toBe('ฝนหนักมาก')
    expect(rainLevel(20.6, DEFAULT_RAIN)).toBe('normal')
    expect(rainLevel(40, DEFAULT_RAIN)).toBe('watch')
    expect(rainLevel(100, DEFAULT_RAIN)).toBe('warning')
  })
  it('computes hourly trend from history', () => {
    const id = 'bma-canal:1'
    const hist = [reading(id, 70, 0.5, 2), reading(id, 60, 0.52, 2), reading(id, 30, 0.6, 2), reading(id, 0, 0.64, 2)]
    expect(trendCmPerHour(hist)).toBeCloseTo(12, 0)
    expect(trendCmPerHour([reading(id, 0, 0.64, 2)])).toBeNull()
    // a single spike at the end is ignored by the median
    const spiky = [reading(id, 60, 0.5, 2), reading(id, 55, 0.5, 2), reading(id, 10, 0.5, 2), reading(id, 5, 0.51, 2), reading(id, 0, 1.2, 2)]
    expect(Math.abs(trendCmPerHour(spiky)!)).toBeLessThan(5)
  })
  it('marks stale readings unknown', () => {
    const s = canal('1', 13.72, 100.75, 2)
    const st = stationStatus(s, reading(s.id, 120, 1.9, 2), {
      now: NOW,
      staleMinutes: 60,
      freeboard: DEFAULT_FREEBOARD,
      rain: DEFAULT_RAIN,
    })
    expect(st.stale).toBe(true)
    expect(st.level).toBe('unknown')
  })
  it('formats a situation line like the reference dashboard', () => {
    const s = canal('1', 13.72, 100.75, 1.98, { name: 'ปตร. คลองประเวศบุรีรมย์ ตอนลาดกระบัง' })
    const st = stationStatus(s, reading(s.id, 5, 0.79, 1.98, { officialStatus: 'วิกฤต' }), {
      now: NOW,
      staleMinutes: 60,
      freeboard: DEFAULT_FREEBOARD,
      rain: DEFAULT_RAIN,
    })
    expect(waterLineTh(st, NOW)).toBe(
      'ปตร. คลองประเวศบุรีรมย์ ตอนลาดกระบัง: น้ำ 0.79 ม. ตลิ่ง 1.98 ม. ห่างตลิ่ง 1.19 ม. (กทม.: วิกฤต)',
    )
  })
})

function snapFor(latest: { station: Station; reading: Reading | null }[], history: Record<string, Reading[]> = {}) {
  return buildSnapshot({
    place,
    latest,
    history,
    weather: null,
    radar: [],
    sources: [],
    lastIngestAt: null,
    pollMinutes: 10,
    staleMinutes: 60,
    now: NOW,
  })
}

function alertsFor(latest: { station: Station; reading: Reading | null }[], prev: AlertState[], history: Record<string, Reading[]> = {}, p: Place = place) {
  const snap = snapFor(latest, history)
  return evaluateAlerts({ place: p, water: snap.water, roadFlood: snap.roadFlood, rainMax24h: snap.rainMax24h, prev, now: NOW })
}

describe('snapshot', () => {
  it('builds overall status, nearest stations and rain max', () => {
    const a = canal('a', 13.721, 100.751, 2)
    const b = canal('b', 13.73, 100.76, 1)
    const far = canal('far', 14.5, 100.75, 1)
    const rain: Station = { ...canal('r', 13.722, 100.752, 0), id: 'thaiwater-rain:1', source: 'thaiwater-rain', kind: 'rain', bankLevel: null, name: 'กรุงเทพฯ บางนา สกษ.' }
    const snap = snapFor([
      { station: a, reading: reading(a.id, 5, 0.8, 2) },
      { station: b, reading: reading(b.id, 5, 0.75, 1) },
      { station: far, reading: reading(far.id, 5, 1.1, 1) },
      { station: rain, reading: { stationId: rain.id, observedAt: NOW.toISOString(), rain24h: 20.6 } },
    ])
    expect(snap.water.map((w) => w.station.id)).toEqual([a.id, b.id])
    expect(snap.water[1]!.level).toBe('warning')
    expect(snap.overall.level).toBe('warning')
    expect(snap.overall.headline).toContain('น้ำใกล้ตลิ่ง 1 จุด')
    expect(snap.rainMax24h?.valueMm).toBe(20.6)
    expect(snap.overall.lines[0]!.level).toBe('warning')
  })
  it('reports no stations in radius', () => {
    const snap = snapFor([])
    expect(snap.overall.level).toBe('unknown')
    expect(snap.overall.headline).toBe('ไม่พบจุดวัดระดับน้ำในรัศมีที่กำหนด')
  })
})

describe('alerts', () => {
  const s = canal('1', 13.721, 100.751, 2)

  it('notifies on first evaluation when already at/above notify level', () => {
    const out = alertsFor([{ station: s, reading: reading(s.id, 5, 1.8, 2) }], [])
    expect(out.event?.level).toBe('warning')
    expect(out.event?.title).toContain('เตือนภัย')
    expect(out.states.find((x) => x.key === `station:${s.id}`)?.level).toBe('warning')
  })

  it('stays quiet below the notify level but records state', () => {
    const out = alertsFor([{ station: s, reading: reading(s.id, 5, 1.5, 2) }], [])
    expect(out.event).toBeNull()
    expect(out.states.find((x) => x.key === `station:${s.id}`)?.level).toBe('watch')
  })

  it('escalates and applies hysteresis before de-escalating', () => {
    const prev: AlertState[] = [
      { placeId: place.id, key: `station:${s.id}`, level: 'warning', lastNotifiedAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    ]
    // freeboard 0.92 m → raw critical; escalate
    const up = alertsFor([{ station: s, reading: reading(s.id, 5, 1.95, 2) }], prev)
    expect(up.event?.kind).toBe('escalate')
    expect(up.event?.level).toBe('critical')

    // freeboard just above the warning boundary but within hysteresis → hold warning, no event
    const hold = alertsFor([{ station: s, reading: reading(s.id, 5, 2 - (0.3 + HYSTERESIS_M / 2), 2) }], prev)
    expect(hold.event).toBeNull()
    expect(hold.states.find((x) => x.key === `station:${s.id}`)?.level).toBe('warning')

    // receded well past → de-escalate to normal (warning was ≥ notify level so we say so)
    const down = alertsFor([{ station: s, reading: reading(s.id, 5, 1.0, 2) }], prev)
    expect(down.event?.kind).toBe('deescalate')
    expect(down.event?.title).toContain('คลี่คลาย')
    expect(down.states.find((x) => x.key === `station:${s.id}`)?.level).toBe('normal')
  })

  it('ignores stale sensors', () => {
    const prev: AlertState[] = [
      { placeId: place.id, key: `station:${s.id}`, level: 'critical', lastNotifiedAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    ]
    const out = alertsFor([{ station: s, reading: reading(s.id, 300, 0.5, 2) }], prev)
    expect(out.event).toBeNull()
    expect(out.states.find((x) => x.key === `station:${s.id}`)?.level).toBe('critical')
  })

  it('warns on rapid rise that will reach watch soon, with cooldown', () => {
    // freeboard 0.85 m, rising 15 cm/h → reaches 0.60 in ~1.7 h
    const hist = [reading(s.id, 60, 1.0, 2), reading(s.id, 0, 1.15, 2)]
    const latest = [{ station: s, reading: hist[1]! }]
    const out = alertsFor(latest, [], { [s.id]: hist })
    expect(out.findings.some((f) => f.kind === 'rapid_rise')).toBe(true)
    expect(out.event?.title).toContain('น้ำขึ้นเร็ว')
    const again = alertsFor(latest, out.states, { [s.id]: hist })
    expect(again.findings.some((f) => f.kind === 'rapid_rise')).toBe(false)
  })

  it('merges multiple findings into one message', () => {
    const t = canal('2', 13.722, 100.752, 1)
    const out = alertsFor(
      [
        { station: s, reading: reading(s.id, 5, 1.8, 2) },
        { station: t, reading: reading(t.id, 5, 0.95, 1) },
      ],
      [],
    )
    expect(out.findings).toHaveLength(2)
    expect(out.event?.level).toBe('critical')
    expect(out.event?.title).toContain('+อีก 1 รายการ')
    expect(out.event?.stationIds).toHaveLength(2)
  })
})
