import type { WeatherNow } from '../types'
import { getWeather } from '../weather'

// 10-minute cache in front of getWeather, keyed by a ~2 km grid cell so nearby
// homes share one upstream request. In-flight requests are shared too.

export const WEATHER_TTL_MS = 10 * 60_000
/** Failures (null) are retried sooner so a provider blip does not hide weather for 10 min. */
export const WEATHER_NULL_TTL_MS = 2 * 60_000
const GRID = 0.02
const MAX_ENTRIES = 2000

interface Entry {
  at: number
  value: Promise<WeatherNow | null>
  settled: WeatherNow | null | undefined
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

export interface WeatherCacheOptions {
  fetch?: typeof fetch
  now?: () => number
  /** Override for tests. */
  load?: typeof getWeather
  /**
   * Asked before an upstream request (cache miss); false ⇒ no request, the result is null
   * and nothing is cached. Used to cap upstream calls for ad-hoc coordinates.
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
  if (opts.allowUpstream && !opts.allowUpstream()) return null
  const { lat: glat, lng: glng } = snapToWeatherGrid(lat, lng)
  const load = opts.load ?? getWeather
  const entry: Entry = { at: now, settled: undefined, value: Promise.resolve(null) }
  entry.value = load(glat, glng, { fetch: opts.fetch, now: new Date(now) })
    .catch(() => null)
    .then((v) => {
      entry.settled = v
      return v
    })
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
