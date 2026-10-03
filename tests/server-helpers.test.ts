import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '@/lib/config'
import {
  bearerToken,
  generateManageToken,
  hasBearerSecret,
  hashToken,
  lineSignature,
  safeEqual,
  verifyLineSignature,
  verifyManageToken,
} from '@/lib/server/auth'
import {
  extractLinkCodes,
  generateLinkCode,
  LINK_CODE_ALPHABET,
  randomLinkCode,
  validateChannelTarget,
} from '@/lib/server/channels'
import { clientIp, readJson, zodMessage } from '@/lib/server/http'
import { bangkokStamp } from '@/lib/server/log'
import { patchPlace } from '@/lib/server/places'
import { runPollCycle, runRelayCycle, startLoop } from '@/lib/server/poller'
import { maskTarget, toPublicChannel, toPublicPlace } from '@/lib/server/public'
import { clearRadarCache, getRadarImage, isJpeg } from '@/lib/server/radar-proxy'
import { RateLimiter } from '@/lib/server/rate-limit'
import { ChannelInputSchema, IngestPayloadSchema, PlaceInputSchema } from '@/lib/server/validation'
import { cachedWeather, clearWeatherCache, weatherKey } from '@/lib/server/weather-cache'
import type { SourceAdapter } from '@/lib/sources/types'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Channel, Place, WeatherNow } from '@/lib/types'
import { DEFAULT_FREEBOARD } from '@/lib/types'
import { ZodError } from 'zod'

const now = '2026-10-03T04:00:00.000Z'

describe('auth helpers', () => {
  it('generates 43-char base64url manage tokens and verifies their sha256', () => {
    const t = generateManageToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateManageToken()).not.toBe(t)
    const h = hashToken(t)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyManageToken(t, h)).toBe(true)
    expect(verifyManageToken(`${t}x`, h)).toBe(false)
    expect(verifyManageToken(null, h)).toBe(false)
    expect(verifyManageToken(t, '')).toBe(false)
  })

  it('compares secrets in constant time and parses bearer headers', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    const req = new Request('http://x/', { headers: { Authorization: 'Bearer  s3cret ' } })
    expect(bearerToken(req)).toBe('s3cret')
    expect(hasBearerSecret(req, 's3cret')).toBe(true)
    expect(hasBearerSecret(req, undefined)).toBe(false)
    expect(bearerToken(new Request('http://x/', { headers: { Authorization: 'Basic abc' } }))).toBeNull()
  })

  it('verifies LINE signatures (base64 HMAC-SHA256 of the raw body)', () => {
    const body = '{"events":[]}'
    // Reference value computed independently with: printf '%s' "$body" | openssl dgst -sha256 -hmac secret -binary | base64
    expect(lineSignature('secret', body)).toBe('pkK1lVPJPiJ+wPLziRD79xIxohl8AImYM8AEeM7IbzQ=')
    expect(verifyLineSignature('secret', body, lineSignature('secret', body))).toBe(true)
    expect(verifyLineSignature('secret', `${body} `, lineSignature('secret', body))).toBe(false)
    expect(verifyLineSignature('secret', body, null)).toBe(false)
    expect(verifyLineSignature(undefined, body, 'x')).toBe(false)
  })
})

describe('PlaceInput validation', () => {
  it('applies defaults', () => {
    const p = PlaceInputSchema.parse({ label: ' บ้าน ', lat: 13.72, lng: 100.75 })
    expect(p).toMatchObject({ label: 'บ้าน', radiusKm: 3, maxStations: 4, rapidRiseCm: 10, notifyMinLevel: 'warning' })
    expect(p.freeboard).toEqual(DEFAULT_FREEBOARD)
    expect(p.rain.watch).toBe(35.1)
  })

  it('rejects bad input with Thai messages', () => {
    const msg = (v: unknown) => {
      const r = PlaceInputSchema.safeParse(v)
      return r.success ? null : zodMessage(r.error)
    }
    const base = { label: 'บ้าน', lat: 13.72, lng: 100.75 }
    expect(msg({ ...base, label: '' })).toBe('กรุณาระบุชื่อสถานที่')
    expect(msg({ ...base, label: 'ก'.repeat(61) })).toContain('60')
    expect(msg({ ...base, lat: 35.68, lng: 139.69 })).toBe('ตำแหน่งต้องอยู่ในประเทศไทย')
    expect(msg({ ...base, radiusKm: 0.2 })).toContain('0.5')
    expect(msg({ ...base, radiusKm: 25 })).toContain('20')
    expect(msg({ ...base, maxStations: 9 })).toContain('8')
    expect(msg({ ...base, maxStations: 2.5 })).toContain('จำนวนเต็ม')
    expect(msg({ ...base, rapidRiseCm: 2 })).toContain('3')
    expect(msg({ ...base, freeboard: { watch: 0.3, warning: 0.6, critical: 0.1 } })).toContain('เฝ้าระวัง > เตือนภัย > วิกฤต')
    expect(msg({ ...base, freeboard: { watch: 0.6, warning: 0.3, critical: -2 } })).toContain('-1')
    expect(msg({ ...base, rain: { watch: 90, warning: 35, critical: 150 } })).toContain('เฝ้าระวัง < เตือนภัย < วิกฤต')
    expect(msg({ ...base, notifyMinLevel: 'normal' })).toBe('ระดับขั้นต่ำที่แจ้งเตือนไม่ถูกต้อง')
    expect(msg({ ...base, lat: 'abc' })).toBe('กรุณาระบุละติจูดเป็นตัวเลข')
    expect(msg({ ...base, freeboard: { watch: 0.6, warning: 0.3, critical: -1 } })).toBeNull()
  })

  it('patches a place by re-validating the merged result', () => {
    const place: Place = {
      id: 'p1',
      ...PlaceInputSchema.parse({ label: 'บ้าน', lat: 13.72, lng: 100.75 }),
      manageTokenHash: 'h',
      createdAt: now,
      updatedAt: now,
    }
    const p = patchPlace(place, { radiusKm: 5, manageTokenHash: 'evil', id: 'other' }, new Date('2026-10-03T05:00:00Z'))
    expect(p).toMatchObject({ id: 'p1', radiusKm: 5, manageTokenHash: 'h', updatedAt: '2026-10-03T05:00:00.000Z' })
    expect(() => patchPlace(place, { lat: 40 })).toThrow(ZodError)
    expect(toPublicPlace(p)).not.toHaveProperty('manageTokenHash')
  })

  it('validates channel and ingest payloads', () => {
    expect(ChannelInputSchema.safeParse({ type: 'sms' }).success).toBe(false)
    expect(ChannelInputSchema.parse({ type: 'webpush', target: { endpoint: 'x' } }).type).toBe('webpush')
    const ok = IngestPayloadSchema.parse({
      results: [
        {
          source: 'bma-canal',
          fetchedAt: now,
          stations: [{ id: 'canal:A', source: 'bma-canal', kind: 'canal', name: 'A', lat: 13.7, lng: 100.5, agency: 'x', extra: 1 }],
          readings: [{ stationId: 'canal:A', observedAt: now, waterLevel: 0.4 }],
        },
      ],
    })
    expect(ok.failures).toEqual([])
    expect(ok.results[0]!.warnings).toEqual([])
    expect((ok.results[0]!.stations[0] as Record<string, unknown>).extra).toBe(1)
    expect(IngestPayloadSchema.safeParse({ results: [{ source: 'nope', fetchedAt: now, stations: [], readings: [] }] }).success).toBe(false)
    expect(
      IngestPayloadSchema.safeParse({
        results: [{ source: 'bma-canal', fetchedAt: now, stations: [], readings: [{ stationId: 'a', observedAt: 'not a date' }] }],
      }).success,
    ).toBe(false)
  })
})

describe('link codes and channel targets', () => {
  it('uses 6 unambiguous characters', () => {
    expect(LINK_CODE_ALPHABET).not.toMatch(/[IO01]/)
    for (let i = 0; i < 200; i++) expect(randomLinkCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })

  it('retries until the code is unused', async () => {
    const store = new SqliteStore(':memory:')
    const taken = new Set<string>()
    const real = store.findChannelByLinkCode.bind(store)
    let calls = 0
    store.findChannelByLinkCode = async (code: string) => {
      calls++
      if (calls < 3) {
        taken.add(code)
        return { id: 'x', placeId: 'p', type: 'line', target: '', verified: false, linkCode: code, createdAt: now }
      }
      return real(code)
    }
    const code = await generateLinkCode(store)
    expect(calls).toBe(3)
    expect(taken.has(code)).toBe(false)
    store.close()
  })

  it('extracts codes from chat text case-insensitively', () => {
    expect(extractLinkCodes('รหัส ab2cd3 ครับ')).toEqual(['AB2CD3'])
    expect(extractLinkCodes('/start XY7Z9Q STATUS')).toEqual(['XY7Z9Q', 'STATUS'])
    expect(extractLinkCodes('code: AB1CD3')).toEqual([]) // contains "1": not in the alphabet
    expect(extractLinkCodes('สวัสดี')).toEqual([])
  })

  it('validates each channel type', () => {
    expect(validateChannelTarget('ntfy', 'fm-home_01')).toEqual({ ok: true, target: 'fm-home_01' })
    expect(validateChannelTarget('ntfy', 'https://ntfy.example.org/my-topic/')).toEqual({ ok: true, target: 'https://ntfy.example.org/my-topic' })
    expect(validateChannelTarget('ntfy', 'http://ntfy.example.org/t').ok).toBe(false)
    expect(validateChannelTarget('ntfy', 'https://127.0.0.1/t').ok).toBe(false)
    expect(validateChannelTarget('ntfy', 'https://localhost/t').ok).toBe(false)
    expect(validateChannelTarget('ntfy', 'has space').ok).toBe(false)
    expect(validateChannelTarget('ntfy', undefined)).toEqual({ ok: false, error: 'กรุณาระบุชื่อหัวข้อ (topic) ของ ntfy' })

    expect(validateChannelTarget('email', ' Someone@Example.COM ')).toEqual({ ok: true, target: 'someone@example.com' })
    expect(validateChannelTarget('email', 'not-an-email').ok).toBe(false)
    expect(validateChannelTarget('email', 'a@b').ok).toBe(false)

    const hook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123'
    expect(validateChannelTarget('discord', hook)).toEqual({ ok: true, target: hook })
    expect(validateChannelTarget('discord', 'https://example.com/api/webhooks/1/2').ok).toBe(false)

    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
    }
    const r = validateChannelTarget('webpush', sub)
    expect(r.ok).toBe(true)
    expect(validateChannelTarget('webpush', JSON.stringify(sub)).ok).toBe(true)
    expect(validateChannelTarget('webpush', { ...sub, endpoint: 'http://fcm.googleapis.com/x' }).ok).toBe(false)
    expect(validateChannelTarget('webpush', { ...sub, endpoint: 'https://192.168.1.2/push' }).ok).toBe(false)
    expect(validateChannelTarget('webpush', { endpoint: 'https://x.example/y' }).ok).toBe(false)

    expect(validateChannelTarget('line', 'ignored')).toEqual({ ok: true, target: '' })
  })

  it('masks targets for public output', () => {
    const ch = (type: Channel['type'], target: string, extra: Partial<Channel> = {}): Channel => ({
      id: 'c',
      placeId: 'p',
      type,
      target,
      verified: true,
      createdAt: now,
      ...extra,
    })
    expect(maskTarget(ch('email', 'test@gmail.com'))).toBe('te***@gmail.com')
    expect(maskTarget(ch('ntfy', 'fm-home-1234'))).toBe('fm-***')
    expect(maskTarget(ch('ntfy', 'https://ntfy.example.org/alerts'))).toBe('ntfy.example.org/ale***')
    expect(maskTarget(ch('discord', 'https://discord.com/api/webhooks/123456789012345678/secret_token_value'))).toBe(
      'discord.com/api/webhooks/1234***',
    )
    expect(maskTarget(ch('webpush', JSON.stringify({ endpoint: 'https://web.push.apple.com/abc' })))).toBe('อุปกรณ์ Apple (Safari)')
    expect(maskTarget(ch('line', 'U4af4980629abcdef'))).toBe('U4a***ef')

    const pending = toPublicChannel(ch('line', '', { verified: false, linkCode: 'ABC234' }))
    expect(pending.linkCode).toBe('ABC234')
    const verified = toPublicChannel(ch('line', 'U4af4980629abcdef', { linkCode: null }))
    expect(verified).not.toHaveProperty('linkCode')
    const email = toPublicChannel(ch('email', 'a@b.co', { verified: false, linkCode: 'secret-confirm-code' }))
    expect(email).not.toHaveProperty('linkCode')
    expect(JSON.stringify(email)).not.toContain('secret-confirm-code')
  })
})

describe('http helpers', () => {
  it('reads JSON with a size cap', async () => {
    const big = new Request('http://x/', { method: 'POST', body: 'x'.repeat(100) })
    await expect(readJson(big, 10)).rejects.toMatchObject({ status: 413 })
    const bad = new Request('http://x/', { method: 'POST', body: '{nope' })
    await expect(readJson(bad)).rejects.toMatchObject({ status: 400 })
    expect(await readJson(new Request('http://x/', { method: 'POST', body: '' }))).toEqual({})
  })

  it('picks the client IP from proxy headers', () => {
    expect(clientIp(new Request('http://x/', { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }))).toBe('1.2.3.4')
    expect(clientIp(new Request('http://x/', { headers: { 'cf-connecting-ip': '5.6.7.8', 'x-forwarded-for': '1.2.3.4' } }))).toBe('5.6.7.8')
    expect(clientIp(new Request('http://x/'))).toBe('unknown')
  })

  it('formats log stamps in Bangkok time', () => {
    expect(bangkokStamp(new Date('2026-10-03T17:05:09Z'))).toBe('2026-10-04 00:05:09')
  })
})

describe('RateLimiter', () => {
  it('allows a burst, refuses, then refills over the window', () => {
    let t = 0
    const rl = new RateLimiter(() => t)
    const rule = { capacity: 10, windowMs: 3_600_000 }
    for (let i = 0; i < 10; i++) expect(rl.take('ip', rule).ok).toBe(true)
    const denied = rl.take('ip', rule)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBe(360)
    expect(rl.take('other-ip', rule).ok).toBe(true)
    t += 360_000
    expect(rl.take('ip', rule).ok).toBe(true)
    expect(rl.take('ip', rule).ok).toBe(false)
  })
})

describe('weather cache', () => {
  afterEach(() => clearWeatherCache())

  const sample: WeatherNow = { observedAt: now, condition: 'มีเมฆมาก', weatherCode: 3, isDay: true, source: 'test' }

  it('rounds keys to a 0.02° grid and caches for 10 minutes', async () => {
    expect(weatherKey(13.7563, 100.5018)).toBe('13.76,100.50')
    expect(weatherKey(13.7501, 100.5099)).toBe('13.76,100.50')
    let t = 0
    const load = vi.fn(async () => sample)
    expect(await cachedWeather(13.7563, 100.5018, { load, now: () => t })).toEqual(sample)
    expect(await cachedWeather(13.7501, 100.5099, { load, now: () => t })).toEqual(sample)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]!.slice(0, 2)).toEqual([13.76, 100.5])
    t += 9 * 60_000
    await cachedWeather(13.7563, 100.5018, { load, now: () => t })
    expect(load).toHaveBeenCalledTimes(1)
    t += 2 * 60_000
    await cachedWeather(13.7563, 100.5018, { load, now: () => t })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('retries failures sooner and never throws', async () => {
    let t = 0
    const load = vi.fn(async () => {
      throw new Error('down')
    })
    expect(await cachedWeather(13.7, 100.5, { load, now: () => t })).toBeNull()
    t += 60_000
    await cachedWeather(13.7, 100.5, { load, now: () => t })
    expect(load).toHaveBeenCalledTimes(1)
    t += 61_000
    await cachedWeather(13.7, 100.5, { load, now: () => t })
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('BMA radar proxy', () => {
  afterEach(() => clearRadarCache())
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

  it('validates JPEG magic bytes', () => {
    expect(isJpeg(jpeg)).toBe(true)
    expect(isJpeg(new TextEncoder().encode('<!DOCTYPE html>'))).toBe(false)
  })

  it('fetches once per 4 minutes and serves the cached image', async () => {
    let t = 1_000_000
    const f = vi.fn(async () => new Response(jpeg, { status: 200 })) as unknown as typeof fetch
    const r1 = await getRadarImage('nongchok', f, () => t)
    expect(r1.ok).toBe(true)
    t += 3 * 60_000
    await getRadarImage('nongchok', f, () => t)
    expect(f).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f).mock.calls[0]![0]).toBe('http://weather.bangkok.go.th/FTPCustomer/radar/pics/radarh.jpg')
    t += 2 * 60_000
    await getRadarImage('nongchok', f, () => t)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('rejects HTML challenge pages and serves a recent stale image when upstream fails', async () => {
    let t = 1_000_000
    const ok = (async () => new Response(jpeg)) as typeof fetch
    const html = vi.fn(async () => new Response('<html>Just a moment...</html>', { status: 200 })) as unknown as typeof fetch
    expect((await getRadarImage('nongkhaem', html, () => t)).ok).toBe(false)
    clearRadarCache()
    await getRadarImage('nongkhaem', ok, () => t)
    t += 5 * 60_000
    const stale = await getRadarImage('nongkhaem', html, () => t)
    expect(stale).toMatchObject({ ok: true, stale: true })
    t += 30 * 60_000
    const gone = await getRadarImage('nongkhaem', html, () => t)
    expect(gone).toEqual({ ok: false, error: 'not a JPEG image' })
  })
})

describe('poller', () => {
  it('runs immediately, never overlaps, and stops gracefully', async () => {
    let running = 0
    let maxRunning = 0
    let runs = 0
    const sleeps: number[] = []
    const loop = startLoop(
      async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        runs++
        await new Promise((r) => setTimeout(r, 5))
        running--
        if (runs === 3) void loop.stop()
      },
      {
        intervalMs: 600_000,
        log: () => {},
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    )
    await loop.done
    expect(runs).toBe(3)
    expect(maxRunning).toBe(1)
    expect(sleeps).toHaveLength(2)
    expect(sleeps[0]).toBeGreaterThan(590_000)
  })

  it('keeps looping after a crashed cycle', async () => {
    let runs = 0
    const logs: string[] = []
    const loop = startLoop(
      async () => {
        runs++
        if (runs === 1) throw new Error('boom')
        void loop.stop()
      },
      { intervalMs: 1000, log: (m) => logs.push(m), sleep: async () => {} },
    )
    await loop.done
    expect(runs).toBe(2)
    expect(logs[0]).toContain('boom')
  })

  const fakeSource = (id: SourceAdapter['id'], fail = false): SourceAdapter => ({
    id,
    label: id,
    thaiIpOnly: true,
    async fetch() {
      if (fail) throw new Error('HTTP 403')
      return {
        source: id,
        fetchedAt: now,
        warnings: [],
        stations: [{ id: `canal:${id}`, source: id, kind: 'canal', name: 'A', lat: 13.7, lng: 100.5, agency: 'x', bankLevel: 1 }],
        readings: [{ stationId: `canal:${id}`, observedAt: now, waterLevel: 0.5, freeboard: 0.5 }],
      }
    },
  })

  it('runPollCycle ingests, skips alerts when RUN_ALERTS=0, and flags total failure', async () => {
    const store = new SqliteStore(':memory:')
    const base = { store, senders: [], fetch: globalThis.fetch, now: () => new Date(now) }
    const s1 = await runPollCycle({ ...base, config: loadConfig({ RUN_ALERTS: '0' }), sources: [fakeSource('bma-canal')] })
    expect(s1.alerts).toBeNull()
    expect(s1.allFailed).toBe(false)
    expect(s1.ingest.results[0]!.inserted).toBe(1)
    const s2 = await runPollCycle({ ...base, config: loadConfig({}), sources: [fakeSource('bma-rain', true)] })
    expect(s2.alerts).not.toBeNull()
    expect(s2.allFailed).toBe(true)
    store.close()
  })

  it('relays results to /api/ingest with retries on 5xx', async () => {
    const posts: { url: string; auth: string | null; body: { results: unknown[]; failures: { source: string }[] } }[] = []
    let attempt = 0
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      attempt++
      return attempt < 3 ? new Response('bad gateway', { status: 502 }) : Response.json({ inserted: 1 })
    }) as typeof fetch
    const sleeps: number[] = []
    const res = await runRelayCycle({
      baseUrl: 'https://flood.example.org/',
      token: 'tok',
      config: loadConfig({}),
      sources: [fakeSource('bma-canal'), fakeSource('bma-rain', true)],
      fetch: f,
      log: () => {},
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(res.ok).toBe(true)
    expect(res.inserted).toBe(1)
    expect(posts).toHaveLength(3)
    expect(sleeps).toEqual([5000, 15000])
    expect(posts[0]!.url).toBe('https://flood.example.org/api/ingest')
    expect(posts[0]!.auth).toBe('Bearer tok')
    expect(posts[0]!.body.results).toHaveLength(1)
    expect(posts[0]!.body.failures.map((x) => x.source)).toEqual(['bma-rain'])
  })

  it('does not retry auth failures', async () => {
    let n = 0
    const f = (async () => {
      n++
      return new Response('{"error":"x"}', { status: 401 })
    }) as unknown as typeof fetch
    const res = await runRelayCycle({
      baseUrl: 'https://flood.example.org',
      token: 'bad',
      config: loadConfig({}),
      sources: [fakeSource('bma-canal')],
      fetch: f,
      log: () => {},
      sleep: async () => {},
    })
    expect(n).toBe(1)
    expect(res).toMatchObject({ ok: false, allFailed: true })
    expect(res.error).toContain('401')
  })
})
