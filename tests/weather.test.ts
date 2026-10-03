import { describe, expect, it } from 'vitest'
import { fetchOpenMeteo, openMeteoUrl, parseOpenMeteo, weatherCodeTh } from '@/lib/weather/openmeteo'

// Shape per Open-Meteo docs with timezone=Asia/Bangkok (utc_offset_seconds = 25200, local times).
const body = {
  latitude: 13.72,
  longitude: 100.68,
  utc_offset_seconds: 25200,
  timezone: 'Asia/Bangkok',
  current: { time: '2026-10-03T11:30', interval: 900, temperature_2m: 31.2, relative_humidity_2m: 68, precipitation: 0.5, weather_code: 3, is_day: 1 },
  hourly: {
    time: ['2026-10-03T10:00', '2026-10-03T11:00', '2026-10-03T12:00', '2026-10-03T13:00', '2026-10-03T14:00'],
    precipitation_probability: [10, 20, 33, 45, 30],
    precipitation: [0, 0.2, 1.1, 2.4, 0.3],
  },
}
const NOW = new Date('2026-10-03T04:35:00.000Z') // 11:35 ICT

describe('Open-Meteo', () => {
  it('builds the request URL', () => {
    const u = new URL(openMeteoUrl(13.72, 100.68))
    expect(u.host).toBe('api.open-meteo.com')
    expect(u.searchParams.get('timezone')).toBe('Asia/Bangkok')
    expect(u.searchParams.get('current')).toContain('weather_code')
  })
  it('parses current conditions and the next 3 hours', () => {
    const w = parseOpenMeteo(body, NOW)!
    expect(w.observedAt).toBe('2026-10-03T04:30:00.000Z')
    expect(w.condition).toBe('มีเมฆมาก')
    expect(w.humidityPct).toBe(68)
    expect(w.precipitationMmH).toBe(2) // 0.5 mm per 15 min
    // hourly values cover the preceding hour: 12:00 (11–12, in progress), 13:00, 14:00
    expect(w.precipitationProbabilityPct).toBe(45)
    expect(w.rainNext3hMm).toBe(3.8)
    // labelled by interval start: 11:00–12:00 ICT
    expect(w.hourly![0]!.time).toBe('2026-10-03T04:00:00.000Z')
    expect(w.rainNext24hMm).toBeNull() // only 3 future hours in this sample → unknown, not 0
  })
  it('treats model gaps as unknown, not as no rain', () => {
    const gap = { ...body, hourly: { ...body.hourly, precipitation: [0, 0.2, null, 2.4, 0.3] } }
    const w = parseOpenMeteo(gap, NOW)!
    expect(w.rainNext3hMm).toBeNull()
    expect(w.hourly!.map((h) => h.precipitationMm)).toEqual([2.4, 0.3])
  })
  it('returns null for error bodies and maps codes', () => {
    expect(parseOpenMeteo({ error: true, reason: 'bad' }, NOW)).toBeNull()
    expect(weatherCodeTh(95)).toBe('พายุฝนฟ้าคะนอง')
    expect(weatherCodeTh(0)).toBe('ท้องฟ้าแจ่มใส')
  })
  it('fetches via injected fetch', async () => {
    const fake = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
    expect((await fetchOpenMeteo(13.72, 100.68, { fetch: fake, now: NOW }))?.temperatureC).toBe(31.2)
  })
})
