import { createHash } from 'node:crypto'
import type { AppConfig } from '../config'
import { getCameraRef, hasCameraRefs, isCameraSourceId, loadCameraCatalogs } from '../cameras/catalog'
import { haversineKm } from '../geo'
import type { Store } from '../store/types'
import type { Camera, CameraCatalog, CameraSourceId } from '../types'
import { publicOrigin } from './http'
import { ImageCache, NotAttemptedError, type CachePolicy } from './image-cache'
import { log } from './log'
import type { CameraLinkOut, CamerasResponse, PublicCamera } from './public'

// CCTV stills through our own server (GET /api/cctv/image/[source]/[file]). Modelled on
// radar-proxy.ts: the client never supplies a URL; the upstream address is built here from a
// fixed host per source and the server-only reference stored with the catalogue. Frames are
// fetched on demand only, shared by every viewer (single-flight, short TTL), kept in memory
// only (never on disk, in the database or in logs), and bounded by per-source concurrency and
// hourly budgets so we stay gentle with the agencies' servers. No (client IP, camera) pair is
// ever logged; only aggregate per-source counters are kept (exposed by /api/health).

/** Sources whose stills are fetched from an agency (demo-cam images are generated locally). */
export type UpstreamCameraSource = Exclude<CameraSourceId, 'demo-cam'>

export interface CctvSourcePolicy extends CachePolicy {
  /** Per upstream request (BMA: the whole frame; DWR: each of the two steps). */
  timeoutMs: number
  /** Upstream requests running at once for this source. */
  maxInFlight: number
  /** Requests allowed to wait for a free slot; more are refused at once (503). */
  maxQueue: number
  /** Longest wait for a free slot before refusing (503). */
  queueWaitMs: number
  /** Upstream frames per rolling hour. */
  hourlyBudget: number
  /** Largest accepted image. */
  maxBytes: number
}

const MIN = 60_000

export const CCTV_POLICY: Record<UpstreamCameraSource, CctvSourcePolicy> = {
  // BMA's /api/proxy grabs one frame from the camera's stream (~9 s of their work per frame).
  'bma-floodcam': {
    ttlMs: 60_000,
    failTtlMs: 60_000,
    staleMaxMs: 15 * MIN,
    timeoutMs: 20_000,
    maxInFlight: 3,
    maxQueue: 20,
    queueWaitMs: 25_000,
    hourlyBudget: 600,
    maxBytes: 2 * 1024 * 1024,
  },
  // DWR stations upload a still about every 15 minutes.
  'dwr-cctv': {
    ttlMs: 5 * MIN,
    failTtlMs: 60_000,
    staleMaxMs: 60 * MIN,
    timeoutMs: 15_000,
    maxInFlight: 2,
    maxQueue: 10,
    queueWaitMs: 25_000,
    hourlyBudget: 240,
    maxBytes: 2 * 1024 * 1024,
  },
}

/** Suggested refresh interval of an open viewer (PublicCamera.refreshSec), seconds. */
export const CCTV_REFRESH_SEC: Record<CameraSourceId, number> = {
  'bma-floodcam': 60,
  'dwr-cctv': 300,
  'demo-cam': 60,
}

/** Fixed upstream endpoints. Nothing from the request ever becomes part of these URLs. */
export const BMA_FLOODCAM_PROXY = 'https://floodbangkok.bangkok.go.th/api/proxy'
export const DWR_API = 'https://telemetry.dwr.go.th/api'

/** Most frames kept in memory at once (the least recently viewed camera is dropped first). */
const MAX_FRAMES = 300
/** Frame hashes kept for frozen-camera detection (a few dozen bytes each, no image data). */
const MAX_HASHES = 2_000
const MAX_JSON_BYTES = 16 * 1024

/** Thai messages for the JSON error bodies. */
export const CCTV_MSG = {
  notFound: 'ไม่พบกล้องนี้',
  unreachable: 'ติดต่อกล้องไม่ได้ในขณะนี้',
  noImage: 'หน่วยงานยังไม่มีภาพจากกล้องนี้',
  paused: 'ระบบพักการดึงภาพชั่วคราว',
} as const

// --- frames -------------------------------------------------------------------------------------

export interface CctvFrame {
  /** JPEG bytes (trimmed after the last end-of-image marker). */
  bytes: Uint8Array
  /** When this server got the frame, epoch ms. */
  fetchedAt: number
  /** Capture time stated by the agency (DWR snapshot path), ISO UTC; null when unknown. */
  capturedAt: string | null
  /** When this exact picture was first seen, epoch ms (a frozen camera keeps an old value). */
  changedAt: number
  width: number | null
  height: number | null
}

/** Why an upstream frame could not be had. `busy`/`budget` mean upstream was not asked. */
export type CctvFailure = 'unreachable' | 'no-image' | 'busy' | 'budget'

export class FrameError extends Error {
  constructor(
    public code: 'unreachable' | 'no-image',
    message: string,
  ) {
    super(message)
    this.name = 'FrameError'
  }
}

/** JPEG files start with FF D8 FF. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

/** Bytes up to and including the last FF D9 (end of image); null when there is none. */
export function trimJpeg(bytes: Uint8Array): Uint8Array | null {
  for (let i = bytes.length - 2; i >= 2; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2 === bytes.length ? bytes : bytes.subarray(0, i + 2)
  }
  return null
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Pixel size from the JPEG start-of-frame header (no image library needed). */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]!
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2 // stand-alone markers
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any SOF
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (len < 2) return null
    if (SOF_MARKERS.has(marker)) {
      if (i + 8 >= bytes.length) return null
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + len
  }
  return null
}

/** Read a response body, refusing (and cancelling) anything over `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new FrameError('unreachable', 'image too large')
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new FrameError('unreachable', 'image too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** Validate an upstream image body: a complete JPEG within the size cap. */
export function validateJpeg(bytes: Uint8Array): { bytes: Uint8Array; width: number | null; height: number | null } {
  if (bytes.byteLength === 0) throw new FrameError('unreachable', 'empty body')
  // Cloudflare challenges, HTML error pages and PNG placeholders are never passed through.
  if (!isJpeg(bytes)) throw new FrameError('unreachable', 'not a JPEG image')
  const trimmed = trimJpeg(bytes)
  if (!trimmed) throw new FrameError('unreachable', 'truncated JPEG')
  const size = jpegSize(trimmed)
  return { bytes: trimmed, width: size?.width ?? null, height: size?.height ?? null }
}

const DWR_PATH_RE = /^\/[A-Za-z0-9_-]{1,32}(?:\/[A-Za-z0-9_.-]{1,64}){1,8}$/
const DWR_TIME_RE = /^\/[A-Za-z0-9_-]+\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})_(\d{1,2})\.jpe?g$/i

/** `/TA100220/2026/10/4/10_15.jpg` (Thai time) → `2026-10-04T03:15:00.000Z`; null when not that shape. */
export function dwrCaptureTime(path: string): string | null {
  const m = DWR_TIME_RE.exec(path)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return null
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return new Date(Date.UTC(y, mo - 1, d, h - 7, mi)).toISOString()
}

/** A BMA LiveStream reference we are willing to hand to BMA's own proxy. */
function isPlausibleStreamRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 512 && !/\s/.test(ref) && /^(rtsps?|rtmp|https?):\/\//i.test(ref)
}

// --- per-source gates, budgets and counters ----------------------------------------------------

/** Concurrency gate with a bounded wait queue. */
class Gate {
  active = 0
  private waiters: (() => void)[] = []

  get queued(): number {
    return this.waiters.length
  }

  acquire(max: number, maxQueue: number, waitMs: number): Promise<boolean> {
    if (this.active < max) {
      this.active++
      return Promise.resolve(true)
    }
    if (this.waiters.length >= maxQueue) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        resolve(true) // the releasing request handed its slot over; `active` is unchanged
      }
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve(false)
      }, waitMs)
      timer.unref?.()
      this.waiters.push(wake)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active = Math.max(0, this.active - 1)
  }
}

/** Events in the last hour, in one-minute buckets (constant memory). */
class HourCounter {
  private buckets = new Map<number, number>()

  add(t: number, n = 1): void {
    const m = Math.floor(t / MIN)
    this.buckets.set(m, (this.buckets.get(m) ?? 0) + n)
    for (const k of this.buckets.keys()) if (k <= m - 60) this.buckets.delete(k)
  }

  total(t: number): number {
    const m = Math.floor(t / MIN)
    let sum = 0
    for (const [k, v] of this.buckets) if (k > m - 60) sum += v
    return sum
  }
}

interface SourceState {
  gate: Gate
  /** Upstream frame attempts (what the hourly budget counts). */
  attempts: HourCounter
  ok: HourCounter
  fail: HourCounter
  /** Requests refused by the concurrency queue or the hourly budget. */
  refused: HourCounter
  lastFrame: { width: number | null; height: number | null; bytes: number } | null
  /** Host-level reachability: a host that never got a frame and keeps failing stops trying. */
  everOk: boolean
  unreachableStreak: number
  downUntil: number
}

/**
 * A host that has never fetched a frame for a source and fails this many times in a row
 * treats the source as unreachable from here (e.g. a cloud server sharing a Supabase store
 * with the Thai worker, so it holds refs but cannot reach Thai-IP-only images) and shows
 * link-outs instead for SOURCE_DOWN_MS before trying again.
 */
export const SOURCE_DOWN_AFTER = 3
export const SOURCE_DOWN_MS = 30 * 60_000

interface CctvGlobal {
  __floodCctv?: {
    frames: ImageCache<CctvFrame>
    hashes: Map<string, { hash: string; changedAt: number }>
    sources: Map<UpstreamCameraSource, SourceState>
  }
}

const g = globalThis as typeof globalThis & CctvGlobal
const state = (g.__floodCctv ??= { frames: new ImageCache<CctvFrame>(MAX_FRAMES), hashes: new Map(), sources: new Map() })

function sourceState(source: UpstreamCameraSource): SourceState {
  let s = state.sources.get(source)
  if (!s) {
    s = {
      gate: new Gate(),
      attempts: new HourCounter(),
      ok: new HourCounter(),
      fail: new HourCounter(),
      refused: new HourCounter(),
      lastFrame: null,
      everOk: false,
      unreachableStreak: 0,
      downUntil: 0,
    }
    state.sources.set(source, s)
  }
  return s
}

/** Tests: forget every frame, hash, counter and queue. */
export function clearCctvCache(): void {
  state.frames.clear()
  state.hashes.clear()
  state.sources.clear()
}

export interface CctvSourceStats {
  source: UpstreamCameraSource
  /** Last hour: frames fetched, upstream failures, requests refused (busy or budget spent). */
  frames1h: { ok: number; fail: number; refused: number; budgetLeft: number }
  inFlight: number
  queued: number
  /** Size of the most recent frame (helps decide whether downscaling is needed). */
  lastFrame: { width: number | null; height: number | null; bytes: number } | null
}

/** Aggregate per-source counters for /api/health (no camera ids, no clients). */
export function cctvImageStats(source: UpstreamCameraSource, now: number = Date.now()): CctvSourceStats {
  const s = sourceState(source)
  return {
    source,
    frames1h: {
      ok: s.ok.total(now),
      fail: s.fail.total(now),
      refused: s.refused.total(now),
      budgetLeft: Math.max(0, CCTV_POLICY[source].hourlyBudget - s.attempts.total(now)),
    },
    inFlight: s.gate.active,
    queued: s.gate.queued,
    lastFrame: s.lastFrame,
  }
}

// --- upstream fetchers --------------------------------------------------------------------------

export interface CctvFetchDeps {
  fetch: typeof fetch
  now?: () => number
  /** PUBLIC_BASE_URL, for the honest User-Agent. */
  publicBaseUrl?: string
  /** Tests: override parts of the source policy. */
  policy?: Partial<CctvSourcePolicy>
}

function userAgent(publicBaseUrl: string | undefined): string {
  const origin = publicOrigin(publicBaseUrl)
  return `flood-monitor/0.1 (+${origin ? `${origin}/about` : 'https://github.com/chalaivate/flood-monitor'})`
}

async function upstream(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    // No Referer / Origin: we say who we are in the User-Agent instead.
    return await fetchImpl(url, { ...init, redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new FrameError('unreachable', timeout ? 'timeout' : 'network error')
  }
}

async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined)
}

interface RawFrame {
  bytes: Uint8Array
  width: number | null
  height: number | null
  capturedAt: string | null
}

async function fetchBmaFrame(ref: string, policy: CctvSourcePolicy, deps: CctvFetchDeps): Promise<RawFrame> {
  if (!isPlausibleStreamRef(ref)) throw new FrameError('unreachable', 'invalid reference')
  const url = `${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}`
  const res = await upstream(deps.fetch, url, { headers: { 'User-Agent': userAgent(deps.publicBaseUrl), Accept: 'image/jpeg' } }, policy.timeoutMs)
  if (!res.ok) {
    await drain(res)
    throw new FrameError('unreachable', `HTTP ${res.status}`)
  }
  const frame = validateJpeg(await readCapped(res, policy.maxBytes))
  return { ...frame, capturedAt: null }
}

async function fetchDwrFrame(ref: string, policy: CctvSourcePolicy, deps: CctvFetchDeps): Promise<RawFrame> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) throw new FrameError('unreachable', 'invalid reference')
  const ua = userAgent(deps.publicBaseUrl)
  // Step 1: the latest still's path, e.g. {"value":"/TA100220/2026/10/4/10_15.jpg"}.
  const snap = await upstream(deps.fetch, `${DWR_API}/public/reportCctv/snapshot/${encodeURIComponent(ref)}`, { headers: { 'User-Agent': ua, Accept: 'application/json' } }, policy.timeoutMs)
  if (snap.status === 404) {
    await drain(snap)
    throw new FrameError('no-image', 'no snapshot')
  }
  if (!snap.ok) {
    await drain(snap)
    throw new FrameError('unreachable', `HTTP ${snap.status}`)
  }
  let value: unknown
  try {
    const body = JSON.parse(new TextDecoder().decode(await readCapped(snap, MAX_JSON_BYTES))) as unknown
    value = body && typeof body === 'object' ? (body as { value?: unknown }).value : undefined
  } catch (err) {
    if (err instanceof FrameError) throw err
    throw new FrameError('unreachable', 'unexpected snapshot response')
  }
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new FrameError('no-image', 'no snapshot')
  }
  if (typeof value !== 'string' || !DWR_PATH_RE.test(value) || value.includes('..')) {
    throw new FrameError('unreachable', 'unexpected snapshot path')
  }
  // Step 2: the JPEG itself (POST only).
  const img = await upstream(
    deps.fetch,
    `${DWR_API}/file/image/cctv`,
    { method: 'POST', headers: { 'User-Agent': ua, Accept: 'image/jpeg', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: value }) },
    policy.timeoutMs,
  )
  if (img.status === 404) {
    await drain(img)
    throw new FrameError('no-image', 'image not found')
  }
  if (!img.ok) {
    await drain(img)
    throw new FrameError('unreachable', `HTTP ${img.status}`)
  }
  const bytes = await readCapped(img, policy.maxBytes)
  if (bytes.byteLength === 0) throw new FrameError('no-image', 'empty image')
  return { ...validateJpeg(bytes), capturedAt: dwrCaptureTime(value) }
}

const FETCHERS: Record<UpstreamCameraSource, (ref: string, policy: CctvSourcePolicy, deps: CctvFetchDeps) => Promise<RawFrame>> = {
  'bma-floodcam': fetchBmaFrame,
  'dwr-cctv': fetchDwrFrame,
}

export type CctvImageOutcome =
  | { ok: true; frame: CctvFrame; stale: boolean; ttlMs: number }
  | { ok: false; failure: CctvFailure }

export function isUpstreamCameraSource(s: string): s is UpstreamCameraSource {
  return s === 'bma-floodcam' || s === 'dwr-cctv'
}

/**
 * Latest still of a camera whose reference has already been checked against the catalogue.
 * Shared cache → single-flight upstream fetch → stale fallback. Never throws.
 */
export async function getCctvImage(source: UpstreamCameraSource, cameraId: string, ref: string, deps: CctvFetchDeps): Promise<CctvImageOutcome> {
  const now = deps.now ?? Date.now
  const policy: CctvSourcePolicy = { ...CCTV_POLICY[source], ...deps.policy }
  const s = sourceState(source)

  const load = async (): Promise<CctvFrame> => {
    if (s.attempts.total(now()) >= policy.hourlyBudget) throw new NotAttemptedError('budget')
    if (!(await s.gate.acquire(policy.maxInFlight, policy.maxQueue, policy.queueWaitMs))) throw new NotAttemptedError('busy')
    try {
      // The budget may have been spent while this request waited for a slot.
      if (s.attempts.total(now()) >= policy.hourlyBudget) throw new NotAttemptedError('budget')
      s.attempts.add(now())
      let raw: RawFrame
      try {
        raw = await FETCHERS[source](ref, policy, deps)
      } catch (err) {
        s.fail.add(now())
        // A missing image from one camera says nothing about reaching the host.
        if (!s.everOk && !(err instanceof FrameError && err.code === 'no-image') && ++s.unreachableStreak >= SOURCE_DOWN_AFTER) {
          s.downUntil = now() + SOURCE_DOWN_MS
          s.unreachableStreak = 0
          log(`[cctv] ${source}: images unreachable from this server; showing agency links for ${SOURCE_DOWN_MS / 60_000} min`)
        }
        throw err
      }
      const t = now()
      s.ok.add(t)
      s.everOk = true
      s.unreachableStreak = 0
      if (!s.lastFrame) log(`[cctv] ${source}: first frame ${raw.width ?? '?'}×${raw.height ?? '?'} px, ${Math.round(raw.bytes.byteLength / 1024)} KB`)
      s.lastFrame = { width: raw.width, height: raw.height, bytes: raw.bytes.byteLength }
      const hash = createHash('sha1').update(raw.bytes).digest('hex')
      const seen = state.hashes.get(cameraId)
      const changedAt = seen && seen.hash === hash ? seen.changedAt : t
      state.hashes.delete(cameraId)
      state.hashes.set(cameraId, { hash, changedAt })
      if (state.hashes.size > MAX_HASHES) state.hashes.delete(state.hashes.keys().next().value!)
      return { bytes: raw.bytes, fetchedAt: t, capturedAt: raw.capturedAt, changedAt, width: raw.width, height: raw.height }
    } finally {
      s.gate.release()
    }
  }

  const res = await state.frames.get(cameraId, policy, load, now)
  if (res.ok) return { ok: true, frame: res.value, stale: res.stale, ttlMs: policy.ttlMs }
  const err = res.error
  if (err instanceof NotAttemptedError) {
    s.refused.add(now())
    return { ok: false, failure: err.reason === 'budget' ? 'budget' : 'busy' }
  }
  return { ok: false, failure: err instanceof FrameError ? err.code : 'unreachable' }
}

// --- request resolution -------------------------------------------------------------------------

/**
 * True when this server shows stills for `source`: the source is enabled, CCTV_IMAGES=1 and
 * this host fetched the catalogue itself (holds the server-only references). Relayed or
 * cloud catalogues are link-only. demo-cam images are generated in DATA_MODE=fixture.
 */
export async function canServeImages(config: AppConfig, store: Store, source: CameraSourceId, now: number = Date.now()): Promise<boolean> {
  if (config.CCTV_IMAGES !== '1' || !config.enabledCameraSources.includes(source)) return false
  if (source === 'demo-cam') return config.DATA_MODE === 'fixture'
  if (sourceState(source).downUntil > now) return false
  return hasCameraRefs(store, source)
}

export function cctvImageExt(source: CameraSourceId): 'svg' | 'jpg' {
  return source === 'demo-cam' ? 'svg' : 'jpg'
}

/** Same-origin still URL of a camera. */
export function cctvImagePath(camera: Pick<Camera, 'source' | 'nativeId'>): string {
  return `/api/cctv/image/${camera.source}/${encodeURIComponent(camera.nativeId)}.${cctvImageExt(camera.source)}`
}

/** `<nativeId>.jpg` (`.svg` for demo-cam) → nativeId; null for anything else. */
export function parseCctvImageFile(source: CameraSourceId, file: string): string | null {
  const m = /^([A-Za-z0-9_-]{1,64})\.(jpg|svg)$/.exec(file)
  if (!m || m[2] !== cctvImageExt(source)) return null
  return m[1]!
}

export type ResolvedCamera = { camera: Camera; ref: string | null }

/**
 * Checks made before anything else: the source serves images on this host, the file name is
 * well-formed, the camera is in the current catalogue and (for agency sources) we hold its
 * reference. null ⇒ 404, and no upstream request is made.
 */
export async function resolveCctvCamera(config: AppConfig, store: Store, source: string, file: string): Promise<ResolvedCamera | null> {
  if (!isCameraSourceId(source)) return null
  if (!(await canServeImages(config, store, source))) return null
  const nativeId = parseCctvImageFile(source, file)
  if (!nativeId) return null
  const [catalog] = await loadCameraCatalogs(store, [source])
  const camera = catalog?.cameras.find((c) => c.nativeId === nativeId && c.source === source)
  if (!camera) return null
  const ref = await getCameraRef(store, camera.id)
  // demo-cam: the ref (when stored) names the simulated station that drives the picture.
  if (source === 'demo-cam') return { camera, ref }
  return ref ? { camera, ref } : null
}

// --- responses ----------------------------------------------------------------------------------

/** Headers every camera image response carries (the CSP matters for the demo SVG). */
export const CCTV_IMAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
  // Other sites cannot embed our proxy with <img> and spend the agencies' budget.
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const

/** JPEG response for a frame from getCctvImage. */
export function cctvFrameResponse(frame: CctvFrame, stale: boolean, ttlMs: number, now: number = Date.now()): Response {
  const maxAge = stale ? 60 : Math.max(1, Math.ceil((frame.fetchedAt + ttlMs - now) / 1000))
  const headers: Record<string, string> = {
    ...CCTV_IMAGE_HEADERS,
    'Content-Type': 'image/jpeg',
    'Content-Length': String(frame.bytes.byteLength),
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Cctv-Fetched-At': new Date(frame.fetchedAt).toISOString(),
    'X-Cctv-Changed-At': new Date(frame.changedAt).toISOString(),
  }
  if (frame.capturedAt) headers['X-Cctv-Captured-At'] = frame.capturedAt
  if (stale) headers['X-Cctv-Stale'] = '1'
  return new Response(frame.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers })
}

/** HTTP status, Thai message and extra headers for a failed image request. */
export function cctvFailure(failure: CctvFailure): { status: 502 | 503; message: string; headers: Record<string, string> } {
  switch (failure) {
    case 'no-image':
      return { status: 502, message: CCTV_MSG.noImage, headers: {} }
    case 'busy':
    case 'budget':
      return { status: 503, message: CCTV_MSG.paused, headers: { 'Retry-After': failure === 'busy' ? '30' : '60' } }
    default:
      return { status: 502, message: CCTV_MSG.unreachable, headers: {} }
  }
}

// --- camera list (GET /api/cctv/cameras) --------------------------------------------------------

/** Agency camera pages we only link to (no images through this server). */
export const CAMERA_LINKS: CameraLinkOut[] = [
  { id: 'dds-cctv', title: 'กล้องระดับน้ำ สำนักการระบายน้ำ', owner: 'สำนักการระบายน้ำ กทม.', url: 'https://dds.bangkok.go.th/cctv.php' },
  { id: 'bma-traffic', title: 'กล้องจราจร กทม.', owner: 'สำนักการจราจรและขนส่ง กทม.', url: 'http://www.bmatraffic.com/' },
  { id: 'dwr-cctv', title: 'กล้องสถานีโทรมาตรแม่น้ำ', owner: 'กรมทรัพยากรน้ำ', url: 'https://telemetry.dwr.go.th/reportCctv' },
  { id: 'rid-wmsc', title: 'CCTV ลุ่มน้ำเจ้าพระยา', owner: 'กรมชลประทาน', url: 'https://wmsc.rid.go.th/cctv2/' },
  { id: 'doh-highway', title: 'กล้องทางหลวง', owner: 'กรมทางหลวง', url: 'https://www.highwaytraffic.go.th/' },
]

/** Fallback official pages when a stored camera's officialUrl is not a plain http(s) link. */
const SOURCE_PAGES: Record<CameraSourceId, string> = {
  'bma-floodcam': 'https://floodbangkok.bangkok.go.th/',
  'dwr-cctv': 'https://telemetry.dwr.go.th/reportCctv',
  'demo-cam': '/about',
}

function safeLink(url: unknown, source: CameraSourceId): string {
  if (typeof url === 'string' && url.length <= 512) {
    if (/^\/(?!\/)[A-Za-z0-9/_#?=&.-]*$/.test(url)) return url // same-origin page (demo)
    try {
      const u = new URL(url)
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return url
    } catch {
      // fall through
    }
  }
  return SOURCE_PAGES[source]
}

/**
 * Public view of a stored camera. Fields are copied one by one (never spread), so anything
 * else a stored object might carry can never reach a response.
 */
export function toPublicCamera(c: Camera, opts: { distanceKm: number | null; image: boolean }): PublicCamera {
  return {
    id: c.id,
    source: c.source,
    nativeId: c.nativeId,
    siteId: c.siteId,
    name: c.name,
    code: c.code ?? null,
    angle: c.angle ?? null,
    owner: c.owner,
    lat: c.lat,
    lng: c.lng,
    facing: c.facing,
    nearStationIds: Array.isArray(c.nearStationIds) ? c.nearStationIds.filter((s) => typeof s === 'string') : [],
    officialUrl: safeLink(c.officialUrl, c.source),
    cadenceMin: c.cadenceMin ?? null,
    distanceKm: opts.distanceKm,
    media: opts.image ? 'image' : 'link',
    imageUrl: opts.image ? cctvImagePath(c) : null,
    refreshSec: CCTV_REFRESH_SEC[c.source],
  }
}

export interface CamerasQuery {
  /** Both or neither. */
  lat?: number
  lng?: number
  /** Radius km. */
  radiusKm: number
  /** Most sites returned (every angle of a site is included). */
  maxSites: number
}

/**
 * Build the /api/cctv/cameras response. With a point: cameras within the radius, nearest
 * first (ties by id), at most `maxSites` sites with all their angles, plus the distance to the
 * nearest camera outside the radius. Without a point: every camera (map layer).
 */
export function buildCamerasResponse(
  catalogs: CameraCatalog[],
  enabled: readonly CameraSourceId[],
  imageSources: ReadonlySet<CameraSourceId>,
  q: CamerasQuery,
  now: Date,
): CamerasResponse {
  const catalogAt: CamerasResponse['catalogAt'] = {}
  for (const s of enabled) catalogAt[s] = catalogs.find((c) => c.source === s)?.fetchedAt ?? null
  const all = catalogs.filter((c) => enabled.includes(c.source)).flatMap((c) => c.cameras.filter((cam) => cam.source === c.source))
  const base = { generatedAt: now.toISOString(), catalogAt, links: CAMERA_LINKS }

  if (q.lat === undefined || q.lng === undefined) {
    return { ...base, cameras: all.map((c) => toPublicCamera(c, { distanceKm: null, image: imageSources.has(c.source) })), nearestOutsideKm: null }
  }
  const { lat, lng } = q
  const measured = all
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng))
    .map((c) => ({ c, d: haversineKm(lat, lng, c.lat, c.lng) }))
    .sort((a, b) => a.d - b.d || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
  const inside = measured.filter((m) => m.d <= q.radiusKm)
  const outside = measured.find((m) => m.d > q.radiusKm)
  const sites: string[] = []
  for (const m of inside) {
    if (sites.includes(m.c.siteId)) continue
    if (sites.length >= q.maxSites) break
    sites.push(m.c.siteId)
  }
  const picked = inside
    .filter((m) => sites.includes(m.c.siteId))
    .sort((a, b) => sites.indexOf(a.c.siteId) - sites.indexOf(b.c.siteId) || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
  return {
    ...base,
    cameras: picked.map((m) => toPublicCamera(m.c, { distanceKm: Math.round(m.d * 100) / 100, image: imageSources.has(m.c.source) })),
    nearestOutsideKm: outside ? Math.round(outside.d * 100) / 100 : null,
  }
}
