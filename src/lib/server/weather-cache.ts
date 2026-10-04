import type { WeatherNow } from '../types'
import { getWeather } from '../weather'
import { LIMITS, rateLimiter } from './rate-limit'

// 10-minute cache in front of getWeather, keyed by a ~2 km grid cell so nearby
// homes share one upstream request. In-flight requests are shared too. Every upstream
// request goes through a server-wide budget; when it is spent (or the provider fails)
// the last good value is served, stale but labelled with its observation time by the UI.

export const WEATHER_TTL_MS = 10 * 60_000
/** Failures (null) are retried sooner so a provider blip does not hide weather for 10 min. */
export const WEATHER_NULL_TTL_MS = 2 * 60_000
/** How old a last good value may be and still be served when no fresh one can be had. */
export const WEATHER_STALE_MAX_MS = 60 * 60_000
const GRID = 0.02
const MAX_ENTRIES = 2000

interface Entry {
  /** When the current upstream request started. */
  at: number
  /** What callers get: the upstream result, or the stale fallback when it failed. */
  value: Promise<WeatherNow | null>
  /** Raw upstream result (undefined while in flight, null on failure). */
  settled: WeatherNow | null | undefined
  /** Last successful upstream value for this cell, kept across refreshes. */
  good: WeatherNow | null
  goodAt: number
}

const g = globalThis as typeof globalThis & { __floodWeatherCache?: Map<string, Entry> }
const cache = (g.__floodWeatherCache ??= new Map<string, Entry>())

const snap = (v: number) => Number((Math.round(v / GRID) * GRID).toFixed(2))

/**
 * Centre of the 0.02° grid cell containing the point. Both the cache key and the
 * upstream request use it, so arbitrary coordinates cannot multiply upstream calls
 * beyond one per cell.
 */
export function snapToWeatherGrid(lat: number, lng: number): { lat: number; lng: number } {
  return { lat: snap(lat), lng: snap(lng) }
}

export function weatherKey(lat: number, lng: number): string {
  const p = snapToWeatherGrid(lat, lng)
  return `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`
}

/**
 * Budget check for one upstream weather request. Every request counts against the
 * server-wide `weather:*` budget (saved places included); ad-hoc map coordinates also
 * against their own smaller share, so map browsing cannot starve saved places.
 */
export function weatherBudget(kind: 'place' | 'adhoc'): () => boolean {
  if (kind === 'adhoc') {
    return () =>
      rateLimiter().takeAll([
        ['weather:adhoc:*', LIMITS.weatherAdHoc],
        ['weather:*', LIMITS.weatherUpstream],
      ]).ok
  }
  return () => rateLimiter().take('weather:*', LIMITS.weatherUpstream).ok
}

export interface WeatherCacheOptions {
  fetch?: typeof fetch
  now?: () => number
  /** Override for tests. */
  load?: typeof getWeather
  /**
   * Asked before an upstream request (cache miss or expired entry); false ⇒ no request:
   * the last good value (up to WEATHER_STALE_MAX_MS old) or null is returned and the cache
   * is left as it was. See weatherBudget().
   */
  allowUpstream?: () => boolean
}

export async function cachedWeather(lat: number, lng: number, opts: WeatherCacheOptions = {}): Promise<WeatherNow | null> {
  const now = opts.now?.() ?? Date.now()
  const key = weatherKey(lat, lng)
  const hit = cache.get(key)
  if (hit) {
    const ttl = hit.settled === null ? WEATHER_NULL_TTL_MS : WEATHER_TTL_MS
    if (now - hit.at < ttl) return hit.value
  }
  const stale = hit?.good && now - hit.goodAt <= WEATHER_STALE_MAX_MS ? hit.good : null
  if (opts.allowUpstream && !opts.allowUpstream()) return stale
  const { lat: glat, lng: glng } = snapToWeatherGrid(lat, lng)
  const load = opts.load ?? getWeather
  const entry: Entry = { at: now, settled: undefined, value: Promise.resolve(null), good: hit?.good ?? null, goodAt: hit?.goodAt ?? 0 }
  entry.value = load(glat, glng, { fetch: opts.fetch, now: new Date(now) })
    .catch(() => null)
    .then((v) => {
      entry.settled = v
      if (v) {
        entry.good = v
        entry.goodAt = now
        return v
      }
      return stale
    })
  // Re-insert so the Map's order is least recently refreshed first (eviction order).
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return entry.value
}

export function clearWeatherCache(): void {
  cache.clear()
}
