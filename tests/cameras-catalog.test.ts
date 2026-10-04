import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_META_PREFIX,
  catalogDue,
  cameraCatalogHealth,
  failureBackoffHours,
  findCamera,
  getCameraRef,
  hasCameraRefs,
  loadCameraCatalogs,
  publicCatalog,
  REFS_META_PREFIX,
  refreshCameraCatalogs,
  saveCameraCatalog,
  STATUS_META_PREFIX,
} from '@/lib/cameras/catalog'
import { joinNearStations, nearStationIds, stationJoinKey } from '@/lib/cameras/join'
import { loadConfig } from '@/lib/config'
import { parseBmaRoadFlood } from '@/lib/sources/bma-misc'
import { BMA_FLOODCAM_LIST_URL, parseBmaCameraProfile } from '@/lib/sources/cameras/bma-floodcam'
import { demoCamSource } from '@/lib/sources/cameras/demo'
import type { CameraCatalogAdapter } from '@/lib/sources/cameras/types'
import { DEMO_SOURCES } from '@/lib/sources/demo'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Camera, CameraCatalogResult, CameraSourceId, Station } from '@/lib/types'

// Camera catalogue storage (Store meta), the < 50 % guard, the station join, scheduling and
// health. Synthesized fixtures only; no network.

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))
const T0 = new Date('2026-10-04T08:00:00.000Z') // 15:00 Bangkok
const HOUR = 3_600_000
const at = (h: number) => new Date(T0.getTime() + h * HOUR)
const liveConfig = loadConfig({ CCTV_SOURCES: 'bma-floodcam,dwr-cctv' })

const bmaFixture = (now = T0) => parseBmaCameraProfile(load('bma-camera-profile.json'), now)
const bmaPartial = (now = T0) => parseBmaCameraProfile(load('bma-camera-profile-partial.json'), now)
const roadStations = () => parseBmaRoadFlood(load('bma-roadflood.json'), T0).stations

/** Everything stored under any cctv:* meta key except the refs key. */
async function publicMeta(store: SqliteStore, source: CameraSourceId): Promise<string> {
  const keys = ['cctv:catalog:', 'cctv:index:', 'cctv:status:'].map((p) => p + source)
  return (await Promise.all(keys.map((k) => store.getMeta(k)))).join('\n')
}

/** Adapter double: returns `make(n)` on the n-th call (1-based); throws what it returns if an Error. */
function fakeAdapter(
  id: CameraSourceId,
  make: (n: number, now: Date) => CameraCatalogResult | Error,
  over: Partial<CameraCatalogAdapter> = {},
): CameraCatalogAdapter & { calls: number } {
  const a = {
    id,
    label: 'ทดสอบ',
    thaiIpOnly: false,
    refreshHours: 24,
    calls: 0,
    async fetchCatalog(ctx: { now: Date }) {
      a.calls++
      const r = make(a.calls, ctx.now)
      if (r instanceof Error) throw r
      return r
    },
    ...over,
  }
  return a
}

function camera(source: CameraSourceId, n: number, over: Partial<Camera> = {}): Camera {
  return {
    id: `${source}:${n}`,
    source,
    nativeId: String(n),
    siteId: `${source}:13.70000,100.50000`,
    name: `กล้อง ${n}`,
    code: null,
    angle: null,
    owner: 'ทดสอบ',
    lat: 13.7 + n * 0.001,
    lng: 100.5,
    facing: 'road',
    nearStationIds: [],
    officialUrl: 'https://telemetry.dwr.go.th/reportCctv',
    cadenceMin: null,
    ...over,
  }
}

function list(source: CameraSourceId, count: number, now: Date, withRefs = true): CameraCatalogResult {
  const cameras = Array.from({ length: count }, (_, i) => camera(source, i + 1))
  return { source, fetchedAt: now.toISOString(), cameras, refs: withRefs ? cameras.map((c) => ({ cameraId: c.id, ref: `ref-${c.nativeId}` })) : [], warnings: [] }
}

describe('saving and loading catalogues', () => {
  it('stores the public list and the refs under separate keys; refs never reach the public part', async () => {
    const store = new SqliteStore(':memory:')
    expect(await saveCameraCatalog(store, bmaFixture(), T0)).toEqual({ saved: true, warning: null })

    const [cat] = await loadCameraCatalogs(store, ['bma-floodcam', 'dwr-cctv'])
    expect(cat!.source).toBe('bma-floodcam')
    expect(cat!.fetchedAt).toBe(T0.toISOString())
    expect(cat!.cameras).toHaveLength(17)
    expect(await loadCameraCatalogs(store, ['dwr-cctv'])).toEqual([]) // missing ones omitted

    const pub = await publicMeta(store, 'bma-floodcam')
    for (const needle of ['rtsp:', 'example.invalid/cam', 'fixture-secret', 'LiveStream']) expect(pub).not.toContain(needle)
    expect(await store.getMeta(REFS_META_PREFIX + 'bma-floodcam')).toContain('rtsp://example.invalid/cam/101')

    expect(await getCameraRef(store, 'bma-floodcam:101')).toBe('rtsp://example.invalid/cam/101')
    expect(await getCameraRef(store, 'bma-floodcam:nope')).toBeNull()
    expect(await getCameraRef(store, 'dwr-cctv:TA100220')).toBeNull()
    expect(await getCameraRef(store, 'garbage')).toBeNull()
    expect(await getCameraRef(store, 'bma-floodcam:../x')).toBeNull()
    expect(await hasCameraRefs(store, 'bma-floodcam')).toBe(true)
    expect(await hasCameraRefs(store, 'dwr-cctv')).toBe(false)
    expect((await findCamera(store, 'bma-floodcam:502'))!.name).toBe('ชุมชนสามัคคีร่วมใจ (1)')
    expect(await findCamera(store, 'bma-floodcam:999')).toBeNull()
    store.close()
  })

  it('caches the parsed list in memory until a new version is saved', async () => {
    const store = new SqliteStore(':memory:')
    await saveCameraCatalog(store, bmaFixture(), T0)
    const get = vi.spyOn(store, 'getMeta')
    const a = await loadCameraCatalogs(store, ['bma-floodcam'])
    const b = await loadCameraCatalogs(store, ['bma-floodcam'])
    expect(b[0]).toBe(a[0])
    // Only the small index is read on a cache hit.
    expect(get.mock.calls.filter(([k]) => k === CATALOG_META_PREFIX + 'bma-floodcam').length).toBeLessThanOrEqual(1)
    await saveCameraCatalog(store, bmaFixture(at(25)), at(25))
    const c = await loadCameraCatalogs(store, ['bma-floodcam'])
    expect(c[0]).not.toBe(a[0])
    expect(c[0]!.fetchedAt).toBe(at(25).toISOString())
    store.close()
  })

  it('refuses a list with fewer than half the cameras; the first save is always accepted', async () => {
    const store = new SqliteStore(':memory:')
    await saveCameraCatalog(store, bmaFixture(), T0)
    const res = await saveCameraCatalog(store, bmaPartial(at(25)), at(25))
    expect(res.saved).toBe(false)
    expect(res.warning).toMatch(/only 3 of 17 cameras \(< 50%\)/)
    expect((await loadCameraCatalogs(store, ['bma-floodcam']))[0]!.cameras).toHaveLength(17)
    expect(await getCameraRef(store, 'bma-floodcam:102')).toBe('rtsp://example.invalid/cam/102')

    const fresh = new SqliteStore(':memory:')
    expect((await saveCameraCatalog(fresh, bmaPartial(), T0)).saved).toBe(true)
    expect((await saveCameraCatalog(fresh, { ...list('dwr-cctv', 0, T0) }, T0)).warning).toMatch(/empty camera list/)
    store.close()
    fresh.close()
  })

  it('a relayed list (no refs) is link-only here, never replaces a fresh local list, and is never older', async () => {
    const store = new SqliteStore(':memory:')
    await saveCameraCatalog(store, bmaFixture(), T0)
    const relayed = publicCatalog(bmaFixture(at(1)))
    expect('refs' in relayed).toBe(false)
    const early = await saveCameraCatalog(store, relayed, at(1))
    expect(early).toMatchObject({ saved: false })
    expect(early.warning).toMatch(/relayed list ignored/)
    expect(await hasCameraRefs(store, 'bma-floodcam')).toBe(true)

    // Our own list is stale after 24 h: the relayed copy wins and our refs are dropped.
    const later = publicCatalog(bmaFixture(at(30)))
    expect(await saveCameraCatalog(store, later, at(30))).toEqual({ saved: true, warning: null })
    expect(await hasCameraRefs(store, 'bma-floodcam')).toBe(false)
    expect(await getCameraRef(store, 'bma-floodcam:101')).toBeNull()
    expect(await store.getMeta(REFS_META_PREFIX + 'bma-floodcam')).toBe('')

    const stale = await saveCameraCatalog(store, publicCatalog(bmaFixture(at(29))), at(31))
    expect(stale.warning).toMatch(/older than the stored one/)
    const future = await saveCameraCatalog(store, publicCatalog(bmaFixture(at(40))), at(31))
    expect(future.warning).toMatch(/fetchedAt is in the future/)
    store.close()
  })

  it('keeps only allowlisted fields and safe official links', async () => {
    const store = new SqliteStore(':memory:')
    const sneaky = {
      source: 'bma-floodcam' as const,
      fetchedAt: T0.toISOString(),
      cameras: [
        { ...camera('bma-floodcam', 1), officialUrl: 'javascript:alert(1)', LiveStream: 'rtsp://example.invalid/x', ref: 'rtsp://example.invalid/y' },
        { ...camera('bma-floodcam', 2), officialUrl: 'https://evil.example/' },
        { ...camera('bma-floodcam', 3), officialUrl: 'https://floodbangkok.bangkok.go.th/map' },
        { ...camera('bma-floodcam', 4), id: 'dwr-cctv:4' }, // id/source mismatch → dropped
        { ...camera('bma-floodcam', 5), lat: 51.5, lng: -0.1 }, // outside Thailand → dropped
        { ...camera('bma-floodcam', 6), name: '  ' }, // no name → dropped
      ],
    }
    expect((await saveCameraCatalog(store, sneaky, T0)).saved).toBe(true)
    const cams = (await loadCameraCatalogs(store, ['bma-floodcam']))[0]!.cameras
    expect(cams.map((c) => c.nativeId)).toEqual(['1', '2', '3'])
    expect(cams.map((c) => c.officialUrl)).toEqual(['https://floodbangkok.bangkok.go.th/', 'https://floodbangkok.bangkok.go.th/', 'https://floodbangkok.bangkok.go.th/map'])
    expect(JSON.stringify(cams)).not.toContain('rtsp:')
    expect(await hasCameraRefs(store, 'bma-floodcam')).toBe(false)
    store.close()
  })
})

describe('camera ↔ station join', () => {
  it('joins road sensors within 50 m (bma-roadflood fixture) and leaves farther ones out', async () => {
    const store = new SqliteStore(':memory:')
    await store.upsertStations(roadStations())
    await saveCameraCatalog(store, bmaFixture(), T0)
    const near = new Map((await loadCameraCatalogs(store, ['bma-floodcam']))[0]!.cameras.map((c) => [c.nativeId, c.nearStationIds]))
    expect(near.get('101')).toEqual(['road:FL.WTL.04']) // 32 m
    expect(near.get('103')).toEqual(['road:FL.WTL.04'])
    expect(near.get('201')).toEqual(['road:FL.SLG.01']) // 0 m
    expect(near.get('202')).toEqual(['road:FL.SLG.01'])
    expect(near.get('301')).toEqual(['road:FL.CTC.04'])
    expect(near.get('401')).toEqual(['road:FL.BKP.03'])
    expect(near.get('402')).toEqual([]) // 107 m from FL.BKP.03
    expect(near.get('501')).toEqual([]) // 627 m from the tunnel TN.BKA.01
    expect(near.get('601')).toEqual([])
    store.close()
  })

  it('canal and river gauges within 150 m; never rain gauges or pumps', () => {
    const cam = camera('bma-floodcam', 1, { lat: 13.75, lng: 100.6 })
    const st = (id: string, kind: Station['kind'], dLatM: number): Station => ({ id, source: 'bma-canal', kind, name: id, lat: 13.75 + dLatM / 111_320, lng: 100.6, agency: 'x' })
    const stations = [st('canal:A', 'canal', 120), st('canal:B', 'canal', 200), st('river:C', 'river', 60), st('rain:D', 'rain', 0), st('pump:E', 'pump', 0), st('road:F', 'roadflood', 70)]
    expect(nearStationIds(cam.lat, cam.lng, stations)).toEqual(['river:C', 'canal:A'])
    expect(joinNearStations([cam], stations)[0]!.nearStationIds).toEqual(['river:C', 'canal:A'])
    expect(cam.nearStationIds).toEqual([]) // input not mutated
    // The join key ignores stations that can never be joined.
    expect(stationJoinKey(stations)).toBe(stationJoinKey([...stations, st('rain:Z', 'rain', 5)]))
    expect(stationJoinKey(stations)).not.toBe(stationJoinKey(stations.slice(1)))
  })
})

describe('refreshCameraCatalogs (scheduling)', () => {
  const deps = (store: SqliteStore, adapters: CameraCatalogAdapter[], now: Date, log?: (m: string) => void) => ({
    store,
    config: liveConfig,
    fetch: (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch,
    now: () => now,
    adapters,
    sleep: async () => {},
    log,
  })

  it('fetches when missing, then once the list is older than refreshHours', async () => {
    const store = new SqliteStore(':memory:')
    const a = fakeAdapter('dwr-cctv', (_n, now) => list('dwr-cctv', 4, now), { refreshHours: 168 })
    const first = await refreshCameraCatalogs(deps(store, [a], T0))
    expect(first).toEqual([{ source: 'dwr-cctv', ok: true, count: 4, warnings: [] }])
    expect(await refreshCameraCatalogs(deps(store, [a], at(1)))).toEqual([{ source: 'dwr-cctv', ok: true, count: 4, skipped: true }])
    await refreshCameraCatalogs(deps(store, [a], at(167)))
    expect(a.calls).toBe(1)
    await refreshCameraCatalogs(deps(store, [a], at(168)))
    expect(a.calls).toBe(2)
    expect((await loadCameraCatalogs(store, ['dwr-cctv']))[0]!.fetchedAt).toBe(at(168).toISOString())
    store.close()
  })

  it('a failed refresh keeps the last good list and retries with backoff (1 h, 2 h, 4 h …)', async () => {
    const store = new SqliteStore(':memory:')
    const logs: string[] = []
    const a = fakeAdapter('dwr-cctv', (n, now) => (n === 1 ? list('dwr-cctv', 4, now) : new TypeError('fetch failed')))
    await refreshCameraCatalogs(deps(store, [a], T0))
    const fail = await refreshCameraCatalogs(deps(store, [a], at(24), (m) => logs.push(m)))
    expect(fail).toEqual([{ source: 'dwr-cctv', ok: false, count: 4, error: 'fetch failed' }])
    expect(logs.join('\n')).toContain('[cctv] dwr-cctv FAILED: fetch failed')
    expect((await loadCameraCatalogs(store, ['dwr-cctv']))[0]!.cameras).toHaveLength(4)

    await refreshCameraCatalogs(deps(store, [a], at(24.5)))
    expect(a.calls).toBe(2) // backoff 1 h
    await refreshCameraCatalogs(deps(store, [a], at(25)))
    expect(a.calls).toBe(3)
    await refreshCameraCatalogs(deps(store, [a], at(26.5)))
    expect(a.calls).toBe(3) // backoff 2 h
    await refreshCameraCatalogs(deps(store, [a], at(27)))
    expect(a.calls).toBe(4)
    expect(JSON.parse((await store.getMeta(STATUS_META_PREFIX + 'dwr-cctv'))!)).toMatchObject({ failures: 3, lastError: 'fetch failed' })
    store.close()
  })

  it('records Thai-IP-only failures with a note, and never throws', async () => {
    const store = new SqliteStore(':memory:')
    const thai = fakeAdapter('bma-floodcam', () => new TypeError('fetch failed'), { thaiIpOnly: true })
    const weird = fakeAdapter('dwr-cctv', () => {
      throw 'not even an Error'
    })
    const res = await refreshCameraCatalogs(deps(store, [thai, weird], T0))
    expect(res[0]).toMatchObject({ source: 'bma-floodcam', ok: false, error: 'fetch failed (แหล่งข้อมูลนี้รับเฉพาะ IP ในประเทศไทย)' })
    expect(res[1]).toMatchObject({ source: 'dwr-cctv', ok: false, error: 'not even an Error' })
    const health = await cameraCatalogHealth(store, ['bma-floodcam', 'dwr-cctv', 'demo-cam'])
    expect(health).toEqual([
      { source: 'bma-floodcam', catalogAt: null, count: 0, lastError: 'fetch failed (แหล่งข้อมูลนี้รับเฉพาะ IP ในประเทศไทย)' },
      { source: 'dwr-cctv', catalogAt: null, count: 0, lastError: 'not even an Error' },
      { source: 'demo-cam', catalogAt: null, count: 0, lastError: null },
    ])

    // A broken store is reported, not thrown.
    const broken = new SqliteStore(':memory:')
    vi.spyOn(broken, 'getMeta').mockRejectedValue(new Error('disk I/O error'))
    const out = await refreshCameraCatalogs(deps(broken, [fakeAdapter('dwr-cctv', (_n, now) => list('dwr-cctv', 1, now))], T0))
    expect(out).toEqual([{ source: 'dwr-cctv', ok: false, count: 0, error: 'disk I/O error' }])
    expect(await cameraCatalogHealth(broken, ['dwr-cctv'])).toEqual([{ source: 'dwr-cctv', catalogAt: null, count: 0, lastError: 'อ่านสถานะรายการกล้องไม่ได้' }])
    store.close()
    broken.close()
  })

  it('redacts stream addresses and credentials from stored errors', async () => {
    const store = new SqliteStore(':memory:')
    const leaky = fakeAdapter('dwr-cctv', () => new Error('connect failed to http://user:pass@cam.dyndns.invalid:8080/x'))
    await refreshCameraCatalogs(deps(store, [leaky], T0))
    const status = (await store.getMeta(STATUS_META_PREFIX + 'dwr-cctv'))!
    expect(status).toContain('connect failed to <url>')
    expect(status).not.toContain('user:pass')
    expect(status).not.toContain('dyndns')
    store.close()
  })

  it('health shows when and how many, and clears the error after a good refresh', async () => {
    const store = new SqliteStore(':memory:')
    const a = fakeAdapter('dwr-cctv', (n, now) => (n === 1 ? new Error('HTTP 502 from telemetry.dwr.go.th') : list('dwr-cctv', 5, now)))
    await refreshCameraCatalogs(deps(store, [a], T0))
    expect((await cameraCatalogHealth(store, ['dwr-cctv']))[0]!.lastError).toBe('HTTP 502 from telemetry.dwr.go.th')
    await refreshCameraCatalogs(deps(store, [a], at(1)))
    expect(await cameraCatalogHealth(store, ['dwr-cctv'])).toEqual([{ source: 'dwr-cctv', catalogAt: at(1).toISOString(), count: 5, lastError: null }])
    store.close()
  })

  it('the < 50 % guard holds during refreshes, until the smaller list keeps coming back for a day', async () => {
    const store = new SqliteStore(':memory:')
    const a = fakeAdapter('dwr-cctv', (n, now) => list('dwr-cctv', n === 1 ? 20 : 8, now))
    await refreshCameraCatalogs(deps(store, [a], T0))
    const r1 = await refreshCameraCatalogs(deps(store, [a], at(24)))
    expect(r1[0]).toMatchObject({ ok: false, count: 20 })
    expect(r1[0]!.error).toMatch(/only 8 of 20 cameras/)
    await refreshCameraCatalogs(deps(store, [a], at(25))) // seen twice (backoff 1 h)
    await refreshCameraCatalogs(deps(store, [a], at(27))) // three times, but within a day
    expect((await loadCameraCatalogs(store, ['dwr-cctv']))[0]!.cameras).toHaveLength(20)
    await refreshCameraCatalogs(deps(store, [a], at(31)))
    await refreshCameraCatalogs(deps(store, [a], at(39)))
    const ok = await refreshCameraCatalogs(deps(store, [a], at(55))) // ≥ 24 h since first seen
    expect(ok[0]).toMatchObject({ ok: true, count: 8 })
    expect((await loadCameraCatalogs(store, ['dwr-cctv']))[0]!.cameras).toHaveLength(8)
    store.close()
  })

  it('demo cameras are built once (or when missing) and joined to the demo stations', async () => {
    const store = new SqliteStore(':memory:')
    for (const s of DEMO_SOURCES) {
      const r = await s.fetch({ fetch, now: T0, timeoutMs: 1 })
      await store.upsertStations(r.stations)
    }
    const fetchSpy = vi.spyOn(demoCamSource, 'fetchCatalog')
    const res = await refreshCameraCatalogs({ ...deps(store, [], T0), adapters: undefined, config: loadConfig({ DATA_MODE: 'fixture' }) })
    expect(res).toEqual([{ source: 'demo-cam', ok: true, count: 5, warnings: [] }])
    const cams = (await loadCameraCatalogs(store, ['demo-cam']))[0]!.cameras
    expect(cams.map((c) => c.nearStationIds)).toEqual([['road:DEMO.FL.01'], ['road:DEMO.FL.02'], ['road:DEMO.FL.03'], ['canal:WL.PWT.03'], ['canal:WL.SLL.01']])
    expect(await getCameraRef(store, 'demo-cam:1')).toBe('road:DEMO.FL.01')
    expect(await hasCameraRefs(store, 'demo-cam')).toBe(true)
    await refreshCameraCatalogs({ ...deps(store, [], at(24 * 400)), adapters: undefined, config: loadConfig({ DATA_MODE: 'fixture' }) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
    store.close()
  })

  it('redoes the join when stations change, without refetching', async () => {
    const store = new SqliteStore(':memory:')
    const a = fakeAdapter('bma-floodcam', () => bmaFixture())
    await refreshCameraCatalogs(deps(store, [a], T0))
    expect((await findCamera(store, 'bma-floodcam:101'))!.nearStationIds).toEqual([])
    await store.upsertStations(roadStations())
    const logs: string[] = []
    await refreshCameraCatalogs(deps(store, [a], at(1), (m) => logs.push(m)))
    expect(a.calls).toBe(1)
    expect((await findCamera(store, 'bma-floodcam:101'))!.nearStationIds).toEqual(['road:FL.WTL.04'])
    expect(await getCameraRef(store, 'bma-floodcam:101')).toBe('rtsp://example.invalid/cam/101') // refs kept
    expect(logs.join('\n')).toContain('stations changed')
    store.close()
  })

  it('concurrent refreshes share one run', async () => {
    const store = new SqliteStore(':memory:')
    const a = fakeAdapter('dwr-cctv', (_n, now) => list('dwr-cctv', 2, now))
    const [x, y] = await Promise.all([refreshCameraCatalogs(deps(store, [a], T0)), refreshCameraCatalogs(deps(store, [a], T0))])
    expect(a.calls).toBe(1)
    expect(y).toBe(x)
    // …and a later call runs again (the in-flight entry is cleared).
    await refreshCameraCatalogs({ ...deps(store, [a], T0) }, { force: true })
    expect(a.calls).toBe(2)
    expect(await refreshCameraCatalogs({ ...deps(store, [], T0) })).toEqual([])
    store.close()
  })

  it('uses the configured adapters with the injected fetch (BMA list end to end)', async () => {
    const store = new SqliteStore(':memory:')
    const urls: string[] = []
    const f = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (String(input) === BMA_FLOODCAM_LIST_URL) return Response.json(load('bma-camera-profile.json'))
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const res = await refreshCameraCatalogs({ store, config: loadConfig({ CCTV_SOURCES: 'bma-floodcam' }), fetch: f, now: () => T0 })
    expect(urls).toEqual([BMA_FLOODCAM_LIST_URL])
    expect(res).toEqual([{ source: 'bma-floodcam', ok: true, count: 17, warnings: expect.any(Array) }])
    expect(await getCameraRef(store, 'bma-floodcam:101')).toBe('rtsp://example.invalid/cam/101')
    expect(await refreshCameraCatalogs({ store, config: loadConfig({ CCTV_SOURCES: 'none' }), fetch: f })).toEqual([])
    store.close()
  })
})

describe('catalogDue', () => {
  const base = { source: 'dwr-cctv' as const, refreshHours: 168, thaiIpOnly: false, local: true, lastAttemptAt: null, failures: 0, now: T0 }

  it('missing, stale, backoff', () => {
    expect(catalogDue({ ...base, fetchedAt: null })).toBe(true)
    expect(catalogDue({ ...base, fetchedAt: at(-167).toISOString() })).toBe(false)
    expect(catalogDue({ ...base, fetchedAt: at(-168).toISOString() })).toBe(true)
    expect(catalogDue({ ...base, fetchedAt: null, failures: 3, lastAttemptAt: at(-3).toISOString() })).toBe(false)
    expect(catalogDue({ ...base, fetchedAt: null, failures: 3, lastAttemptAt: at(-4).toISOString() })).toBe(true)
    expect([1, 2, 3, 6, 9, 20].map((f) => failureBackoffHours(f, 24))).toEqual([1, 2, 4, 24, 24, 24])
    expect(failureBackoffHours(0, 24)).toBe(0)
  })

  it('daily BMA list drifts to 03:00 Bangkok', () => {
    const bma = { ...base, source: 'bma-floodcam' as const, refreshHours: 24, thaiIpOnly: true }
    const fetched15h = T0.toISOString() // 15:00 Bangkok
    expect(catalogDue({ ...bma, fetchedAt: fetched15h, now: new Date('2026-10-04T19:30:00Z') })).toBe(false) // 02:30 BKK
    expect(catalogDue({ ...bma, fetchedAt: fetched15h, now: new Date('2026-10-04T20:05:00Z') })).toBe(true) // 03:05 BKK, 12 h old
    expect(catalogDue({ ...bma, fetchedAt: new Date('2026-10-04T19:00:00Z').toISOString(), now: new Date('2026-10-04T20:05:00Z') })).toBe(false)
  })

  it('a relayed list is refetched locally once per period, unless the upstream is Thai-IP-only', () => {
    const relayed = { ...base, local: false, fetchedAt: at(-1).toISOString() }
    expect(catalogDue(relayed)).toBe(true)
    expect(catalogDue({ ...relayed, lastAttemptAt: at(-2).toISOString() })).toBe(false)
    expect(catalogDue({ ...relayed, lastAttemptAt: at(-168).toISOString() })).toBe(true)
    expect(catalogDue({ ...relayed, thaiIpOnly: true })).toBe(false)
  })

  it('demo (refreshHours = ∞) only when missing', () => {
    const demo = { ...base, source: 'demo-cam' as const, refreshHours: Number.POSITIVE_INFINITY }
    expect(catalogDue({ ...demo, fetchedAt: null })).toBe(true)
    expect(catalogDue({ ...demo, fetchedAt: at(-24 * 3650).toISOString() })).toBe(false)
  })
})
