import { getConfig } from '../config'
import type { WeatherNow } from '../types'
import { demoWeather } from '../sources/demo'
import { fetchOpenMeteo } from './openmeteo'

/**
 * Current weather + short forecast at a point. Returns null when the provider is unreachable
 * (callers should cache; see src/lib/server). DATA_MODE=fixture returns demo weather.
 */
export async function getWeather(
  lat: number,
  lng: number,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<WeatherNow | null> {
  const now = opts.now ?? new Date()
  if (getConfig().DATA_MODE === 'fixture') return demoWeather(lat, lng, now)
  try {
    return await fetchOpenMeteo(lat, lng, { fetch: opts.fetch ?? fetch, now })
  } catch {
    return null
  }
}
