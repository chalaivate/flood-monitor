import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraFrame } from '@/components/cctv/CameraFrame'
import { cameraCatalogHealth, getCameraRef, hasCameraRefs, loadCameraCatalogs, refreshCameraCatalogs } from '@/lib/cameras/catalog'
import { WATER_JOIN_M } from '@/lib/cameras/join'
import { loadConfig } from '@/lib/config'
import { haversineKm } from '@/lib/geo'
import {
  CCTV_POLICY,
  CCTV_REFRESH_SEC,
  CCTV_SERVER_MAX_MS,
  DDS_ORIGIN,
  SOURCE_DOWN_AFTER,
  cctvFrameResponse,
  cctvImageStats,
  clearCctvCache,
  ddsCaptureTime,
  getCctvImage,
  isUpstreamCameraSource,
  toPublicCamera,
  type CctvFetchDeps,
} from '@/lib/server/cctv-proxy'
import { isRelayCameraSource, parseRelayCameraCatalog, RELAY_CAMERA_SOURCES } from '@/lib/server/validation'
import { CAMERA_ADAPTERS, RELAYABLE_CAMERA_SOURCES } from '@/lib/sources/cameras'
import { BANGKOK_BBOX } from '@/lib/sources/cameras/bma-floodcam'
import { inBox, NATIVE_ID_RE, siteIdFor } from '@/lib/sources/cameras/common'
import { DDS_CAMERAS, DDS_CCTV_PAGE, ddsCameraCatalog, ddsCameraRow, ddsCamSource } from '@/lib/sources/cameras/dds'
import type { CameraCatalogAdapter } from '@/lib/sources/cameras/types'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Station } from '@/lib/types'
import { cameraAltTh, frameCondition, frameCopy, parseFrameMeta } from '@/lib/ui/cctv'

// DDS water-level cameras (bma-ddscam): a static catalogue in code and stills from
// dds.bangkok.go.th at each row's fixed path (cctv-image/cctv<n>.jpg; camera 3: cctv/cctv3.jpg).
// No network: fetch is injected, frames are synthetic JPEG-shaped bytes, stations are made up
// around the table's positions.

const NOW = new Date('2026-10-06T01:00:00.000Z')
const HOUR = 3_600_000
const noNetwork = vi.fn(() => Promise.reject(new Error('no network'))) as unknown as typeof fetch

/** Minimal JPEG-shaped bytes: SOI, APP0, SOF0 (w×h), a scan byte that varies with `seed`, EOI. */
function jpeg(w = 1280, h = 720, seed = 0): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, seed & 0xff, 0x00,
    0xff, 0xd9,
  ])
}

describe('DDS water-level cameras: static catalogue', () => {
  it('builds six cameras from the table without any request', async () => {
    const f = vi.fn(noNetwork)
    const r = await ddsCamSource.fetchCatalog({ fetch: f as unknown as typeof fetch, now: NOW, timeoutMs: 1 })
    expect(f).not.toHaveBeenCalled()
    expect(r.source).toBe('bma-ddscam')
    expect(r.fetchedAt).toBe(NOW.toISOString())
    expect(r.warnings).toEqual([])
    expect(r.cameras.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5', '6'].map((n) => `bma-ddscam:${n}`))
    expect(new Set(r.cameras.map((c) => c.siteId)).size).toBe(6)
    expect(r.refs).toEqual(r.cameras.map((c) => ({ cameraId: c.id, ref: c.nativeId })))
    expect(r.refs.map((x) => x.ref)).toEqual(['1', '2', '3', '4', '5', '6'])
    for (const c of r.cameras) {
      expect(c.source).toBe('bma-ddscam')
      expect(NATIVE_ID_RE.test(c.nativeId)).toBe(true)
      expect(c.siteId).toBe(siteIdFor('bma-ddscam', c.lat, c.lng))
      expect(inBox(c.lat, c.lng, BANGKOK_BBOX), c.id).toBe(true)
      expect(c.name).toMatch(/^กล้องระดับน้ำ \S/)
      expect(c.code).toBe(`DDS-CCTV-0${c.nativeId}`)
      expect(c.angle).toBeNull()
      expect(c.owner).toBe('สำนักการระบายน้ำ กทม.')
      expect(c.facing).toBe('water')
      expect(c.officialUrl).toBe(DDS_CCTV_PAGE)
      expect(new URL(c.officialUrl)).toMatchObject({ protocol: 'https:', hostname: 'dds.bangkok.go.th', pathname: '/cctv.php' })
      expect(c.cadenceMin).toBeNull()
      for (const id of c.nearStationIds) expect(id).toMatch(/^canal:WL\.[A-Z]{3}\.\d{2}$/)
    }
    expect(r.cameras.find((c) => c.nativeId === '1')!.nearStationIds).toEqual(['canal:WL.BKA.01'])
    expect(r.cameras.find((c) => c.nativeId === '3')!.nearStationIds).toEqual(['canal:WL.BNA.01'])
    // Same list for any time; the table itself is never handed out.
    const again = ddsCameraCatalog(new Date('2027-01-01T00:00:00Z'))
    expect(again.cameras).toEqual(r.cameras)
    expect(again.cameras[0]!.nearStationIds).not.toBe(DDS_CAMERAS[0]!.nearStationIds)
  })

  it('table rows: numbers 1–6 once each, Thai place names, fixed image paths (camera 3 in /cctv/)', () => {
    expect(DDS_CAMERAS.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6])
    for (const r of DDS_CAMERAS) expect(r.place).toMatch(/^[฀-๿][฀-๿ 0-9]*$/)
    // As DDS's own map popups link them (captured 2026-09-28).
    expect(DDS_CAMERAS.map((r) => r.imagePath)).toEqual([
      '/cctv-image/cctv1.jpg',
      '/cctv-image/cctv2.jpg',
      '/cctv/cctv3.jpg',
      '/cctv-image/cctv4.jpg',
      '/cctv-image/cctv5.jpg',
      '/cctv-image/cctv6.jpg',
    ])
    for (const r of DDS_CAMERAS) {
      expect(r.imagePath).toMatch(/^\/(cctv|cctv-image)\/cctv\d\.jpg$/)
      expect(new URL(r.imagePath, DDS_ORIGIN).href).toBe(`${DDS_ORIGIN}${r.imagePath}`)
    }
    // A row is found by its exact number only.
    expect(ddsCameraRow('3')).toBe(DDS_CAMERAS[2])
    for (const ref of ['7', '0', '03', ' 3', '3 ', '3.jpg', '__proto__', 'constructor', 'toString', '']) {
      expect(ddsCameraRow(ref), ref).toBeUndefined()
    }
  })

  it('positions: inside Bangkok, at the BMA station matched by name (DDS\'s own pin for the bridge)', () => {
    // BMA's station list (2026-10-03) for the matched stations; camera 2 is DDS's own map pin
    // (2026-09-28). DDS's pins for cameras 1, 4, 5 and 6 are geocodes of names (4 and 6 outside
    // Bangkok) and are not used.
    const expected: Record<number, { lat: number; lng: number; station?: string }> = {
      1: { lat: 13.81722, lng: 100.51066, station: 'canal:WL.BKA.01' },
      2: { lat: 13.7638088, lng: 100.4880244 },
      3: { lat: 13.67482, lng: 100.58775, station: 'canal:WL.BNA.01' },
      4: { lat: 13.79063, lng: 100.46199, station: 'canal:WL.SDN.01' },
      5: { lat: 13.7789, lng: 100.46431, station: 'canal:WL.CPA.01' },
      6: { lat: 13.80042, lng: 100.32977, station: 'canal:WL.TWW.01' },
    }
    for (const r of DDS_CAMERAS) {
      const e = expected[r.n]!
      expect(inBox(r.lat, r.lng, BANGKOK_BBOX), String(r.n)).toBe(true)
      // Within the water join radius of its station, so distance and pin agree.
      expect(haversineKm(r.lat, r.lng, e.lat, e.lng) * 1000, String(r.n)).toBeLessThan(WATER_JOIN_M)
      expect(r.nearStationIds, String(r.n)).toEqual(e.station ? [e.station] : [])
    }
  })

  it('needs no Thai IP, refreshes daily and pins the stations of its table', () => {
    expect(CAMERA_ADAPTERS['bma-ddscam']).toBe(ddsCamSource)
    expect(ddsCamSource.thaiIpOnly).toBe(false)
    expect(ddsCamSource.refreshHours).toBe(24)
    expect(ddsCamSource.label).toBe('สำนักการระบายน้ำ กทม.')
    expect(ddsCamSource.pinnedStationIds?.('1')).toEqual(['canal:WL.BKA.01'])
    expect(ddsCamSource.pinnedStationIds?.('2')).toEqual([])
    expect(ddsCamSource.pinnedStationIds?.('3')).toEqual(['canal:WL.BNA.01'])
    expect(ddsCamSource.pinnedStationIds?.('99')).toEqual([])
    expect(ddsCamSource.staticList).toBe(true)
  })
})

describe('DDS catalogue in the store', () => {
  const station = (code: string, lat: number, lng: number): Station => ({
    id: `canal:${code}`,
    source: 'bma-canal',
    kind: 'canal',
    code,
    name: `สถานีทดสอบ ${code}`,
    lat,
    lng,
    agency: 'สำนักการระบายน้ำ กทม.',
  })

  it('every host builds it with its own refs; pinned stations are kept beyond the join radius', async () => {
    const store = new SqliteStore(':memory:')
    const cam1 = DDS_CAMERAS[0]!
    const cam4 = DDS_CAMERAS[3]!
    await store.upsertStations([
      station('WL.BKA.01', cam1.lat + 0.003, cam1.lng), // ≈ 330 m north: beyond 150 m, pinned
      station('WL.SDN.01', cam4.lat, cam4.lng), // same spot: found by distance and pinned (listed once)
      station('WL.ZZZ.01', cam4.lat + 0.0005, cam4.lng), // ≈ 55 m: found by distance only
    ])
    const config = loadConfig({ CCTV_SOURCES: 'bma-ddscam' })
    // A cloud host (Thai-IP-only sources skipped) builds it too.
    const res = await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => NOW, skipThaiIpOnly: true })
    expect(res).toEqual([{ source: 'bma-ddscam', ok: true, count: 6, warnings: [] }])
    const [cat] = await loadCameraCatalogs(store, ['bma-ddscam'])
    const near = (n: string) => cat!.cameras.find((c) => c.nativeId === n)!.nearStationIds
    expect(near('1')).toEqual(['canal:WL.BKA.01'])
    expect(near('4')).toEqual(['canal:WL.SDN.01', 'canal:WL.ZZZ.01'])
    // Pinned stations this server does not have are left out.
    expect(near('6')).toEqual([])
    expect(await hasCameraRefs(store, 'bma-ddscam')).toBe(true)
    expect(await getCameraRef(store, 'bma-ddscam:3')).toBe('3')

    // A station that appears later is joined without refetching (stations changed → rejoin).
    const cam6 = DDS_CAMERAS[5]!
    await store.upsertStations([station('WL.TWW.01', cam6.lat - 0.01, cam6.lng)])
    const later = await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => new Date(NOW.getTime() + HOUR) })
    expect(later).toEqual([{ source: 'bma-ddscam', ok: true, count: 6, skipped: true }])
    const [rejoined] = await loadCameraCatalogs(store, ['bma-ddscam'])
    expect(rejoined!.fetchedAt).toBe(NOW.toISOString())
    expect(rejoined!.cameras.find((c) => c.nativeId === '6')!.nearStationIds).toEqual(['canal:WL.TWW.01'])

    // Rebuilt daily, so a corrected table row reaches the stored list within a day.
    const nextDay = new Date(NOW.getTime() + 24 * HOUR)
    expect((await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => nextDay }))[0]).toMatchObject({ ok: true, count: 6 })
    expect((await loadCameraCatalogs(store, ['bma-ddscam']))[0]!.fetchedAt).toBe(nextDay.toISOString())
  })

  /** The adapter as a release that keeps only cameras 1 and 2 would build it. */
  const trimmedTo2 = (adapter: CameraCatalogAdapter): CameraCatalogAdapter => ({
    ...adapter,
    async fetchCatalog(ctx) {
      const full = await adapter.fetchCatalog(ctx)
      return { ...full, cameras: full.cameras.slice(0, 2), refs: full.refs.slice(0, 2) }
    },
  })

  it('a release that trims the table is saved on the next due refresh: no shrink guard, no health error', async () => {
    const store = new SqliteStore(':memory:')
    const config = loadConfig({ CCTV_SOURCES: 'bma-ddscam' })
    expect(await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => NOW })).toEqual([{ source: 'bma-ddscam', ok: true, count: 6, warnings: [] }])
    expect(await getCameraRef(store, 'bma-ddscam:6')).toBe('6')

    const nextDay = new Date(NOW.getTime() + 24 * HOUR)
    const res = await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => nextDay, adapters: [trimmedTo2(ddsCamSource)] })
    expect(res).toEqual([{ source: 'bma-ddscam', ok: true, count: 2, warnings: [] }])
    const [cat] = await loadCameraCatalogs(store, ['bma-ddscam'])
    expect(cat!.cameras.map((c) => c.id)).toEqual(['bma-ddscam:1', 'bma-ddscam:2'])
    expect(cat!.fetchedAt).toBe(nextDay.toISOString())
    // The dropped cameras lose their refs with the list.
    expect(await getCameraRef(store, 'bma-ddscam:2')).toBe('2')
    expect(await getCameraRef(store, 'bma-ddscam:6')).toBeNull()
    expect(await cameraCatalogHealth(store, ['bma-ddscam'])).toEqual([{ source: 'bma-ddscam', catalogAt: nextDay.toISOString(), count: 2, lastError: null }])
    // Not refetched before the next period.
    const later = await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => new Date(nextDay.getTime() + HOUR), adapters: [trimmedTo2(ddsCamSource)] })
    expect(later).toEqual([{ source: 'bma-ddscam', ok: true, count: 2, skipped: true }])
  })

  it('an upstream list (not static) that shrinks the same way is still refused', async () => {
    const store = new SqliteStore(':memory:')
    const config = loadConfig({ CCTV_SOURCES: 'bma-ddscam' })
    await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => NOW })
    const upstreamLike: CameraCatalogAdapter = { ...trimmedTo2(ddsCamSource), staticList: false }
    const nextDay = new Date(NOW.getTime() + 24 * HOUR)
    const [res] = await refreshCameraCatalogs({ store, config, fetch: noNetwork, now: () => nextDay, adapters: [upstreamLike] })
    expect(res).toMatchObject({ source: 'bma-ddscam', ok: false, count: 6 })
    expect(res!.error).toMatch(/only 2 of 6 cameras \(< 50%\)/)
    expect((await loadCameraCatalogs(store, ['bma-ddscam']))[0]!.cameras).toHaveLength(6)
    expect((await cameraCatalogHealth(store, ['bma-ddscam']))[0]!.lastError).toMatch(/only 2 of 6 cameras/)
  })
})

describe('DDS stills', () => {
  interface Call {
    url: string
    init: RequestInit
  }
  function fakeFetch(respond: (url: string) => Response) {
    const calls: Call[] = []
    const f = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return respond(String(input))
    })
    return { fetch: f as unknown as typeof fetch, calls }
  }
  let t = 0
  const deps = (f: typeof fetch): CctvFetchDeps => ({ fetch: f, now: () => t, publicBaseUrl: 'https://flood.example.org' })
  const LAST_MODIFIED = 'Tue, 06 Oct 2026 00:58:00 GMT'

  beforeEach(() => {
    t = NOW.getTime()
    clearCctvCache()
  })
  afterEach(() => clearCctvCache())

  it('asks for the row\'s still with a timestamp and the usual headers; Last-Modified is the capture time', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg(1280, 720), { headers: { 'content-type': 'image/jpeg', 'last-modified': LAST_MODIFIED } }))
    const res = await getCctvImage('bma-ddscam', 'bma-ddscam:2', '2', deps(fetch))
    expect(res).toMatchObject({ ok: true, stale: false, ttlMs: 60_000 })
    expect(res.ok && res.frame).toMatchObject({ type: 'image/jpeg', width: 1280, height: 720, capturedAt: '2026-10-06T00:58:00.000Z' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://dds.bangkok.go.th/cctv-image/cctv2.jpg?t=${t}`)
    expect(calls[0]!.url.startsWith(`${DDS_ORIGIN}/`)).toBe(true)
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(calls[0]!.init.method ?? 'GET').toBe('GET')
    const h = new Headers(calls[0]!.init.headers)
    expect(h.get('user-agent')).toMatch(/^Mozilla\/5\.0 .*flood-monitor\/0\.1 \(\+https:\/\/flood\.example\.org\/about\)$/)
    expect(h.get('accept')).toMatch(/^image\/jpeg,image\/png,image\/webp/)
    expect(h.has('referer')).toBe(false)
    expect(h.has('origin')).toBe(false)
    // Shared by every viewer for a minute.
    expect((await getCctvImage('bma-ddscam', 'bma-ddscam:2', '2', deps(fetch))).ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('ignores a Last-Modified that is unparseable or more than 5 minutes ahead', async () => {
    const now = NOW.getTime()
    expect(ddsCaptureTime(LAST_MODIFIED, now)).toBe('2026-10-06T00:58:00.000Z')
    expect(ddsCaptureTime(new Date(now + 4 * 60_000).toUTCString(), now)).toBe(new Date(now + 4 * 60_000).toISOString())
    expect(ddsCaptureTime(new Date(now + 6 * 60_000).toUTCString(), now)).toBeNull()
    expect(ddsCaptureTime('yesterday', now)).toBeNull()
    expect(ddsCaptureTime(null, now)).toBeNull()

    const ahead = fakeFetch(() => new Response(jpeg(), { headers: { 'last-modified': new Date(now + HOUR).toUTCString() } }))
    const res = await getCctvImage('bma-ddscam', 'bma-ddscam:1', '1', deps(ahead.fetch))
    expect(res.ok && res.frame.capturedAt).toBeNull()
    const none = fakeFetch(() => new Response(jpeg()))
    const res2 = await getCctvImage('bma-ddscam', 'bma-ddscam:3', '3', deps(none.fetch))
    expect(res2.ok && res2.frame.capturedAt).toBeNull()
  })

  it('maps 404 and an empty body to no-image, other errors to unreachable', async () => {
    const missing = fakeFetch(() => new Response('not found', { status: 404 }))
    expect(await getCctvImage('bma-ddscam', 'bma-ddscam:4', '4', deps(missing.fetch))).toEqual({ ok: false, failure: 'no-image' })
    const empty = fakeFetch(() => new Response(new Uint8Array(0), { headers: { 'content-type': 'image/jpeg' } }))
    expect(await getCctvImage('bma-ddscam', 'bma-ddscam:5', '5', deps(empty.fetch))).toEqual({ ok: false, failure: 'no-image' })
    const broken = fakeFetch(() => Response.json({ error: 'Internal Server Error' }, { status: 500 }))
    expect(await getCctvImage('bma-ddscam', 'bma-ddscam:6', '6', deps(broken.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    expect(cctvImageStats('bma-ddscam', t).lastFailure?.reason).toBe('HTTP 500')
  })

  it('builds each URL from the table row only: camera 3 from /cctv/, the others from /cctv-image/', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg(), { headers: { 'content-type': 'image/jpeg' } }))
    for (const r of DDS_CAMERAS) {
      expect((await getCctvImage('bma-ddscam', `bma-ddscam:${r.n}`, String(r.n), deps(fetch))).ok, String(r.n)).toBe(true)
    }
    expect(calls.map((c) => c.url)).toEqual([
      `https://dds.bangkok.go.th/cctv-image/cctv1.jpg?t=${t}`,
      `https://dds.bangkok.go.th/cctv-image/cctv2.jpg?t=${t}`,
      `https://dds.bangkok.go.th/cctv/cctv3.jpg?t=${t}`,
      `https://dds.bangkok.go.th/cctv-image/cctv4.jpg?t=${t}`,
      `https://dds.bangkok.go.th/cctv-image/cctv5.jpg?t=${t}`,
      `https://dds.bangkok.go.th/cctv-image/cctv6.jpg?t=${t}`,
    ])
  })

  it('refuses references that are not a camera of the table, without any request', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg()))
    for (const [i, ref] of ['7', '9', '0', '100', '01', '1/../x', '1.jpg', 'a', ' 1', '', '__proto__', 'constructor'].entries()) {
      expect(await getCctvImage('bma-ddscam', `bma-ddscam:r${i}`, ref, deps(fetch)), ref).toEqual({ ok: false, failure: 'unreachable' })
    }
    expect(calls).toHaveLength(0)
  })

  it('rejects an HTML page as being turned away; a host that never got a still then links out', async () => {
    const html = fakeFetch(() => new Response('<!DOCTYPE html><title>Just a moment...</title>', { headers: { 'content-type': 'text/html' } }))
    for (let i = 1; i < SOURCE_DOWN_AFTER; i++) {
      expect(await getCctvImage('bma-ddscam', `bma-ddscam:${i}`, String(i), deps(html.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    }
    expect(cctvImageStats('bma-ddscam', t).lastFailure?.reason).toBe('not an image')
    // The last refusal switches the source to agency links; later requests never go upstream.
    expect(await getCctvImage('bma-ddscam', 'bma-ddscam:5', '5', deps(html.fetch))).toMatchObject({ ok: false, failure: 'unavailable' })
    expect(await getCctvImage('bma-ddscam', 'bma-ddscam:6', '6', deps(html.fetch))).toMatchObject({ ok: false, failure: 'unavailable' })
    expect(html.calls).toHaveLength(SOURCE_DOWN_AFTER)
  })

  it('a still last modified 38 days ago is shown dimmed as older than a day, with its date', async () => {
    // A third party saw DDS's newest still dated 28 Aug on 2026-09-28: the feed may have stopped.
    const lastModified = new Date(t - 38 * 24 * HOUR) // 2026-08-29 08:00 Bangkok
    const { fetch } = fakeFetch(() => new Response(jpeg(), { headers: { 'content-type': 'image/jpeg', 'last-modified': lastModified.toUTCString() } }))
    const res = await getCctvImage('bma-ddscam', 'bma-ddscam:1', '1', deps(fetch))
    if (!res.ok) throw new Error(`expected a still, got ${res.failure}`)
    expect(res.stale).toBe(false)
    expect(res.frame.capturedAt).toBe('2026-08-29T01:00:00.000Z')

    // What the browser receives, and how the tile labels it.
    const http = cctvFrameResponse(res.frame, res.stale, res.ttlMs, t)
    expect(http.headers.get('x-cctv-captured-at')).toBe('2026-08-29T01:00:00.000Z')
    const meta = parseFrameMeta((name) => http.headers.get(name), t)
    const camera = toPublicCamera(ddsCameraCatalog(NOW).cameras[0]!, { distanceKm: null, image: true })
    expect(frameCondition(meta, camera, t)).toBe('old')
    const copy = frameCopy(camera, { meta, loading: false, failure: null }, t)
    expect(copy.badge).toBe('ภาพเก่ากว่า 1 วัน')
    expect(copy.dim).toBe(true)
    expect(copy.warn).toBe(true)
    expect(copy.notices).toEqual(['ภาพเก่ากว่า 1 วัน — ถ่ายเมื่อ 29 ส.ค. 08:00 น.'])
    expect(copy.line).toMatch(/^ภาพนิ่ง · ถ่าย 29 ส\.ค\. 08:00 น\. · /)
    expect(cameraAltTh(camera, meta, t)).toBe('ภาพจากกล้อง กล้องระดับน้ำ บางเขนใหม่ (สำนักการระบายน้ำ กทม.) ถ่ายเมื่อ 29 ส.ค. 08:00 น.')
    const html = renderToStaticMarkup(createElement(CameraFrame, { camera, frame: { src: 'blob:test/dds1', meta, loading: false }, copy, size: 'tile', nowMs: t }))
    expect(html).toMatch(/<img[^>]+class="[^"]*opacity-45/)
    expect(html).toContain('ภาพเก่ากว่า 1 วัน')
    expect(html).toContain('ถ่ายเมื่อ 29 ส.ค. 08:00 น.')
  })

  it('has its own gentle policy within the server deadline', () => {
    const p = CCTV_POLICY['bma-ddscam']
    expect(p).toEqual({
      ttlMs: 60_000,
      failTtlMs: 60_000,
      staleMaxMs: 15 * 60_000,
      timeoutMs: 15_000,
      maxInFlight: 2,
      maxQueue: 10,
      queueWaitMs: 15_000,
      hourlyBudget: 360,
      maxBytes: 2 * 1024 * 1024,
    })
    expect(p.queueWaitMs + p.timeoutMs).toBeLessThanOrEqual(CCTV_SERVER_MAX_MS)
    expect(CCTV_REFRESH_SEC['bma-ddscam']).toBe(60)
    expect(isUpstreamCameraSource('bma-ddscam')).toBe(true)
    expect(isUpstreamCameraSource('demo-cam')).toBe(false)
    expect(isUpstreamCameraSource('toString')).toBe(false)
  })
})

describe('DDS configuration and relay', () => {
  it('is on by default and can be chosen alone', () => {
    const warn = vi.fn()
    expect(loadConfig({}, { warn }).enabledCameraSources).toEqual(['bma-floodcam', 'bma-ddscam', 'dwr-cctv'])
    expect(loadConfig({ CCTV_SOURCES: 'bma-ddscam' }, { warn }).enabledCameraSources).toEqual(['bma-ddscam'])
    expect(loadConfig({ CCTV_SOURCES: 'dwr-cctv,bma-ddscam' }, { warn }).enabledCameraSources).toEqual(['bma-ddscam', 'dwr-cctv'])
    expect(loadConfig({ DATA_MODE: 'fixture' }, { warn }).enabledCameraSources).toEqual(['demo-cam'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('is never relayed: the relay does not send it and the receiver refuses it', () => {
    expect([...RELAYABLE_CAMERA_SOURCES].sort()).toEqual([...RELAY_CAMERA_SOURCES].sort())
    expect(RELAYABLE_CAMERA_SOURCES).not.toContain('bma-ddscam')
    expect(isRelayCameraSource('bma-ddscam')).toBe(false)
    expect(isRelayCameraSource('demo-cam')).toBe(false)
    expect(isRelayCameraSource('bma-floodcam')).toBe(true)
    const list = ddsCameraCatalog(NOW)
    expect(parseRelayCameraCatalog({ source: 'bma-ddscam', fetchedAt: list.fetchedAt, cameras: list.cameras })).toMatchObject({ ok: false, source: 'bma-ddscam' })
    // Smuggled into another source's list: dropped.
    const mixed = parseRelayCameraCatalog({ source: 'bma-floodcam', fetchedAt: list.fetchedAt, cameras: list.cameras })
    expect(mixed).toMatchObject({ ok: false, error: 'no valid camera in the list' })
  })
})
