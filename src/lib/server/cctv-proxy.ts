import { createHash } from 'node:crypto'
import type { AppConfig } from '../config'
import { getCameraRef, hasCameraRefs, isCameraSourceId, loadCameraCatalogs } from '../cameras/catalog'
import { haversineKm } from '../geo'
import type { Store } from '../store/types'
import type { Camera, CameraCatalog, CameraSourceId } from '../types'
import { BROWSER_UA } from '../sources/http'
import { publicOrigin } from './http'
import { ImageCache, NotAttemptedError, type CachePolicy } from './image-cache'
import { log, type Logger } from './log'
import type { CameraLinkOut, CamerasResponse, PublicCamera } from './public'
import { LIMITS, rateLimiter, type RateLimiter } from './rate-limit'

// CCTV stills through our own server (GET /api/cctv/image/[source]/[file]). Modelled on
// radar-proxy.ts: the client never supplies a URL; the upstream address is built here from a
// fixed host per source and the server-only reference stored with the catalogue. Frames are
// fetched on demand only, shared by every viewer of this server process (single-flight, short
// TTL), kept in memory only (never on disk, in the database or in logs) and dropped on time
// even when no further requests come. Per-source concurrency and hourly budgets keep us gentle
// with the agencies' servers, and per-client limits on cache misses keep one visitor from
// using them up. All of this state is per process: serverless instances (Vercel) each have
// their own, which is why CCTV_IMAGES defaults to 0 there. No (client IP, camera) pair is ever
// logged; only aggregate per-source counters are kept (exposed coarsely by /api/health).

/** Sources whose stills are fetched from an agency (demo-cam images are generated locally). */
export type UpstreamCameraSource = Exclude<CameraSourceId, 'demo-cam'>

export interface CctvSourcePolicy extends CachePolicy {
  /** The whole upstream fetch (BMA: one request; DWR: both steps together). */
  timeoutMs: number
  /** Upstream requests running at once for this source. */
  maxInFlight: number
  /** Requests allowed to wait for a free slot; more are refused at once (503). */
  maxQueue: number
  /** Longest total wait for a slot (the client's own line, then the source queue) before refusing (503). */
  queueWaitMs: number
  /** Upstream frames per rolling hour. */
  hourlyBudget: number
  /** Largest accepted image. */
  maxBytes: number
}

const MIN = 60_000

/**
 * Longest an image request may take on this server: queue wait + upstream fetch (each source's
 * queueWaitMs + timeoutMs stays within it). The client watchdog (src/lib/ui/cctv.ts) must be
 * longer, or a slow but successful frame is shown as unreachable while the server still pays
 * for it.
 */
export const CCTV_SERVER_MAX_MS = 40_000

export const CCTV_POLICY: Record<UpstreamCameraSource, CctvSourcePolicy> = {
  // BMA's /api/proxy grabs one frame from the camera's stream (~9 s of their work per frame).
  'bma-floodcam': {
    ttlMs: 60_000,
    failTtlMs: 60_000,
    staleMaxMs: 15 * MIN,
    // BMA's proxy grabs a frame from the camera stream first (~9 s, slower when busy).
    timeoutMs: 25_000,
    maxInFlight: 3,
    maxQueue: 20,
    queueWaitMs: 15_000,
    hourlyBudget: 600,
    maxBytes: 2 * 1024 * 1024,
  },
  // DWR stations upload a still about every 15 minutes.
  'dwr-cctv': {
    ttlMs: 5 * MIN,
    failTtlMs: 60_000,
    staleMaxMs: 60 * MIN,
    timeoutMs: 20_000,
    maxInFlight: 2,
    maxQueue: 10,
    queueWaitMs: 15_000,
    hourlyBudget: 240,
    maxBytes: 2 * 1024 * 1024,
  },
}

/**
 * Upstream fetches one client (IP, or IPv6 /64) may have going at once, running or waiting in a
 * source queue, so one client cannot fill the shared queue. Its further cache misses wait in
 * the client's own line (at most CLIENT_MAX_WAITING; more get 429).
 */
export const CLIENT_MAX_MISSES = 2
export const CLIENT_MAX_WAITING = 6
/** Retry-After (s) when a client's own line is full. */
const CLIENT_LINE_RETRY_SEC = 15

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
  limited: 'ขอภาพบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  unavailable: 'ขณะนี้เซิร์ฟเวอร์นี้แสดงภาพจากกล้องของหน่วยงานนี้ไม่ได้ ดูภาพได้ที่เว็บไซต์ของหน่วยงาน',
} as const

// --- frames -------------------------------------------------------------------------------------

export type CctvImageType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface CctvFrame {
  /** Image bytes (JPEG trimmed after the last end-of-image marker). */
  bytes: Uint8Array
  type: CctvImageType
  /** When this server got the frame, epoch ms. */
  fetchedAt: number
  /** Capture time stated by the agency (DWR snapshot path), ISO UTC; null when unknown. */
  capturedAt: string | null
  /** When this exact picture was first seen, epoch ms (a frozen camera keeps an old value). */
  changedAt: number
  width: number | null
  height: number | null
}

/**
 * Why an upstream frame could not be had. Upstream was not asked for `busy`/`budget` (shared
 * queue or hourly budget), `limited` (this client's own miss limits) and `unavailable` (this
 * server cannot fetch the source at the moment: host fallback or agency backoff).
 */
export type CctvFailure = 'unreachable' | 'no-image' | 'busy' | 'budget' | 'limited' | 'unavailable'

/**
 * What a failed fetch says about reaching the agency from this server:
 * - `refused`: the host answered but turned this server away (HTTP 403, an HTML or challenge
 *   page instead of an image);
 * - `unreachable`: no answer at all (the fetch itself failed: DNS, TLS, connection refused);
 * - `reached`: an ordinary answer (HTTP 5xx/404, a timeout, an odd body): the host is reachable
 *   and the camera is the problem;
 * - `unknown`: no request was made.
 * Only `refused` and `unreachable` count toward the source-level fallbacks.
 */
export type HostSignal = 'refused' | 'unreachable' | 'reached' | 'unknown'

export class FrameError extends Error {
  host: HostSignal
  status: number | null
  /** The agency's Retry-After, ms. */
  retryAfterMs: number | null

  constructor(
    public code: 'unreachable' | 'no-image',
    message: string,
    opts: { host?: HostSignal; status?: number; retryAfterMs?: number | null } = {},
  ) {
    super(message)
    this.name = 'FrameError'
    this.host = opts.host ?? 'reached'
    this.status = opts.status ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
  }
}

/** Retry-After as ms (delta seconds or an HTTP date), or null. */
export function parseRetryAfterMs(v: string | null | undefined, now: number): number | null {
  const s = v?.trim()
  if (!s) return null
  if (/^\d{1,9}$/.test(s)) return Number(s) * 1000
  const at = Date.parse(s)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** A markup page (error page, Cloudflare challenge, geo block) where an image was expected. */
function looksLikeHtml(bytes: Uint8Array): boolean {
  return /^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 64)))
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

/**
 * Read a response body, refusing (and cancelling) anything over `maxBytes`. An oversize markup
 * page (a challenge page where a small JSON answer was expected) still counts as a refusal.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new FrameError('unreachable', 'image too large', { host: /html/i.test(res.headers.get('content-type') ?? '') ? 'refused' : 'reached' })
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
        throw new FrameError('unreachable', 'image too large', { host: looksLikeHtml(chunks[0] ?? value) ? 'refused' : 'reached' })
      }
      chunks.push(value)
    }
  } catch (err) {
    // A body cut off by the deadline or the connection: the host did answer.
    if (err instanceof FrameError) throw err
    throw new FrameError('unreachable', 'body read failed')
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
  // Cloudflare challenges, HTML error pages and PNG placeholders are never passed through. A
  // markup page means this server was turned away; a placeholder image is the camera's problem.
  if (!isJpeg(bytes)) throw new FrameError('unreachable', 'not a JPEG image', { host: looksLikeHtml(bytes) ? 'refused' : 'reached' })
  const trimmed = trimJpeg(bytes)
  if (!trimmed) throw new FrameError('unreachable', 'truncated JPEG')
  const size = jpegSize(trimmed)
  return { bytes: trimmed, width: size?.width ?? null, height: size?.height ?? null }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Smaller pictures are placeholders ("no signal" tiles, 1×1 pixels), not camera frames. */
const MIN_FRAME_PX = { width: 64, height: 48 }

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 24 && PNG_MAGIC.every((b, i) => bytes[i] === b)
}

export function isWebp(bytes: Uint8Array): boolean {
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  return bytes.length > 16 && tag(0) === 'RIFF' && tag(8) === 'WEBP'
}

/**
 * Validate an upstream image body: a complete JPEG (trimmed after its end marker), or a PNG /
 * WebP still. Markup pages are refusals; tiny pictures are placeholders (the camera's problem).
 */
export function validateImage(bytes: Uint8Array): { bytes: Uint8Array; type: CctvImageType; width: number | null; height: number | null } {
  if (bytes.byteLength === 0) throw new FrameError('unreachable', 'empty body')
  if (isJpeg(bytes)) return { ...validateJpeg(bytes), type: 'image/jpeg' }
  if (isPng(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (width < MIN_FRAME_PX.width || height < MIN_FRAME_PX.height) throw new FrameError('no-image', 'placeholder image')
    return { bytes, type: 'image/png', width, height }
  }
  if (isWebp(bytes)) {
    if (bytes.byteLength < 1024) throw new FrameError('no-image', 'placeholder image')
    return { bytes, type: 'image/webp', width: null, height: null }
  }
  throw new FrameError('unreachable', 'not an image', { host: looksLikeHtml(bytes) ? 'refused' : 'reached' })
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

type Acquired = 'ok' | 'full' | 'timeout' | 'aborted'

/** Concurrency gate with a bounded wait queue. A waiter leaves the queue when its request is aborted. */
class Gate {
  active = 0
  private waiters: (() => void)[] = []

  get queued(): number {
    return this.waiters.length
  }

  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0
  }

  acquire(max: number, maxQueue: number, waitMs: number, signal?: AbortSignal): Promise<Acquired> {
    if (signal?.aborted) return Promise.resolve('aborted')
    if (this.active < max) {
      this.active++
      return Promise.resolve('ok')
    }
    if (this.waiters.length >= maxQueue) return Promise.resolve('full')
    if (waitMs <= 0) return Promise.resolve('timeout')
    return new Promise<Acquired>((resolve) => {
      const settle = (r: Acquired) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const leave = (r: Acquired) => {
        const i = this.waiters.indexOf(wake)
        if (i < 0) return // already handed a slot
        this.waiters.splice(i, 1)
        settle(r)
      }
      const wake = () => settle('ok') // the releasing request handed its slot over; `active` is unchanged
      const onAbort = () => leave('aborted')
      const timer = setTimeout(() => leave('timeout'), waitMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
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

/** Why this server shows no stills for a source (the UI links to the agency page instead). */
export type CctvImagesOff =
  /** CCTV_IMAGES=0, or the source is not enabled. */
  | 'disabled'
  /** The catalogue came without image references (relayed or fetched by another host). */
  | 'link-only'
  /** This host never got a frame and keeps being turned away (e.g. a cloud host and Thai-IP-only images). */
  | 'host-unreachable'
  /** The agency answered 429 (or 403/503 with Retry-After, or kept answering 403): we pause. */
  | 'agency-backoff'

interface SourceState {
  gate: Gate
  /** Upstream frame attempts (what the hourly budget counts). */
  attempts: HourCounter
  ok: HourCounter
  fail: HourCounter
  /** Requests refused by the concurrency queue or the hourly budget. */
  refused: HourCounter
  lastFrame: { width: number | null; height: number | null; bytes: number } | null
  /** This process has fetched a frame for the source. */
  everOk: boolean
  /** Host-level failures in a row (refused or unreachable), reset whenever the host answers normally. */
  blockedStreak: number
  /** HTTP 403 / HTML answers in a row (a WAF block), reset whenever the host answers normally. */
  refusalStreak: number
  /** No upstream requests for the source until then (epoch ms), for `offReason`. */
  offUntil: number
  offReason: 'host-unreachable' | 'agency-backoff' | null
  /** Agency backoffs since the last good frame (doubles the pause when no Retry-After is given). */
  backoffs: number
  /** HTTP 5xx answers in a row on a host that never gave a frame (the request form may be wrong). */
  agencyErrorStreak: number
  /** Why the latest upstream attempt failed (no camera id, no reference), for health and the log. */
  lastFailure: { reason: string; at: number } | null
  /** reason → last time it was logged (one line per reason per FAILURE_LOG_MS). */
  failureLogged: Map<string, number>
}

/**
 * A host that has never fetched a frame for a source and is turned away this many times in a
 * row (network errors, HTTP 403, HTML pages; not timeouts or camera errors, which prove the
 * host answers) treats the source as unreachable from here (e.g. a cloud server sharing a
 * Supabase store with the Thai worker, so it holds refs but cannot reach Thai-IP-only images)
 * and shows link-outs instead for SOURCE_DOWN_MS before trying again. On a host that has had
 * frames, the same count of 403 / HTML answers starts an agency backoff instead (BMA answers a
 * sporadic 403 even to Thai IPs, so one is not enough).
 */
/** A host that never gave a frame and answers this many 5xx in a row is rested for a while. */
export const AGENCY_ERROR_AFTER = 8
export const AGENCY_ERROR_PAUSE_MS = 15 * 60_000

/** One log line per failure reason per source this often. */
const FAILURE_LOG_MS = 30 * 60_000

export const SOURCE_DOWN_AFTER = 3
export const SOURCE_DOWN_MS = 30 * 60_000
/** Agency backoff: Retry-After when given (clamped), else 10 → 20 → 40 → 60 min. */
export const BACKOFF_MIN_MS = MIN
export const BACKOFF_BASE_MS = 10 * MIN
export const BACKOFF_MAX_MS = 60 * MIN

/** How often memory is swept when no requests come in. */
export const CCTV_SWEEP_MS = 60_000
/** Frame hashes (frozen-camera detection) of cameras nobody has looked at for this long are forgotten. */
export const HASH_MAX_AGE_MS = 2 * 60 * MIN

/** Bump when CctvState or SourceState changes shape: a dev hot reload then starts afresh. */
const STATE_VERSION = 2

interface CctvState {
  version: number
  frames: ImageCache<CctvFrame>
  hashes: Map<string, { hash: string; changedAt: number; seenAt: number }>
  sources: Map<UpstreamCameraSource, SourceState>
  /** Per-client lines for upstream misses (keyed by IP bucket; removed when idle). */
  clients: Map<string, Gate>
}

interface CctvGlobal {
  __floodCctv?: CctvState
  __floodCctvSweep?: ReturnType<typeof setInterval>
  __floodCctvWarningsLogged?: boolean
}

const g = globalThis as typeof globalThis & CctvGlobal
if (g.__floodCctv?.version !== STATE_VERSION) {
  g.__floodCctv = { version: STATE_VERSION, frames: new ImageCache<CctvFrame>(MAX_FRAMES), hashes: new Map(), sources: new Map(), clients: new Map() }
}
const state: CctvState = g.__floodCctv

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
      blockedStreak: 0,
      refusalStreak: 0,
      offUntil: 0,
      offReason: null,
      agencyErrorStreak: 0,
      backoffs: 0,
      lastFailure: null,
      failureLogged: new Map(),
    }
    state.sources.set(source, s)
  }
  return s
}

/** Seconds until the source may be asked again, or null while it may be asked now. */
function offFor(s: SourceState, t: number): number | null {
  return s.offUntil > t ? Math.max(1, Math.ceil((s.offUntil - t) / 1000)) : null
}

/** Tests: forget every frame, hash, counter and queue. */
export function clearCctvCache(): void {
  state.frames.clear()
  state.hashes.clear()
  state.sources.clear()
  state.clients.clear()
}

/**
 * Drop frames at (or within `aheadMs` of) their stale limit and frame hashes older than
 * HASH_MAX_AGE_MS. Runs on every image request (frames) and from an unref'd timer, so the
 * retention promised on /about holds when nobody asks for images any more.
 */
export function sweepCctvMemory(t: number = Date.now(), aheadMs: number = CCTV_SWEEP_MS): void {
  state.frames.prune(t, aheadMs)
  for (const [id, h] of state.hashes) if (t - h.seenAt >= HASH_MAX_AGE_MS) state.hashes.delete(id)
}

/** (Re)start this process's periodic sweep. It never keeps the process alive. */
export function startCctvSweeper(intervalMs: number = CCTV_SWEEP_MS): void {
  if (g.__floodCctvSweep) clearInterval(g.__floodCctvSweep)
  const timer = setInterval(() => sweepCctvMemory(Date.now(), intervalMs), intervalMs)
  timer.unref?.()
  g.__floodCctvSweep = timer
}

startCctvSweeper()

export interface CctvSourceStats {
  source: UpstreamCameraSource
  /** Last hour: frames fetched, upstream failures, requests refused (busy or budget spent). */
  frames1h: { ok: number; fail: number; refused: number; budgetLeft: number }
  /** Coarse budget state for public output: 'low' when under a quarter is left. */
  budget: 'ok' | 'low' | 'spent'
  inFlight: number
  queued: number
  /** Size of the most recent frame (helps decide whether downscaling is needed). */
  lastFrame: { width: number | null; height: number | null; bytes: number } | null
  /** Why the latest upstream attempt failed, e.g. "HTTP 403" or "not an image" (no camera id). */
  lastFailure: { reason: string; at: string } | null
}

/** Aggregate per-source counters (no camera ids, no clients). */
export function cctvImageStats(source: UpstreamCameraSource, now: number = Date.now()): CctvSourceStats {
  const s = sourceState(source)
  const hourly = CCTV_POLICY[source].hourlyBudget
  const budgetLeft = Math.max(0, hourly - s.attempts.total(now))
  return {
    source,
    frames1h: {
      ok: s.ok.total(now),
      fail: s.fail.total(now),
      refused: s.refused.total(now),
      budgetLeft,
    },
    budget: budgetLeft === 0 ? 'spent' : budgetLeft < hourly / 4 ? 'low' : 'ok',
    inFlight: s.gate.active,
    queued: s.gate.queued,
    lastFrame: s.lastFrame,
    lastFailure: s.lastFailure ? { reason: s.lastFailure.reason, at: new Date(s.lastFailure.at).toISOString() } : null,
  }
}

// --- upstream fetchers --------------------------------------------------------------------------

export interface CctvFetchDeps {
  fetch: typeof fetch
  now?: () => number
  /** PUBLIC_BASE_URL, for the honest User-Agent. */
  publicBaseUrl?: string
  /**
   * Rate-limit key of the requesting client (ipBucket of its IP). Its cache misses are
   * counted (LIMITS.cctvMiss) and capped at CLIENT_MAX_MISSES at once. null/undefined when the
   * IP is unknown (TRUST_PROXY=none): only the per-source limits apply.
   */
  client?: string | null
  /** The client's request signal: an abandoned request leaves the queues at once. */
  signal?: AbortSignal
  /** Tests: the limiter holding the per-client miss buckets (default: this process's). */
  limiter?: RateLimiter
  /** Tests: override parts of the source policy. */
  policy?: Partial<CctvSourcePolicy>
}

/**
 * Browser-style User-Agent that still names this system (the same one every BMA request uses):
 * agency WAFs refuse bare tool user agents, and the suffix says who is asking.
 */
function userAgent(publicBaseUrl: string | undefined): string {
  const origin = publicOrigin(publicBaseUrl)
  return `${BROWSER_UA} (+${origin ? `${origin}/about` : 'https://github.com/chalaivate/flood-monitor'})`
}

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/*;q=0.8'
/** Redirects followed per upstream request, and only within the same origin. */
const MAX_REDIRECTS = 2

async function upstream(fetchImpl: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    // No Referer / Origin: we say who we are in the User-Agent instead. Redirects are followed
    // by hand and only within the same origin, so the upstream host never changes.
    let current = new URL(url)
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(current.href, { ...init, redirect: 'manual', referrerPolicy: 'no-referrer', signal })
      if (res.status < 300 || res.status > 399 || res.status === 304) return res
      await res.body?.cancel().catch(() => undefined)
      const location = res.headers.get('location')
      const next = location ? new URL(location, current) : null
      if (!next || next.origin !== current.origin || hop >= MAX_REDIRECTS || (res.status !== 307 && res.status !== 308 && init.method && init.method !== 'GET')) {
        throw new FrameError('unreachable', `HTTP ${res.status} redirect${next && next.origin !== current.origin ? ' to another host' : ''}`, { host: 'reached', status: res.status })
      }
      current = next
    }
  } catch (err) {
    if (err instanceof FrameError) throw err
    // A timeout means a slow answer, not a blocked host: a blocked host fails fast (refused,
    // reset, or undici's 10 s connect timeout, which is a TypeError). Anything else (DNS, TLS,
    // refused, reset, a redirect) is a host-level failure.
    const timeout = signal.aborted || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    throw new FrameError('unreachable', timeout ? 'timeout' : 'network error', { host: timeout ? 'reached' : 'unreachable' })
  }
}

/** Error for a non-OK upstream answer (drains the body). 403 means this server is turned away. */
async function httpError(res: Response, now: number): Promise<FrameError> {
  await res.body?.cancel().catch(() => undefined)
  return new FrameError('unreachable', `HTTP ${res.status}`, {
    host: res.status === 403 ? 'refused' : 'reached',
    status: res.status,
    retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), now),
  })
}

async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined)
}

interface RawFrame {
  bytes: Uint8Array
  type: CctvImageType
  width: number | null
  height: number | null
  capturedAt: string | null
}

/**
 * One frame. `signal` is the deadline for the whole fetch (policy.timeoutMs), so the server's
 * worst case stays queue wait + timeoutMs (CCTV_SERVER_MAX_MS).
 */
type Fetcher = (ref: string, policy: CctvSourcePolicy, deps: CctvFetchDeps, signal: AbortSignal) => Promise<RawFrame>

const fetchBmaFrame: Fetcher = async (ref, policy, deps, signal) => {
  if (!isPlausibleStreamRef(ref)) throw new FrameError('unreachable', 'invalid reference', { host: 'unknown' })
  // Same form as BMA's own page: the timestamp defeats caches between BMA and the camera.
  const url = `${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}&timestamp=${(deps.now ?? Date.now)()}`
  const res = await upstream(deps.fetch, url, { headers: { 'User-Agent': userAgent(deps.publicBaseUrl), Accept: IMAGE_ACCEPT } }, signal)
  if (!res.ok) throw await httpError(res, (deps.now ?? Date.now)())
  const frame = validateImage(await readCapped(res, policy.maxBytes))
  return { ...frame, capturedAt: null }
}

const fetchDwrFrame: Fetcher = async (ref, policy, deps, signal) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) throw new FrameError('unreachable', 'invalid reference', { host: 'unknown' })
  const ua = userAgent(deps.publicBaseUrl)
  const now = deps.now ?? Date.now
  // Step 1: the latest still's path, e.g. {"value":"/TA100220/2026/10/4/10_15.jpg"}.
  const snap = await upstream(deps.fetch, `${DWR_API}/public/reportCctv/snapshot/${encodeURIComponent(ref)}`, { headers: { 'User-Agent': ua, Accept: 'application/json' } }, signal)
  if (snap.status === 404) {
    await drain(snap)
    throw new FrameError('no-image', 'no snapshot')
  }
  if (!snap.ok) throw await httpError(snap, now())
  let value: unknown
  const raw = await readCapped(snap, MAX_JSON_BYTES)
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as unknown
    value = body && typeof body === 'object' ? (body as { value?: unknown }).value : undefined
  } catch {
    throw new FrameError('unreachable', 'unexpected snapshot response', { host: looksLikeHtml(raw) ? 'refused' : 'reached' })
  }
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new FrameError('no-image', 'no snapshot')
  }
  if (typeof value !== 'string' || !DWR_PATH_RE.test(value) || value.includes('..')) {
    throw new FrameError('unreachable', 'unexpected snapshot path')
  }
  // Step 2: the JPEG itself (POST only), within the same deadline as step 1.
  const img = await upstream(
    deps.fetch,
    `${DWR_API}/file/image/cctv`,
    { method: 'POST', headers: { 'User-Agent': ua, Accept: IMAGE_ACCEPT, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: value }) },
    signal,
  )
  if (img.status === 404) {
    await drain(img)
    throw new FrameError('no-image', 'image not found')
  }
  if (!img.ok) throw await httpError(img, now())
  const bytes = await readCapped(img, policy.maxBytes)
  if (bytes.byteLength === 0) throw new FrameError('no-image', 'empty image')
  return { ...validateImage(bytes), capturedAt: dwrCaptureTime(value) }
}

const FETCHERS: Record<UpstreamCameraSource, Fetcher> = {
  'bma-floodcam': fetchBmaFrame,
  'dwr-cctv': fetchDwrFrame,
}

export type CctvImageOutcome =
  | { ok: true; frame: CctvFrame; stale: boolean; ttlMs: number }
  /** `retryAfterSec` is set for 'limited' and 'unavailable'. */
  | { ok: false; failure: CctvFailure; retryAfterSec?: number }

export function isUpstreamCameraSource(s: string): s is UpstreamCameraSource {
  return s === 'bma-floodcam' || s === 'dwr-cctv'
}

/** Switch the source off from `t` for `ms` (logged once: failures while off are not counted). */
function goOff(source: UpstreamCameraSource, s: SourceState, reason: 'host-unreachable' | 'agency-backoff', t: number, ms: number, why: string): void {
  s.offUntil = t + ms
  s.offReason = reason
  s.blockedStreak = 0
  s.refusalStreak = 0
  const min = Math.max(1, Math.round(ms / 60_000))
  log(
    reason === 'host-unreachable'
      ? `[cctv] ${source}: images unreachable from this server (${why}); showing agency links for ${min} min`
      : `[cctv] ${source}: the agency is refusing image requests (${why}); pausing them for about ${min} min`,
  )
}

/** Source-level bookkeeping for a failed upstream fetch (not called while the source is off). */
function noteFailure(source: UpstreamCameraSource, s: SourceState, err: FrameError, t: number): void {
  const explicit = err.status === 429 || (err.retryAfterMs !== null && (err.status === 403 || err.status === 503))
  if (explicit) {
    // The agency asked us to slow down: honour Retry-After (clamped), whatever this host's history.
    const ms = err.retryAfterMs ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** s.backoffs)
    s.backoffs++
    goOff(source, s, 'agency-backoff', t, Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, ms)), `HTTP ${err.status}`)
    return
  }
  if (err.host === 'reached') {
    // The host answered: a camera-level failure says nothing about reaching it.
    s.blockedStreak = 0
    s.refusalStreak = 0
    // But server errors for every camera on a host that never gave a frame mean the agency's
    // service is down or no longer accepts this request: rest it and show agency links.
    if (!s.everOk && err.status !== null && err.status >= 500 && ++s.agencyErrorStreak >= AGENCY_ERROR_AFTER) {
      s.agencyErrorStreak = 0
      goOff(source, s, 'agency-backoff', t, AGENCY_ERROR_PAUSE_MS, `HTTP ${err.status} ×${AGENCY_ERROR_AFTER}`)
    }
    return
  }
  if (err.host !== 'refused' && err.host !== 'unreachable') return
  s.blockedStreak++
  if (err.host === 'refused') s.refusalStreak++
  if (!s.everOk && s.blockedStreak >= SOURCE_DOWN_AFTER) {
    goOff(source, s, 'host-unreachable', t, SOURCE_DOWN_MS, err.message)
  } else if (s.everOk && s.refusalStreak >= SOURCE_DOWN_AFTER) {
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** s.backoffs)
    s.backoffs++
    goOff(source, s, 'agency-backoff', t, ms, `${err.message} ×${SOURCE_DOWN_AFTER}`)
  }
}

function releaseClient(client: string, gate: Gate, acquired: boolean): void {
  if (acquired) gate.release()
  if (gate.idle && state.clients.get(client) === gate) state.clients.delete(client)
}

/**
 * Latest still of a camera whose reference has already been checked against the catalogue.
 * Shared cache → single-flight upstream fetch → stale fallback. Never throws.
 *
 * A request that would go upstream (a cache miss) is checked first: the source must not be
 * off (host fallback / agency backoff), and a known client spends a token of its miss bucket
 * and waits in its own line (CLIENT_MAX_MISSES at once) before it may join the source queue.
 * The whole wait is bounded by queueWaitMs and ends early when `deps.signal` aborts. When a
 * miss is refused, the last good frame is served if it is still young enough.
 */
export async function getCctvImage(source: UpstreamCameraSource, cameraId: string, ref: string, deps: CctvFetchDeps): Promise<CctvImageOutcome> {
  const now = deps.now ?? Date.now
  const policy: CctvSourcePolicy = { ...CCTV_POLICY[source], ...deps.policy }
  const s = sourceState(source)
  const deadline = now() + policy.queueWaitMs
  const waitLeft = () => Math.max(0, deadline - now())
  /** The last good frame while it may be served, else `failure`. */
  const staleOr = (failure: CctvFailure, retryAfterSec?: number): CctvImageOutcome => {
    const v = state.frames.peek(cameraId, policy, now()).value
    if (v) return { ok: true, frame: v, stale: now() - v.fetchedAt >= policy.ttlMs, ttlMs: policy.ttlMs }
    return retryAfterSec === undefined ? { ok: false, failure } : { ok: false, failure, retryAfterSec }
  }

  let line: { client: string; gate: Gate } | null = null
  if (state.frames.peek(cameraId, policy, now()).wouldLoad) {
    const off = offFor(s, now())
    if (off !== null) return staleOr('unavailable', off)
    if (deps.client) {
      const token = (deps.limiter ?? rateLimiter()).take(`cctvMiss:${deps.client}`, LIMITS.cctvMiss)
      if (!token.ok) return staleOr('limited', token.retryAfterSec)
      const gate = state.clients.get(deps.client) ?? new Gate()
      state.clients.set(deps.client, gate)
      const got = await gate.acquire(CLIENT_MAX_MISSES, CLIENT_MAX_WAITING, waitLeft(), deps.signal)
      if (got !== 'ok') {
        releaseClient(deps.client, gate, false)
        if (got === 'full') return staleOr('limited', CLIENT_LINE_RETRY_SEC)
        if (got === 'timeout') s.refused.add(now())
        return staleOr('busy')
      }
      line = { client: deps.client, gate }
    }
  }

  const load = async (): Promise<CctvFrame> => {
    if (offFor(s, now()) !== null) throw new NotAttemptedError('unavailable')
    if (s.attempts.total(now()) >= policy.hourlyBudget) throw new NotAttemptedError('budget')
    const got = await s.gate.acquire(policy.maxInFlight, policy.maxQueue, waitLeft(), deps.signal)
    if (got !== 'ok') throw new NotAttemptedError(got === 'aborted' ? 'aborted' : 'busy')
    try {
      // The source may have gone off, or the budget been spent, while this request waited:
      // requests queued behind the failures that switched the source off never go upstream.
      if (offFor(s, now()) !== null) throw new NotAttemptedError('unavailable')
      if (s.attempts.total(now()) >= policy.hourlyBudget) throw new NotAttemptedError('budget')
      s.attempts.add(now())
      let raw: RawFrame
      try {
        raw = await FETCHERS[source](ref, policy, deps, AbortSignal.timeout(policy.timeoutMs))
      } catch (err) {
        const t = now()
        s.fail.add(t)
        const reason = err instanceof FrameError ? err.message : 'unexpected error'
        s.lastFailure = { reason, at: t }
        if ((s.failureLogged.get(reason) ?? 0) + FAILURE_LOG_MS <= t) {
          s.failureLogged.set(reason, t)
          log(`[cctv] ${source}: could not get a still: ${reason}`)
        }
        // Answers still arriving after the source went off are not counted again.
        if (err instanceof FrameError && offFor(s, t) === null) noteFailure(source, s, err, t)
        throw err
      }
      const t = now()
      s.ok.add(t)
      s.everOk = true
      s.blockedStreak = 0
      s.refusalStreak = 0
      s.backoffs = 0
      s.agencyErrorStreak = 0
      if (!s.lastFrame) log(`[cctv] ${source}: first frame ${raw.width ?? '?'}×${raw.height ?? '?'} px, ${Math.round(raw.bytes.byteLength / 1024)} KB`)
      s.lastFrame = { width: raw.width, height: raw.height, bytes: raw.bytes.byteLength }
      const hash = createHash('sha1').update(raw.bytes).digest('hex')
      const seen = state.hashes.get(cameraId)
      const changedAt = seen && seen.hash === hash && t - seen.seenAt < HASH_MAX_AGE_MS ? seen.changedAt : t
      state.hashes.delete(cameraId)
      state.hashes.set(cameraId, { hash, changedAt, seenAt: t })
      if (state.hashes.size > MAX_HASHES) state.hashes.delete(state.hashes.keys().next().value!)
      return { bytes: raw.bytes, type: raw.type, fetchedAt: t, capturedAt: raw.capturedAt, changedAt, width: raw.width, height: raw.height }
    } finally {
      s.gate.release()
    }
  }

  try {
    const res = await state.frames.get(cameraId, policy, load, now)
    if (res.ok) return { ok: true, frame: res.value, stale: res.stale, ttlMs: policy.ttlMs }
    // The source is off (possibly because of this very answer): say so, not 'unreachable'.
    const off = offFor(s, now())
    if (off !== null) return { ok: false, failure: 'unavailable', retryAfterSec: off }
    const err = res.error
    if (err instanceof NotAttemptedError) {
      if (err.reason !== 'aborted') s.refused.add(now()) // an abandoned request was not refused
      return { ok: false, failure: err.reason === 'budget' ? 'budget' : 'busy' }
    }
    return { ok: false, failure: err instanceof FrameError ? err.code : 'unreachable' }
  } finally {
    if (line) releaseClient(line.client, line.gate, true)
  }
}

// --- request resolution -------------------------------------------------------------------------

export interface CctvAvailability {
  images: boolean
  /** Why not (null while images is true). */
  reason: CctvImagesOff | null
  /** End of an automatic fallback (host-unreachable / agency-backoff), epoch ms; else null. */
  until: number | null
}

/** Retry-After (s) for a source whose stills are off by configuration or catalogue (no end time). */
const OFF_RETRY_SEC = 3600

/**
 * Whether this server shows stills for `source` now, and why not: the source is enabled,
 * CCTV_IMAGES=1, this host fetched the catalogue itself (holds the server-only references) and
 * the source is not switched off by the host fallback or an agency backoff. Relayed or cloud
 * catalogues are link-only. demo-cam images are generated in DATA_MODE=fixture.
 */
export async function cctvImageAvailability(config: AppConfig, store: Store, source: CameraSourceId, now: number = Date.now()): Promise<CctvAvailability> {
  const off = (reason: CctvImagesOff, until: number | null = null): CctvAvailability => ({ images: false, reason, until })
  if (config.CCTV_IMAGES !== '1' || !config.enabledCameraSources.includes(source)) return off('disabled')
  if (source === 'demo-cam') return config.DATA_MODE === 'fixture' ? { images: true, reason: null, until: null } : off('disabled')
  const s = sourceState(source)
  if (s.offUntil > now) return off(s.offReason ?? 'host-unreachable', s.offUntil)
  if (!(await hasCameraRefs(store, source))) return off('link-only')
  return { images: true, reason: null, until: null }
}

/** True when this server shows stills for `source` now (see cctvImageAvailability). */
export async function canServeImages(config: AppConfig, store: Store, source: CameraSourceId, now: number = Date.now()): Promise<boolean> {
  return (await cctvImageAvailability(config, store, source, now)).images
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

export type CctvResolution =
  | { kind: 'camera'; camera: Camera; ref: string | null }
  /** Unknown source, malformed file name, or not in the current catalogue (404). */
  | { kind: 'not-found' }
  /** A listed camera whose stills this server cannot show right now (503, link to the agency). */
  | { kind: 'unavailable'; retryAfterSec: number; reason: CctvImagesOff }

/**
 * Checks made before anything else, none of which asks upstream: the source is enabled, the
 * file name is well-formed, the camera is in the current catalogue, this server shows stills
 * for the source right now and (for agency sources) holds the camera's reference.
 */
export async function resolveCctvCamera(config: AppConfig, store: Store, source: string, file: string, now: number = Date.now()): Promise<CctvResolution> {
  const notFound = { kind: 'not-found' } as const
  if (!isCameraSourceId(source) || !config.enabledCameraSources.includes(source)) return notFound
  const nativeId = parseCctvImageFile(source, file)
  if (!nativeId) return notFound
  const [catalog] = await loadCameraCatalogs(store, [source])
  const camera = catalog?.cameras.find((c) => c.nativeId === nativeId && c.source === source)
  if (!camera) return notFound
  const a = await cctvImageAvailability(config, store, source, now)
  if (!a.images) {
    const retryAfterSec = a.until !== null ? Math.max(1, Math.ceil((a.until - now) / 1000)) : OFF_RETRY_SEC
    return { kind: 'unavailable', retryAfterSec, reason: a.reason ?? 'disabled' }
  }
  const ref = await getCameraRef(store, camera.id)
  // demo-cam: the ref (when stored) names the simulated station that drives the picture.
  if (source === 'demo-cam') return { kind: 'camera', camera, ref }
  return ref ? { kind: 'camera', camera, ref } : notFound
}

/**
 * Startup warnings when this server proxies agency stills: without a trusted client IP there
 * are no per-client limits, and without CONTACT_EMAIL the /about takedown promise has no
 * channel. Empty in fixture mode (generated demo images) and when stills are off.
 */
export function cctvConfigWarnings(config: AppConfig): string[] {
  if (config.CCTV_IMAGES !== '1' || !config.enabledCameraSources.some(isUpstreamCameraSource)) return []
  const out: string[] = []
  if (config.TRUST_PROXY === 'none') {
    out.push(
      'camera stills are on but TRUST_PROXY=none: there are no per-client limits on image requests, so one visitor can use up ' +
        "an agency source's hourly budget for everyone. Set TRUST_PROXY to the header your reverse proxy sets (cloudflare, xff), or CCTV_IMAGES=0",
    )
  }
  const email = config.CONTACT_EMAIL?.trim()
  if (!email || !/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/.test(email)) {
    out.push(
      'camera stills are on but CONTACT_EMAIL is not set to an e-mail address: /about promises to stop showing a camera on request ' +
        'but offers no way to ask. Set CONTACT_EMAIL, or CCTV_IMAGES=0 to show agency links only',
    )
  }
  return out
}

/** Log cctvConfigWarnings once per process. */
export function logCctvConfigWarnings(config: AppConfig, logger: Logger = log): void {
  if (g.__floodCctvWarningsLogged) return
  g.__floodCctvWarningsLogged = true
  for (const w of cctvConfigWarnings(config)) logger(`[cctv] WARNING: ${w}`)
}

/** Tests: allow logCctvConfigWarnings to log again. */
export function __resetCctvWarningsForTests(): void {
  g.__floodCctvWarningsLogged = undefined
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
    'Content-Type': frame.type ?? 'image/jpeg',
    'Content-Length': String(frame.bytes.byteLength),
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Cctv-Fetched-At': new Date(frame.fetchedAt).toISOString(),
    'X-Cctv-Changed-At': new Date(frame.changedAt).toISOString(),
  }
  if (frame.capturedAt) headers['X-Cctv-Captured-At'] = frame.capturedAt
  if (stale) headers['X-Cctv-Stale'] = '1'
  return new Response(frame.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers })
}

/**
 * HTTP status, Thai message and extra headers for a failed image request. The JSON body is
 * `{ error: message, reason: failure }`:
 * - 502 `unreachable` | `no-image`;
 * - 503 `busy` | `budget` (+ Retry-After): the shared queue or hourly budget, try again later;
 * - 503 `unavailable` (+ Retry-After): this server cannot fetch the source right now (host
 *   fallback, agency backoff, stills switched off): the UI shows the agency link instead;
 * - 429 `limited` (+ Retry-After, never cached by shared caches): this client's own limits.
 */
export function cctvFailure(failure: CctvFailure, retryAfterSec?: number): { status: 429 | 502 | 503; message: string; headers: Record<string, string> } {
  switch (failure) {
    case 'no-image':
      return { status: 502, message: CCTV_MSG.noImage, headers: {} }
    case 'busy':
    case 'budget':
      return { status: 503, message: CCTV_MSG.paused, headers: { 'Retry-After': failure === 'busy' ? '30' : '60' } }
    case 'unavailable':
      return { status: 503, message: CCTV_MSG.unavailable, headers: { 'Retry-After': String(retryAfterSec ?? 60) } }
    case 'limited':
      return { status: 429, message: CCTV_MSG.limited, headers: { 'Retry-After': String(retryAfterSec ?? 60), 'Cache-Control': 'no-store' } }
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
