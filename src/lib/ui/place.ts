import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { isValidLatLng } from '../geo'
import { usePublicConfig } from './public-config'

// Client-side "current place" resolution. Priority:
//   1. URL ?place=<id>                       (shared or manage link of a saved place)
//   2. URL ?lat=&lng=&label=(&r=&n=)         (shared coordinates)
//   3. localStorage 'fm-place'               (the user's home)
//   4. defaultPlace from GET /api/config/public
// The pure functions are unit-tested; the hook wires them to the browser.

export const PLACE_STORAGE_KEY = 'fm-place'
export const DEFAULT_RADIUS_KM = 3
export const DEFAULT_MAX_STATIONS = 4
export const RADIUS_MIN_KM = 0.5
export const RADIUS_MAX_KM = 20
export const STATIONS_MIN = 1
export const STATIONS_MAX = 8
export const FALLBACK_PLACE = { label: 'กรุงเทพมหานคร', lat: 13.7563, lng: 100.5018 }
const SHARED_LABEL = 'ตำแหน่งที่แชร์'
const PLACE_PARAMS = ['place', 'lat', 'lng', 'label', 'r', 'n'] as const

export interface StoredPlace {
  label: string
  lat: number
  lng: number
  radiusKm: number
  maxStations: number
  /** Server-side place id once alerts were set up on /alerts. */
  placeId?: string
  /** Secret token that manages the server-side place. Never put it in a URL query. */
  manageToken?: string
}

export type PlaceOrigin = 'url-id' | 'url' | 'storage' | 'default'

export interface ResolvedPlace {
  origin: PlaceOrigin
  label: string
  /** null only for a bare ?place=<id> link before the snapshot tells us the coordinates. */
  lat: number | null
  lng: number | null
  radiusKm: number
  maxStations: number
  placeId?: string
  manageToken?: string
}

export function clampRadius(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) return DEFAULT_RADIUS_KM
  return Math.round(Math.min(RADIUS_MAX_KM, Math.max(RADIUS_MIN_KM, n)) * 10) / 10
}

export function clampCount(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) return DEFAULT_MAX_STATIONS
  return Math.round(Math.min(STATIONS_MAX, Math.max(STATIONS_MIN, n)))
}

export function isPlaceId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v)
}

function cleanLabel(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.replace(/\s+/g, ' ').trim().slice(0, 80)
  return s || fallback
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return NaN
}

/** Parse the localStorage value; null when missing or malformed. */
export function parseStoredPlace(raw: string | null | undefined): StoredPlace | null {
  if (!raw) return null
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const lat = toNum(r.lat)
  const lng = toNum(r.lng)
  if (!isValidLatLng(lat, lng)) return null
  const out: StoredPlace = {
    label: cleanLabel(r.label, 'บ้าน'),
    lat,
    lng,
    radiusKm: clampRadius(r.radiusKm),
    maxStations: clampCount(r.maxStations),
  }
  if (isPlaceId(r.placeId)) out.placeId = r.placeId
  if (typeof r.manageToken === 'string' && r.manageToken.length >= 8 && r.manageToken.length <= 200) out.manageToken = r.manageToken
  return out
}

export type UrlPlace =
  | { kind: 'id'; placeId: string }
  | { kind: 'coords'; label: string; lat: number; lng: number; radiusKm: number; maxStations: number }

/** Read place parameters from a query string ("?a=b" or URLSearchParams). */
export function parsePlaceParams(search: string | URLSearchParams): UrlPlace | null {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search
  const id = q.get('place')
  if (isPlaceId(id)) return { kind: 'id', placeId: id }
  const lat = toNum(q.get('lat'))
  const lng = toNum(q.get('lng'))
  if (!isValidLatLng(lat, lng)) return null
  return {
    kind: 'coords',
    label: cleanLabel(q.get('label'), SHARED_LABEL),
    lat,
    lng,
    radiusKm: q.has('r') ? clampRadius(q.get('r')) : DEFAULT_RADIUS_KM,
    maxStations: q.has('n') ? clampCount(q.get('n')) : DEFAULT_MAX_STATIONS,
  }
}

export function resolvePlace(
  search: string,
  storedRaw: string | null,
  def: { label: string; lat: number; lng: number } | null | undefined,
): ResolvedPlace {
  const url = parsePlaceParams(search)
  const stored = parseStoredPlace(storedRaw)
  if (url?.kind === 'id') {
    if (stored?.placeId === url.placeId) return { ...stored, origin: 'url-id' }
    return {
      origin: 'url-id',
      placeId: url.placeId,
      label: 'จุดเฝ้าระวังที่แชร์',
      lat: null,
      lng: null,
      radiusKm: DEFAULT_RADIUS_KM,
      maxStations: DEFAULT_MAX_STATIONS,
    }
  }
  if (url?.kind === 'coords') {
    return {
      origin: 'url',
      label: url.label,
      lat: url.lat,
      lng: url.lng,
      radiusKm: url.radiusKm,
      maxStations: url.maxStations,
    }
  }
  if (stored) return { ...stored, origin: 'storage' }
  const d = def && isValidLatLng(def.lat, def.lng) ? def : FALLBACK_PLACE
  return {
    origin: 'default',
    label: cleanLabel(d.label, FALLBACK_PLACE.label),
    lat: d.lat,
    lng: d.lng,
    radiusKm: DEFAULT_RADIUS_KM,
    maxStations: DEFAULT_MAX_STATIONS,
  }
}

const fmtCoord = (v: number) => String(Math.round(v * 1e5) / 1e5)

/** Query string (without "?") for GET /api/snapshot. */
export function snapshotQuery(p: ResolvedPlace, opts: { preferCoords?: boolean } = {}): string {
  const q = new URLSearchParams()
  if (p.placeId && (!opts.preferCoords || p.lat === null || p.lng === null)) {
    q.set('place', p.placeId)
    return q.toString()
  }
  if (p.lat === null || p.lng === null) return ''
  q.set('lat', fmtCoord(p.lat))
  q.set('lng', fmtCoord(p.lng))
  q.set('label', p.label)
  q.set('r', String(p.radiusKm))
  q.set('n', String(p.maxStations))
  return q.toString()
}

/** Shareable link with coordinates (never the manage token). */
export function shareUrl(base: string, p: Pick<ResolvedPlace, 'label' | 'lat' | 'lng' | 'radiusKm' | 'maxStations' | 'placeId'>, path = '/'): string {
  const u = new URL(path, base)
  if (p.lat !== null && p.lng !== null) {
    u.searchParams.set('lat', fmtCoord(p.lat))
    u.searchParams.set('lng', fmtCoord(p.lng))
    u.searchParams.set('label', p.label)
    u.searchParams.set('r', String(p.radiusKm))
    u.searchParams.set('n', String(p.maxStations))
  } else if (p.placeId) {
    u.searchParams.set('place', p.placeId)
  }
  return u.toString()
}

/** Link that restores management of a saved place on another device. */
export function manageUrl(base: string, placeId: string, token: string): string {
  const u = new URL('/alerts', base)
  u.searchParams.set('place', placeId)
  u.hash = `token=${encodeURIComponent(token)}`
  return u.toString()
}

/** Read "#token=..." from a location hash. */
export function parseHashToken(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  const v = new URLSearchParams(h).get('token')
  return v && v.length >= 8 && v.length <= 200 ? v : null
}

/** Remove the place parameters from a query string; returns "" or "?rest". */
export function stripPlaceParams(search: string): string {
  const q = new URLSearchParams(search)
  for (const k of PLACE_PARAMS) q.delete(k)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function toStoredPlace(p: ResolvedPlace | StoredPlace): StoredPlace | null {
  if (p.lat === null || p.lng === null || !isValidLatLng(p.lat, p.lng)) return null
  const out: StoredPlace = {
    label: cleanLabel(p.label, 'บ้าน'),
    lat: p.lat,
    lng: p.lng,
    radiusKm: clampRadius(p.radiusKm),
    maxStations: clampCount(p.maxStations),
  }
  if (p.placeId) out.placeId = p.placeId
  if (p.manageToken) out.manageToken = p.manageToken
  return out
}

// --- browser store -----------------------------------------------------------

const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PLACE_STORAGE_KEY) cb()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('popstate', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('popstate', cb)
  }
}

export function readStoredRaw(): string | null {
  try {
    return window.localStorage.getItem(PLACE_STORAGE_KEY)
  } catch {
    return null
  }
}

export function readStoredPlace(): StoredPlace | null {
  return parseStoredPlace(readStoredRaw())
}

/** Inputs as one string so useSyncExternalStore compares by value. */
function getRawSnapshot(): string {
  return `${window.location.search}\u0000${readStoredRaw() ?? ''}`
}

function getServerSnapshot(): string | null {
  return null
}

/**
 * Save the user's place (localStorage) and drop place parameters from the URL
 * without reloading, so the saved place takes effect immediately.
 */
export function setPlace(next: StoredPlace | null): void {
  try {
    if (next) window.localStorage.setItem(PLACE_STORAGE_KEY, JSON.stringify(next))
    else window.localStorage.removeItem(PLACE_STORAGE_KEY)
  } catch {
    // Storage blocked (private mode): the URL still carries the place below.
  }
  const search = stripPlaceParams(window.location.search)
  let nextSearch = search
  if (next && readStoredRaw() === null) {
    // Storage unavailable: keep the place in the URL instead.
    const u = new URL(shareUrl(window.location.origin, next, window.location.pathname))
    nextSearch = u.search
  }
  const url = `${window.location.pathname}${nextSearch}${window.location.hash}`
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, '', url)
  }
  emit()
}

/** Merge fields into the stored place (e.g. placeId/manageToken after POST /api/places). */
export function updateStoredPlace(patch: Partial<StoredPlace>): StoredPlace | null {
  const cur = readStoredPlace()
  const merged = cur ? { ...cur, ...patch } : null
  const next = merged ? toStoredPlace(merged) : null
  if (next) {
    if (patch.placeId === undefined && 'placeId' in patch) delete next.placeId
    if (patch.manageToken === undefined && 'manageToken' in patch) delete next.manageToken
    try {
      window.localStorage.setItem(PLACE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
    emit()
  }
  return next
}

/** Force subscribers to re-read (after a manual history change). */
export function notifyPlaceChanged(): void {
  emit()
}

export interface UsePlace {
  /** null during SSR / before hydration. */
  place: ResolvedPlace | null
  /** false while the default place is still waiting for /api/config/public. */
  ready: boolean
  setPlace: (p: StoredPlace | null) => void
}

export function usePlace(): UsePlace {
  const raw = useSyncExternalStore(subscribe, getRawSnapshot, getServerSnapshot)
  const cfg = usePublicConfig()
  const def = cfg.config?.defaultPlace ?? null
  const place = useMemo(() => {
    if (raw === null) return null
    const i = raw.indexOf('\u0000')
    return resolvePlace(raw.slice(0, i), raw.slice(i + 1) || null, def)
  }, [raw, def])
  const ready = !!place && (place.origin !== 'default' || !!cfg.config || !!cfg.error)
  const set = useCallback((p: StoredPlace | null) => setPlace(p), [])
  return { place, ready, setPlace: set }
}
