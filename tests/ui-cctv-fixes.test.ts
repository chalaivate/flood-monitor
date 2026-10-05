import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CamerasResponse, PublicCamera } from '@/lib/server/public'
import {
  CCTV_LIMITED_TH,
  CCTV_LINK_ONLY_TH,
  CCTV_LINKS_NOTE_TH,
  CCTV_LOADING_TH,
  CCTV_NOT_FLOOD_SIGNAL_TH,
  CCTV_UNAVAILABLE_TH,
  UNAVAILABLE_MIN_RETRY_SEC,
  WATCHDOG_MS,
  activeHold,
  cameraAltTh,
  cardSubtitleTh,
  failureFromResponse,
  frameCopy,
  groupSites,
  isLinkOnlyFailure,
  listReloadGate,
  loadFrame,
  mapCamerasStatusTh,
  noteRetryHold,
  reloadDelay,
  retryScope,
  tileAutoRefresh,
  tileMayLoad,
  whenTh,
  type FrameDeps,
  type FrameMeta,
  type RetryHolds,
} from '@/lib/ui/cctv'
import { CameraCard } from '@/components/cctv/CameraCard'
import { CameraFrame, CameraLinks } from '@/components/cctv/CameraFrame'
import { ViewerStill } from '@/components/cctv/CameraViewer'
import { requestCameraListReload, subscribeCameraListReload } from '@/components/cctv/hooks'
import { keepViewerFocus } from '@/components/cctv/viewer-focus'
import {
  VIEWER_HISTORY_KEY,
  closeCameraViewer,
  currentViewerState,
  mountViewerHost,
  newViewerHostId,
  openCameraViewer,
  viewerStateFor,
} from '@/components/cctv/viewer-store'
import { popupFootTh } from '@/components/map/CameraPopup'
import { popupKeyAction } from '@/components/map/popup-focus'
import { CCTV_POLICY, CCTV_SERVER_MAX_MS, cctvFailure, type CctvFailure } from '@/lib/server/cctv-proxy'
import { resetConfigCache } from '@/lib/config'

// Regression tests for the CCTV UI review fixes (cctv-ui-01 … 15, correctness F8, privacy F9).
// Synthetic cameras only; no network.

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), connection: async () => {} }))

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
const link = cam({ id: 'bma-floodcam:202', media: 'link', imageUrl: null })

function meta(over: Partial<FrameMeta> = {}): FrameMeta {
  return { fetchedAt: NOW - 1 * MIN, capturedAt: null, changedAt: NOW - 1 * MIN, stale: false, ...over }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// --- ui-01: the viewer belongs to its page and to a history entry ---------------------------------

/** A stand-in for window: history entries + popstate listeners (popstate fires on back()). */
function fakeWindow() {
  const entries: unknown[] = [{ __NA: true }]
  let index = 0
  const popstate = new Set<() => void>()
  const calls = { push: 0, back: 0 }
  const fire = () => {
    for (const l of [...popstate]) l()
  }
  const w = {
    history: {
      get state() {
        return entries[index]
      },
      pushState(data: unknown) {
        calls.push++
        entries.splice(index + 1)
        entries.push(data)
        index++
      },
      back() {
        calls.back++
        if (index > 0) index--
        fire()
      },
    },
    addEventListener: (type: string, cb: () => void) => type === 'popstate' && popstate.add(cb),
    removeEventListener: (type: string, cb: () => void) => type === 'popstate' && popstate.delete(cb),
    /** The browser's Back button: move back one entry and fire popstate (no back() call). */
    userBack() {
      if (index > 0) index--
      fire()
    },
    get index() {
      return index
    },
    calls,
  }
  return w
}

describe('cctv-ui-01: viewer state does not survive navigation; Back closes it', () => {
  let w: ReturnType<typeof fakeWindow>
  let release: (() => void) | null = null
  beforeEach(() => {
    w = fakeWindow()
    vi.stubGlobal('window', w)
  })
  afterEach(() => {
    closeCameraViewer()
    release?.()
    release = null
    vi.unstubAllGlobals()
  })

  const sites = groupSites([bma])

  it('opening adds a same-URL history entry; Back pops it and closes the viewer without leaving the page', () => {
    const id = newViewerHostId()
    release = mountViewerHost(id)
    openCameraViewer({ kind: 'sites', sites, index: 0 })
    expect(w.calls.push).toBe(1)
    expect((w.history.state as Record<string, unknown>)[VIEWER_HISTORY_KEY]).toBe(currentViewerState()!.entry)
    expect(viewerStateFor(id)?.request.kind).toBe('sites')

    w.userBack()
    expect(currentViewerState()).toBeNull()
    expect(w.index).toBe(0)
    // Closing because of Back never goes back a second time.
    expect(w.calls.back).toBe(0)
  })

  it('closing from the page removes the entry again (Back then leaves the page as usual)', () => {
    release = mountViewerHost(newViewerHostId())
    openCameraViewer({ kind: 'sites', sites, index: 0 })
    closeCameraViewer()
    expect(currentViewerState()).toBeNull()
    expect(w.calls.back).toBe(1)
    expect(w.index).toBe(0)
    // A second close (the dialog's own close event) does nothing.
    closeCameraViewer()
    expect(w.calls.back).toBe(1)
  })

  it("another page's viewer never shows the state, and it is dropped when its page unmounts", () => {
    const dash = newViewerHostId()
    const releaseDash = mountViewerHost(dash)
    openCameraViewer({ kind: 'sites', sites, index: 0 })
    // Client navigation: the next page renders (and mounts its viewer) before the old one's cleanup.
    const map = newViewerHostId()
    expect(viewerStateFor(map)).toBeNull()
    releaseDash()
    release = mountViewerHost(map)
    expect(currentViewerState()).toBeNull()
    expect(viewerStateFor(map)).toBeNull()
    // The page went away: history is the router's now, so nothing is popped.
    expect(w.calls.back).toBe(0)
  })

  it('replacing the request from inside (chain chip) keeps the opener and the history entry', () => {
    release = mountViewerHost(newViewerHostId())
    openCameraViewer({ kind: 'sites', sites, index: 0 })
    const first = currentViewerState()!
    openCameraViewer({ kind: 'chain' })
    const next = currentViewerState()!
    expect(next.seq).toBeGreaterThan(first.seq)
    expect(next.entry).toBe(first.entry)
    expect(w.calls.push).toBe(1)
  })
})

// --- ui-02: map popups from the keyboard ------------------------------------------------------------

describe('cctv-ui-02: popup keys (focus moves in on open; Escape returns to the marker)', () => {
  it('Escape closes; Tab past the last control continues after the marker; Shift+Tab before the first returns to it', () => {
    // Focusables in DOM order: [ดูภาพ, เปิดเว็บทางการ, Leaflet's close ×]
    expect(popupKeyAction('Escape', false, 1, 3)).toBe('close')
    expect(popupKeyAction('Tab', false, 2, 3)).toBe('to-next')
    expect(popupKeyAction('Tab', false, 0, 3)).toBeNull()
    expect(popupKeyAction('Tab', true, 1, 3)).toBeNull()
    expect(popupKeyAction('Tab', true, 0, 3)).toBe('to-opener')
    // A popup without controls: its content holds focus (index -1); Tab reaches the close button.
    expect(popupKeyAction('Tab', false, -1, 1)).toBeNull()
    expect(popupKeyAction('Tab', false, 0, 1)).toBe('to-next')
    expect(popupKeyAction('Tab', true, -1, 1)).toBe('to-opener')
    expect(popupKeyAction('Tab', false, -1, 0)).toBe('to-next')
    expect(popupKeyAction('Enter', false, 1, 3)).toBeNull()
  })
})

// --- ui-03 / F8 / 429: the image error contract -------------------------------------------------------

describe('cctv-ui-03 + F8: 503 unavailable and 404 are link-only for now, with the caveat', () => {
  it('maps the shared error contract to UI states', () => {
    expect(failureFromResponse(503, { reason: 'unavailable' })).toBe('unavailable')
    expect(failureFromResponse(404, { reason: 'not-found' })).toBe('unavailable')
    expect(failureFromResponse(404, null)).toBe('unavailable')
    expect(failureFromResponse(503, { reason: 'busy' })).toBe('budget')
    expect(failureFromResponse(503, { reason: 'budget' })).toBe('budget')
    expect(failureFromResponse(429, { reason: 'limited' })).toBe('limited')
    expect(failureFromResponse(502, { reason: 'unreachable' })).toBe('unreachable')
    expect(failureFromResponse(502, { reason: 'no-image' })).toBe('no-image')
    expect(isLinkOnlyFailure('unavailable')).toBe(true)
    expect(isLinkOnlyFailure('unreachable')).toBe(false)
  })

  it("agrees with the server's own failure responses (status, reason, Retry-After)", async () => {
    const expected: Record<CctvFailure, string> = {
      unreachable: 'unreachable',
      'no-image': 'no-image',
      busy: 'budget',
      budget: 'budget',
      limited: 'limited',
      unavailable: 'unavailable',
    }
    for (const [kind, ui] of Object.entries(expected) as [CctvFailure, string][]) {
      const f = cctvFailure(kind, 90)
      const res = new Response(JSON.stringify({ error: f.message, reason: kind }), { status: f.status, headers: f.headers })
      const out = await loadFrame('/x.jpg', new AbortController().signal, deps(res))
      expect(out, kind).toMatchObject({ ok: false, failure: ui })
      if (kind === 'limited' || kind === 'unavailable') expect(out, kind).toMatchObject({ retryAfterSec: 90 })
    }
  })

  it('without a still: link-only copy that says it is no flood signal, no warning badge', () => {
    const c = frameCopy(bma, { meta: null, loading: false, failure: 'unavailable' }, NOW)
    expect(c.notices).toEqual([CCTV_UNAVAILABLE_TH])
    expect(c.notices[0]).toContain(CCTV_NOT_FLOOD_SIGNAL_TH)
    expect(c.notices[0]).toContain('เปิดดูที่เว็บของหน่วยงาน')
    expect(c.notices[0]).not.toContain('ไม่พบกล้อง')
    expect(c.badge).toBe('ดูที่เว็บหน่วยงาน')
    expect(c.linkOnly).toBe(true)
    expect(c.live).toBe(CCTV_UNAVAILABLE_TH)
  })

  it('the camera list reload is coalesced when several tiles fail together', () => {
    const gate = listReloadGate(20_000)
    expect(gate(NOW)).toBe(true)
    expect(gate(NOW + 1)).toBe(false)
    expect(gate(NOW + 19_999)).toBe(false)
    expect(gate(NOW + 20_000)).toBe(true)

    const reloads = vi.fn()
    const off = subscribeCameraListReload(reloads)
    requestCameraListReload()
    requestCameraListReload()
    expect(reloads).toHaveBeenCalledTimes(1)
    off()
    // Automatic attempts after "unavailable" wait at least 5 minutes (the list reload decides).
    expect(UNAVAILABLE_MIN_RETRY_SEC).toBeGreaterThanOrEqual(300)
  })

  it("429 'limited': 'ขอภาพบ่อยเกินไป — รอสักครู่', and a manual reload waits out Retry-After", () => {
    const c = frameCopy(bma, { meta: null, loading: false, failure: 'limited' }, NOW)
    expect(c.notices).toEqual([CCTV_LIMITED_TH])
    expect(CCTV_LIMITED_TH).toBe('ขอภาพบ่อยเกินไป — รอสักครู่')
    expect(c.badge).toBe('รอสักครู่')
    expect(reloadDelay(NOW - 10_000, 30, NOW)).toBe(20_000)
    expect(reloadDelay(NOW - 40_000, 30, NOW)).toBe(0)
    expect(reloadDelay(NOW, null, NOW)).toBe(0)
    expect(reloadDelay(null, 30, NOW)).toBe(0)
  })
})

describe('Retry-After holds every still it applies to (a new viewer does not ask again at once)', () => {
  const a = '/api/cctv/image/bma-floodcam/1.jpg'
  const b = '/api/cctv/image/bma-floodcam/2.jpg'
  const d = '/api/cctv/image/dwr-cctv/TA100220.jpg'

  it("429 'limited' holds this client (every camera); 503 holds one source; no header, no hold", () => {
    expect(retryScope('limited', a)).toBe('client')
    expect(retryScope('budget', a)).toBe('source:bma-floodcam')
    expect(retryScope('unavailable', d)).toBe('source:dwr-cctv')
    expect(retryScope('unreachable', a)).toBeNull()

    const holds: RetryHolds = new Map()
    noteRetryHold(holds, 'limited', a, 30, NOW)
    expect(activeHold(holds, d, NOW + 1000)).toEqual({ waitMs: 29_000, failure: 'limited' })
    expect(activeHold(holds, d, NOW + 30_000)).toBeNull()

    noteRetryHold(holds, 'unavailable', a, 600, NOW)
    expect(activeHold(holds, b, NOW)).toEqual({ waitMs: 600_000, failure: 'unavailable' })
    expect(activeHold(holds, d, NOW)).toBeNull()
    // A 404 (no Retry-After) is about one camera only: it holds nothing.
    const none: RetryHolds = new Map()
    noteRetryHold(none, 'unavailable', a, null, NOW)
    expect(activeHold(none, b, NOW)).toBeNull()
  })
})

function deps(res: Response): FrameDeps {
  return {
    fetch: (async () => res) as unknown as typeof fetch,
    createObjectURL: () => 'blob:test/1',
    revokeObjectURL: () => {},
    decode: async () => {},
    now: () => NOW,
  }
}

// --- ui-04: focus after the request is replaced inside the viewer -------------------------------------

describe('cctv-ui-04: focus never drops to <body> inside the open viewer', () => {
  function dialog(open: boolean, inside: unknown[]) {
    const title = { focus: vi.fn() }
    return { d: { open, contains: (n: unknown) => inside.includes(n), querySelector: (sel: string) => (sel === '#cam-viewer-title' ? title : null) }, title }
  }

  it('moves focus to the viewer heading when the focused control went away', () => {
    const body = {}
    const { d, title } = dialog(true, [])
    expect(keepViewerFocus(d, body as Element)).toBe(true)
    expect(title.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('leaves focus alone while it is inside the viewer, or when the viewer is closed', () => {
    const btn = {}
    const a = dialog(true, [btn])
    expect(keepViewerFocus(a.d, btn as Element)).toBe(false)
    expect(a.title.focus).not.toHaveBeenCalled()
    const b = dialog(false, [])
    expect(keepViewerFocus(b.d, null)).toBe(false)
    expect(b.title.focus).not.toHaveBeenCalled()
  })
})

// --- ui-05: a camera that turned link-only drops (or dims and dates) its last still -------------------

describe('cctv-ui-05: no undimmed, unlabelled old still once a camera is link-only', () => {
  const frame = { src: 'blob:test/old', meta: meta(), loading: false }

  it('a link-only camera never renders its previous still', () => {
    const copy = frameCopy(link, { meta: frame.meta, loading: false, failure: null }, NOW)
    const html = renderToStaticMarkup(createElement(CameraFrame, { camera: link, frame, copy, size: 'tile', nowMs: NOW }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('blob:test/old')
  })

  it('a still kept after "unavailable" is dimmed and labelled with its time', () => {
    const copy = frameCopy(bma, { meta: frame.meta, loading: false, failure: 'unavailable' }, NOW)
    expect(copy.dim).toBe(true)
    expect(copy.badge).toBe('ภาพล่าสุด · 10:41 น.')
    expect(copy.line).toContain('10:41 น.')
    expect(copy.notices).toContain(CCTV_UNAVAILABLE_TH)
    const html = renderToStaticMarkup(createElement(CameraFrame, { camera: bma, frame, copy, size: 'tile', nowMs: NOW }))
    expect(html).toMatch(/<img[^>]+class="[^"]*opacity-45/)
    expect(html).toContain('ภาพล่าสุด · 10:41 น.')
  })
})

// --- ui-06: tiles pause behind the open viewer -----------------------------------------------------------

describe('cctv-ui-06: dashboard tiles do not refresh behind the open viewer', () => {
  const on = { onScreen: true, visible: true, paused: false, saveData: false }
  it('treats the open viewer like off-screen for refreshes and first loads', () => {
    expect(tileAutoRefresh({ ...on, viewerOpen: false })).toBe(true)
    expect(tileAutoRefresh({ ...on, viewerOpen: true })).toBe(false)
    expect(tileMayLoad({ onScreen: true, saveData: false, viewerOpen: true, tapped: false })).toBe(false)
    expect(tileMayLoad({ onScreen: true, saveData: false, viewerOpen: false, tapped: false })).toBe(true)
  })
})

// --- ui-07 / F9: disclosure copy -----------------------------------------------------------------------

describe('cctv-ui-07 + F9: the agency-links disclosure does not claim the server never fetches from them', () => {
  it('only says where the links go, even with DWR listed', () => {
    const html = renderToStaticMarkup(
      createElement(CameraLinks, {
        links: [{ id: 'dwr-cctv', title: 'กล้องสถานีโทรมาตรแม่น้ำ', owner: 'กรมทรัพยากรน้ำ', url: 'https://telemetry.dwr.go.th/reportCctv' }],
      }),
    )
    expect(html).toContain('telemetry.dwr.go.th')
    expect(html).toContain(CCTV_LINKS_NOTE_TH)
    expect(html).not.toContain('ไม่ได้ดึงภาพ')
  })
})

// --- ui-08 / ui-09: /about promises -----------------------------------------------------------------------

describe('cctv-ui-08 + ui-09: /about retention promise and takedown contact', () => {
  const keys = ['CONTACT_EMAIL', 'PUBLIC_BASE_URL', 'CCTV_SOURCES', 'CCTV_IMAGES', 'DATA_MODE'] as const
  let saved: Partial<Record<(typeof keys)[number], string | undefined>> = {}
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    for (const k of keys) delete process.env[k]
    process.env.DATA_MODE = 'live'
    resetConfigCache()
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetConfigCache()
  })

  async function about(): Promise<string> {
    const { default: AboutPage } = await import('@/app/about/page')
    return renderToStaticMarkup(await AboutPage())
  }

  it('states the same in-memory limits the server enforces (BMA and DDS 15 min, DWR 1 h)', async () => {
    expect(CCTV_POLICY['bma-floodcam'].staleMaxMs).toBe(15 * MIN)
    expect(CCTV_POLICY['bma-ddscam'].staleMaxMs).toBe(15 * MIN)
    expect(CCTV_POLICY['dwr-cctv'].staleMaxMs).toBe(60 * MIN)
    const html = await about()
    expect(html).toContain('ไม่เกิน 15 นาที (กล้องกรมทรัพยากรน้ำไม่เกิน 1 ชั่วโมง)')
    // Every camera source with stills is credited, the DDS water-level cameras included.
    expect(html).toContain('กล้องระดับน้ำ:</span> สำนักการระบายน้ำ กรุงเทพมหานคร')
    expect(html).toContain('href="https://dds.bangkok.go.th/cctv.php"')
    // ui-15 on /about: road-flood status comes from depth, not freeboard.
    expect(html).toContain('สถานะและการแจ้งเตือนมาจากเซ็นเซอร์วัดน้ำ (ระยะห่างตลิ่งของคลองและแม่น้ำ หรือความลึกน้ำบนถนน) ไม่ได้มาจากภาพกล้อง')
  })

  it('without CONTACT_EMAIL: names this site and says no address is set — never invents one', async () => {
    process.env.PUBLIC_BASE_URL = 'https://flood.example.org/'
    resetConfigCache()
    const html = await about()
    const takedown = html.slice(html.indexOf('หากพบภาพที่กระทบความเป็นส่วนตัว'), html.indexOf('ระบบนี้ไม่ใช่ประกาศเตือนภัยทางการ'))
    const text = takedown.replace(/<[^>]+>/g, '')
    expect(text).toContain('ผู้ดูแลเว็บไซต์นี้ (flood.example.org)')
    expect(text).toContain('ยังไม่ได้ระบุช่องทางติดต่อ')
    // No promise the operator cannot keep without a channel; the camera owner is reachable.
    expect(text).not.toContain('ทันที')
    expect(takedown).toContain('href="tel:1555"')
    expect(takedown).not.toMatch(/mailto:|@/)
    expect(html).not.toContain('mailto:')
  })

  it('without PUBLIC_BASE_URL either: no host, still honest', async () => {
    const text = (await about()).replace(/<[^>]+>/g, '')
    expect(text).toContain('ติดต่อ ผู้ดูแลเว็บไซต์นี้ — ')
    expect(text).toContain('ยังไม่ได้ระบุช่องทางติดต่อ')
  })

  it('with CONTACT_EMAIL: a mailto link and the immediate takedown promise', async () => {
    process.env.CONTACT_EMAIL = 'cctv@example.org'
    resetConfigCache()
    const html = await about()
    expect(html).toContain('href="mailto:cctv@example.org"')
    expect(html).toContain('เราจะปิดการแสดงภาพจากแหล่งนั้นทันที')
    expect(html).not.toContain('ยังไม่ได้ระบุช่องทางติดต่อ')
  })
})

// --- ui-10 / ui-12: CSS ---------------------------------------------------------------------------------

describe('cctv-ui-10 + ui-12: anchors clear the sticky bar; the tile focus ring is not clipped', () => {
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

  it('in-page anchors land below the 57 px sticky header', () => {
    const m = css.match(/html\s*\{\s*scroll-padding-top:\s*calc\(57px \+ ([\d.]+)rem\);/)
    expect(m).not.toBeNull()
  })

  it('draws the tile focus ring on the card (its own outline would be clipped by overflow-hidden)', () => {
    expect(css).toMatch(/\.fm-cam-tile:has\(> button:focus-visible\)\s*\{\s*outline: 2px solid var\(--accent\);/)
    expect(css).toMatch(/\.fm-cam-tile > button:focus-visible\s*\{\s*outline: none;/)
    const data: CamerasResponse = {
      generatedAt: new Date(NOW).toISOString(),
      catalogAt: { 'bma-floodcam': new Date(NOW).toISOString() },
      cameras: [bma],
      nearestOutsideKm: null,
      links: [],
    }
    const html = renderToStaticMarkup(createElement(CameraCard, { data, place: { lat: 13.75, lng: 100.5, radiusKm: 3 }, sensors: new Map(), nowMs: NOW }))
    expect(html).toMatch(/<article class="fm-cam-tile [^"]*overflow-hidden/)
  })
})

// --- ui-11: one notice for link-only cameras in the viewer ------------------------------------------------

describe('cctv-ui-11: the viewer prints the link-only notice once', () => {
  it('renders CCTV_LINK_ONLY_TH exactly once (frame placeholder only)', () => {
    const html = renderToStaticMarkup(createElement(ViewerStill, { cam: link }))
    expect(count(html, CCTV_LINK_ONLY_TH)).toBe(1)
    // No refresh controls for a camera this server has no stills for.
    expect(html).not.toContain('หยุดรีเฟรช')
  })
})

// --- ui-13: the date whenever the still is not from today --------------------------------------------------

describe('cctv-ui-13: alt text and badges carry the date when the still is not from today', () => {
  const midnight = Date.parse('2026-10-03T17:03:00Z') // 00:03 Bangkok, 4 Oct

  it('whenTh adds the Bangkok date only for another day', () => {
    expect(whenTh(NOW - MIN, NOW)).toBe('10:41 น.')
    expect(whenTh(midnight - 5 * MIN, midnight)).toBe('3 ต.ค. 23:58 น.')
  })

  it('a still from yesterday is dated in the badge, the line and the alt text', () => {
    // Fresh (5 min old) but from before midnight.
    const m = meta({ fetchedAt: midnight - 5 * MIN, changedAt: midnight - 5 * MIN })
    const c = frameCopy(bma, { meta: m, loading: false, failure: null }, midnight)
    expect(c.badge).toBe('ภาพนิ่ง · 3 ต.ค. 23:58 น.')
    expect(c.line).toContain('3 ต.ค. 23:58 น.')
    expect(cameraAltTh(bma, m, midnight)).toBe('ภาพจากกล้อง ซอยทดสอบ 101 (สำนักการระบายน้ำ กทม.) ได้ภาพเมื่อ 3 ต.ค. 23:58 น.')
    // Stale: the badge and the notice are dated too.
    const old = meta({ fetchedAt: midnight - 20 * MIN, changedAt: midnight - 20 * MIN })
    const s = frameCopy(bma, { meta: old, loading: false, failure: null }, midnight)
    expect(s.badge).toBe('ภาพเก่า · 3 ต.ค. 23:43 น.')
    expect(s.notices).toContain('ภาพนี้ไม่ใช่ภาพปัจจุบัน — ภาพล่าสุดเมื่อ 3 ต.ค. 23:43 น.')
  })

  it('a DWR still captured days ago reads as such in the alt text', () => {
    const m = meta({ capturedAt: NOW - 3 * 24 * 60 * MIN - 27 * MIN, changedAt: NOW - 3 * 24 * 60 * MIN })
    expect(cameraAltTh(dwr, m, NOW)).toBe('ภาพจากกล้อง ซอยทดสอบ TA100220 (กรมทรัพยากรน้ำ) ถ่ายเมื่อ 1 ต.ค. 10:15 น.')
    // A fresh DWR still captured before midnight: dated badge.
    const fresh = meta({ capturedAt: midnight - 10 * MIN, fetchedAt: midnight - MIN, changedAt: midnight - 10 * MIN })
    expect(frameCopy(dwr, { meta: fresh, loading: false, failure: null }, midnight).badge).toBe('ถ่าย · 3 ต.ค. 23:53 น.')
  })
})

// --- ui-14 / F9 (correctness): watchdog longer than the server's longest request ----------------------------

describe('cctv-ui-14: the client watchdog outlasts the server', () => {
  it('waits 50 s, longer than any source can take on the server', () => {
    expect(WATCHDOG_MS).toBe(50_000)
    expect(WATCHDOG_MS).toBeGreaterThan(CCTV_SERVER_MAX_MS)
    for (const [source, p] of Object.entries(CCTV_POLICY)) expect(p.queueWaitMs + p.timeoutMs, source).toBeLessThan(WATCHDOG_MS)
    expect(CCTV_LOADING_TH).toBe('กำลังขอภาพจากกล้อง… (อาจใช้เวลาราว 10–40 วินาที)')
  })
})

// --- ui-15: per-source subtitle and map copy -----------------------------------------------------------------

describe('cctv-ui-15: card subtitle and map copy are true for the cameras shown', () => {
  it('names each cadence and says status comes from the sensors', () => {
    const tail = '— ใช้ดูประกอบเท่านั้น สถานะมาจากเซ็นเซอร์วัดน้ำ ไม่ได้มาจากภาพ'
    expect(cardSubtitleTh([bma])).toBe(`ภาพนิ่งจากกล้องของหน่วยงาน อัปเดตราวทุก 1–3 นาที ${tail}`)
    expect(cardSubtitleTh([dwr])).toBe(`ภาพนิ่งจากกล้องของหน่วยงาน ถ่ายภาพราวทุก 15 นาที ${tail}`)
    expect(cardSubtitleTh([bma, dwr])).toBe(`ภาพนิ่งจากกล้องของหน่วยงาน อัปเดตราวทุก 1–3 นาที (กล้องกรมทรัพยากรน้ำ ถ่ายภาพราวทุก 15 นาที) ${tail}`)
    expect(cardSubtitleTh([link])).toBe('ลิงก์ไปยังกล้องของหน่วยงาน — ใช้ดูประกอบเท่านั้น สถานะมาจากเซ็นเซอร์วัดน้ำ ไม่ได้มาจากภาพ')
    for (const s of [cardSubtitleTh([bma]), cardSubtitleTh([dwr]), cardSubtitleTh([link])]) expect(s).not.toContain('ระยะห่างตลิ่ง')
  })

  it('the map invites a tap for stills only when this server has stills', () => {
    expect(mapCamerasStatusTh(groupSites([bma, dwr]))).toBe('2 จุดกล้อง · แตะเพื่อดูภาพนิ่ง')
    expect(mapCamerasStatusTh(groupSites([link]))).toBe('1 จุดกล้อง · แตะเพื่อเปิดเว็บของหน่วยงาน')
  })

  it('camera popups state the DWR capture cadence and make no still promise for link-only sites', () => {
    expect(popupFootTh(groupSites([dwr])[0]!, true)).toBe('ภาพนิ่ง ไม่ใช่วิดีโอ · หน่วยงานถ่ายภาพราวทุก 15 นาที · ภาพ: กรมทรัพยากรน้ำ')
    expect(popupFootTh(groupSites([bma])[0]!, true)).toBe('ภาพนิ่ง ไม่ใช่วิดีโอ · ภาพ: สำนักการระบายน้ำ กทม.')
    expect(popupFootTh(groupSites([link])[0]!, false)).toBe('ภาพ: สำนักการระบายน้ำ กทม.')
  })
})
