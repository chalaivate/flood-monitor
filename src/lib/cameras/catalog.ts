import { hostname } from 'node:os'
import type { AppConfig } from '../config'
import { isInThailand } from '../geo'
import { CAMERA_ADAPTERS, getCameraSources } from '../sources/cameras'
import { cleanName, NATIVE_ID_RE, redactSecrets, siteIdFor } from '../sources/cameras/common'
import type { CameraCatalogAdapter } from '../sources/cameras/types'
import type { Store } from '../store/types'
import { CAMERA_SOURCE_IDS } from '../types'
import type { Camera, CameraCatalog, CameraCatalogResult, CameraRef, CameraSourceId, Station } from '../types'
import { joinNearStations, MAX_NEAR_STATIONS, stationJoinKey } from './join'

// Camera catalogues: stored in Store meta (public part and server-only refs under separate
// keys), refreshed by the poller when due, joined to nearby stations when saved.
//
// Meta keys per source:
//   cctv:catalog:<src>  public list {source, fetchedAt, joinedAt, cameras}        (~200 KB for BMA)
//   cctv:refs:<src>     server-only {fetchedAt, refs}; '' when this host did not fetch the list
//   cctv:index:<src>    small index {version, fetchedAt, joinedAt, joinKey, count, local}; written
//                       last, so it is the commit point readers check before the big list
//   cctv:status:<src>   refresh bookkeeping {lastAttemptAt, lastSuccessAt, lastError, failures, shrink,
//                       hosts}; `hosts` keeps attempts per host for Thai-IP-only sources
// Refs (BMA LiveStream addresses, DDS image numbers, DWR snapshot ids) never leave this module
// except through getCameraRef(); they are never logged, relayed or put into an API response.

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
/** A list at least this old is refetched in its preferred hour (so any fetch time drifts there). */
const DRIFT_MIN_AGE_H = 1
/** Hosts whose attempts are remembered per Thai-IP-only source (most recent first). */
const MAX_TRACKED_HOSTS = 8

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
  /**
   * Leave Thai-IP-only sources alone (hosts that may run outside Thailand, e.g. /api/cron/poll on
   * serverless): their lists are kept and shown, but only a Thai host refreshes them.
   */
  skipThaiIpOnly?: boolean
  /** Identifies this host in the per-host attempt bookkeeping (default: the OS hostname). */
  hostId?: string
  /** Whole-refresh deadline (default CATALOG_REFRESH_DEADLINE_MS; tests). */
  deadlineMs?: number
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
  /** Distinct lists (by fetchedAt) seen with about this count. */
  seen: number
  /** fetchedAt of the last one counted: a list re-sent unchanged is not a new sighting. */
  lastFetchedAt?: string
}

interface HostAttempt {
  lastAttemptAt: string | null
  failures: number
}

interface CatalogStatus {
  /** Last local refresh attempt (relayed lists do not count); any host for Thai-IP-only sources. */
  lastAttemptAt: string | null
  /** Last time a list was saved (fetched here or relayed). */
  lastSuccessAt: string | null
  lastError: string | null
  /** Consecutive failed local refreshes (drives the retry backoff, except for Thai-IP-only sources). */
  failures: number
  shrink: ShrinkTrack | null
  /**
   * Thai-IP-only sources: attempts and backoff per host. A store can be shared (Supabase), and a
   * host that cannot reach the source must never hold back the Thai host that can.
   */
  hosts?: Record<string, HostAttempt>
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
  'bma-ddscam': 'dds.bangkok.go.th',
  'dwr-cctv': 'telemetry.dwr.go.th',
  'demo-cam': null, // same-origin page
}
const DEFAULT_PAGES: Record<CameraSourceId, string> = {
  'bma-floodcam': 'https://floodbangkok.bangkok.go.th/',
  'bma-ddscam': 'https://dds.bangkok.go.th/cctv.php',
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
 * refresh error (null once a list was saved since; a relayed list this server refused shows as
 * "relay: …"). Cheap (small meta keys only); never throws.
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

/**
 * Station join for one source: stations by distance, plus the ones the source's own table pins
 * to a camera (DDS), first, when they exist in `stations`.
 */
function joinCameras(source: CameraSourceId, cameras: readonly Camera[], stations: readonly Station[]): Camera[] {
  const joined = joinNearStations(cameras, stations)
  const pinned = CAMERA_ADAPTERS[source]?.pinnedStationIds
  if (!pinned) return joined
  const known = new Set(stations.map((s) => s.id))
  return joined.map((c) => {
    const extra = pinned(c.nativeId).filter((id) => known.has(id) && !c.nearStationIds.includes(id))
    return extra.length ? { ...c, nearStationIds: [...extra, ...c.nearStationIds].slice(0, MAX_NEAR_STATIONS) } : c
  })
}

/** Why a list was not saved. */
export type CatalogRefuseReason = 'invalid' | 'empty' | 'older' | 'local-fresh' | 'shrink'
type RefuseReason = CatalogRefuseReason

interface WriteResult {
  saved: boolean
  warning: string | null
  reason?: RefuseReason
  /** Valid cameras in the list offered. */
  count: number
}

function refuse(reason: RefuseReason, warning: string, count = 0): WriteResult {
  return { saved: false, warning, reason, count }
}

interface WriteOptions {
  stations?: Station[]
  /** Status read before the write: a smaller list that kept coming back is accepted (see shrinkAccepted). */
  shrink?: CatalogStatus
  /** The list is a table in code (CameraCatalogAdapter.staticList): never refused as shrunk. */
  staticList?: boolean
  /** Extra status changes saved with a successful write. */
  onSaved?: (s: CatalogStatus) => CatalogStatus
}

async function writeCatalog(store: Store, input: CameraCatalog | CameraCatalogResult, now: Date, opts: WriteOptions = {}): Promise<WriteResult> {
  const source = input?.source
  if (!isCameraSourceId(source)) return refuse('invalid', 'unknown camera source')
  const fetchedAt = validIso(input.fetchedAt)
  if (!fetchedAt) return refuse('invalid', `${source}: invalid fetchedAt`)
  // A clock-skewed relay must not pin a list as "fresh" for longer than its period.
  if (Date.parse(fetchedAt) > now.getTime() + MAX_FUTURE_SKEW_MS) return refuse('invalid', `${source}: fetchedAt is in the future (check the sender's clock)`)
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

  const n = cameras.length
  const prev = await readIndex(store, source)
  if (prev) {
    if (!local && prev.local && hoursSince(prev.fetchedAt, now) < refreshHoursOf(source)) {
      return refuse('local-fresh', `${source}: relayed list ignored; this server fetched its own list at ${prev.fetchedAt}`, n)
    }
    if (Date.parse(fetchedAt) < Date.parse(prev.fetchedAt)) {
      return refuse('older', `${source}: list from ${fetchedAt} is older than the stored one`, n)
    }
    // The guard is for partial upstream answers; a list from code is complete by definition.
    const accepted = opts.staticList || (opts.shrink ? shrinkAccepted(opts.shrink, n, fetchedAt, now) : false)
    if (!accepted && prev.count > 0 && n < prev.count * MIN_KEEP_RATIO) {
      return refuse('shrink', `${source}: only ${n} of ${prev.count} cameras (< 50%); kept the previous list until the smaller list repeats for ${SHRINK_ACCEPT_AFTER_H} h`, n)
    }
  }

  const stations = opts.stations ?? (await store.listStations())
  const joined = joinCameras(source, cameras, stations)
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
  const onSaved = opts.onSaved ?? ((s: CatalogStatus) => s)
  await updateStatus(store, source, (s) => onSaved({ ...s, lastSuccessAt: joinedAt, lastError: null, failures: 0, shrink: null }))
  return { saved: true, warning: null, count: joined.length }
}

/** Refusals that mean "the sender has a problem" and so show in /api/health. */
const REPORTED_REFUSALS: ReadonlySet<RefuseReason> = new Set(['invalid', 'empty', 'shrink'])

export interface SaveCatalogResult {
  saved: boolean
  warning: string | null
  /** Set when the list was refused. */
  reason?: CatalogRefuseReason
}

/**
 * Persist a catalogue. `refs` present ⇒ stored server-side too (this host fetched the list);
 * absent (relayed) ⇒ any refs are dropped and the source becomes link-only here. Refused:
 * an empty list, a list older than the stored one, a relayed list while this host's own list is
 * still fresh, and a list with fewer than half the previous cameras (partial responses must never
 * wipe the catalogue; the first save is always accepted). A smaller list is still accepted once
 * it has come back ≥ 3 times (distinct fetches) over ≥ 24 h, as for a local refresh. Refusals
 * that point at a problem (invalid, empty, shrink) are kept as lastError, so /api/health shows
 * them; this host's own retry backoff is never touched. Stations are joined at save time.
 */
export async function saveCameraCatalog(
  store: Store,
  catalog: CameraCatalog | CameraCatalogResult,
  now: Date = new Date(),
): Promise<SaveCatalogResult> {
  const source = catalog?.source
  const status = isCameraSourceId(source) ? await readStatus(store, source) : undefined
  const written = await writeCatalog(store, catalog, now, { shrink: status })
  if (written.saved) return { saved: true, warning: null }
  if (isCameraSourceId(source) && written.reason && REPORTED_REFUSALS.has(written.reason)) {
    const relayed = !('refs' in catalog && Array.isArray(catalog.refs))
    const fetchedAt = validIso(catalog.fetchedAt)
    await updateStatus(store, source, (s) => ({
      ...s,
      lastError: `${relayed ? 'relay: ' : ''}${redactSecrets(written.warning ?? 'list refused')}`,
      shrink: written.reason === 'shrink' && fetchedAt ? nextShrink(s, written.count, fetchedAt, now) : s.shrink,
    }))
  }
  return { saved: false, warning: written.warning, ...(written.reason ? { reason: written.reason } : {}) }
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
  const cameras = joinCameras(source, stored.cameras, stations)
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
 * Is a refresh due? Missing or older than refreshHours (with failure backoff). Daily lists also
 * refresh in their preferred Bangkok hour once at least an hour old, so whenever a list was
 * first fetched, the schedule moves to that hour at the next window (one extra fetch that day).
 * A list relayed from elsewhere is refetched locally once per period when the upstream is not
 * Thai-IP-only (this host may then serve its images); a relayed Thai-IP-only list is left to the
 * Thai machine that sends it.
 */
export function catalogDue(p: DueInput): boolean {
  const age = hoursSince(p.fetchedAt, p.now)
  const sinceAttempt = hoursSince(p.lastAttemptAt, p.now)
  if (sinceAttempt < failureBackoffHours(p.failures, p.refreshHours)) return false
  if (!p.local && p.thaiIpOnly && p.fetchedAt !== null) return false
  if (age >= p.refreshHours) return true
  const preferred = PREFERRED_HOUR_BKK[p.source]
  if (preferred !== undefined && age >= DRIFT_MIN_AGE_H && sinceAttempt >= 1 && (p.now.getUTCHours() + 7) % 24 === preferred) return true
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

/** Accept a smaller list after it came back consistently (±10%, distinct fetches) for a day. */
function shrinkAccepted(status: CatalogStatus, count: number, fetchedAt: string, now: Date): boolean {
  const s = status.shrink
  if (!s || Math.abs(count - s.count) > s.count * 0.1) return false
  const seen = s.lastFetchedAt === fetchedAt ? s.seen : s.seen + 1
  return seen >= SHRINK_ACCEPT_SEEN && hoursSince(s.firstSeenAt, now) >= SHRINK_ACCEPT_AFTER_H
}

function nextShrink(status: CatalogStatus, count: number, fetchedAt: string, now: Date): ShrinkTrack {
  const s = status.shrink
  if (s && Math.abs(count - s.count) <= s.count * 0.1) {
    return s.lastFetchedAt === fetchedAt ? s : { ...s, seen: s.seen + 1, lastFetchedAt: fetchedAt }
  }
  return { count, firstSeenAt: now.toISOString(), seen: 1, lastFetchedAt: fetchedAt }
}

/** The OS hostname, cleaned (status keys); 'host' when unavailable. */
function defaultHostId(): string {
  try {
    return hostname()
  } catch {
    return 'host'
  }
}

function hostKey(hostId: string): string {
  return `h:${hostId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'host'}`
}

/** This host's attempts: its own entry for Thai-IP-only sources (host set), else the shared ones. */
function attemptOf(s: CatalogStatus, host: string | null): HostAttempt {
  if (host === null) return { lastAttemptAt: s.lastAttemptAt, failures: s.failures }
  const h = s.hosts && Object.hasOwn(s.hosts, host) ? s.hosts[host] : undefined
  return {
    lastAttemptAt: typeof h?.lastAttemptAt === 'string' ? h.lastAttemptAt : null,
    failures: typeof h?.failures === 'number' && Number.isInteger(h.failures) && h.failures > 0 ? h.failures : 0,
  }
}

/** Record an attempt (shared fields always; the host's own entry too when set). */
function withAttempt(s: CatalogStatus, host: string | null, a: HostAttempt): CatalogStatus {
  const next: CatalogStatus = { ...s, lastAttemptAt: a.lastAttemptAt, failures: a.failures }
  if (host === null) return next
  const time = (x: HostAttempt) => (x.lastAttemptAt ? Date.parse(x.lastAttemptAt) || 0 : 0)
  const hosts = Object.entries({ ...(s.hosts ?? {}), [host]: a })
    .sort(([, x], [, y]) => time(y) - time(x))
    .slice(0, MAX_TRACKED_HOSTS)
  return { ...next, hosts: Object.fromEntries(hosts) }
}

async function refreshOne(
  deps: CameraCatalogDeps,
  adapter: CameraCatalogAdapter,
  now: Date,
  signal: AbortSignal,
  stations: () => Promise<Station[]>,
  force: boolean,
  hostId: string,
  deadlineMs: number,
): Promise<CameraCatalogReport> {
  const { store } = deps
  const source = adapter.id
  // Thai-IP-only lists: attempts and backoff are kept per host (see CatalogStatus.hosts).
  const host = adapter.thaiIpOnly ? hostKey(hostId) : null
  let count = 0
  try {
    const [index, status] = await Promise.all([readIndex(store, source), readStatus(store, source)])
    count = index?.count ?? 0
    const mine = attemptOf(status, host)
    const due =
      force ||
      catalogDue({
        source,
        refreshHours: adapter.refreshHours,
        thaiIpOnly: adapter.thaiIpOnly,
        fetchedAt: index?.fetchedAt ?? null,
        local: index?.local ?? false,
        lastAttemptAt: mine.lastAttemptAt,
        failures: mine.failures,
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

    const attemptedAt = now.toISOString()
    let result: CameraCatalogResult
    try {
      // The list in use: DWR keeps a station's last known position when its lookup fails.
      const previous = index ? ((await loadEntry(store, source).catch(() => null))?.catalog ?? null) : null
      result = await adapter.fetchCatalog({ fetch: deps.fetch, now, timeoutMs: deps.config.FETCH_TIMEOUT_MS, signal, sleep: deps.sleep, previous })
    } catch (err) {
      if (deps.signal?.aborted) {
        // Stopped by the caller (shutdown or its own deadline), not by the upstream: nothing is
        // recorded (no backoff, no health error), so the next run refreshes straight away.
        deps.log?.(`[cctv] ${source}: refresh interrupted; retried on the next run`)
        return { source, ok: false, count, skipped: true, error: 'aborted' }
      }
      // Our own whole-refresh deadline is not a network symptom: no "Thai IP only" note.
      const error = signal.aborted ? `refresh took longer than ${deadlineMs / 1000} s` : describeError(err, adapter.thaiIpOnly)
      await updateStatus(store, source, (s) =>
        withAttempt({ ...s, lastError: error }, host, { lastAttemptAt: attemptedAt, failures: attemptOf(s, host).failures + 1 }),
      )
      deps.log?.(`[cctv] ${source} FAILED: ${error}`)
      return { source, ok: false, count, error }
    }
    const warnings = result.warnings.map(redactSecrets)
    let written: WriteResult
    try {
      written = await writeCatalog(store, result, now, {
        // A static list skips the shrink guard and its bookkeeping (a saved list clears it).
        ...(adapter.staticList ? { staticList: true } : { shrink: status }),
        stations: await stations(),
        onSaved: (s) => withAttempt(s, host, { lastAttemptAt: attemptedAt, failures: 0 }),
      })
    } catch (err) {
      // Could not store it: back off like a failed fetch rather than refetch every cycle.
      const error = `store failed: ${describeError(err, false)}`
      await updateStatus(store, source, (s) =>
        withAttempt({ ...s, lastError: error }, host, { lastAttemptAt: attemptedAt, failures: attemptOf(s, host).failures + 1 }),
      ).catch(() => undefined)
      deps.log?.(`[cctv] ${source}: ${error}`)
      return { source, ok: false, count, error, warnings }
    }
    if (written.saved) {
      const sites = new Set(result.cameras.map((c) => c.siteId)).size
      deps.log?.(`[cctv] ${source}: ${result.cameras.length} camera(s) at ${sites} site(s)${warnings.length ? ` (${warnings.join('; ')})` : ''}`)
      return { source, ok: true, count: result.cameras.length, warnings }
    }
    const error = written.warning ?? 'not saved'
    const fetchedAt = validIso(result.fetchedAt)
    await updateStatus(store, source, (s) =>
      withAttempt(
        {
          ...s,
          lastError: error,
          shrink: written.reason === 'shrink' && fetchedAt ? nextShrink(s, written.count, fetchedAt, now) : s.shrink,
        },
        host,
        { lastAttemptAt: attemptedAt, failures: attemptOf(s, host).failures + 1 },
      ),
    )
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
 * Refresh the enabled catalogues that are due (or all with `force`); with `skipThaiIpOnly`, only
 * those reachable from anywhere. Never throws; a failed refresh keeps the last good list.
 * Concurrent calls for one store share a single run.
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
    const configured = deps.adapters ?? getCameraSources(deps.config)
    const adapters = deps.skipThaiIpOnly ? configured.filter((a) => !a.thaiIpOnly) : configured
    if (adapters.length === 0) return []
    const now = deps.now?.() ?? new Date()
    const deadlineMs = deps.deadlineMs ?? CATALOG_REFRESH_DEADLINE_MS
    const deadline = AbortSignal.timeout(deadlineMs)
    const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline
    let stationsP: Promise<Station[]> | null = null
    const stations = () => (stationsP ??= deps.store.listStations())
    const hostId = deps.hostId ?? defaultHostId()
    // Different upstream hosts: run side by side.
    return await Promise.all(adapters.map((a) => refreshOne(deps, a, now, signal, stations, force, hostId, deadlineMs)))
  } catch (err) {
    deps.log?.(`[cctv] refresh error: ${describeError(err, false)}`)
    return []
  }
}
