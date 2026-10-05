import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/lib/config'
import { CAMERA_ADAPTERS, getCameraSources } from '@/lib/sources/cameras'
import {
  BMA_FLOODCAM_LIST_URL,
  bmaFloodcamSource,
  facingFromName,
  isValidLiveStream,
  parseBmaCameraProfile,
  splitCameraName,
} from '@/lib/sources/cameras/bma-floodcam'
import { cameraNativeId, pointIn, redactSecrets } from '@/lib/sources/cameras/common'
import { demoCameraCatalog, demoCamSource } from '@/lib/sources/cameras/demo'
import {
  DWR_LIST_URL,
  DWR_LOOKUP_SPACING_MS,
  dwrStationUrl,
  fetchDwrCatalog,
  parseDwrListItem,
  parseDwrListPage,
  parseDwrStationPoint,
} from '@/lib/sources/cameras/dwr'
import { demoCanal, demoRoadFlood } from '@/lib/sources/demo'
import { HttpError } from '@/lib/sources/http'

// Camera catalogue adapters. Every fixture is synthesized (fake example.invalid streams, fake
// dyndns.invalid credential links); nothing here touches the network.

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))
const NOW = new Date('2026-10-04T03:00:00.000Z')
const noSleep = async () => {}

interface Call {
  url: string
  method: string
  headers: Headers
  body: string
}

/** fetch stub: `routes(url, call)` returns a Response, or throws for "network" failures. */
function stubFetch(routes: (url: string, call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? String(init.body) : '' }
    calls.push(call)
    return routes(call.url, call)
  }) as typeof fetch
  return { fetch: f, calls }
}

const SECRET_NEEDLES = ['rtsp:', 'example.invalid/cam', 'user:pass', 'admin:secret', 'dyndns', '@', 'cctvSnapshotLink', 'cctvVideoLink', 'fixture-secret', '10.0.0.9', 'LiveStream']

function expectNoSecrets(value: unknown) {
  const json = JSON.stringify(value)
  for (const needle of SECRET_NEEDLES) expect(json, `leaked ${needle}`).not.toContain(needle)
}

describe('BMA flood-watch camera list (camera_profile)', () => {
  const out = parseBmaCameraProfile(load('bma-camera-profile.json'), NOW)
  const byId = new Map(out.cameras.map((c) => [c.nativeId, c]))

  it('keeps only rows with a valid stream and Bangkok coordinates', () => {
    expect(out.cameras).toHaveLength(17)
    expect(out.refs).toHaveLength(17)
    for (const id of ['901', '902', '903', '904', '905']) expect(byId.has(id)).toBe(false)
    expect(out.warnings).toEqual([
      'skipped 3 camera row(s) without a usable stream',
      'skipped 2 camera row(s) outside Bangkok or without coordinates',
      'skipped 1 malformed camera row(s)',
      'skipped 1 duplicate camera id(s)',
    ])
    expect(out.fetchedAt).toBe(NOW.toISOString())
  })

  it('strips the code prefix, the CAM suffix and list numbering from the display name', () => {
    expect(byId.get('101')).toMatchObject({
      id: 'bma-floodcam:101',
      name: 'สะพานข้ามคลองแสนแสบ ซอยลาดพร้าว 122 (มหาดไทย)',
      code: 'CM1-WL-50-C1',
      owner: 'สำนักการระบายน้ำ กทม.',
      officialUrl: 'https://floodbangkok.bangkok.go.th/',
      nearStationIds: [],
      cadenceMin: null,
    })
    expect(byId.get('402')!.name).toBe('ตรงข้ามนวมินทร์ 2')
    expect(byId.get('601')).toMatchObject({ name: 'บางเขนใหม่', code: null })
    // The whole name in both fields is not doubled.
    expect(byId.get('701')).toMatchObject({ name: 'บริเวณหน้าบ้านสบายสปา สุขุมวิท 26', code: 'SB-KT-10-C1' })
  })

  it('accepts numbers or numeric strings, swapped lat/lng, and hashes unsafe ids', () => {
    expect(byId.get('103')).toMatchObject({ lat: 13.7634, lng: 100.624 })
    expect(byId.get('803')).toMatchObject({ lat: 13.72729, lng: 100.5743 })
    const hashed = out.cameras.find((c) => c.code === 'SB-BN-12-C2')!
    expect(hashed.nativeId).toMatch(/^[0-9a-f]{16}$/)
    expect(hashed.nativeId).toBe(cameraNativeId('../cam 804'))
    // Code-only camera alone at its spot: a generic Thai name.
    expect(hashed.name).toBe('กล้อง SB-BN-12-C2')
  })

  it('groups angles by site: numbers from -Cn on one pole, sequential across poles', () => {
    const site = (id: string) => byId.get(id)!.siteId
    expect(site('101')).toBe('bma-floodcam:13.76340,100.62400')
    expect(site('102')).toBe(site('101'))
    expect(site('103')).toBe(site('101'))
    expect(['101', '102', '103'].map((id) => byId.get(id)!.angle)).toEqual(['มุม 1', 'มุม 2', 'มุม 3'])
    // CM2-SL-102-C3 and CM3-SL-65-C1 share a spot but not a pole.
    expect(site('201')).toBe(site('202'))
    expect([byId.get('201')!.angle, byId.get('202')!.angle]).toEqual(['มุม 1', 'มุม 2'])
    // A single camera at its spot has no angle label.
    expect(byId.get('401')!.angle).toBeNull()
    expect(byId.get('402')!.angle).toBeNull()
  })

  it('lets a code-only camera borrow the name of its site', () => {
    expect(byId.get('502')).toMatchObject({ name: 'ชุมชนสามัคคีร่วมใจ (1)', code: 'CM1-JJ-51-C1' })
  })

  it('guesses what a camera faces from its name', () => {
    expect(byId.get('101')!.facing).toBe('water') // สะพานข้ามคลอง…
    expect(byId.get('802')!.facing).toBe('water') // เชิงสะพานคลองลาดพร้าว
    expect(byId.get('801')!.facing).toBe('road') // สะพานลอย (footbridge over a road)
    expect(byId.get('301')!.facing).toBe('road')
    expect(facingFromName('แยกคลองตัน')).toBe('road')
    expect(facingFromName('ถนนคลองเตย')).toBe('road')
    expect(facingFromName('สถานีสูบน้ำพระโขนง')).toBe('water')
    expect(facingFromName('ปตร. คลองแสนแสบ')).toBe('water')
  })

  it('keeps LiveStream only as a server-side ref; the public cameras carry no upstream field', () => {
    expect(out.refs.find((r) => r.cameraId === 'bma-floodcam:101')!.ref).toBe('rtsp://example.invalid/cam/101')
    expectNoSecrets(out.cameras)
    for (const c of out.cameras) {
      expect(Object.keys(c).sort()).toEqual(
        ['angle', 'cadenceMin', 'code', 'facing', 'id', 'lat', 'lng', 'name', 'nativeId', 'nearStationIds', 'officialUrl', 'owner', 'siteId', 'source'].sort(),
      )
    }
  })

  it('accepts a bare array and rejects other shapes or a list without usable rows', () => {
    expect(parseBmaCameraProfile(load('bma-camera-profile.json').data, NOW).cameras).toHaveLength(17)
    expect(() => parseBmaCameraProfile({ errors: [{ message: 'forbidden' }] }, NOW)).toThrow(/expected \{data/)
    expect(() => parseBmaCameraProfile({ data: [{ id: 1, LiveStream: null, Lat: 13.7, Long: 100.5 }] }, NOW)).toThrow(/no usable camera/)
  })

  it('validates stream addresses', () => {
    expect(isValidLiveStream('rtsp://example.invalid/cam/1')).toBe(true)
    expect(isValidLiveStream('https://example.invalid/live/1.m3u8')).toBe(true)
    expect(isValidLiveStream('rtmp://example.invalid/app/1')).toBe(true)
    expect(isValidLiveStream('javascript:alert(1)')).toBe(false)
    expect(isValidLiveStream('file:///etc/passwd')).toBe(false)
    expect(isValidLiveStream('rtsp://example.invalid/a b')).toBe(false)
    expect(isValidLiveStream('rtsp://example.invalid/a\nb')).toBe(false)
    expect(isValidLiveStream(`rtsp://example.invalid/${'x'.repeat(600)}`)).toBe(false)
    expect(isValidLiveStream('')).toBe(false)
    expect(isValidLiveStream(42)).toBe(false)
  })

  it('splits names in every layout seen in the relay copy', () => {
    expect(splitCameraName('CM3-JJ-70-C2', 'ปากซอยงามวงศ์วาน 62-CAM2')).toEqual({ code: 'CM3-JJ-70-C2', name: 'ปากซอยงามวงศ์วาน 62', angleNo: 2 })
    expect(splitCameraName('CM3-JJ-70-C2 ปากซอยงามวงศ์วาน 62-CAM2', null)).toEqual({ code: 'CM3-JJ-70-C2', name: 'ปากซอยงามวงศ์วาน 62', angleNo: 2 })
    expect(splitCameraName('CM5-SL-202-1-C1', 'จุดที่ 2 ชุมชนสถานีสูบน้ำคลองกะจะ-CAM1')).toEqual({
      code: 'CM5-SL-202-1-C1',
      name: 'จุดที่ 2 ชุมชนสถานีสูบน้ำคลองกะจะ',
      angleNo: 1,
    })
    expect(splitCameraName('CM1-KP-41-C4', '41.ซอยรามคำแหง 36/1-CAM4')).toEqual({ code: 'CM1-KP-41-C4', name: 'ซอยรามคำแหง 36/1', angleNo: 4 })
    expect(splitCameraName('SB-BN-12-C2', null)).toEqual({ code: 'SB-BN-12-C2', name: null, angleNo: 2 })
    expect(splitCameraName(null, 'ใต้สะพานพระรามที่ 7 - CAM2')).toEqual({ code: null, name: 'ใต้สะพานพระรามที่ 7', angleNo: 2 })
    expect(splitCameraName(null, null)).toEqual({ code: null, name: null, angleNo: null })
  })

  it('fetches with GET, no Referer/Origin, and parses the list', async () => {
    const { fetch, calls } = stubFetch(() => Response.json(load('bma-camera-profile.json')))
    const res = await bmaFloodcamSource.fetchCatalog({ fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(BMA_FLOODCAM_LIST_URL)
    expect(calls[0]!.url).toContain('items/camera_profile?limit=-1&fields=id,CameraName,LiveStream,Lat,Long,camera_description')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.headers.has('referer')).toBe(false)
    expect(calls[0]!.headers.has('origin')).toBe(false)
    expect(res.cameras).toHaveLength(17)
    expect(bmaFloodcamSource).toMatchObject({ thaiIpOnly: true, refreshHours: 24 })
  })

  it('never quotes the upstream body in an error (truncated lists carry stream addresses)', async () => {
    const truncated = '{"data":[{"id":1,"CameraName":"x","LiveStream":"rtsp://example.invalid/cam/secret-1","Lat":13.7'
    const bad = stubFetch(() => new Response(truncated, { headers: { 'content-type': 'application/json' } }))
    const err = await bmaFloodcamSource.fetchCatalog({ fetch: bad.fetch, now: NOW, timeoutMs: 1000 }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/invalid JSON from floodbangkok\.bangkok\.go\.th/)
    expect((err as Error).message).not.toContain('secret-1')

    const html = stubFetch(() => new Response('<!DOCTYPE html><title>Just a moment...</title>', { headers: { 'content-type': 'text/html' } }))
    await expect(bmaFloodcamSource.fetchCatalog({ fetch: html.fetch, now: NOW, timeoutMs: 1000 })).rejects.toThrow(/HTML instead of JSON/)

    const refused = stubFetch(() => new Response('denied rtsp://example.invalid/cam/2', { status: 403 }))
    const e403 = await bmaFloodcamSource.fetchCatalog({ fetch: refused.fetch, now: NOW, timeoutMs: 1000 }).catch((e: Error) => e)
    expect(e403).toBeInstanceOf(HttpError)
    expect((e403 as Error).message).not.toContain('rtsp')
    expect(refused.calls).toHaveLength(1) // no retry inside one refresh
  })
})

describe('DWR telemetry river cameras', () => {
  const list = load('dwr-cctv-list.json')
  const station = load('dwr-station-TA100220.json')
  /** getByCode payload for any code: the TA100220 fixture with another point. */
  const POINTS: Record<string, { lat: number; lon: number }> = {
    TA100220: { lat: 13.738694, lon: 100.49633 },
    TA100221: { lat: 13.59801, lon: 100.59622 },
    TC100224: { lat: 13.965762, lon: 100.53591 },
    TA100218: { lat: 14.368386, lon: 100.52908 },
    TA130202: { lat: 13.530655, lon: 100.26536 },
    TA100219: { lat: 14.025061, lon: 100.53942 },
  }
  const stationFor = (code: string) => {
    const s = structuredClone(station)
    s.value.fullCon.entity.stationCode = code
    s.value.fullCon.entity.point = POINTS[code] ?? null
    return s
  }
  const routes = (over: Partial<Record<string, () => Response>> = {}) => (url: string) => {
    if (url === DWR_LIST_URL) return Response.json(list)
    const code = decodeURIComponent(url.split('/').pop()!)
    const custom = over[code]
    if (custom) return custom()
    if (url === dwrStationUrl(code)) return Response.json(stationFor(code))
    throw new TypeError(`unexpected ${url}`)
  }

  it('reads list rows through an allowlist (credential links are dropped)', () => {
    const page = parseDwrListPage(list)
    expect(page.totalCount).toBe(8)
    expect(page.items).toHaveLength(8)
    expect(page.items[7]).toBeNull() // no stationCode
    expect(page.items[0]).toEqual({
      snapshotId: '00000000-0000-4000-8000-000000000220',
      stationCode: 'TA100220',
      nameTh: 'สะพานพระพุทธยอดฟ้า',
      nameEn: 'Phra Phuttha Yot Fa Bridge',
      province: 'กรุงเทพมหานคร',
    })
    expect(page.items[1]!.province).toBe('สมุทรปราการ') // "จ." prefix removed
    expectNoSecrets(page.items)
    expect(parseDwrListItem({ entity: { id: 'x y', stationCode: 'TA1' } })).toBeNull()
    expect(() => parseDwrListPage({ status: 'ERROR' })).toThrow(/expected \{value/)
  })

  it('reads station coordinates in either point layout, inside Thailand only', () => {
    expect(parseDwrStationPoint(station)).toEqual({ lat: 13.738694, lng: 100.49633 })
    expect(parseDwrStationPoint({ value: { fullCon: { entity: { point: { type: 'Point', coordinates: [100.5, 13.7] } } } } })).toEqual({ lat: 13.7, lng: 100.5 })
    expect(parseDwrStationPoint({ value: { fullCon: { entity: { point: { lat: '13.7', lon: '100.5' } } } } })).toEqual({ lat: 13.7, lng: 100.5 })
    expect(parseDwrStationPoint({ value: { fullCon: { entity: { point: { lat: 0, lon: 0 } } } } })).toBeNull()
    expect(parseDwrStationPoint({ value: { fullCon: { entity: { point: null } } } })).toBeNull()
    expect(parseDwrStationPoint(null)).toBeNull()
  })

  it('lists with orders:[] (required), looks up in-scope stations ~200 ms apart, and never stores credentials', async () => {
    const { fetch, calls } = stubFetch(routes())
    const sleeps: number[] = []
    const res = await fetchDwrCatalog({ fetch, now: NOW, timeoutMs: 1000, sleep: async (ms) => void sleeps.push(ms) })

    expect(calls[0]!.url).toBe(DWR_LIST_URL)
    expect(calls[0]!.method).toBe('POST')
    expect(JSON.parse(calls[0]!.body)).toEqual({ paginate: { page: 1, pageSize: 200, orders: [] }, search: {} })
    expect(calls[0]!.headers.get('content-type')).toBe('application/json')
    const looked = calls.slice(1).map((c) => decodeURIComponent(c.url.split('/').pop()!))
    // The northern station is out of scope and never looked up.
    expect(looked).toEqual(['TA100220', 'TA100221', 'TC100224', 'TA100218', 'TA130202', 'TA100219'])
    expect(sleeps).toEqual(Array(looked.length - 1).fill(DWR_LOOKUP_SPACING_MS))

    expect(res.cameras.map((c) => c.nativeId)).toEqual(['TA100220', 'TA100221', 'TC100224', 'TA100218', 'TA130202', 'TA100219'])
    expect(res.cameras[0]).toEqual({
      id: 'dwr-cctv:TA100220',
      source: 'dwr-cctv',
      nativeId: 'TA100220',
      siteId: 'dwr-cctv:13.73869,100.49633',
      name: 'สะพานพระพุทธยอดฟ้า',
      code: 'TA100220',
      angle: null,
      owner: 'กรมทรัพยากรน้ำ',
      lat: 13.738694,
      lng: 100.49633,
      facing: 'water',
      nearStationIds: [],
      officialUrl: 'https://telemetry.dwr.go.th/reportCctv',
      cadenceMin: 15,
    })
    // The ref is the snapshot id used by /api/public/reportCctv/snapshot/{id}.
    expect(res.refs[0]).toEqual({ cameraId: 'dwr-cctv:TA100220', ref: '00000000-0000-4000-8000-000000000220' })
    expect(res.warnings).toEqual(['skipped 1 malformed camera row(s)'])
    expectNoSecrets(res)
  })

  it('skips a station whose lookup fails, but stops on a refusal', async () => {
    const flaky = stubFetch(routes({ TA100221: () => new Response('oops', { status: 500 }), TC100224: () => Response.json({ value: {} }) }))
    const res = await fetchDwrCatalog({ fetch: flaky.fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })
    expect(res.cameras.map((c) => c.nativeId)).toEqual(['TA100220', 'TA100218', 'TA130202', 'TA100219'])
    expect(res.warnings).toContain('station lookup failed for 1 camera(s)')
    expect(res.warnings).toContain('skipped 1 camera(s) without coordinates')

    const banned = stubFetch(routes({ TA100221: () => new Response('slow down', { status: 429 }) }))
    await expect(fetchDwrCatalog({ fetch: banned.fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })).rejects.toBeInstanceOf(HttpError)
    expect(banned.calls).toHaveLength(3) // list + TA100220 + TA100221, then stop
  })

  it('keeps the last known position of a station whose lookup fails or gives none; never takes positions from another source', async () => {
    const first = await fetchDwrCatalog({ fetch: stubFetch(routes()).fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })
    const previous = { source: first.source, fetchedAt: first.fetchedAt, cameras: first.cameras }
    const flaky = stubFetch(routes({ TA100220: () => new Response('oops', { status: 502 }), TC100224: () => Response.json({ value: {} }) }))
    const res = await fetchDwrCatalog({ fetch: flaky.fetch, now: NOW, timeoutMs: 1000, sleep: noSleep, previous })
    expect(res.cameras.map((c) => c.nativeId)).toEqual(['TA100220', 'TA100221', 'TC100224', 'TA100218', 'TA130202', 'TA100219'])
    expect(res.cameras[0]).toEqual(first.cameras[0])
    expect(res.refs).toEqual(first.refs)
    expect(res.warnings).toContain('kept the last known position of 2 camera(s) (station lookup failed or gave none)')
    expect(res.warnings.join(' ')).not.toMatch(/lookup failed for/)

    // A previous list of another source (or with odd rows) is ignored.
    const foreign = { ...previous, source: 'bma-floodcam' as const }
    const odd = { ...previous, cameras: previous.cameras.map((c) => ({ ...c, lat: 51.5 })) }
    for (const prev of [foreign, odd]) {
      const r = await fetchDwrCatalog({ fetch: flaky.fetch, now: NOW, timeoutMs: 1000, sleep: noSleep, previous: prev })
      expect(r.cameras.map((c) => c.nativeId)).not.toContain('TA100220')
    }
  })

  it('fails the refresh when more lookups fail than a few (no known position), keeping the last good list', async () => {
    const down = stubFetch(routes({ TA100220: () => new Response('', { status: 503 }), TA100221: () => new Response('', { status: 503 }), TC100224: () => new Response('', { status: 503 }) }))
    await expect(fetchDwrCatalog({ fetch: down.fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })).rejects.toThrow(
      'DWR camera list: station lookup failed for 3 of 6 camera(s); kept the previous list',
    )
    // With their last known positions, the same outage is a complete list.
    const first = await fetchDwrCatalog({ fetch: stubFetch(routes()).fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })
    const res = await fetchDwrCatalog({ fetch: down.fetch, now: NOW, timeoutMs: 1000, sleep: noSleep, previous: first })
    expect(res.cameras).toHaveLength(6)
  })

  it('reads further pages until totalCount', async () => {
    const page1 = { value: { totalCount: 201, results: Array.from({ length: 200 }, (_, i) => ({ entity: { id: `p1-${i}`, stationCode: `TX${i}` }, provinceNameTh: 'เชียงใหม่' })) } }
    const page2 = structuredClone(list)
    page2.value.totalCount = 201
    page2.value.results = [list.value.results[0]]
    const { fetch, calls } = stubFetch((url, call) => {
      if (url === DWR_LIST_URL) return Response.json(JSON.parse(call.body).paginate.page === 1 ? page1 : page2)
      return Response.json(stationFor('TA100220'))
    })
    const res = await fetchDwrCatalog({ fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })
    expect(calls.filter((c) => c.url === DWR_LIST_URL)).toHaveLength(2)
    expect(res.cameras.map((c) => c.id)).toEqual(['dwr-cctv:TA100220'])
  })

  it('fails when nothing usable is left', async () => {
    const { fetch } = stubFetch((url) => (url === DWR_LIST_URL ? Response.json({ value: { totalCount: 0, results: [] } }) : Response.json({})))
    await expect(fetchDwrCatalog({ fetch, now: NOW, timeoutMs: 1000, sleep: noSleep })).rejects.toThrow(/no usable camera/)
  })
})

describe('demo cameras (DATA_MODE=fixture)', () => {
  it('one simulated camera per demo road sensor plus two canal cameras, deterministic', async () => {
    const a = demoCameraCatalog(NOW)
    const b = await demoCamSource.fetchCatalog({ fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch, now: new Date('2027-01-01T00:00:00Z'), timeoutMs: 1 })
    expect(b.cameras).toEqual(a.cameras)
    const roads = demoRoadFlood(NOW, 0).stations
    expect(a.cameras).toHaveLength(roads.length + 2)
    expect(a.cameras.map((c) => c.id)).toEqual(['demo-cam:1', 'demo-cam:2', 'demo-cam:3', 'demo-cam:4', 'demo-cam:5'])
    expect(a.cameras.every((c) => c.name.startsWith('กล้องจำลอง · ') && c.owner === 'ข้อมูลสาธิต (จำลอง)' && c.officialUrl === '/about')).toBe(true)
    expect(a.cameras.map((c) => c.facing)).toEqual(['road', 'road', 'road', 'water', 'water'])
    // Each ref names the demo station whose simulated water drives the generated image.
    const canalIds = new Set(demoCanal(NOW, 0).stations.map((s) => s.id))
    expect(a.refs.slice(0, 3).map((r) => r.ref)).toEqual(roads.map((s) => s.id))
    expect(a.refs.slice(3).every((r) => canalIds.has(r.ref))).toBe(true)
    expect(demoCamSource.refreshHours).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('camera source registry and helpers', () => {
  it('enables sources from CCTV_SOURCES; fixture mode uses only the demo', () => {
    expect(getCameraSources(loadConfig({})).map((a) => a.id)).toEqual(['bma-floodcam', 'bma-ddscam', 'dwr-cctv'])
    expect(getCameraSources(loadConfig({ CCTV_SOURCES: 'dwr-cctv' })).map((a) => a.id)).toEqual(['dwr-cctv'])
    expect(getCameraSources(loadConfig({ CCTV_SOURCES: 'bma-ddscam' })).map((a) => a.id)).toEqual(['bma-ddscam'])
    expect(getCameraSources(loadConfig({ CCTV_SOURCES: 'none' }))).toEqual([])
    expect(getCameraSources(loadConfig({ DATA_MODE: 'fixture' })).map((a) => a.id)).toEqual(['demo-cam'])
    expect(Object.keys(CAMERA_ADAPTERS).sort()).toEqual(['bma-ddscam', 'bma-floodcam', 'demo-cam', 'dwr-cctv'])
  })

  it('native ids, swapped points and secret redaction', () => {
    expect(cameraNativeId(42)).toBe('42')
    expect(cameraNativeId('TA100220')).toBe('TA100220')
    expect(cameraNativeId(-1)).toBeNull()
    expect(cameraNativeId(' ')).toBeNull()
    expect(cameraNativeId({})).toBeNull()
    const box = { minLat: 13, maxLat: 14, minLng: 100, maxLng: 101 }
    expect(pointIn('100.5', 13.5, box)).toEqual({ lat: 13.5, lng: 100.5 })
    expect(pointIn('13.5abc', 100.5, box)).toBeNull()
    expect(redactSecrets('GET rtsp://admin:x@cam.dyndns.invalid/1 failed for user:pass@host')).toBe('GET <url> failed for <redacted>')
  })
})
