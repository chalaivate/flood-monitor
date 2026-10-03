import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/lib/store/supabase'
import type { AlertState, Channel, Place, Reading, Station } from '@/lib/types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'

// SupabaseStore is exercised against a fake PostgREST: we assert the HTTP requests
// supabase-js produces (paths, filters, Prefer headers, chunking, pagination).

interface Req {
  method: string
  url: URL
  table: string
  headers: Headers
  body: unknown
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> }

function fakePostgrest(route: (req: Req) => Reply | undefined) {
  const requests: Req[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const raw = init?.body ? String(init.body) : null
    const req: Req = {
      method: init?.method ?? 'GET',
      url,
      table: url.pathname.replace('/rest/v1/', ''),
      headers,
      body: raw ? JSON.parse(raw) : null,
    }
    requests.push(req)
    const r = route(req) ?? { json: [] }
    const status = r.status ?? 200
    const body = status === 204 ? null : JSON.stringify(r.json ?? [])
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...r.headers } })
  }) as typeof fetch
  return { fetchImpl, requests }
}

const KEY = 'service-role-key'

function makeStore(route: (req: Req) => Reply | undefined, opts: { pageSize?: number; chunkSize?: number } = {}) {
  const fake = fakePostgrest(route)
  const store = new SupabaseStore({ url: 'https://proj.supabase.co', serviceRoleKey: KEY, fetch: fake.fetchImpl, ...opts })
  return { store, requests: fake.requests }
}

const station = (i: number): Station => ({
  id: `canal:WL.T.${String(i).padStart(4, '0')}`,
  source: 'bma-canal',
  kind: 'canal',
  name: `จุดวัด ${i}`,
  lat: 13.7 + i / 1000,
  lng: 100.6,
  agency: 'สำนักการระบายน้ำ กทม.',
  bankLevel: 1.5,
})

describe('SupabaseStore', () => {
  it('authenticates with the service role key and no session', async () => {
    const { store, requests } = makeStore(() => ({ json: [] }))
    await store.listStations()
    const h = requests[0]!.headers
    expect(h.get('apikey')).toBe(KEY)
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(requests[0]!.url.origin).toBe('https://proj.supabase.co')
  })

  it('inserts readings in chunks of ≤ 500 with ON CONFLICT DO NOTHING and counts inserted rows', async () => {
    const { store, requests } = makeStore((req) => {
      // Pretend half of each chunk already existed.
      const rows = req.body as unknown[]
      return { status: 201, json: rows.slice(0, Math.floor(rows.length / 2)).map(() => ({ station_id: 'x' })) }
    })
    const readings: Reading[] = Array.from({ length: 1200 }, (_, i) => ({
      stationId: 'canal:WL.T.0001',
      observedAt: new Date(Date.UTC(2026, 9, 3, 0, 0) + i * 60_000).toISOString(),
      waterLevel: 0.5,
      freeboard: 1.0,
    }))
    // A duplicate inside the batch is dropped client-side.
    readings.push({ ...readings[0]! })
    const inserted = await store.insertReadings(readings)
    expect(requests).toHaveLength(3)
    expect(requests.map((r) => (r.body as unknown[]).length)).toEqual([500, 500, 200])
    for (const r of requests) {
      expect(r.method).toBe('POST')
      expect(r.table).toBe('readings')
      expect(r.url.searchParams.get('on_conflict')).toBe('station_id,observed_at')
      expect(r.url.searchParams.get('select')).toBe('station_id')
      expect(r.headers.get('prefer')).toContain('resolution=ignore-duplicates')
      expect(r.headers.get('prefer')).toContain('return=representation')
    }
    expect(inserted).toBe(250 + 250 + 100)
    const first = (requests[0]!.body as Record<string, unknown>[])[0]!
    expect(first).toEqual({
      station_id: 'canal:WL.T.0001',
      observed_at: '2026-10-03T00:00:00.000Z',
      water_level: 0.5,
      freeboard: 1,
      rain_1h: null,
      rain_24h: null,
      road_flood_cm: null,
      pumps_running: null,
      pumps_total: null,
      official_status: null,
    })
  })

  it('upserts stations (deduplicated, merge on id) with jsonb data', async () => {
    const { store, requests } = makeStore(() => ({ status: 201 }))
    await store.upsertStations([station(1), { ...station(1), bankLevel: 2 }, station(2)])
    expect(requests).toHaveLength(1)
    const r = requests[0]!
    expect(r.url.searchParams.get('on_conflict')).toBe('id')
    expect(r.headers.get('prefer')).toContain('resolution=merge-duplicates')
    const rows = r.body as { id: string; data: Station; kind: string }[]
    expect(rows.map((x) => x.id)).toEqual([station(1).id, station(2).id])
    expect(rows[0]!.data.bankLevel).toBe(2)
    expect(rows[0]!.kind).toBe('canal')
  })

  it('paginates selects past the page size', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ data: station(i) }))
    const { store, requests } = makeStore(
      (req) => {
        const offset = Number(req.url.searchParams.get('offset') ?? 0)
        const limit = Number(req.url.searchParams.get('limit') ?? 1000)
        return { json: all.slice(offset, offset + limit) }
      },
      { pageSize: 2 },
    )
    const stations = await store.listStations()
    expect(stations.map((s) => s.id)).toEqual(all.map((r) => r.data.id))
    expect(requests).toHaveLength(3)
    expect(requests.map((r) => r.url.searchParams.get('offset'))).toEqual(['0', '2', '4'])
    expect(requests[0]!.url.searchParams.get('order')).toBe('id.asc')
  })

  it('joins the latest_readings view with stations and normalises timestamps', async () => {
    const { store, requests } = makeStore((req) => {
      if (req.table === 'stations') return { json: [{ data: station(1) }, { data: station(2) }] }
      if (req.table === 'latest_readings') {
        return {
          json: [{ station_id: station(1).id, observed_at: '2026-10-03T04:10:00+00:00', water_level: '0.55', freeboard: 0.95, pumps_running: null }],
        }
      }
      return undefined
    })
    const latest = await store.latest()
    expect(latest).toHaveLength(2)
    expect(latest[0]!.reading).toMatchObject({ observedAt: '2026-10-03T04:10:00.000Z', waterLevel: 0.55, freeboard: 0.95 })
    expect(latest[1]!.reading).toBeNull()
    expect(requests.map((r) => r.table).sort()).toEqual(['latest_readings', 'stations'])
  })

  it('queries history with in/gte filters ordered by station and time', async () => {
    const { store, requests } = makeStore(() => ({
      json: [
        { station_id: 'a', observed_at: '2026-10-03T03:00:00+00:00', water_level: 0.4 },
        { station_id: 'a', observed_at: '2026-10-03T04:00:00+00:00', water_level: 0.5 },
      ],
    }))
    const h = await store.history(['a', 'b'], '2026-10-03T02:00:00Z')
    expect(h.a!.map((r) => r.waterLevel)).toEqual([0.4, 0.5])
    expect(h.b).toEqual([])
    const q = requests[0]!.url.searchParams
    expect(q.get('station_id')).toBe('in.(a,b)')
    expect(q.get('observed_at')).toBe('gte.2026-10-03T02:00:00.000Z')
    expect(q.get('order')).toBe('station_id.asc,observed_at.asc')
    expect(await store.history([], '2026-10-03T02:00:00Z')).toEqual({})
    expect(requests).toHaveLength(1)
  })

  it('prunes with DELETE and an exact count', async () => {
    const { store, requests } = makeStore(() => ({ status: 200, json: [], headers: { 'content-range': '*/7' } }))
    expect(await store.pruneReadings('2026-10-01T00:00:00Z')).toBe(7)
    const r = requests[0]!
    expect(r.method).toBe('DELETE')
    expect(r.url.searchParams.get('observed_at')).toBe('lt.2026-10-01T00:00:00.000Z')
    expect(r.headers.get('prefer')).toContain('count=exact')
  })

  it('reads and writes meta, health, places, channels, alert state and events', async () => {
    const now = '2026-10-03T04:00:00.000Z'
    const place: Place = {
      id: 'p1',
      label: 'บ้าน',
      lat: 13.72,
      lng: 100.75,
      radiusKm: 3,
      maxStations: 4,
      freeboard: DEFAULT_FREEBOARD,
      rain: DEFAULT_RAIN,
      rapidRiseCm: 10,
      notifyMinLevel: 'warning',
      manageTokenHash: 'h',
      createdAt: now,
      updatedAt: now,
    }
    const ch: Channel = { id: 'c1', placeId: 'p1', type: 'line', target: '', verified: false, linkCode: 'ABC234', createdAt: now }
    const { store, requests } = makeStore((req) => {
      if (req.method !== 'GET') return { status: 201 }
      if (req.table === 'meta') return { json: req.url.searchParams.get('key') === 'eq.lastIngestAt' ? [{ value: now }] : [] }
      if (req.table === 'places') return { json: [{ data: place }] }
      if (req.table === 'channels') return { json: req.url.searchParams.get('link_code') === 'eq.ABC234' ? [{ data: ch }] : [] }
      if (req.table === 'alert_events') return { json: [{ data: { id: 'e1' } }] }
      return { json: [] }
    })

    await store.setMeta('lastIngestAt', now)
    expect(requests.at(-1)!.url.searchParams.get('on_conflict')).toBe('key')
    expect(await store.getMeta('lastIngestAt')).toBe(now)
    expect(await store.getMeta('missing')).toBeNull()

    await store.setSourceHealth({ source: 'bma-canal', ok: true, lastAttemptAt: now })
    expect(requests.at(-1)!.table).toBe('source_health')

    await store.createPlace(place)
    expect(requests.at(-1)!.body).toMatchObject({ id: 'p1', created_at: now, data: { label: 'บ้าน' } })
    expect((await store.getPlace('p1'))?.label).toBe('บ้าน')

    await store.addChannel(ch)
    expect(requests.at(-1)!.body).toMatchObject({ id: 'c1', place_id: 'p1', type: 'line', link_code: 'ABC234' })
    expect((await store.findChannelByLinkCode('ABC234'))?.id).toBe('c1')
    expect(await store.findChannelByLinkCode('ZZZZZZ')).toBeNull()

    await store.updateChannel({ ...ch, verified: true, linkCode: null, target: 'U1' })
    const upd = requests.at(-1)!
    expect(upd.method).toBe('PATCH')
    expect(upd.url.searchParams.get('id')).toBe('eq.c1')
    expect(upd.body).toMatchObject({ link_code: null, data: { verified: true } })

    const states: AlertState[] = [
      { placeId: 'p1', key: 'rain', level: 'normal', updatedAt: now },
      { placeId: 'p1', key: 'rain', level: 'watch', updatedAt: now },
    ]
    await store.setAlertStates(states)
    const st = requests.at(-1)!
    expect(st.url.searchParams.get('on_conflict')).toBe('place_id,key')
    expect((st.body as unknown[]).length).toBe(1)

    await store.appendAlertEvent({ id: 'e1', placeId: 'p1', kind: 'test', level: 'normal', title: 't', body: 'b', stationIds: [], createdAt: now })
    expect(requests.at(-1)!.body).toMatchObject({ id: 'e1', place_id: 'p1' })
    const events = await store.listAlertEvents('p1', 9999)
    expect(events).toEqual([{ id: 'e1' }])
    const evq = requests.at(-1)!.url.searchParams
    expect(evq.get('order')).toBe('created_at.desc')
    expect(evq.get('limit')).toBe('500')

    const before = requests.length
    await store.deletePlace('p1')
    const dels = requests.slice(before)
    expect(dels.map((r) => `${r.method} ${r.table}`)).toEqual([
      'DELETE channels',
      'DELETE alert_states',
      'DELETE alert_events',
      'DELETE places',
    ])
  })

  it('throws with the table name on PostgREST errors', async () => {
    const { store } = makeStore(() => ({ status: 400, json: { message: 'relation "public.meta" does not exist', code: '42P01' } }))
    await expect(store.setMeta('k', 'v')).rejects.toThrow(/supabase meta: relation/)
  })
})
