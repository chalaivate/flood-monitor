import type { AppConfig } from '../config'
import { isInThailand } from '../geo'
import { CAMERA_ADAPTERS, getCameraSources } from '../sources/cameras'
import { cleanName, NATIVE_ID_RE, redactSecrets, siteIdFor } from '../sources/cameras/common'
import type { CameraCatalogAdapter } from '../sources/cameras/types'
import type { Store } from '../store/types'
import { CAMERA_SOURCE_IDS } from '../types'
import type { Camera, CameraCatalog, CameraCatalogResult, CameraRef, CameraSourceId, Station } from '../types'
import { joinNearStations, stationJoinKey } from './join'

// Camera catalogues: stored in Store meta (public part and server-only refs under separate
// keys), refreshed by the poller when due, joined to nearby stations when saved.
//
// Meta keys per source:
//   cctv:catalog:<src>  public list {source, fetchedAt, joinedAt, cameras}        (~200 KB for BMA)
//   cctv:refs:<src>     server-only {fetchedAt, refs}; '' when this host did not fetch the list
//   cctv:index:<src>    small index {version, fetchedAt, joinedAt, joinKey, count, local}; written
//                       last, so it is the commit point readers check before the big list
//   cctv:status:<src>   refresh bookkeeping {lastAttemptAt, lastSuccessAt, lastError, failures, shrink}
// Refs (BMA LiveStream addresses, DWR snapshot ids) never leave this module except through
// getCameraRef(); they are never logged, relayed or put into an API response.

export const CATALOG_META_PREFIX = 'cctv:catalog:'
export const REFS_META_PREFIX = 'cctv:refs:'
export const INDEX_META_PREFIX = 'cctv:index:'
export const STATUS_META_PREFIX = 'cctv:status:'

/** A new list with fewer than this share of the stored cameras is refused (partial response). */
export const MIN_KEEP_RATIO = 0.5
/** …unless the same smaller list keeps coming back this many times over this many hours. */
export const SHRINK_ACCEPT_SEEN = 3
export const SHRINK_ACCEPT_AFTER_H = 24
/** Lists stamped further in the future than this are refused. */
const MAX_FUTURE_SKEW_MS = 10 * 60_000
/** Whole refresh (all sources) must finish within this; it runs after alerts, never before. */
export const CATALOG_REFRESH_DEADLINE_MS = 120_000
/** Daily lists drift towards this Bangkok hour (quiet time upstream). */
const PREFERRED_HOUR_BKK: Partial<Record<CameraSourceId, number>> = { 'bma-floodcam': 3 }

const HOUR_MS = 3_600_000

export interface CameraCatalogDeps {
  store: Store
  config: AppConfig
  fetch: typeof fetch
  now?: () => Date
  log?: (msg: string) => void
  signal?: AbortSignal
  /** Injectable sleep (DWR spaces its station lookups ~200 ms apart). */
  sleep?: (ms: number) => Promise<void>
  /** Adapters to use instead of the configured ones (tests). */
  adapters?: CameraCatalogAdapter[]
}

export interface CameraCatalogReport {
  source: CameraSourceId
  ok: boolean
  count: number
  skipped?: boolean
  error?: string
  warnings?: string[]
}

interface CatalogIndex {
  version: string
  fetchedAt: string
  joinedAt: string
  joinKey: string
  count: number
  /** This host fetched the list itself and holds its refs. */
  local: boolean
}

interface ShrinkTrack {
  count: number
  firstSeenAt: string
  seen: number
}

interface CatalogStatus {
  /** Last refresh attempted by this host (relayed lists do not count). */
  lastAttemptAt: string | null
  /** Last time a list was saved (fetched here or relayed). */
  lastSuccessAt: string | null
  lastError: string | null
  /** Consecutive failed local refreshes (drives the retry backoff). */
  failures: number
  shrink: ShrinkTrack | null
}

interface StoredCatalog extends CameraCatalog {
  joinedAt: string
}

interface StoredRefs {
  fetchedAt: string
  refs: CameraRef[]
}

const EMPTY_STATUS: CatalogStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, failures: 0, shrink: null }

// --- small helpers ------------------------------------------------------------------------

export function isCameraSourceId(v: unknown): v is CameraSourceId {
  return typeof v === 'string' && (CAMERA_SOURCE_IDS as readonly string[]).includes(v)
}

function sourceOfCameraId(cameraId: string): CameraSourceId | null {
  const i = cameraId.indexOf(':')
  const source = i > 0 ? cameraId.slice(0, i) : ''
  return isCameraSourceId(source) && NATIVE_ID_RE.test(cameraId.slice(i + 1)) ? source : null
}

function versionOf(fetchedAt: string, joinedAt: string): string {
  return `${fetchedAt}|${joinedAt}`
}

function validIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function hoursSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : (now.getTime() - t) / HOUR_MS
}

function refreshHoursOf(source: CameraSourceId): number {
  return CAMERA_ADAPTERS[source]?.refreshHours ?? 24
}

async function readJsonMeta<T>(store: Store, key: string): Promise<T | null> {
  const raw = await store.getMeta(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readIndex(store: Store, source: CameraSourceId): Promise<CatalogIndex | null> {
  const ix = await readJsonMeta<CatalogIndex>(store, INDEX_META_PREFIX + source)
  return ix && typeof ix.version === 'string' && typeof ix.fetchedAt === 'string' ? ix : null
}

async function readStatus(store: Store, source: CameraSourceId): Promise<CatalogStatus> {
  const st = await readJsonMeta<Partial<CatalogStatus>>(store, STATUS_META_PREFIX + source)
  return { ...EMPTY_STATUS, ...(st ?? {}) }
}

async function updateStatus(store: Store, source: CameraSourceId, fn: (s: CatalogStatus) => CatalogStatus): Promise<void> {
  await store.setMeta(STATUS_META_PREFIX + source, JSON.stringify(fn(await readStatus(store, source))))
}

const OFFICIAL_HOSTS: Record<CameraSourceId, string | null> = {
  'bma-floodcam': 'floodbangkok.bangkok.go.th',
  'dwr-cctv': 'telemetry.dwr.go.th',
  'demo-cam': null, // same-origin page
}
const DEFAULT_PAGES: Record<CameraSourceId, string> = {
  'bma-floodcam': 'https://floodbangkok.bangkok.go.th/',
  'dwr-cctv': 'https://telemetry.dwr.go.th/reportCctv',
  'demo-cam': '/about',
}

/** Official page links are rendered in the UI: https on the agency's own host only. */
function safeOfficialUrl(source: CameraSourceId, v: unknown): string {
  if (typeof v === 'string' && v.length <= 500) {
    const host = OFFICIAL_HOSTS[source]
    if (host === null) {
      if (/^\/(?!\/)[A-Za-z0-9/_#?=&.-]*$/.test(v)) return v
    } else {
      try {
        const u = new URL(v)
        if (u.protocol === 'https:' && u.hostname === host && !u.username && !u.password) return u.toString()
      } catch {
        // fall through to the default page
      }
    }
  }
  return DEFAULT_PAGES[source]
}

function shortText(v: unknown, max: number): string | null {
  const s = cleanName(v)
  return s ? s.slice(0, max) : null
}

/**
 * Public camera fields only, validated (allowlist; unknown keys such as an upstream ref are
 * dropped). Null when the camera is unusable.
 */
export function sanitizeCamera(source: CameraSourceId, raw: unknown): Camera | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const nativeId = typeof c.nativeId === 'string' && NATIVE_ID_RE.test(c.nativeId) ? c.nativeId : null
  if (!nativeId || c.source !== source || c.id !== `${source}:${nativeId}`) return null
  const lat = c.lat
  const lng = c.lng
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || !isInThailand(lat, lng)) return null
  const name = shortText(c.name, 300)
  if (!name) return null
  const facing = c.facing === 'water' || c.facing === 'road' ? c.facing : 'unknown'
  const cadence = typeof c.cadenceMin === 'number' && Number.isFinite(c.cadenceMin) && c.cadenceMin > 0 && c.cadenceMin <= 1440 ? c.cadenceMin : null
  const siteId = typeof c.siteId === 'string' && c.siteId.startsWith(`${source}:`) && c.siteId.length <= 100 ? c.siteId : siteIdFor(source, lat, lng)
  const near = Array.isArray(c.nearStationIds)
    ? c.nearStationIds.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, 20)
    : []
  return {
    id: `${source}:${nativeId}`,
    source,
    nativeId,
    siteId,
    name,
    code: shortText(c.code, 100),
    angle: shortText(c.angle, 40),
    owner: shortText(c.owner, 200) ?? CAMERA_ADAPTERS[source].label,
    lat,
    lng,
    facing,
    nearStationIds: near,
    officialUrl: safeOfficialUrl(source, c.officialUrl),
    cadenceMin: cadence,
  }
}

/** Public part of a catalogue (what a relay may push): allowlisted camera fields, never refs. */
export function publicCatalog(catalog: CameraCatalog | CameraCatalogResult): CameraCatalog {
  const cameras = catalog.cameras.map((c) => sanitizeCamera(catalog.source, c)).filter((c): c is Camera => !!c)
  return { source: catalog.source, fetchedAt: catalog.fetchedAt, cameras }
}

// --- reading (memory-cached per store, keyed by version) ---------------------------------

interface CatalogCacheEntry {
  version: string
  catalog: CameraCatalog
  byId: Map<string, Camera>
}

const catalogCache = new WeakMap<Store, Map<CameraSourceId, CatalogCacheEntry>>()
const refsCache = new WeakMap<Store, Map<CameraSourceId, { fetchedAt: string; refs: Map<string, string> }>>()

function cacheFor<V>(map: WeakMap<Store, Map<CameraSourceId, V>>, store: Store): Map<CameraSourceId, V> {
  let m = map.get(store)
  if (!m) map.set(store, (m = new Map()))
  return m
}

async function loadEntry(store: Store, source: CameraSourceId): Promise<CatalogCacheEntry | null> {
  const index = await readIndex(store, source)
  if (!index) return null
  const cache = cacheFor(catalogCache, store)
  const hit = cache.get(source)
  if (hit && hit.version === index.version) return hit
  const stored = await readJsonMeta<StoredCatalog>(store, CATALOG_META_PREFIX + source)
  if (!stored || stored.source !== source || !Array.isArray(stored.cameras) || typeof stored.fetchedAt !== 'string') return null
  const catalog: CameraCatalog = { source, fetchedAt: stored.fetchedAt, cameras: stored.cameras }
  const entry: CatalogCacheEntry = {
    version: versionOf(stored.fetchedAt, String(stored.joinedAt)),
    catalog,
    byId: new Map(stored.cameras.map((c) => [c.id, c])),
  }
  cache.set(source, entry)
  return entry
}

/**
 * Stored catalogues for the given sources (missing ones omitted); memory-cached by version.
 * The returned objects are shared: treat them as read-only.
 */
export async function loadCameraCatalogs(store: Store, sources: readonly CameraSourceId[]): Promise<CameraCatalog[]> {
  const unique = [...new Set(sources)].filter(isCameraSourceId)
  const entries = await Promise.all(unique.map((s) => loadEntry(store, s)))
  return entries.filter((e): e is CatalogCacheEntry => !!e).map((e) => e.catalog)
}

/** One camera from the stored catalogue (read-only), or null. */
export async function findCamera(store: Store, cameraId: string): Promise<Camera | null> {
  const source = sourceOfCameraId(cameraId)
  if (!source) return null
  return (await loadEntry(store, source))?.byId.get(cameraId) ?? null
}

async function loadRefs(store: Store, source: CameraSourceId): Promise<Map<string, string> | null> {
  const index = await readIndex(store, source)
  if (!index?.local) return null
  const cache = cacheFor(refsCache, store)
  const hit = cache.get(source)
  if (hit && hit.fetchedAt === index.fetchedAt) return hit.refs
  const stored = await readJsonMeta<StoredRefs>(store, REFS_META_PREFIX + source)
  if (!stored || !Array.isArray(stored.refs) || stored.fetchedAt !== index.fetchedAt) return null
  const refs = new Map<string, string>()
  for (const r of stored.refs) if (typeof r?.cameraId === 'string' && typeof r.ref === 'string' && r.ref) refs.set(r.cameraId, r.ref)
  cache.set(source, { fetchedAt: stored.fetchedAt, refs })
  return refs
}

/** Server-only upstream reference for a camera id, or null when this host has none. */
export async function getCameraRef(store: Store, cameraId: string): Promise<string | null> {
  const source = sourceOfCameraId(cameraId)
  if (!source) return null
  return (await loadRefs(store, source))?.get(cameraId) ?? null
}

/** True when this host holds image references for the source (it fetched the list itself). */
export async function hasCameraRefs(store: Store, source: CameraSourceId): Promise<boolean> {
  if (!isCameraSourceId(source)) return false
  return ((await loadRefs(store, source))?.size ?? 0) > 0
}

/**
 * Catalogue state for /api/health: when each list was fetched, how many cameras, and the last
 * refresh error (null once a list was saved since). Cheap (small meta keys only); never throws.
 */
export async function cameraCatalogHealth(
  store: Store,
  sources: readonly CameraSourceId[],
): Promise<{ source: CameraSourceId; catalogAt: string | null; count: number; lastError: string | null }[]> {
  return Promise.all(
    sources.map(async (source) => {
      try {
        const [index, status] = await Promise.all([readIndex(store, source), readStatus(store, source)])
        return { source, catalogAt: index?.fetchedAt ?? null, count: index?.count ?? 0, lastError: status.lastError }
      } catch {
        return { source, catalogAt: null, count: 0, lastError: 'อ่านสถานะรายการกล้องไม่ได้' }
      }
    }),
  )
}

// --- writing ---------------------------------------------------------------------------------

type RefuseReason = 'invalid' | 'empty' | 'older' | 'local-fresh' | 'shrink'

interface WriteResult {
  saved: boolean
  warning: string | null
  reason?: RefuseReason
}

function refuse(reason: RefuseReason, warning: string): WriteResult {
  return { saved: false, warning, reason }
}

async function writeCatalog(
  store: Store,
  input: CameraCatalog | CameraCatalogResult,
  now: Date,
  opts: { force?: boolean; stations?: Station[] } = {},
): Promise<WriteResult> {
  const source = input?.source
  if (!isCameraSourceId(source)) return refuse('invalid', 'unknown camera source')
  const fetchedAt = validIso(input.fetchedAt)
  if (!fetchedAt) return refuse('invalid', `${source}: invalid fetchedAt`)
  // A clock-skewed relay must not pin a list as "fresh" for longer than its period.
  if (Date.parse(fetchedAt) > now.getTime() + MAX_FUTURE_SKEW_MS) return refuse('invalid', `${source}: fetchedAt is in the future`)
  const local = 'refs' in input && Array.isArray(input.refs)
  const seen = new Set<string>()
  const cameras: Camera[] = []
  for (const raw of Array.isArray(input.cameras) ? input.cameras : []) {
    const c = sanitizeCamera(source, raw)
    if (c && !seen.has(c.id)) {
      seen.add(c.id)
      cameras.push(c)
    }
  }
  if (cameras.length === 0) return refuse('empty', `${source}: empty camera list; kept the previous list`)

  const prev = await readIndex(store, source)
  if (prev) {
    if (!local && prev.local && hoursSince(prev.fetchedAt, now) < refreshHoursOf(source)) {
      return refuse('local-fresh', `${source}: relayed list ignored; this server fetched its own list at ${prev.fetchedAt}`)
    }
    if (Date.parse(fetchedAt) < Date.parse(prev.fetchedAt)) {
      return refuse('older', `${source}: list from ${fetchedAt} is older than the stored one`)
    }
    if (!opts.force && prev.count > 0 && cameras.length < prev.count * MIN_KEEP_RATIO) {
      return refuse('shrink', `${source}: only ${cameras.length} of ${prev.count} cameras (< 50%); kept the previous list`)
    }
  }

  const stations = opts.stations ?? (await store.listStations())
  const joined = joinNearStations(cameras, stations)
  const joinedAt = now.toISOString()
  // Refs first, then the list, then the index (the commit point readers check).
  if (local) {
    const ids = new Set(joined.map((c) => c.id))
    const refs = (input as CameraCatalogResult).refs
      .filter((r) => ids.has(r?.cameraId) && typeof r.ref === 'string' && r.ref.length > 0 && r.ref.length <= 1024)
      .map((r) => ({ cameraId: r.cameraId, ref: r.ref }))
    await store.setMeta(REFS_META_PREFIX + source, JSON.stringify({ fetchedAt, refs } satisfies StoredRefs))
  } else {
    // A relayed list replaces ours: our refs no longer describe it.
    await store.setMeta(REFS_META_PREFIX + source, '')
  }
  await store.setMeta(CATALOG_META_PREFIX + source, JSON.stringify({ source, fetchedAt, joinedAt, cameras: joined } satisfies StoredCatalog))
  const index: CatalogIndex = {
    version: versionOf(fetchedAt, joinedAt),
    fetchedAt,
    joinedAt,
    joinKey: stationJoinKey(stations),
    count: joined.length,
    local,
  }
  await store.setMeta(INDEX_META_PREFIX + source, JSON.stringify(index))
  await updateStatus(store, source, (s) => ({ ...s, lastSuccessAt: joinedAt, lastError: null, failures: 0, shrink: null }))
  return { saved: true, warning: null }
}

/**
 * Persist a catalogue. `refs` present ⇒ stored server-side too (this host fetched the list);
 * absent (relayed) ⇒ any refs are dropped and the source becomes link-only here. Refused:
 * an empty list, a list older than the stored one, a relayed list while this host's own list is
 * still fresh, and a list with fewer than half the previous cameras (partial responses must never
 * wipe the catalogue; the first save is always accepted). Stations are joined at save time.
 */
export async function saveCameraCatalog(
  store: Store,
  catalog: CameraCatalog | CameraCatalogResult,
  now: Date = new Date(),
): Promise<{ saved: boolean; warning: string | null }> {
  const { saved, warning } = await writeCatalog(store, catalog, now)
  return { saved, warning }
}

/** Record a refresh failure reported by a relay (does not change this host's own retry backoff). */
export async function recordCameraCatalogFailure(store: Store, source: CameraSourceId, error: string): Promise<void> {
  if (!isCameraSourceId(source)) return
  await updateStatus(store, source, (s) => ({ ...s, lastError: `relay: ${redactSecrets(error)}` }))
}

/** Recompute nearStationIds of a stored list (stations changed); keeps fetchedAt and refs. */
async function rejoin(store: Store, source: CameraSourceId, index: CatalogIndex, stations: Station[], now: Date): Promise<boolean> {
  const stored = await readJsonMeta<StoredCatalog>(store, CATALOG_META_PREFIX + source)
  if (!stored || !Array.isArray(stored.cameras) || stored.fetchedAt !== index.fetchedAt) return false
  const joinedAt = now.toISOString()
  const cameras = joinNearStations(stored.cameras, stations)
  await store.setMeta(CATALOG_META_PREFIX + source, JSON.stringify({ ...stored, joinedAt, cameras } satisfies StoredCatalog))
  await store.setMeta(
    INDEX_META_PREFIX + source,
    JSON.stringify({ ...index, version: versionOf(stored.fetchedAt, joinedAt), joinedAt, joinKey: stationJoinKey(stations) } satisfies CatalogIndex),
  )
  return true
}

// --- scheduling ------------------------------------------------------------------------------

export interface DueInput {
  source: CameraSourceId
  refreshHours: number
  thaiIpOnly: boolean
  /** fetchedAt of the stored list (null = none). */
  fetchedAt: string | null
  /** The stored list was fetched by this host. */
  local: boolean
  lastAttemptAt: string | null
  failures: number
  now: Date
}

/** Hours to wait after `failures` consecutive failed refreshes: 1, 2, 4 … capped at refreshHours. */
export function failureBackoffHours(failures: number, refreshHours: number): number {
  return failures > 0 ? Math.min(refreshHours, 2 ** (failures - 1)) : 0
}

/**
 * Is a refresh due? Missing or older than refreshHours (with failure backoff); daily lists also
 * refresh at their preferred Bangkok hour once half a period old. A list relayed from elsewhere
 * is refetched locally once per period when the upstream is not Thai-IP-only (this host may
 * then serve its images).
 */
export function catalogDue(p: DueInput): boolean {
  const age = hoursSince(p.fetchedAt, p.now)
  const sinceAttempt = hoursSince(p.lastAttemptAt, p.now)
  if (sinceAttempt < failureBackoffHours(p.failures, p.refreshHours)) return false
  if (age >= p.refreshHours) return true
  const preferred = PREFERRED_HOUR_BKK[p.source]
  if (preferred !== undefined && age >= p.refreshHours / 2 && sinceAttempt >= 1 && (p.now.getUTCHours() + 7) % 24 === preferred) return true
  if (!p.local && !p.thaiIpOnly) return sinceAttempt >= p.refreshHours
  return false
}

function describeError(err: unknown, thaiIpOnly: boolean): string {
  let text =
    err instanceof Error
      ? err.name === 'TimeoutError'
        ? 'timeout'
        : err.name === 'AbortError'
          ? 'aborted'
          : err.message
      : String(err)
  text = redactSecrets(text)
  if (thaiIpOnly && /timeout|ECONNRESET|ETIMEDOUT|fetch failed|403|HTML/i.test(text)) text += ' (แหล่งข้อมูลนี้รับเฉพาะ IP ในประเทศไทย)'
  return text
}

/** Accept a smaller list after it came back consistently (±10%) for a day. */
function shrinkAccepted(status: CatalogStatus, count: number, now: Date): boolean {
  const s = status.shrink
  return !!s && Math.abs(count - s.count) <= s.count * 0.1 && s.seen + 1 >= SHRINK_ACCEPT_SEEN && hoursSince(s.firstSeenAt, now) >= SHRINK_ACCEPT_AFTER_H
}

function nextShrink(status: CatalogStatus, count: number, now: Date): ShrinkTrack {
  const s = status.shrink
  if (s && Math.abs(count - s.count) <= s.count * 0.1) return { ...s, seen: s.seen + 1 }
  return { count, firstSeenAt: now.toISOString(), seen: 1 }
}

async function refreshOne(
  deps: CameraCatalogDeps,
  adapter: CameraCatalogAdapter,
  now: Date,
  signal: AbortSignal,
  stations: () => Promise<Station[]>,
  force: boolean,
): Promise<CameraCatalogReport> {
  const { store } = deps
  const source = adapter.id
  let count = 0
  try {
    const [index, status] = await Promise.all([readIndex(store, source), readStatus(store, source)])
    count = index?.count ?? 0
    const due =
      force ||
      catalogDue({
        source,
        refreshHours: adapter.refreshHours,
        thaiIpOnly: adapter.thaiIpOnly,
        fetchedAt: index?.fetchedAt ?? null,
        local: index?.local ?? false,
        lastAttemptAt: status.lastAttemptAt,
        failures: status.failures,
        now,
      })
    if (!due) {
      if (index) {
        const st = await stations()
        if (stationJoinKey(st) !== index.joinKey && (await rejoin(store, source, index, st, now))) {
          deps.log?.(`[cctv] ${source}: stations changed, camera join refreshed`)
        }
      }
      return { source, ok: true, count, skipped: true }
    }
    if (signal.aborted) return { source, ok: false, count, skipped: true, error: 'aborted' }

    await updateStatus(store, source, (s) => ({ ...s, lastAttemptAt: now.toISOString() }))
    let result: CameraCatalogResult
    try {
      result = await adapter.fetchCatalog({ fetch: deps.fetch, now, timeoutMs: deps.config.FETCH_TIMEOUT_MS, signal, sleep: deps.sleep })
    } catch (err) {
      const error = describeError(err, adapter.thaiIpOnly)
      await updateStatus(store, source, (s) => ({ ...s, lastError: error, failures: s.failures + 1 }))
      deps.log?.(`[cctv] ${source} FAILED: ${error}`)
      return { source, ok: false, count, error }
    }
    const warnings = result.warnings.map(redactSecrets)
    const written = await writeCatalog(store, result, now, {
      force: shrinkAccepted(status, result.cameras.length, now),
      stations: await stations(),
    })
    if (written.saved) {
      const sites = new Set(result.cameras.map((c) => c.siteId)).size
      deps.log?.(`[cctv] ${source}: ${result.cameras.length} camera(s) at ${sites} site(s)${warnings.length ? ` (${warnings.join('; ')})` : ''}`)
      return { source, ok: true, count: result.cameras.length, warnings }
    }
    const error = written.warning ?? 'not saved'
    await updateStatus(store, source, (s) => ({
      ...s,
      lastError: error,
      failures: s.failures + 1,
      shrink: written.reason === 'shrink' ? nextShrink(s, result.cameras.length, now) : s.shrink,
    }))
    deps.log?.(`[cctv] ${source}: ${error}`)
    return { source, ok: false, count, error, warnings }
  } catch (err) {
    const error = describeError(err, false)
    deps.log?.(`[cctv] ${source} refresh error: ${error}`)
    return { source, ok: false, count, error }
  }
}

const inflight = new WeakMap<Store, Promise<CameraCatalogReport[]>>()

/**
 * Refresh the enabled catalogues that are due (or all with `force`). Never throws; a failed
 * refresh keeps the last good list. Concurrent calls for one store share a single run.
 */
export async function refreshCameraCatalogs(deps: CameraCatalogDeps, opts: { force?: boolean } = {}): Promise<CameraCatalogReport[]> {
  const running = inflight.get(deps.store)
  if (running) return running
  // .finally runs in a later microtask, so the entry is always set before it is removed.
  const run = refreshAll(deps, !!opts.force).finally(() => inflight.delete(deps.store))
  inflight.set(deps.store, run)
  return run
}

async function refreshAll(deps: CameraCatalogDeps, force: boolean): Promise<CameraCatalogReport[]> {
  try {
    const adapters = deps.adapters ?? getCameraSources(deps.config)
    if (adapters.length === 0) return []
    const now = deps.now?.() ?? new Date()
    const deadline = AbortSignal.timeout(CATALOG_REFRESH_DEADLINE_MS)
    const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline
    let stationsP: Promise<Station[]> | null = null
    const stations = () => (stationsP ??= deps.store.listStations())
    // Different upstream hosts: run side by side.
    return await Promise.all(adapters.map((a) => refreshOne(deps, a, now, signal, stations, force)))
  } catch (err) {
    deps.log?.(`[cctv] refresh error: ${describeError(err, false)}`)
    return []
  }
}
