import type { WeatherNow } from '../types'
import { requestJson } from '../sources/http'

// Open-Meteo forecast API (free, no key, reachable from cloud hosts).
// Docs: https://open-meteo.com/en/docs — data under CC BY 4.0, attribution required.

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'

/** WMO weather interpretation codes → Thai condition text. */
export function weatherCodeTh(code: number): string {
  switch (code) {
    case 0:
      return 'ท้องฟ้าแจ่มใส'
    case 1:
      return 'มีเมฆเล็กน้อย'
    case 2:
      return 'มีเมฆบางส่วน'
    case 3:
      return 'มีเมฆมาก'
    case 45:
    case 48:
      return 'มีหมอก'
    case 51:
    case 53:
    case 55:
    case 56:
    case 57:
      return 'ฝนละออง'
    case 61:
      return 'ฝนตกเล็กน้อย'
    case 63:
      return 'ฝนตกปานกลาง'
    case 65:
      return 'ฝนตกหนัก'
    case 66:
    case 67:
      return 'ฝนตก'
    case 80:
      return 'ฝนตกเป็นช่วง ๆ เล็กน้อย'
    case 81:
      return 'ฝนตกเป็นช่วง ๆ ปานกลาง'
    case 82:
      return 'ฝนตกหนักเป็นช่วง ๆ'
    case 95:
      return 'พายุฝนฟ้าคะนอง'
    case 96:
    case 99:
      return 'พายุฝนฟ้าคะนองและลูกเห็บ'
    default:
      return code >= 71 && code <= 86 ? 'หิมะ' : 'ไม่ทราบสภาพอากาศ'
  }
}

export function openMeteoUrl(lat: number, lng: number): string {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code,is_day',
    hourly: 'precipitation_probability,precipitation',
    forecast_hours: '24',
    timezone: 'Asia/Bangkok',
  })
  return `${OPEN_METEO_URL}?${p.toString()}`
}

interface OpenMeteoResponse {
  utc_offset_seconds?: number
  current?: {
    time?: string
    interval?: number
    temperature_2m?: number | null
    relative_humidity_2m?: number | null
    precipitation?: number | null
    weather_code?: number | null
    is_day?: number | null
  }
  hourly?: {
    time?: string[]
    precipitation_probability?: (number | null)[]
    precipitation?: (number | null)[]
  }
}

/** Open-Meteo local times ("2026-10-03T11:30") → ISO UTC using the response's utc offset. */
function localToIso(local: string, offsetSeconds: number): string | null {
  const ms = Date.parse(`${local}:00Z`)
  return Number.isFinite(ms) ? new Date(ms - offsetSeconds * 1000).toISOString() : null
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function parseOpenMeteo(body: unknown, now: Date): WeatherNow | null {
  const b = body as OpenMeteoResponse
  const cur = b?.current
  if (!cur || typeof cur.weather_code !== 'number') return null
  const offset = typeof b.utc_offset_seconds === 'number' ? b.utc_offset_seconds : 7 * 3600
  const observedAt = (cur.time && localToIso(cur.time, offset)) || now.toISOString()
  const intervalMin = (finite(cur.interval) ?? 900) / 60
  const precip = finite(cur.precipitation)

  const times = b.hourly?.time ?? []
  const probs = b.hourly?.precipitation_probability ?? []
  const amounts = b.hourly?.precipitation ?? []
  const hourly: NonNullable<WeatherNow['hourly']> = []
  for (let i = 0; i < times.length; i++) {
    const t = localToIso(times[i]!, offset)
    if (!t) continue
    // Keep the hour that contains "now" and the following ones.
    if (Date.parse(t) + 3_600_000 <= now.getTime()) continue
    hourly.push({ time: t, precipitationMm: finite(amounts[i]) ?? 0, probabilityPct: finite(probs[i]) })
  }
  const next3 = hourly.slice(0, 3)
  const next24 = hourly.slice(0, 24)
  const probs3 = next3.map((h) => h.probabilityPct).filter((p): p is number => p !== null)

  return {
    observedAt,
    condition: weatherCodeTh(cur.weather_code),
    weatherCode: cur.weather_code,
    isDay: cur.is_day !== 0,
    temperatureC: finite(cur.temperature_2m),
    humidityPct: finite(cur.relative_humidity_2m),
    precipitationMmH: precip === null ? null : Math.round(((precip * 60) / intervalMin) * 10) / 10,
    precipitationProbabilityPct: probs3.length ? Math.max(...probs3) : null,
    rainNext3hMm: next3.length ? Math.round(next3.reduce((s, h) => s + h.precipitationMm, 0) * 10) / 10 : null,
    rainNext24hMm: next24.length ? Math.round(next24.reduce((s, h) => s + h.precipitationMm, 0) * 10) / 10 : null,
    hourly: hourly.slice(0, 12),
    source: 'Open-Meteo',
  }
}

export async function fetchOpenMeteo(
  lat: number,
  lng: number,
  opts: { fetch: typeof fetch; now: Date; timeoutMs?: number },
): Promise<WeatherNow | null> {
  const body = await requestJson(opts.fetch, openMeteoUrl(lat, lng), {
    timeoutMs: opts.timeoutMs ?? 10_000,
    retryDelaysMs: [1_000],
    headers: { Accept: 'application/json' },
  })
  return parseOpenMeteo(body, opts.now)
}
