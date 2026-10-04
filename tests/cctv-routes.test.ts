import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfigCache } from '@/lib/config'
import { saveCameraCatalog } from '@/lib/cameras/catalog'
import { renderDemoCameraSvg, DEMO_WATERMARK } from '@/lib/server/cctv-demo-image'
import { CCTV_POLICY, clearCctvCache } from '@/lib/server/cctv-proxy'
import type { CamerasResponse } from '@/lib/server/public'
import { rateLimiter } from '@/lib/server/rate-limit'
import { demoCameraCatalog } from '@/lib/sources/cameras/demo'
import { demoCanal, demoRoadFlood } from '@/lib/sources/demo'
import { __setStoreForTests } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Camera, CameraRef, CameraSourceId, Station } from '@/lib/types'

import * as camerasRoute from '@/app/api/cctv/cameras/route'
import * as imageRoute from '@/app/api/cctv/image/[source]/[file]/route'
import * as healthRoute from '@/app/api/health/route'

// /api/cctv/cameras, /api/cctv/image/[source]/[file] and the cameras part of /api/health,
// invoked directly against an in-memory SQLite store. Catalogues are seeded through
// saveCameraCatalog; every camera, reference and frame is synthetic (example.invalid hosts,
// JPEG-shaped bytes). Outbound HTTP goes to a stubbed global fetch.

const ENV = {
  DATA_MODE: 'live',
  STORE: 'sqlite',
  PUBLIC_BASE_URL: 'https://flood.example.org',
  TRUST_PROXY: 'xff',
  CCTV_SOURCES: '',
  CCTV_IMAGES: '',
}
const saved: Record<string, string | undefined> = {}

async function withEnv<T>(over: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(over)) {
    before[k] = process.env[k]
    process.env[k] = v
  }
  resetConfigCache()
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetConfigCache()
  }
}

// --- synthetic catalogue ----------------------------------------------------------------------

const HOME = { lat: 13.7563, lng: 100.5018 }

function cam(source: CameraSourceId, nativeId: string, lat: number, lng: number, extra: Partial<Camera> = {}): Camera {
  return {
    id: `${source}:${nativeId}`,
    source,
    nativeId,
    siteId: `${source}:${lat.toFixed(5)},${lng.toFixed(5)}`,
    name: 'ปากซอยทดสอบ 62',
    code: null,
    angle: null,
    owner: source === 'dwr-cctv' ? 'กรมทรัพยากรน้ำ' : 'สำนักการระบายน้ำ กทม.',
    lat,
    lng,
    facing: 'road',
    nearStationIds: [],
    officialUrl: source === 'dwr-cctv' ? 'https://telemetry.dwr.go.th/reportCctv' : 'https://floodbangkok.bangkok.go.th/',
    cadenceMin: null,
    ...extra,
  }
}

const BMA_CAMS: Camera[] = [
  cam('bma-floodcam', '101', HOME.lat, HOME.lng, { code: 'CM3-TT-01-C1', angle: 'มุม 1' }),
  cam('bma-floodcam', '102', HOME.lat, HOME.lng, { code: 'CM3-TT-01-C2', angle: 'มุม 2' }),
  cam('bma-floodcam', '103', HOME.lat, HOME.lng, { code: 'CM3-TT-01-C3', angle: 'มุม 3' }),
  cam('bma-floodcam', '201', 13.76, 100.505, { name: 'แยกทดสอบ' }), // ≈ 0.55 km
  cam('bma-floodcam', '301', 13.77, 100.53, { name: 'สะพานทดสอบ', facing: 'water' }), // ≈ 3.4 km
  cam('bma-floodcam', '401', 13.95, 100.65, { name: 'ชุมชนทดสอบ' }), // ≈ 27 km
]
// Credential-shaped references (never real): the responses must never contain any of them.
const BMA_REFS: CameraRef[] = BMA_CAMS.map((c) => ({ cameraId: c.id, ref: `rtsp://admin:pw${c.nativeId}@cam${c.nativeId}.example.invalid:554/LiveStream` }))
const DWR_CAMS: Camera[] = [cam('dwr-cctv', 'TA100220', 13.738694, 100.49633, { name: 'สะพานพระพุทธยอดฟ้า', facing: 'water', cadenceMin: 15 })] // ≈ 2 km
const DWR_REFS: CameraRef[] = [{ cameraId: 'dwr-cctv:TA100220', ref: '0b8f5a2e-1111-4222-8333-944455556666' }]
const FETCHED_AT = '2026-10-04T03:00:00.000Z'

/** A road-flood sensor at the first camera site (joined to cameras 101–103 when the list is saved). */
const ROAD_SENSOR: Station = {
  id: 'road:FL.TEST.01',
  source: 'bma-roadflood',
  kind: 'roadflood',
  name: 'จุดวัดน้ำบนถนนทดสอบ',
  lat: HOME.lat,
  lng: HOME.lng,
  agency: 'สำนักการระบายน้ำ กทม.',
}

async function seedLive(opts: { refs?: boolean } = {}) {
  const refs = opts.refs ?? true
  await store.upsertStations([ROAD_SENSOR])
  const bma = { source: 'bma-floodcam' as const, fetchedAt: FETCHED_AT, cameras: BMA_CAMS }
  const dwr = { source: 'dwr-cctv' as const, fetchedAt: FETCHED_AT, cameras: DWR_CAMS }
  await saveCameraCatalog(store, refs ? { ...bma, refs: BMA_REFS, warnings: [] } : bma)
  await saveCameraCatalog(store, refs ? { ...dwr, refs: DWR_REFS, warnings: [] } : dwr)
}

// --- request helpers --------------------------------------------------------------------------

/** Minimal JPEG-shaped bytes (SOI, APP0, SOF0, scan, EOI). */
function jpeg(w = 352, h = 288, seed = 0): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, seed & 0xff, 0x00,
    0xff, 0xd9,
  ])
}

let store: SqliteStore
let outbound: string[] = []
let upstreamDown = false

function stubFetch() {
  outbound = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    outbound.push(url)
    if (upstreamDown) throw new TypeError('fetch failed')
    if (url.startsWith('https://floodbangkok.bangkok.go.th/api/proxy?rtcUrl=')) return new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } })
    if (url.startsWith('https://telemetry.dwr.go.th/api/public/reportCctv/snapshot/')) return Response.json({ value: '/TA100220/2026/10/4/10_15.jpg' })
    if (url === 'https://telemetry.dwr.go.th/api/file/image/cctv') return new Response(jpeg(704, 576))
    throw new TypeError(`fetch failed (blocked in tests): ${url}`)
  })
}

const BASE = 'http://localhost'
const req = (path: string, ip = '203.0.113.7') => new Request(`${BASE}${path}`, { headers: { 'x-forwarded-for': ip } })
const ctx = (source: string, file: string) => ({ params: Promise.resolve({ source, file }) })
const image = (source: string, file: string, ip?: string) => imageRoute.GET(req(`/api/cctv/image/${source}/${file}`, ip), ctx(source, file))
const cameras = async (query = '', ip?: string) => {
  const res = await camerasRoute.GET(req(`/api/cctv/cameras${query}`, ip))
  return { res, body: (await res.json()) as CamerasResponse & { error?: string } }
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  resetConfigCache()
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetConfigCache()
  __setStoreForTests(null)
  vi.unstubAllGlobals()
})

beforeEach(() => {
  store = new SqliteStore(':memory:')
  __setStoreForTests(store)
  rateLimiter().reset()
  clearCctvCache()
  upstreamDown = false
  stubFetch()
})

// --- GET /api/cctv/cameras --------------------------------------------------------------------

describe('GET /api/cctv/cameras', () => {
  it('lists every camera for the map, with same-origin image URLs for sources this host fetched', async () => {
    await seedLive()
    const { res, body } = await cameras()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('public')
    expect(body.cameras).toHaveLength(BMA_CAMS.length + DWR_CAMS.length)
    expect(body.cameras.every((c) => c.distanceKm === null)).toBe(true)
    expect(body.nearestOutsideKm).toBeNull()
    expect(body.catalogAt).toEqual({ 'bma-floodcam': FETCHED_AT, 'dwr-cctv': FETCHED_AT })
    expect(body.cameras.filter((c) => c.nearStationIds.includes('road:FL.TEST.01')).map((c) => c.nativeId)).toEqual(['101', '102', '103'])
    const c101 = body.cameras.find((c) => c.id === 'bma-floodcam:101')!
    expect(c101).toMatchObject({ media: 'image', imageUrl: '/api/cctv/image/bma-floodcam/101.jpg', refreshSec: 60, nearStationIds: ['road:FL.TEST.01'] })
    expect(body.cameras.find((c) => c.source === 'dwr-cctv')).toMatchObject({ media: 'image', imageUrl: '/api/cctv/image/dwr-cctv/TA100220.jpg', refreshSec: 300 })
    expect(body.links.map((l) => l.id)).toEqual(['dds-cctv', 'bma-traffic', 'dwr-cctv', 'rid-wmsc', 'doh-highway'])
    expect(body.links.every((l) => /^https?:\/\//.test(l.url) && /[฀-๿]/.test(l.title))).toBe(true)
    expect(outbound).toHaveLength(0)
  })

  it('returns the nearest sites within the radius with every angle, and the nearest camera outside', async () => {
    await seedLive()
    const { body } = await cameras(`?lat=${HOME.lat}&lng=${HOME.lng}`)
    expect(body.cameras.map((c) => c.id)).toEqual([
      'bma-floodcam:101',
      'bma-floodcam:102',
      'bma-floodcam:103',
      'bma-floodcam:201',
      'dwr-cctv:TA100220',
    ])
    expect(body.cameras[0]!.distanceKm).toBe(0)
    expect(body.cameras[3]!.distanceKm).toBeCloseTo(0.55, 1)
    expect(body.nearestOutsideKm).toBeGreaterThan(3)
    expect(body.nearestOutsideKm).toBeLessThan(4)

    const one = await cameras(`?lat=${HOME.lat}&lng=${HOME.lng}&n=1`)
    expect(one.body.cameras.map((c) => c.nativeId)).toEqual(['101', '102', '103'])
    const small = await cameras(`?lat=${HOME.lat}&lng=${HOME.lng}&r=0.5`)
    expect(small.body.cameras.map((c) => c.siteId)).toEqual(Array(3).fill(BMA_CAMS[0]!.siteId))
    expect(small.body.nearestOutsideKm).toBeCloseTo(0.55, 1)
    const wide = await cameras(`?lat=${HOME.lat}&lng=${HOME.lng}&r=50&n=100`)
    expect(wide.body.cameras).toHaveLength(BMA_CAMS.length + DWR_CAMS.length - 1) // r is capped at 20 km
  })

  it('validates the query', async () => {
    expect((await cameras('?lat=13.7')).res.status).toBe(400)
    const outside = await cameras('?lat=35.6&lng=139.7')
    expect(outside.res.status).toBe(400)
    expect(outside.body.error).toBe('ตำแหน่งต้องอยู่ในประเทศไทย')
    expect((await cameras(`?lat=${HOME.lat}&lng=${HOME.lng}&r=abc`)).res.status).toBe(400)
  })

  it('links out (no image URL) for relayed catalogues and when CCTV_IMAGES=0', async () => {
    await seedLive({ refs: false })
    const relayed = await cameras()
    expect(relayed.body.cameras.length).toBeGreaterThan(0)
    expect(relayed.body.cameras.every((c) => c.media === 'link' && c.imageUrl === null)).toBe(true)

    await seedLive()
    await withEnv({ CCTV_IMAGES: '0' }, async () => {
      const { body } = await cameras()
      expect(body.cameras.every((c) => c.media === 'link' && c.imageUrl === null)).toBe(true)
    })
  })

  it('follows CCTV_SOURCES', async () => {
    await seedLive()
    await withEnv({ CCTV_SOURCES: 'none' }, async () => {
      const { body } = await cameras()
      expect(body.cameras).toEqual([])
      expect(body.catalogAt).toEqual({})
    })
    await withEnv({ CCTV_SOURCES: 'dwr-cctv' }, async () => {
      const { body } = await cameras()
      expect(body.cameras.map((c) => c.source)).toEqual(['dwr-cctv'])
    })
  })

  it('is rate limited per client IP', async () => {
    await seedLive()
    for (let i = 0; i < 30; i++) expect((await cameras('', '198.51.100.1')).res.status).toBe(200)
    const limited = await cameras('', '198.51.100.1')
    expect(limited.res.status).toBe(429)
    expect(limited.res.headers.get('retry-after')).toBeTruthy()
    expect((await cameras('', '198.51.100.2')).res.status).toBe(200)
  })
})

// --- GET /api/cctv/image/[source]/[file] ------------------------------------------------------

describe('GET /api/cctv/image', () => {
  it('serves a proxied BMA still with freshness and safety headers', async () => {
    await seedLive()
    const res = await image('bma-floodcam', '101.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=(59|60)$/)
    expect(res.headers.get('x-cctv-fetched-at')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(res.headers.get('x-cctv-changed-at')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(jpeg())
    expect(outbound).toEqual([`https://floodbangkok.bangkok.go.th/api/proxy?rtcUrl=${encodeURIComponent(BMA_REFS[0]!.ref)}`])
    // A second viewer is served from the shared cache.
    expect((await image('bma-floodcam', '101.jpg', '198.51.100.9')).status).toBe(200)
    expect(outbound).toHaveLength(1)
  })

  it('serves DWR stills with the capture time', async () => {
    await seedLive()
    const res = await image('dwr-cctv', 'TA100220.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-cctv-captured-at')).toBe('2026-10-04T03:15:00.000Z')
    expect(outbound).toEqual([
      'https://telemetry.dwr.go.th/api/public/reportCctv/snapshot/0b8f5a2e-1111-4222-8333-944455556666',
      'https://telemetry.dwr.go.th/api/file/image/cctv',
    ])
  })

  it('answers 404 without any upstream request for unknown, malformed, disabled or link-only cameras', async () => {
    await seedLive()
    const notFound = await image('bma-floodcam', '999.jpg')
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ error: 'ไม่พบกล้องนี้', reason: 'not-found' })
    for (const [source, file] of [
      ['bma-floodcam', '101.svg'],
      ['bma-floodcam', '101'],
      ['bma-floodcam', '..%2F101.jpg'],
      ['popnix', '101.jpg'],
      ['demo-cam', '1.svg'], // not in fixture mode
    ] as const) {
      expect((await image(source, file)).status).toBe(404)
    }
    await withEnv({ CCTV_SOURCES: 'dwr-cctv' }, async () => expect((await image('bma-floodcam', '101.jpg')).status).toBe(404))
    await withEnv({ CCTV_IMAGES: '0' }, async () => expect((await image('bma-floodcam', '101.jpg')).status).toBe(404))
    expect(outbound).toHaveLength(0)

    store = new SqliteStore(':memory:')
    __setStoreForTests(store)
    await seedLive({ refs: false })
    expect((await image('bma-floodcam', '101.jpg')).status).toBe(404)
    expect(outbound).toHaveLength(0)
  })

  it('limits each client to 60 image requests a minute (429, not cached by shared caches)', async () => {
    await seedLive()
    for (let i = 0; i < 60; i++) expect((await image('bma-floodcam', '101.jpg', '198.51.100.3')).status).toBe(200)
    const limited = await image('bma-floodcam', '101.jpg', '198.51.100.3')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    expect(limited.headers.get('cache-control')).toBe('no-store')
    expect(((await limited.json()) as { error: string }).error).toMatch(/[฀-๿]/)
    expect((await image('bma-floodcam', '101.jpg', '198.51.100.4')).status).toBe(200)
    expect(outbound).toHaveLength(1)
  })

  it('answers Thai JSON 502 when the camera cannot be reached and 503 when the budget is spent', async () => {
    await seedLive()
    upstreamDown = true
    const down = await image('bma-floodcam', '101.jpg')
    expect(down.status).toBe(502)
    expect(down.headers.get('cache-control')).toBe('public, max-age=30')
    expect(await down.json()).toEqual({ error: 'ติดต่อกล้องไม่ได้ในขณะนี้', reason: 'unreachable' })

    upstreamDown = false
    const policy = CCTV_POLICY['bma-floodcam']
    const budget = policy.hourlyBudget
    policy.hourlyBudget = 1 // the failed attempt above used it
    try {
      const paused = await image('bma-floodcam', '102.jpg')
      expect(paused.status).toBe(503)
      expect(paused.headers.get('retry-after')).toBe('60')
      expect(await paused.json()).toEqual({ error: 'ระบบพักการดึงภาพชั่วคราว', reason: 'budget' })
    } finally {
      policy.hourlyBudget = budget
    }
    expect(outbound).toHaveLength(1)
  })
})

// --- demo mode ----------------------------------------------------------------------------------

describe('demo-cam (DATA_MODE=fixture)', () => {
  const now = new Date()
  const demoCams: Camera[] = [
    // Driven by its ref (the simulated station id); placed far from it so only the ref can match.
    cam('demo-cam', '1', 13.75, 100.75, { name: 'กล้องจำลอง · ถ.อ่อนนุช (ซ.อ่อนนุช 65)', owner: 'ข้อมูลสาธิต (จำลอง)' }),
    cam('demo-cam', '2', 13.72396, 100.68956, { name: 'กล้องจำลอง · คลองประเวศบุรีรมย์', owner: 'ข้อมูลสาธิต (จำลอง)', facing: 'water', nearStationIds: ['canal:WL.PWT.03'] }),
  ]

  async function seedDemo() {
    for (const r of [demoRoadFlood(now, 1), demoCanal(now, 1)]) {
      await store.upsertStations(r.stations)
      await store.insertReadings(r.readings)
    }
    const refs = [{ cameraId: 'demo-cam:1', ref: 'road:DEMO.FL.02' }]
    await saveCameraCatalog(store, { source: 'demo-cam', fetchedAt: now.toISOString(), cameras: demoCams, refs, warnings: [] })
  }

  it('lists demo cameras with generated SVG images and serves them with the watermark', async () => {
    await withEnv({ DATA_MODE: 'fixture' }, async () => {
      await seedDemo()
      const { body } = await cameras()
      expect(body.cameras.map((c) => c.imageUrl)).toEqual(['/api/cctv/image/demo-cam/1.svg', '/api/cctv/image/demo-cam/2.svg'])
      expect(body.catalogAt).toEqual({ 'demo-cam': now.toISOString() })

      for (const file of ['1.svg', '2.svg']) {
        const res = await image('demo-cam', file)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
        expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        const svg = await res.text()
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
        expect(svg).toContain(DEMO_WATERMARK)
        expect(svg).not.toMatch(/<script|<image|href=|<style|on\w+=/i)
      }
      const road = await (await image('demo-cam', '1.svg')).text()
      expect(road).toContain('น้ำบนถนน (จำลอง)')
      expect(road).toContain('จำลองจาก: ถ.อ่อนนุช (ซ.อ่อนนุช 65)')
      const canal = await (await image('demo-cam', '2.svg')).text()
      expect(canal).toContain('ระยะห่างตลิ่ง (จำลอง)')
      expect(canal).toContain('จำลองจาก: ปตร. คลองประเวศบุรีรมย์')
      expect((await image('demo-cam', '1.jpg')).status).toBe(404)
      expect(outbound).toHaveLength(0)
    })
  })

  it('serves every camera of the simulated catalogue', async () => {
    await withEnv({ DATA_MODE: 'fixture' }, async () => {
      for (const r of [demoRoadFlood(now, 1), demoCanal(now, 1)]) {
        await store.upsertStations(r.stations)
        await store.insertReadings(r.readings)
      }
      expect((await saveCameraCatalog(store, demoCameraCatalog(now))).saved).toBe(true)
      const { body } = await cameras()
      expect(body.cameras.length).toBeGreaterThan(0)
      for (const c of body.cameras) {
        expect(c).toMatchObject({ source: 'demo-cam', media: 'image', refreshSec: 60 })
        const res = await image('demo-cam', c.imageUrl!.split('/').pop()!)
        expect(res.status).toBe(200)
        const svg = await res.text()
        expect(svg).toContain(DEMO_WATERMARK)
        expect(svg).toMatch(/น้ำบนถนน \(จำลอง\)|ระยะห่างตลิ่ง \(จำลอง\)/)
      }
      expect(outbound).toHaveLength(0)
    })
  })

  it('draws the water band from the simulated reading and never labels the picture as live', () => {
    const camera = { name: 'กล้อง <ทดสอบ> & "x"', facing: 'road' as const }
    const station = { kind: 'roadflood' as const, name: 'ถ.ทดสอบ' }
    const at = (cm: number) => renderDemoCameraSvg({ camera, station, reading: { stationId: 'road:X', observedAt: now.toISOString(), roadFloodCm: cm }, now })
    const dry = at(0)
    const wet = at(30)
    expect(dry).not.toContain('fill="#2563eb"')
    expect(wet).toContain('fill="#2563eb"')
    expect(wet).toContain('น้ำบนถนน (จำลอง) 30 ซม.')
    expect(wet).toContain('กล้อง &lt;ทดสอบ&gt; &amp; &quot;x&quot;')
    const none = renderDemoCameraSvg({ camera, station: null, reading: null, now })
    expect(none).toContain('ยังไม่มีข้อมูลจำลองของจุดนี้')
    for (const svg of [dry, wet, none]) {
      expect(svg).toContain(DEMO_WATERMARK)
      expect(svg).not.toMatch(/สด|LIVE/i)
    }
  })
})

// --- health and secrets -------------------------------------------------------------------------

describe('cameras in /api/health', () => {
  it('reports catalogue and aggregate image counters without changing ok', async () => {
    await seedLive()
    await image('bma-floodcam', '101.jpg')
    const res = await healthRoute.GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; cameras: { source: string; count: number; images: boolean; frames1h: { ok: number } | null }[] }
    expect(body.ok).toBe(true)
    const bma = body.cameras.find((c) => c.source === 'bma-floodcam')!
    expect(bma).toMatchObject({ count: BMA_CAMS.length, catalogAt: FETCHED_AT, images: true })
    expect(bma.frames1h).toMatchObject({ ok: 1, fail: 0, budgetLeft: CCTV_POLICY['bma-floodcam'].hourlyBudget - 1 })
    expect(body.cameras.find((c) => c.source === 'dwr-cctv')).toMatchObject({ count: 1, images: true })
  })
})

describe('no upstream references in any response', () => {
  it('never serialises LiveStream values, stream URLs or credentials', async () => {
    await seedLive()
    await image('bma-floodcam', '101.jpg')
    await image('dwr-cctv', 'TA100220.jpg')
    const texts: string[] = []
    for (const q of ['', `?lat=${HOME.lat}&lng=${HOME.lng}`, `?lat=${HOME.lat}&lng=${HOME.lng}&r=20&n=24`]) {
      texts.push(await (await camerasRoute.GET(req(`/api/cctv/cameras${q}`))).text())
    }
    texts.push(await (await healthRoute.GET()).text())
    await withEnv({ CCTV_IMAGES: '0' }, async () => {
      texts.push(await (await camerasRoute.GET(req('/api/cctv/cameras', '198.51.100.20'))).text())
      texts.push(await (await healthRoute.GET()).text())
    })
    expect(texts).toHaveLength(6)
    for (const text of texts) {
      for (const r of [...BMA_REFS, ...DWR_REFS]) expect(text).not.toContain(r.ref)
      expect(text).not.toMatch(/rtsp:|rtmp:|LiveStream|dyndns|@/i)
    }
  })
})
