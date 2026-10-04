import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CamerasResponse, PublicCamera } from '@/lib/server/public'
import type { DashboardSnapshot } from '@/lib/types'
import { fetchCameras } from '@/lib/ui/api'
import {
  CCTV_CARD_SUBTITLE,
  CCTV_DEMO_TH,
  CCTV_LINK_ONLY_TH,
  CCTV_LOADING_TH,
  CCTV_PAUSE_KEY,
  CCTV_TAP_TO_LOAD_TH,
  FETCHED_STALE_MS,
  VIEWER_AUTO_PAUSE_MS,
  WATCHDOG_REASON,
  cameraAltTh,
  camerasAtStation,
  cardQuery,
  chaoPhrayaChain,
  failureFromResponse,
  frameCondition,
  frameCopy,
  frameUrl,
  groupSites,
  isAutoPaused,
  loadFrame,
  nextAttemptDelay,
  noCamerasTh,
  officialLink,
  parseFrameMeta,
  rankSites,
  readPaused,
  retryAfterSec,
  sensorFromStatus,
  sensorIndex,
  sensorLineTh,
  tileAutoRefresh,
  tileIntervalMs,
  tileMayLoad,
  viewAtStationTh,
  viewerAutoRefresh,
  viewerIntervalMs,
  writePaused,
  type FrameDeps,
  type FrameMeta,
  type SensorInfo,
} from '@/lib/ui/cctv'
import { CameraCard } from '@/components/cctv/CameraCard'
import { Dashboard } from '@/components/dashboard/Dashboard'
import snapshotJson from '@/app/dev/preview/snapshot-sample.json'

// Synthetic cameras only: no real stream addresses, no real frames.

const NOW = Date.parse('2026-10-04T03:42:00Z') // 10:42 Bangkok
const MIN = 60_000

function cam(over: Partial<PublicCamera> & Pick<PublicCamera, 'id'>): PublicCamera {
  const nativeId = over.id.split(':')[1] ?? '1'
  return {
    source: 'bma-floodcam',
    nativeId,
    siteId: `bma-floodcam:${nativeId}`,
    name: `ซอยทดสอบ ${nativeId}`,
    code: null,
    angle: null,
    owner: 'สำนักการระบายน้ำ กทม.',
    lat: 13.75,
    lng: 100.5,
    facing: 'road',
    nearStationIds: [],
    officialUrl: 'https://floodbangkok.bangkok.go.th/',
    cadenceMin: null,
    distanceKm: 1,
    media: 'image',
    imageUrl: `/api/cctv/image/bma-floodcam/${nativeId}.jpg`,
    refreshSec: 60,
    ...over,
  }
}

const bma = cam({ id: 'bma-floodcam:101' })
const dwr = cam({ id: 'dwr-cctv:TA100220', source: 'dwr-cctv', owner: 'กรมทรัพยากรน้ำ', code: 'TA100220', cadenceMin: 15, refreshSec: 300, facing: 'water' })
const demo = cam({ id: 'demo-cam:3', source: 'demo-cam', owner: 'ข้อมูลสาธิต (จำลอง)', officialUrl: '/about' })
const link = cam({ id: 'bma-floodcam:202', media: 'link', imageUrl: null })

function meta(over: Partial<FrameMeta> = {}): FrameMeta {
  return { fetchedAt: NOW - 1 * MIN, capturedAt: null, changedAt: NOW - 1 * MIN, stale: false, ...over }
}

/** Thai has no spaces: "แสดง" contains สด, so match สด only as a word of its own. */
const LIVE_RE = /(?<![ก-๙])สด(?![ก-๙])|ภาพสด|ถ่ายทอดสด|\blive\b/i

function allText(c: ReturnType<typeof frameCopy>): string {
  return [c.badge, c.line ?? '', ...c.notices, c.live].join('\n')
}

describe('cctv frame states and Thai copy', () => {
  it('fresh BMA still: "ภาพนิ่ง · ได้ภาพ HH:MM น." with no notice and nothing to announce', () => {
    const c = frameCopy(bma, { meta: meta(), loading: false, failure: null }, NOW)
    expect(c.line).toBe('ภาพนิ่ง · ได้ภาพ 10:41 น. · เมื่อสักครู่')
    expect(c.badge).toBe('ภาพนิ่ง · 10:41 น.')
    expect(c.notices).toEqual([])
    expect(c.live).toBe('')
    expect(c.dim).toBe(false)
  })

  it('fresh DWR still uses the agency capture time ("ถ่าย")', () => {
    const m = meta({ capturedAt: NOW - 27 * MIN, fetchedAt: NOW - 2 * MIN, changedAt: NOW - 20 * MIN })
    expect(frameCondition(m, dwr, NOW)).toBe('fresh')
    const c = frameCopy(dwr, { meta: m, loading: false, failure: null }, NOW)
    expect(c.line).toBe('ภาพนิ่ง · ถ่าย 10:15 น. · 27 นาทีที่แล้ว')
  })

  it('stale: dimmed with "ภาพนี้ไม่ใช่ภาพปัจจุบัน — ภาพล่าสุดเมื่อ HH:MM น."', () => {
    const old = meta({ fetchedAt: NOW - FETCHED_STALE_MS - MIN, changedAt: NOW - 30 * MIN })
    expect(frameCondition(old, bma, NOW)).toBe('stale')
    const c = frameCopy(bma, { meta: old, loading: false, failure: null }, NOW)
    expect(c.dim).toBe(true)
    expect(c.notices).toContain('ภาพนี้ไม่ใช่ภาพปัจจุบัน — ภาพล่าสุดเมื่อ 10:36 น.')
    expect(c.live).toBe('ภาพจากกล้องนี้ไม่ใช่ภาพปัจจุบัน')
    // The server re-serving its last good still is stale too, whatever its age.
    expect(frameCondition(meta({ stale: true }), bma, NOW)).toBe('stale')
    // DWR goes stale after 45 min of capture age, and "old" after a day.
    expect(frameCondition(meta({ capturedAt: NOW - 46 * MIN }), dwr, NOW)).toBe('stale')
    expect(frameCondition(meta({ capturedAt: NOW - 25 * 60 * MIN }), dwr, NOW)).toBe('old')
    expect(frameCopy(dwr, { meta: meta({ capturedAt: NOW - 25 * 60 * MIN }), loading: false, failure: null }, NOW).badge).toBe('ภาพเก่ากว่า 1 วัน')
  })

  it('frozen: same picture for 15 min (3 cadences for DWR) → "กล้องอาจค้าง"', () => {
    const m = meta({ changedAt: NOW - 16 * MIN })
    expect(frameCondition(m, bma, NOW)).toBe('frozen')
    expect(frameCopy(bma, { meta: m, loading: false, failure: null }, NOW).notices).toContain('ภาพไม่เปลี่ยนตั้งแต่ 10:26 น. — กล้องอาจค้าง')
    expect(frameCondition(meta({ capturedAt: NOW - 5 * MIN, changedAt: NOW - 20 * MIN }), dwr, NOW)).toBe('fresh')
    expect(frameCondition(meta({ capturedAt: NOW - 5 * MIN, changedAt: NOW - 46 * MIN }), dwr, NOW)).toBe('frozen')
  })

  it('failures say what happened and never that there is no flood', () => {
    const unreachable = frameCopy(bma, { meta: null, loading: false, failure: 'unreachable' }, NOW)
    expect(unreachable.notices).toEqual(['ติดต่อกล้องไม่ได้ในขณะนี้ — ไม่ได้แปลว่าไม่มีน้ำท่วม'])
    expect(unreachable.live).toBe(unreachable.notices[0])
    expect(frameCopy(bma, { meta: null, loading: false, failure: 'timeout' }, NOW).notices).toEqual(unreachable.notices)
    expect(frameCopy(dwr, { meta: null, loading: false, failure: 'no-image' }, NOW).notices).toEqual(['หน่วยงานยังไม่มีภาพจากกล้องนี้'])
    expect(frameCopy(bma, { meta: null, loading: false, failure: 'budget' }, NOW).notices).toEqual([
      'มีผู้ขอภาพจำนวนมาก ระบบพักการดึงภาพชั่วคราวเพื่อไม่รบกวนเซิร์ฟเวอร์ของหน่วยงาน',
    ])
    // A failed refresh keeps the previous still and says so.
    const kept = frameCopy(bma, { meta: meta(), loading: false, failure: 'unreachable' }, NOW)
    expect(kept.line).not.toBeNull()
    expect(kept.notices.at(-1)).toContain('ไม่ได้แปลว่าไม่มีน้ำท่วม')
  })

  it('link-only, loading, tap-to-load and demo states', () => {
    expect(frameCopy(link, { meta: null, loading: false, failure: null }, NOW).notices).toEqual([CCTV_LINK_ONLY_TH])
    expect(frameCopy(bma, { meta: null, loading: true, failure: null }, NOW).notices).toEqual([CCTV_LOADING_TH])
    expect(frameCopy(bma, { meta: null, loading: false, failure: null, tapToLoad: true }, NOW).notices).toEqual([CCTV_TAP_TO_LOAD_TH])
    const d = frameCopy(demo, { meta: meta(), loading: false, failure: null }, NOW)
    expect(d.notices[0]).toBe(CCTV_DEMO_TH)
    expect(d.badge.startsWith('ภาพจำลอง')).toBe(true)
  })

  it('never labels anything live ("สด"/"LIVE") and never implies dry or normal', () => {
    const states = [
      frameCopy(bma, { meta: meta(), loading: false, failure: null }, NOW),
      frameCopy(dwr, { meta: meta({ capturedAt: NOW - 5 * MIN }), loading: false, failure: null }, NOW),
      frameCopy(bma, { meta: meta({ stale: true }), loading: false, failure: 'unreachable' }, NOW),
      frameCopy(bma, { meta: meta({ changedAt: NOW - 60 * MIN }), loading: false, failure: null }, NOW),
      frameCopy(demo, { meta: meta(), loading: false, failure: null }, NOW),
      frameCopy(link, { meta: null, loading: false, failure: null }, NOW),
      ...(['unreachable', 'timeout', 'no-image', 'budget', 'rate', 'not-found'] as const).map((f) =>
        frameCopy(bma, { meta: null, loading: false, failure: f }, NOW),
      ),
    ]
    for (const s of states) {
      const t = allText(s)
      expect(t).not.toMatch(LIVE_RE)
      // The only mention of "no flood" is the explicit "it does not mean there is no flood".
      expect(t.replaceAll('ไม่ได้แปลว่าไม่มีน้ำท่วม', '')).not.toMatch(/ถนนแห้ง|ไม่มีน้ำท่วม|น้ำไม่ท่วม|ปกติ/)
    }
    expect(CCTV_CARD_SUBTITLE).not.toMatch(LIVE_RE)
    // The word check itself: "แสดง" is not "สด".
    expect('แสดงภาพ').not.toMatch(LIVE_RE)
    expect('ภาพสด').toMatch(LIVE_RE)
  })

  it('alt text names camera, agency and time — never the scene', () => {
    expect(cameraAltTh(bma, meta())).toBe('ภาพจากกล้อง ซอยทดสอบ 101 (สำนักการระบายน้ำ กทม.) ได้ภาพเมื่อ 10:41 น.')
    expect(cameraAltTh(dwr, meta({ capturedAt: NOW - 27 * MIN }))).toBe('ภาพจากกล้อง ซอยทดสอบ TA100220 (กรมทรัพยากรน้ำ) ถ่ายเมื่อ 10:15 น.')
    expect(cameraAltTh(demo, meta())).toContain(CCTV_DEMO_TH)
    expect(cameraAltTh(bma, meta())).not.toMatch(/น้ำท่วม|แห้ง/)
  })

  it('maps image errors from status and the JSON reason', () => {
    expect(failureFromResponse(404, { error: 'ไม่พบกล้องนี้', reason: 'not-found' })).toBe('not-found')
    expect(failureFromResponse(429, null)).toBe('rate')
    expect(failureFromResponse(503, { reason: 'budget' })).toBe('budget')
    expect(failureFromResponse(503, { reason: 'busy' })).toBe('budget')
    expect(failureFromResponse(502, { reason: 'no-image' })).toBe('no-image')
    expect(failureFromResponse(502, { reason: 'unreachable' })).toBe('unreachable')
    expect(failureFromResponse(500, null)).toBe('unreachable')
    expect(retryAfterSec('60')).toBe(60)
    expect(retryAfterSec('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull()
    expect(retryAfterSec(null)).toBeNull()
  })

  it('reads X-Cctv-* headers, falling back to the receive time', () => {
    const h = new Headers({
      'X-Cctv-Fetched-At': '2026-10-04T03:41:00.000Z',
      'X-Cctv-Captured-At': '2026-10-04T03:15:00.000Z',
      'X-Cctv-Changed-At': '2026-10-04T03:20:00.000Z',
      'X-Cctv-Stale': '1',
    })
    expect(parseFrameMeta((n) => h.get(n), NOW)).toEqual({
      fetchedAt: NOW - MIN,
      capturedAt: NOW - 27 * MIN,
      changedAt: NOW - 22 * MIN,
      stale: true,
    })
    expect(parseFrameMeta(() => null, NOW)).toEqual({ fetchedAt: NOW, capturedAt: null, changedAt: null, stale: false })
  })
})

describe('cctv still loading (fetch → blob → object URL → decode)', () => {
  function deps(res: Response | (() => Promise<Response>), over: Partial<FrameDeps> = {}) {
    const created: string[] = []
    const revoked: string[] = []
    const d: FrameDeps = {
      fetch: vi.fn(async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch,
      createObjectURL: () => {
        const u = `blob:test/${created.length + 1}`
        created.push(u)
        return u
      },
      revokeObjectURL: (u) => revoked.push(u),
      decode: async () => {},
      now: () => NOW,
      ...over,
    }
    return { d, created, revoked }
  }
  const jpeg = () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'X-Cctv-Fetched-At': '2026-10-04T03:41:00.000Z' },
    })

  it('returns a decoded object URL with the frame metadata; no referrer is sent', async () => {
    const { d, created } = deps(jpeg())
    const out = await loadFrame('/api/cctv/image/bma-floodcam/101.jpg?t=1', new AbortController().signal, d)
    expect(out).toEqual({ ok: true, src: created[0], meta: { fetchedAt: NOW - MIN, capturedAt: null, changedAt: null, stale: false } })
    const init = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.credentials).toBe('same-origin')
  })

  it('maps error responses (502 no-image, 503 with Retry-After, 404) without creating URLs', async () => {
    const noImg = deps(new Response(JSON.stringify({ error: 'หน่วยงานยังไม่มีภาพจากกล้องนี้', reason: 'no-image' }), { status: 502 }))
    expect(await loadFrame('/x.jpg', new AbortController().signal, noImg.d)).toEqual({ ok: false, failure: 'no-image', retryAfterSec: null })
    const busy = deps(new Response(JSON.stringify({ error: 'ระบบพักการดึงภาพชั่วคราว', reason: 'budget' }), { status: 503, headers: { 'Retry-After': '60' } }))
    expect(await loadFrame('/x.jpg', new AbortController().signal, busy.d)).toEqual({ ok: false, failure: 'budget', retryAfterSec: 60 })
    const gone = deps(new Response('{"error":"ไม่พบกล้องนี้"}', { status: 404 }))
    expect(await loadFrame('/x.jpg', new AbortController().signal, gone.d)).toMatchObject({ ok: false, failure: 'not-found' })
    expect(noImg.created.length + busy.created.length + gone.created.length).toBe(0)
  })

  it('rejects non-image bodies and revokes a still that fails to decode', async () => {
    const html = deps(new Response('<html>challenge</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    expect(await loadFrame('/x.jpg', new AbortController().signal, html.d)).toMatchObject({ ok: false, failure: 'unreachable' })
    const empty = deps(new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
    expect(await loadFrame('/x.jpg', new AbortController().signal, empty.d)).toMatchObject({ ok: false, failure: 'no-image' })
    const bad = deps(jpeg(), { decode: async () => Promise.reject(new Error('decode')) })
    expect(await loadFrame('/x.jpg', new AbortController().signal, bad.d)).toMatchObject({ ok: false, failure: 'no-image' })
    expect(bad.revoked).toEqual(bad.created)
    const network = deps(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await loadFrame('/x.jpg', new AbortController().signal, network.d)).toMatchObject({ ok: false, failure: 'unreachable' })
  })

  it('the watchdog abort reads as "timeout"; any other abort throws (camera switched)', async () => {
    const hang = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const watch = new AbortController()
    const w = deps(jpeg(), { fetch: ((_: unknown, init: RequestInit) => hang(init.signal!)) as unknown as typeof fetch })
    const p1 = loadFrame('/x.jpg', watch.signal, w.d)
    watch.abort(WATCHDOG_REASON)
    expect(await p1).toEqual({ ok: false, failure: 'timeout', retryAfterSec: null })

    const user = new AbortController()
    const p2 = loadFrame('/x.jpg', user.signal, w.d)
    user.abort()
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' })

    // Aborted while decoding: the new URL is revoked, nothing is returned.
    const late = new AbortController()
    const l = deps(jpeg(), {
      decode: async () => {
        late.abort()
      },
    })
    await expect(loadFrame('/x.jpg', late.signal, l.d)).rejects.toMatchObject({ name: 'AbortError' })
    expect(l.revoked).toEqual(l.created)
  })
})

describe('cctv refresh rules', () => {
  const on = { onScreen: true, visible: true, paused: false, saveData: false }

  it('tiles refresh only on screen, in a visible tab, not paused and not under Save-Data', () => {
    expect(tileAutoRefresh(on)).toBe(true)
    expect(tileAutoRefresh({ ...on, onScreen: false })).toBe(false)
    expect(tileAutoRefresh({ ...on, visible: false })).toBe(false)
    expect(tileAutoRefresh({ ...on, paused: true })).toBe(false)
    expect(tileAutoRefresh({ ...on, saveData: true })).toBe(false)
    expect(tileIntervalMs(bma)).toBe(180_000)
    expect(tileIntervalMs(dwr)).toBe(300_000)
  })

  it('Save-Data: tap to load (the first still waits for a tap)', () => {
    expect(tileMayLoad({ onScreen: true, saveData: false, tapped: false })).toBe(true)
    expect(tileMayLoad({ onScreen: false, saveData: false, tapped: false })).toBe(false)
    expect(tileMayLoad({ onScreen: true, saveData: true, tapped: false })).toBe(false)
    expect(tileMayLoad({ onScreen: true, saveData: true, tapped: true })).toBe(true)
  })

  it('viewer: every 60 s (DWR 5 min), stops after 5 minutes, honours its pause and Save-Data', () => {
    expect(viewerIntervalMs(bma)).toBe(60_000)
    expect(viewerIntervalMs(dwr)).toBe(300_000)
    const v = { visible: true, paused: false, autoPaused: false, saveData: false }
    expect(viewerAutoRefresh(v)).toBe(true)
    expect(viewerAutoRefresh({ ...v, paused: true })).toBe(false)
    expect(viewerAutoRefresh({ ...v, autoPaused: true })).toBe(false)
    expect(viewerAutoRefresh({ ...v, saveData: true })).toBe(false)
    expect(viewerAutoRefresh({ ...v, visible: false })).toBe(false)
    expect(isAutoPaused(NOW - VIEWER_AUTO_PAUSE_MS + 1, NOW)).toBe(false)
    expect(isAutoPaused(NOW - VIEWER_AUTO_PAUSE_MS, NOW)).toBe(true)
  })

  it('the next request waits a full interval after the previous one finished (never overlapping)', () => {
    expect(nextAttemptDelay(null, 60_000, NOW)).toBe(0)
    expect(nextAttemptDelay(NOW - 20_000, 60_000, NOW)).toBe(40_000)
    expect(nextAttemptDelay(NOW - 90_000, 60_000, NOW)).toBe(0)
    expect(nextAttemptDelay(NOW, 60_000, NOW, 120)).toBe(120_000)
  })

  it('still URLs change once per cache bucket', () => {
    const a = frameUrl('/api/cctv/image/bma-floodcam/101.jpg', NOW, 60)
    expect(a).toMatch(/^\/api\/cctv\/image\/bma-floodcam\/101\.jpg\?t=\d+$/)
    expect(frameUrl('/api/cctv/image/bma-floodcam/101.jpg', NOW + 1000, 60)).toBe(a)
    expect(frameUrl('/api/cctv/image/bma-floodcam/101.jpg', NOW + 61_000, 60)).not.toBe(a)
  })

  it('the global pause lives in localStorage and survives storage that throws', () => {
    const mem = new Map<string, string>()
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
    expect(readPaused(() => store)).toBe(false)
    writePaused(() => store, true)
    expect(mem.get(CCTV_PAUSE_KEY)).toBe('1')
    expect(readPaused(() => store)).toBe(true)
    writePaused(() => store, false)
    expect(mem.has(CCTV_PAUSE_KEY)).toBe(false)
    const broken = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(readPaused(broken)).toBe(false)
    expect(() => writePaused(broken, true)).not.toThrow()
    expect(readPaused(() => null)).toBe(false)
  })
})

function road(id: string, level: SensorInfo['level'], cm: number, stale = false): SensorInfo {
  return { id, name: id, kind: 'roadflood', level, stale, roadFloodCm: cm, freeboard: null }
}

describe('cctv sites, sensors and ranking', () => {

  it('groups angles per site in angle order and keeps the nearest distance', () => {
    const sites = groupSites([
      cam({ id: 'bma-floodcam:12', siteId: 's1', code: 'CM3-JJ-70-C2', distanceKm: 0.4 }),
      cam({ id: 'bma-floodcam:11', siteId: 's1', code: 'CM3-JJ-70-C1', distanceKm: 0.4, nearStationIds: ['road:FL.A'] }),
      cam({ id: 'bma-floodcam:13', siteId: 's1', code: 'CM3-JJ-70-C10', distanceKm: 0.41, nearStationIds: ['road:FL.B', 'road:FL.A'] }),
      cam({ id: 'bma-floodcam:20', siteId: 's2', distanceKm: 0.9 }),
    ])
    expect(sites.map((s) => s.siteId)).toEqual(['s1', 's2'])
    expect(sites[0]!.cameras.map((c) => c.code)).toEqual(['CM3-JJ-70-C1', 'CM3-JJ-70-C2', 'CM3-JJ-70-C10'])
    expect(sites[0]!.distanceKm).toBe(0.4)
    expect(sites[0]!.nearStationIds).toEqual(['road:FL.A', 'road:FL.B'])
  })

  it('moves sites whose sensor is on watch or worse first, then fills from beyond the radius up to 10 km', () => {
    const sites = groupSites([
      cam({ id: 'bma-floodcam:1', siteId: 'a', distanceKm: 0.5 }),
      cam({ id: 'bma-floodcam:2', siteId: 'b', distanceKm: 1.0, nearStationIds: ['road:FL.W'] }),
      cam({ id: 'bma-floodcam:3', siteId: 'c', distanceKm: 1.0 }),
      cam({ id: 'bma-floodcam:4', siteId: 'd', distanceKm: 2.5, nearStationIds: ['road:FL.C'] }),
      cam({ id: 'bma-floodcam:5', siteId: 'e', distanceKm: 4.2 }),
      cam({ id: 'bma-floodcam:6', siteId: 'f', distanceKm: 11 }),
    ])
    const sensors = sensorIndex([road('road:FL.W', 'watch', 12), road('road:FL.C', 'critical', 40)])
    const ranked = rankSites(sites, { radiusKm: 3, sensors, limit: 6 })
    expect(ranked.map((s) => s.siteId)).toEqual(['d', 'b', 'a', 'c', 'e'])
    expect(ranked.map((s) => s.outside)).toEqual([false, false, false, false, true])
    expect(ranked[0]!.sensor?.id).toBe('road:FL.C')
    // A stale sensor is not promoted.
    const stale = rankSites(sites, { radiusKm: 3, sensors: sensorIndex([road('road:FL.C', 'critical', 40, true)]) })
    expect(stale.map((s) => s.siteId)).toEqual(['a', 'b', 'c', 'd'])
    // Ties by distance are broken by site id.
    expect(rankSites(sites, { radiusKm: 3, sensors: new Map() }).map((s) => s.siteId).slice(1, 3)).toEqual(['b', 'c'])
  })

  it('shows the sensor reading (not the picture) as the tile status line', () => {
    expect(sensorLineTh(road('r', 'watch', 12))).toBe('น้ำบนถนน 12 ซม. · เฝ้าระวัง')
    expect(sensorLineTh(road('r', 'watch', 12, true))).toBe('เซ็นเซอร์น้ำบนถนน: ไม่มีข้อมูลล่าสุด')
    expect(sensorLineTh({ id: 'c', name: 'c', kind: 'water', level: 'warning', stale: false, roadFloodCm: null, freeboard: 0.42 })).toBe(
      'ห่างตลิ่ง 0.42 ม. · เตือนภัย',
    )
    const snapshot = snapshotJson as unknown as DashboardSnapshot
    const s = snapshot.roadFlood[0] ?? snapshot.water[0]
    if (s) expect(sensorFromStatus(s)?.id).toBe(s.station.id)
  })

  it('empty state and query helpers', () => {
    expect(noCamerasTh(10, 14.23)).toBe('ไม่มีกล้องในระยะ 10 กม. — กล้องที่ใกล้ที่สุดอยู่ห่าง 14.2 กม.')
    expect(noCamerasTh(10, null)).toBe('ไม่มีกล้องในระยะ 10 กม.')
    expect(cardQuery({ lat: 13.7, lng: 100.5, radiusKm: 3 })).toEqual({ lat: 13.7, lng: 100.5, r: 10, n: 12 })
    expect(cardQuery({ lat: 13.7, lng: 100.5, radiusKm: 15 }).r).toBe(15)
    expect(viewAtStationTh(2)).toBe('ดูกล้องที่จุดนี้ (2 มุม)')
    expect(camerasAtStation('road:FL.A', [cam({ id: 'bma-floodcam:1', nearStationIds: ['road:FL.A'] }), bma]).map((c) => c.id)).toEqual([
      'bma-floodcam:1',
    ])
  })

  it('steps through the Chao Phraya chain: Bangkok, Samut Prakan, Pathum Thani, then upstream', () => {
    const d = (code: string, lat: number) => cam({ id: `dwr-cctv:${code}`, source: 'dwr-cctv', code, lat })
    const chain = chaoPhrayaChain([d('TA100217', 14.59), d('TA130204', 13.72), d('TA100219', 14.02), d('TC100224', 13.97), d('TA100221', 13.6), d('TA100220', 13.74), d('TA100213', 15.33), bma])
    expect(chain.map((c) => c.code)).toEqual(['TA100220', 'TA100221', 'TC100224', 'TA100219', 'TA100217', 'TA100213'])
  })

  it('opens only http(s) agency links in a new tab; same-origin pages stay internal', () => {
    expect(officialLink('https://floodbangkok.bangkok.go.th/')).toEqual({ href: 'https://floodbangkok.bangkok.go.th/', external: true })
    expect(officialLink('/about')).toEqual({ href: '/about', external: false })
    expect(officialLink('javascript:alert(1)')).toBeNull()
    expect(officialLink('//evil.example.invalid/')).toBeNull()
  })
})

describe('cctv api helper', () => {
  it('builds the query and normalises missing fields', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ cameras: [bma] }), { status: 200 }))
    const r = await fetchCameras({ lat: 13.7, lng: 100.5, r: 10, n: 12 }, { fetch: f as unknown as typeof fetch })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/cctv/cameras?lat=13.7&lng=100.5&r=10&n=12')
    expect(r.cameras).toHaveLength(1)
    expect(r).toMatchObject({ catalogAt: {}, links: [], nearestOutsideKm: null })
    await fetchCameras(null, { fetch: f as unknown as typeof fetch })
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe('/api/cctv/cameras')
  })
})

describe('cctv dashboard card and layout', () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
  const snapshot = snapshotJson as unknown as DashboardSnapshot

  it("gives the camera card its own grid area in every wide template (no order / display: contents)", () => {
    const templates = [...css.matchAll(/grid-template-areas:\s*((?:'[^']*'\s*)+);/g)].map((m) => [...m[1]!.matchAll(/'([^']*)'/g)].map((r) => r[1]!.trim().split(/\s+/)))
    expect(templates.length).toBe(4)
    for (const rows of templates) {
      // One full-width row of its own, right above the legend.
      const camRows = rows.filter((r) => r.includes('cam'))
      expect(camRows).toHaveLength(1)
      expect(camRows[0]!.every((c) => c === 'cam')).toBe(true)
      expect(rows[rows.indexOf(camRows[0]!) + 1]!.every((c) => c === 'legend')).toBe(true)
    }
    expect(css).toMatch(/\.fm-dash > \[data-area='cam'\] \{\s*grid-area: cam;/)
  })

  it('keeps the camera area out of the dashboard until the camera list has loaded', () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, {
        snapshot,
        place: null,
        dataMode: 'live',
        nowMs: Date.parse(snapshot.generatedAt),
        history: { data: null, error: null },
        status: { error: null, updatedAt: null, carriedOver: false },
      }),
    )
    expect(html).not.toContain('data-area="cam"')
    // The viewer dialog is present (closed) for tiles and markers to open.
    expect(html).toContain('aria-labelledby="cam-viewer-title"')
  })

  it('renders tiles with angle badge, distance, outside-radius label, sensor line, credit and safe agency links', () => {
    const data: CamerasResponse = {
      generatedAt: new Date(NOW).toISOString(),
      catalogAt: { 'bma-floodcam': new Date(NOW - 3600_000).toISOString(), 'dwr-cctv': new Date(NOW - 86_400_000).toISOString() },
      cameras: [
        cam({ id: 'bma-floodcam:1', siteId: 's1', code: 'CM-1-C1', distanceKm: 0.3, nearStationIds: ['road:FL.W'] }),
        cam({ id: 'bma-floodcam:2', siteId: 's1', code: 'CM-1-C2', distanceKm: 0.3, nearStationIds: ['road:FL.W'] }),
        cam({ id: 'bma-floodcam:3', siteId: 's2', distanceKm: 1.4 }),
        cam({ id: 'bma-floodcam:4', siteId: 's3', distanceKm: 6.1, media: 'link', imageUrl: null }),
      ],
      nearestOutsideKm: null,
      links: [
        { id: 'bma-traffic', title: 'กล้องจราจร กทม.', owner: 'สำนักการจราจรและขนส่ง กทม.', url: 'http://www.bmatraffic.com/' },
        { id: 'bad', title: 'x', owner: 'x', url: 'javascript:alert(1)' },
      ],
    }
    const sensors = sensorIndex([road('road:FL.W', 'watch', 12)])
    const html = renderToStaticMarkup(createElement(CameraCard, { data, place: { lat: 13.75, lng: 100.5, radiusKm: 3 }, sensors, nowMs: NOW }))
    expect(html).toContain('กล้อง CCTV ใกล้บ้าน')
    expect(html).toContain(CCTV_CARD_SUBTITLE)
    expect(html).toContain('2 มุม')
    expect(html).toContain('300 ม.')
    expect(html).toContain('6.1 กม. · นอกรัศมี')
    expect(html).toContain('น้ำบนถนน 12 ซม. · เฝ้าระวัง')
    expect(html).toContain('ภาพ: สำนักการระบายน้ำ กทม.')
    expect(html).toContain(CCTV_LINK_ONLY_TH)
    expect(html).toContain('กล้องแม่น้ำเจ้าพระยา')
    expect(html).toContain('href="/map?cams=1"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toMatch(/<a href="http:\/\/www\.bmatraffic\.com\/" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/i)
    expect(html).not.toContain('javascript:')
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(LIVE_RE)
    // No still is requested during server rendering.
    expect(html).not.toContain('<img')
  })

  it('empty state reports the distance to the nearest camera', () => {
    const data: CamerasResponse = {
      generatedAt: new Date(NOW).toISOString(),
      catalogAt: { 'bma-floodcam': new Date(NOW).toISOString() },
      cameras: [],
      nearestOutsideKm: 14.2,
      links: [],
    }
    const html = renderToStaticMarkup(createElement(CameraCard, { data, place: { lat: 13.9, lng: 100.9, radiusKm: 3 }, sensors: new Map(), nowMs: NOW }))
    expect(html).toContain('ไม่มีกล้องในระยะ 10 กม. — กล้องที่ใกล้ที่สุดอยู่ห่าง 14.2 กม.')
  })
})
