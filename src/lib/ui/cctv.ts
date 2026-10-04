import type { CameraSourceId, Level, StationStatus } from '../types'
import { LEVEL_ORDER } from '../types'
import type { MapStation, PublicCamera } from '../server/public'
import { distanceTh } from '../engine/format'
import { formatAgeTh } from '../time'
import { bkkDayMonth, bkkTime } from './chart'
import { farDistanceTh } from './coverage'
import { freeboardTh } from './format'
import { levelLabel } from './levels'

// CCTV in the UI: which camera sites a card shows, how a still's age and failures read in Thai,
// and when stills may be (re)loaded. Pure, so it is unit-tested (tests/ui-cctv.test.ts).
// Rules (docs/DESIGN.md, CCTV): stills only, never called "live"; a camera never says anything
// about flooding (status comes from the sensors); no state may suggest "dry" or "normal".

// --- copy -------------------------------------------------------------------------------------

export const CCTV_CARD_TITLE = 'กล้อง CCTV ใกล้บ้าน'
export const CCTV_CARD_SUBTITLE = 'ภาพนิ่งจากกล้องของหน่วยงาน อัปเดตราวทุก 1–3 นาที — ใช้ดูประกอบ สถานะยังคำนวณจากระยะห่างตลิ่ง'
export const CCTV_RIGHTS_TH = 'ภาพเป็นของหน่วยงานเจ้าของกล้อง ซึ่งไม่ได้รับรองหรือเกี่ยวข้องกับโครงการนี้'
export const CCTV_DEMO_TH = 'ภาพจำลอง — ไม่ใช่ภาพจากกล้องจริง'
export const CCTV_LINK_ONLY_TH = 'เซิร์ฟเวอร์นี้แสดงภาพกล้องนี้ไม่ได้ — เปิดดูที่เว็บของหน่วยงาน'
export const CCTV_LOADING_TH = 'กำลังขอภาพจากกล้อง… (อาจใช้เวลาราว 10 วินาที)'
export const CCTV_TAP_TO_LOAD_TH = 'แตะเพื่อโหลดภาพ (~50 KB ต่อภาพ)'
export const CCTV_NOT_FLOOD_SIGNAL_TH = 'ไม่ได้แปลว่าไม่มีน้ำท่วม'
export const CCTV_PAUSE_TH = 'หยุดรีเฟรชภาพกล้อง'
export const CCTV_AUTO_PAUSED_TH = 'หยุดรีเฟรชอัตโนมัติแล้ว'
export const CCTV_RESUME_TH = 'รีเฟรชต่อ'
export const CCTV_OTHER_AGENCIES_TH = 'กล้องจากหน่วยงานอื่น'
export const CCTV_CHAIN_TH = 'กล้องแม่น้ำเจ้าพระยา'
export const CCTV_OUTSIDE_TH = 'นอกรัศมี'

/** Why the last still request failed. */
export type FrameFailure = 'unreachable' | 'timeout' | 'no-image' | 'budget' | 'rate' | 'not-found'

const FAILURE_TH: Record<FrameFailure, { notice: string; badge: string }> = {
  unreachable: { notice: `ติดต่อกล้องไม่ได้ในขณะนี้ — ${CCTV_NOT_FLOOD_SIGNAL_TH}`, badge: 'ติดต่อกล้องไม่ได้' },
  timeout: { notice: `ติดต่อกล้องไม่ได้ในขณะนี้ — ${CCTV_NOT_FLOOD_SIGNAL_TH}`, badge: 'ติดต่อกล้องไม่ได้' },
  'no-image': { notice: 'หน่วยงานยังไม่มีภาพจากกล้องนี้', badge: 'ยังไม่มีภาพ' },
  budget: {
    notice: 'มีผู้ขอภาพจำนวนมาก ระบบพักการดึงภาพชั่วคราวเพื่อไม่รบกวนเซิร์ฟเวอร์ของหน่วยงาน',
    badge: 'พักการดึงภาพชั่วคราว',
  },
  rate: { notice: 'ขอภาพบ่อยเกินไป กรุณารอสักครู่แล้วระบบจะลองใหม่', badge: 'รอสักครู่' },
  'not-found': { notice: 'ไม่พบกล้องนี้ในรายการของเซิร์ฟเวอร์แล้ว', badge: 'ไม่พบกล้อง' },
}

export function failureTh(f: FrameFailure): string {
  return FAILURE_TH[f].notice
}

/** Failure from an image response (status + the JSON `{ error, reason }` body, when any). */
export function failureFromResponse(status: number, body: unknown): FrameFailure {
  const reason = body && typeof body === 'object' ? (body as Record<string, unknown>).reason : null
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate'
  if (status === 503) return 'budget'
  if (reason === 'no-image') return 'no-image'
  return 'unreachable'
}

/** Seconds from a Retry-After header (delta form only), else null. */
export function retryAfterSec(v: string | null | undefined): number | null {
  if (!v || !/^\d{1,5}$/.test(v.trim())) return null
  return Number(v.trim())
}

// --- frames -----------------------------------------------------------------------------------

/** What the image response says about the still (X-Cctv-* headers), epoch ms. */
export interface FrameMeta {
  /** When the server got the still (or, without that header, when we received it). */
  fetchedAt: number
  /** Capture time stated by the agency (DWR), when known. */
  capturedAt: number | null
  /** When this exact picture was first seen (a frozen camera keeps an old value). */
  changedAt: number | null
  /** The server answered with its last good still because the camera failed. */
  stale: boolean
}

function headerTime(v: string | null): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export function parseFrameMeta(get: (name: string) => string | null, receivedAt: number): FrameMeta {
  return {
    fetchedAt: headerTime(get('X-Cctv-Fetched-At')) ?? receivedAt,
    capturedAt: headerTime(get('X-Cctv-Captured-At')),
    changedAt: headerTime(get('X-Cctv-Changed-At')),
    stale: get('X-Cctv-Stale') === '1',
  }
}

const MIN = 60_000
/** Stills by fetch time stop counting as current after this (3-min tiles + 1-min server cache + slack). */
export const FETCHED_STALE_MS = 5 * MIN
/** DWR stills (agency capture time, ~15-min cadence). */
export const CAPTURED_STALE_MS = 45 * MIN
export const OLD_MS = 24 * 60 * MIN
/** Same picture for this long (or 3 upstream cadences, if longer) → the camera may be stuck. */
export const FROZEN_MS = 15 * MIN

export type FrameCondition = 'fresh' | 'stale' | 'old' | 'frozen'

type CamLike = Pick<PublicCamera, 'source' | 'cadenceMin'>

/** The time a still is labelled with: agency capture time when known, else when the server got it. */
export function frameTime(meta: FrameMeta): number {
  return meta.capturedAt ?? meta.fetchedAt
}

export function frameCondition(meta: FrameMeta, cam: CamLike, nowMs: number): FrameCondition {
  const age = nowMs - frameTime(meta)
  if (meta.capturedAt !== null) {
    // The agency's capture time is authoritative, even when the server re-served its last still.
    if (age > OLD_MS) return 'old'
    if (age > CAPTURED_STALE_MS) return 'stale'
  } else if (meta.stale || age > FETCHED_STALE_MS) {
    return 'stale'
  }
  const frozenMs = Math.max(FROZEN_MS, 3 * (cam.cadenceMin ?? 0) * MIN)
  if (meta.changedAt !== null && nowMs - meta.changedAt >= frozenMs) return 'frozen'
  return 'fresh'
}

/** Inputs of a still's on-screen state. */
export interface FrameStatus {
  /** The still on screen (null before the first one). */
  meta: FrameMeta | null
  /** A request is in flight. */
  loading: boolean
  /** The latest attempt failed (the previous still, if any, stays on screen). */
  failure: FrameFailure | null
  /** Nothing loads until the viewer taps (Save-Data). */
  tapToLoad?: boolean
}

export interface FrameCopy {
  /** Short overlay on the picture. */
  badge: string
  /** Time line for the viewer ("ภาพนิ่ง · ได้ภาพ 10:42 น. · 1 นาทีที่แล้ว"), null without a still. */
  line: string | null
  /** Sentences to show under the picture (state changes, failures). */
  notices: string[]
  /** aria-live text: depends only on the state, never on the frame, so each new still is silent. */
  live: string
  /** The picture is not current: show it dimmed. */
  dim: boolean
  warn: boolean
}

function clock(ms: number): string {
  return `${bkkTime(ms)} น.`
}

/** Thai labels for a camera's still. `link` cameras have no still on this server. */
export function frameCopy(cam: CamLike & Pick<PublicCamera, 'media'>, s: FrameStatus, nowMs: number): FrameCopy {
  const demo = cam.source === 'demo-cam'
  if (cam.media === 'link') {
    return { badge: 'ดูที่เว็บหน่วยงาน', line: null, notices: [CCTV_LINK_ONLY_TH], live: '', dim: false, warn: false }
  }
  if (!s.meta) {
    if (s.failure) {
      const f = FAILURE_TH[s.failure]
      return { badge: f.badge, line: null, notices: [f.notice], live: f.notice, dim: false, warn: true }
    }
    if (s.loading) return { badge: 'กำลังขอภาพ…', line: null, notices: [CCTV_LOADING_TH], live: '', dim: false, warn: false }
    if (s.tapToLoad) return { badge: 'แตะเพื่อโหลดภาพ', line: null, notices: [CCTV_TAP_TO_LOAD_TH], live: '', dim: false, warn: false }
    return { badge: 'รอโหลดภาพ', line: null, notices: [], live: '', dim: false, warn: false }
  }

  const m = s.meta
  const t = frameTime(m)
  const captured = m.capturedAt !== null
  const cond = frameCondition(m, cam, nowMs)
  const when = cond === 'old' ? `${bkkDayMonth(t)} ${clock(t)}` : clock(t)
  const verb = captured ? 'ถ่าย' : demo ? 'สร้างภาพ' : 'ได้ภาพ'
  const line = `${demo ? 'ภาพจำลอง' : 'ภาพนิ่ง'} · ${verb} ${when} · ${formatAgeTh(new Date(t).toISOString(), new Date(nowMs))}`
  const notices: string[] = []
  let badge: string
  let live = ''
  let dim = false
  let warn = false
  if (cond === 'old') {
    badge = 'ภาพเก่ากว่า 1 วัน'
    notices.push(`ภาพเก่ากว่า 1 วัน — ${captured ? 'ถ่าย' : 'ได้ภาพ'}เมื่อ ${when}`)
    live = 'ภาพจากกล้องนี้เก่ากว่า 1 วัน'
    dim = true
    warn = true
  } else if (cond === 'stale') {
    badge = `ภาพเก่า · ${clock(t)}`
    notices.push(`ภาพนี้ไม่ใช่ภาพปัจจุบัน — ภาพล่าสุดเมื่อ ${clock(t)}`)
    live = 'ภาพจากกล้องนี้ไม่ใช่ภาพปัจจุบัน'
    dim = true
    warn = true
  } else if (cond === 'frozen') {
    badge = `ภาพอาจค้าง · ${clock(t)}`
    notices.push(`ภาพไม่เปลี่ยนตั้งแต่ ${clock(m.changedAt ?? t)} — กล้องอาจค้าง`)
    live = 'ภาพจากกล้องนี้ไม่เปลี่ยน กล้องอาจค้าง'
    warn = true
  } else {
    badge = `${demo ? 'ภาพจำลอง' : captured ? 'ถ่าย' : 'ภาพนิ่ง'} · ${clock(t)}`
  }
  if (s.failure) {
    notices.push(FAILURE_TH[s.failure].notice)
    live = FAILURE_TH[s.failure].notice
    warn = true
  }
  if (demo) notices.unshift(CCTV_DEMO_TH)
  return { badge, line, notices, live, dim, warn }
}

/** Alt text: who, which camera and when — never what the picture shows (flooded or not). */
export function cameraAltTh(cam: Pick<PublicCamera, 'name' | 'owner' | 'source'>, meta: FrameMeta): string {
  const verb = meta.capturedAt !== null ? 'ถ่ายเมื่อ' : 'ได้ภาพเมื่อ'
  const base = `ภาพจากกล้อง ${cam.name} (${cam.owner}) ${verb} ${clock(frameTime(meta))}`
  return cam.source === 'demo-cam' ? `${base} — ${CCTV_DEMO_TH}` : base
}

// --- loading a still --------------------------------------------------------------------------

/** Abort reason used by the request watchdog. */
export const WATCHDOG_REASON = 'cctv-watchdog'
export const WATCHDOG_MS = 25_000

export interface FrameDeps {
  fetch: typeof fetch
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  /** Resolves once the image at `url` is decoded (so a swap never shows a blank frame). */
  decode: (url: string) => Promise<void>
  now: () => number
}

export type FrameLoad =
  | { ok: true; src: string; meta: FrameMeta }
  | { ok: false; failure: FrameFailure; retryAfterSec: number | null }

function isAbort(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError'
}

/**
 * Fetch one still (same origin, so the X-Cctv-* headers are readable), turn it into an object
 * URL and wait until it is decoded. The caller owns the returned URL and revokes it once it is
 * replaced. Throws only when `signal` was aborted by someone other than the watchdog.
 */
export async function loadFrame(url: string, signal: AbortSignal, deps: FrameDeps): Promise<FrameLoad> {
  let src: string | null = null
  try {
    const res = await deps.fetch(url, { signal, credentials: 'same-origin', referrerPolicy: 'no-referrer' })
    if (!res.ok) {
      let body: unknown = null
      try {
        body = JSON.parse(await res.text())
      } catch {
        body = null
      }
      return { ok: false, failure: failureFromResponse(res.status, body), retryAfterSec: retryAfterSec(res.headers.get('Retry-After')) }
    }
    const type = res.headers.get('Content-Type') ?? ''
    if (!/^image\//i.test(type)) return { ok: false, failure: 'unreachable', retryAfterSec: null }
    const blob = await res.blob()
    if (blob.size === 0) return { ok: false, failure: 'no-image', retryAfterSec: null }
    const meta = parseFrameMeta((n) => res.headers.get(n), deps.now())
    src = deps.createObjectURL(blob)
    await deps.decode(src)
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    return { ok: true, src, meta }
  } catch (e) {
    if (src) deps.revokeObjectURL(src)
    if (signal.aborted) {
      if (signal.reason === WATCHDOG_REASON) return { ok: false, failure: 'timeout', retryAfterSec: null }
      throw isAbort(e) ? e : new DOMException('aborted', 'AbortError')
    }
    // A still that cannot be decoded is as good as none.
    return { ok: false, failure: src ? 'no-image' : 'unreachable', retryAfterSec: null }
  }
}

/** Still URL with a cache key that changes once per `bucketSec` (shared HTTP caches stay useful). */
export function frameUrl(imageUrl: string, nowMs: number, bucketSec: number): string {
  const bucket = Math.floor(nowMs / (Math.max(1, bucketSec) * 1000))
  return `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}t=${bucket}`
}

// --- refresh rules ----------------------------------------------------------------------------

/** Dashboard tiles refresh at most this often (seconds). */
export const TILE_REFRESH_SEC = 180
/** An open viewer refreshes at most this often (seconds). */
export const VIEWER_REFRESH_SEC = 60
/** An open viewer stops refreshing on its own after this long. */
export const VIEWER_AUTO_PAUSE_MS = 5 * MIN
/** The camera list of a place is reloaded this often. */
export const CAMERA_LIST_REFRESH_MS = 30 * MIN

export function tileIntervalMs(cam: Pick<PublicCamera, 'refreshSec'>): number {
  return Math.max(TILE_REFRESH_SEC, cam.refreshSec || 0) * 1000
}

export function viewerIntervalMs(cam: Pick<PublicCamera, 'refreshSec'>): number {
  return Math.max(VIEWER_REFRESH_SEC, cam.refreshSec || 0) * 1000
}

export interface RefreshConditions {
  /** The card is on screen (IntersectionObserver). */
  onScreen: boolean
  /** document.visibilityState === 'visible'. */
  visible: boolean
  /** The viewer's global "หยุดรีเฟรชภาพกล้อง" toggle. */
  paused: boolean
  /** navigator.connection.saveData. */
  saveData: boolean
}

/** Tiles auto-refresh only on screen, in a visible tab, not paused and not under Save-Data. */
export function tileAutoRefresh(c: RefreshConditions): boolean {
  return c.onScreen && c.visible && !c.paused && !c.saveData
}

/** A tile loads its first still once on screen; under Save-Data only after a tap. */
export function tileMayLoad(c: Pick<RefreshConditions, 'onScreen' | 'saveData'> & { tapped: boolean }): boolean {
  return c.tapped || (c.onScreen && !c.saveData)
}

/** An open viewer refreshes while visible, not paused (own or auto) and not under Save-Data. */
export function viewerAutoRefresh(c: { visible: boolean; paused: boolean; autoPaused: boolean; saveData: boolean }): boolean {
  return c.visible && !c.paused && !c.autoPaused && !c.saveData
}

export function isAutoPaused(sinceMs: number, nowMs: number): boolean {
  return nowMs - sinceMs >= VIEWER_AUTO_PAUSE_MS
}

/**
 * Milliseconds until the next still may be requested: `intervalMs` after the previous request
 * finished (never overlapping), or later when the server asked to retry after a while.
 */
export function nextAttemptDelay(lastFinishedAt: number | null, intervalMs: number, nowMs: number, retryAfter: number | null = null): number {
  if (lastFinishedAt === null) return 0
  const wait = Math.max(intervalMs, (retryAfter ?? 0) * 1000)
  return Math.max(0, lastFinishedAt + wait - nowMs)
}

// --- global pause (per viewer, localStorage) ---------------------------------------------------

export const CCTV_PAUSE_KEY = 'fm-cctv-paused'

/** Storage may be missing or throw (private mode, blocked site data): never let that break the page. */
export function readPaused(storage: () => Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage()?.getItem(CCTV_PAUSE_KEY) === '1'
  } catch {
    return false
  }
}

export function writePaused(storage: () => Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, paused: boolean): void {
  try {
    const s = storage()
    if (paused) s?.setItem(CCTV_PAUSE_KEY, '1')
    else s?.removeItem(CCTV_PAUSE_KEY)
  } catch {
    // Not persisted; the toggle still works for this page.
  }
}

// --- sites, sensors and ranking ---------------------------------------------------------------

/** The cameras (angles) at one spot. */
export interface CameraSite {
  siteId: string
  cameras: PublicCamera[]
  name: string
  owner: string
  source: CameraSourceId
  lat: number
  lng: number
  /** Nearest angle's distance from the requested point (null on map lists). */
  distanceKm: number | null
  /** Union of the angles' joined stations, nearest first. */
  nearStationIds: string[]
}

const byCode = new Intl.Collator('en', { numeric: true })

/** Group cameras by site, keeping the input order of the sites (the API sorts by distance). */
export function groupSites(cameras: readonly PublicCamera[]): CameraSite[] {
  const sites = new Map<string, PublicCamera[]>()
  for (const c of cameras) {
    const list = sites.get(c.siteId)
    if (list) list.push(c)
    else sites.set(c.siteId, [c])
  }
  return [...sites.entries()].map(([siteId, list]) => {
    const cams = [...list].sort((a, b) => byCode.compare(a.angle ?? a.code ?? a.id, b.angle ?? b.code ?? b.id) || byCode.compare(a.id, b.id))
    const first = cams[0]!
    const dists = cams.map((c) => c.distanceKm).filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
    const near: string[] = []
    for (const c of cams) for (const id of c.nearStationIds) if (!near.includes(id)) near.push(id)
    return {
      siteId,
      cameras: cams,
      name: first.name,
      owner: first.owner,
      source: first.source,
      lat: first.lat,
      lng: first.lng,
      distanceKm: dists.length ? Math.min(...dists) : null,
      nearStationIds: near,
    }
  })
}

/** "มุม 2" (agency label) or the angle's position. */
export function angleLabel(cam: Pick<PublicCamera, 'angle'>, index: number): string {
  return cam.angle?.trim() || `มุม ${index + 1}`
}

/** A joined sensor as the camera UI shows it. Its status comes from the sensor, never from a picture. */
export interface SensorInfo {
  id: string
  name: string
  kind: 'roadflood' | 'water'
  level: Level
  stale: boolean
  roadFloodCm: number | null
  freeboard: number | null
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function sensorFromStatus(s: StationStatus): SensorInfo | null {
  const k = s.station.kind
  if (k !== 'roadflood' && k !== 'canal' && k !== 'river') return null
  return {
    id: s.station.id,
    name: s.station.shortName || s.station.name,
    kind: k === 'roadflood' ? 'roadflood' : 'water',
    level: s.level,
    stale: s.stale,
    roadFloodCm: num(s.reading?.roadFloodCm),
    freeboard: num(s.reading?.freeboard),
  }
}

export function sensorFromMapStation(s: MapStation): SensorInfo | null {
  if (s.kind !== 'roadflood' && s.kind !== 'canal' && s.kind !== 'river') return null
  return {
    id: s.id,
    name: s.shortName || s.name,
    kind: s.kind === 'roadflood' ? 'roadflood' : 'water',
    level: s.level,
    stale: s.stale,
    roadFloodCm: num(s.roadFloodCm),
    freeboard: num(s.freeboard),
  }
}

export function sensorIndex(list: readonly (SensorInfo | null)[]): Map<string, SensorInfo> {
  const out = new Map<string, SensorInfo>()
  for (const s of list) if (s) out.set(s.id, s)
  return out
}

/** Level to show for a sensor: a stale reading is "ไม่มีข้อมูล". */
export function sensorLevel(s: SensorInfo): Level {
  return s.stale ? 'unknown' : s.level
}

/** The joined sensor to show for a site: the most severe current one, nearest on ties. */
export function siteSensor(site: Pick<CameraSite, 'nearStationIds'>, sensors: ReadonlyMap<string, SensorInfo>): SensorInfo | null {
  let best: SensorInfo | null = null
  for (const id of site.nearStationIds) {
    const s = sensors.get(id)
    if (!s) continue
    if (!best || LEVEL_ORDER[sensorLevel(s)] > LEVEL_ORDER[sensorLevel(best)]) best = s
  }
  return best
}

/** "น้ำบนถนน 12 ซม. · เฝ้าระวัง" / "ห่างตลิ่ง 1.20 ม. · ปกติ" — the sensor's reading, not the picture's. */
export function sensorLineTh(s: SensorInfo): string {
  if (s.kind === 'roadflood') {
    if (s.stale || s.roadFloodCm === null) return 'เซ็นเซอร์น้ำบนถนน: ไม่มีข้อมูลล่าสุด'
    return `น้ำบนถนน ${Math.round(s.roadFloodCm)} ซม. · ${levelLabel(s.level)}`
  }
  if (s.stale) return 'จุดวัดระดับน้ำ: ไม่มีข้อมูลล่าสุด'
  if (s.freeboard === null) return 'จุดวัดระดับน้ำ: ไม่มีข้อมูลตลิ่ง'
  return `${freeboardTh(s.freeboard)} · ${levelLabel(s.level)}`
}

export interface RankedSite extends CameraSite {
  /** Beyond the place radius (shown only to fill the card). */
  outside: boolean
  sensor: SensorInfo | null
}

/** Sites shown on the dashboard card (2×2). */
export const CARD_SITES = 4
/** The card fills up with sites beyond the place radius, up to this distance. */
export const FILL_KM = 10
/** Sites asked from the API, so a nearby site whose sensor is on watch can still be promoted. */
export const LIST_SITES = 12

function byDistance(a: CameraSite, b: CameraSite): number {
  return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0)
}

/**
 * Card order: sites within the radius by distance (ties by id), with sites whose joined sensor
 * is at "เฝ้าระวัง" or worse moved to the front (most severe first); then, if fewer than `limit`,
 * the nearest sites beyond the radius up to `fillKm`, marked `outside`.
 */
export function rankSites(
  sites: readonly CameraSite[],
  opts: { radiusKm: number; sensors: ReadonlyMap<string, SensorInfo>; limit?: number; fillKm?: number },
): RankedSite[] {
  const limit = opts.limit ?? CARD_SITES
  const fillKm = opts.fillKm ?? FILL_KM
  const withSensor = sites.map((s) => ({ ...s, sensor: siteSensor(s, opts.sensors), outside: false }))
  const inside = withSensor.filter((s) => s.distanceKm !== null && s.distanceKm <= opts.radiusKm).sort(byDistance)
  const sev = (s: RankedSite) => (s.sensor ? LEVEL_ORDER[sensorLevel(s.sensor)] : -1)
  const promoted = inside.filter((s) => sev(s) >= LEVEL_ORDER.watch).sort((a, b) => sev(b) - sev(a) || byDistance(a, b))
  const rest = inside.filter((s) => sev(s) < LEVEL_ORDER.watch)
  const out: RankedSite[] = [...promoted, ...rest].slice(0, limit)
  if (out.length < limit) {
    const fill = withSensor
      .filter((s) => s.distanceKm !== null && s.distanceKm > opts.radiusKm && s.distanceKm <= fillKm)
      .sort(byDistance)
      .slice(0, limit - out.length)
      .map((s) => ({ ...s, outside: true }))
    out.push(...fill)
  }
  return out
}

/** Query for the dashboard card: wide enough to fill up to FILL_KM. */
export function cardQuery(p: { lat: number; lng: number; radiusKm: number }): { lat: number; lng: number; r: number; n: number } {
  return { lat: p.lat, lng: p.lng, r: Math.min(20, Math.max(p.radiusKm, FILL_KM)), n: LIST_SITES }
}

/** "ไม่มีกล้องในระยะ 10 กม. — กล้องที่ใกล้ที่สุดอยู่ห่าง 14.2 กม." */
export function noCamerasTh(radiusKm: number, nearestOutsideKm: number | null): string {
  const head = `ไม่มีกล้องในระยะ ${radiusKm} กม.`
  return nearestOutsideKm !== null && Number.isFinite(nearestOutsideKm) ? `${head} — กล้องที่ใกล้ที่สุดอยู่ห่าง ${farDistanceTh(nearestOutsideKm)}` : head
}

/** "800 ม. · นอกรัศมี" */
export function siteDistanceTh(site: Pick<RankedSite, 'distanceKm' | 'outside'>): string {
  return [distanceTh(site.distanceKm), site.outside ? CCTV_OUTSIDE_TH : ''].filter(Boolean).join(' · ')
}

export function anglesTh(n: number): string {
  return `${n} มุม`
}

/** Cameras joined to a station (map popup "ดูกล้องที่จุดนี้"). */
export function camerasAtStation(stationId: string, cameras: readonly PublicCamera[]): PublicCamera[] {
  return cameras.filter((c) => c.nearStationIds.includes(stationId))
}

export function viewAtStationTh(n: number): string {
  return `ดูกล้องที่จุดนี้ (${anglesTh(n)})`
}

/** "ภาพ: สำนักการระบายน้ำ กทม." */
export function creditTh(owner: string): string {
  return `ภาพ: ${owner}`
}

/** Unique owners in display order (card footer attribution). */
export function ownersOf(cameras: readonly Pick<PublicCamera, 'owner'>[]): string[] {
  const out: string[] = []
  for (const c of cameras) if (c.owner && !out.includes(c.owner)) out.push(c.owner)
  return out
}

/** Sites nearest to a point first (prev/next in the viewer when opened from the map). */
export function sitesNear(sites: readonly CameraSite[], lat: number, lng: number, limit: number): CameraSite[] {
  const d = (s: CameraSite) => (s.lat - lat) ** 2 + ((s.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2
  return [...sites].sort((a, b) => d(a) - d(b) || (a.siteId < b.siteId ? -1 : 1)).slice(0, limit)
}

// --- Chao Phraya chain (DWR) ------------------------------------------------------------------

/** Bangkok → Samut Prakan → Pathum Thani, then the rest of the main stem going upstream. */
export const CHAO_PHRAYA_CODES = ['TA100220', 'TA100221', 'TC100224', 'TA100219'] as const
const MAIN_STEM_RE = /^T[AC]1002\d{2}$/

/** DWR river cameras on the Chao Phraya, in the order the viewer steps through them. */
export function chaoPhrayaChain(cameras: readonly PublicCamera[]): PublicCamera[] {
  const pinned = CHAO_PHRAYA_CODES as readonly string[]
  const rank = (c: PublicCamera) => {
    const i = pinned.indexOf(c.code ?? '')
    return i === -1 ? pinned.length : i
  }
  return cameras
    .filter((c) => c.source === 'dwr-cctv' && c.code && (pinned.includes(c.code) || MAIN_STEM_RE.test(c.code)))
    .sort((a, b) => rank(a) - rank(b) || a.lat - b.lat || byCode.compare(a.id, b.id))
}

/** A link we may open in a new tab: plain http(s) only. Same-origin pages (demo) are internal. */
export function officialLink(url: string): { href: string; external: boolean } | null {
  if (/^\/(?!\/)/.test(url)) return { href: url, external: false }
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? { href: u.toString(), external: true } : null
  } catch {
    return null
  }
}
