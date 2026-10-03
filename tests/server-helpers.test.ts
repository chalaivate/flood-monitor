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
  generateLinkCode,
  isLinkCodeExpired,
  LINK_CODE_ALPHABET,
  LINK_CODE_TTL_MS,
  parseLinkCode,
  randomLinkCode,
  validateChannelTarget,
} from '@/lib/server/channels'
import { HttpError, clientIp, readBodyCapped, readJson, zodMessage } from '@/lib/server/http'
import { linkByCode } from '@/lib/server/linking'
import { bangkokStamp } from '@/lib/server/log'
import { assertPublicUrl, isPrivateAddress, isPublicHostname, isRedirect, type LookupFn } from '@/lib/server/net'
import { alertSettingsChanged, patchPlace } from '@/lib/server/places'
import { runPollCycle, runRelayCycle, startLoop } from '@/lib/server/poller'
import { maskTarget, toPublicChannel, toPublicPlace } from '@/lib/server/public'
import { clearRadarCache, getRadarImage, isJpeg } from '@/lib/server/radar-proxy'
import { enforceClientLimit, ipBucket, LIMITS, RateLimiter, rateLimiter } from '@/lib/server/rate-limit'
import { ChannelInputSchema, IngestPayloadSchema, PlaceInputSchema } from '@/lib/server/validation'
import { cachedWeather, clearWeatherCache, snapToWeatherGrid, weatherKey } from '@/lib/server/weather-cache'
import type { SourceAdapter } from '@/lib/sources/types'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Channel, Place, WeatherNow } from '@/lib/types'
import { DEFAULT_FREEBOARD } from '@/lib/types'
import { ZodError } from 'zod'

const now = '2026-10-03T04:00:00.000Z'

/** Fake DNS: known public names resolve to public addresses, `*.evil.example` to private ones. */
const fakeLookup: LookupFn = async (host) => {
  const table: Record<string, string[]> = {
    'ntfy.example.org': ['203.0.114.10'],
    'fcm.googleapis.com': ['142.250.4.95', '2404:6800:4003:c00::5f'],
    'discord.com': ['162.159.128.233'],
    'rebind.evil.example': ['93.184.216.34', '10.0.0.5'],
    'loopback.evil.example': ['127.0.0.1'],
    'metadata.evil.example': ['169.254.169.254'],
    'v6.evil.example': ['::ffff:192.168.1.1'],
  }
  const hit = table[host]
  if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  return hit
}

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

  it('detects edits that change what a place is alerted about', () => {
    const place: Place = {
      id: 'p1',
      ...PlaceInputSchema.parse({ label: 'บ้าน', lat: 13.72, lng: 100.75 }),
      manageTokenHash: 'h',
      createdAt: now,
      updatedAt: now,
    }
    const changed = (patch: Record<string, unknown>) => alertSettingsChanged(place, patchPlace(place, patch))
    expect(changed({ label: 'คอนโด' })).toBe(false)
    expect(changed({})).toBe(false)
    expect(changed({ radiusKm: place.radiusKm })).toBe(false)
    expect(changed({ notifyMinLevel: 'watch' })).toBe(true)
    expect(changed({ lat: 13.73 })).toBe(true)
    expect(changed({ radiusKm: 5 })).toBe(true)
    expect(changed({ maxStations: 2 })).toBe(true)
    expect(changed({ rapidRiseCm: 20 })).toBe(true)
    expect(changed({ freeboard: { watch: 0.8, warning: 0.3, critical: 0.1 } })).toBe(true)
    expect(changed({ rain: { watch: 40, warning: 90.1, critical: 150 } })).toBe(true)
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
  it('uses 8 unambiguous characters', () => {
    expect(LINK_CODE_ALPHABET).not.toMatch(/[IO01]/)
    for (let i = 0; i < 200; i++) expect(randomLinkCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
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

  it('accepts only a message that is one code (optionally after "รหัส"), case-insensitively', () => {
    expect(parseLinkCode('ab2cd3ef')).toBe('AB2CD3EF')
    expect(parseLinkCode('  XY7Z9QWE \n')).toBe('XY7Z9QWE')
    expect(parseLinkCode('รหัส ab2cd3ef')).toBe('AB2CD3EF')
    expect(parseLinkCode('รหัสเชื่อมต่อ: AB2CD3EF')).toBe('AB2CD3EF')
    expect(parseLinkCode('code AB2CD3EF')).toBe('AB2CD3EF')
    // Several tokens in one message used to be tried one by one: now nothing is.
    expect(parseLinkCode('AB2CD3EF XY7Z9QWE')).toBeNull()
    expect(parseLinkCode('รหัส AB2CD3EF ครับ')).toBeNull()
    expect(parseLinkCode('AB1CD3EF')).toBeNull() // "1" is not in the alphabet
    expect(parseLinkCode('AB2CD3')).toBeNull() // old 6-character format
    expect(parseLinkCode('AB2CD3EFG')).toBeNull()
    expect(parseLinkCode('สวัสดี')).toBeNull()
    expect(parseLinkCode(Array.from({ length: 300 }, () => 'ABCDEFGH').join(' '))).toBeNull()
  })

  it('expires pending codes 60 minutes after the channel was created', () => {
    expect(LINK_CODE_TTL_MS).toBe(3_600_000)
    const createdAt = '2026-10-03T04:00:00.000Z'
    expect(isLinkCodeExpired({ createdAt }, new Date('2026-10-03T04:59:59.000Z'))).toBe(false)
    expect(isLinkCodeExpired({ createdAt }, new Date('2026-10-03T05:00:00.000Z'))).toBe(true)
    expect(isLinkCodeExpired({ createdAt: 'garbage' }, new Date(createdAt))).toBe(true)
  })

  it('links a pending chat channel only with a live code of the right type', async () => {
    const store = new SqliteStore(':memory:')
    const place: Place = {
      id: 'p1',
      ...PlaceInputSchema.parse({ label: 'บ้าน', lat: 13.72, lng: 100.75 }),
      manageTokenHash: 'h',
      createdAt: now,
      updatedAt: now,
    }
    await store.createPlace(place)
    await store.addChannel({ id: 'c1', placeId: 'p1', type: 'telegram', target: '', verified: false, linkCode: 'AB2CD3EF', createdAt: now })
    const at = (min: number) => new Date(Date.parse(now) + min * 60_000)
    expect(await linkByCode(store, 'line', 'AB2CD3EF', 'U1', at(1))).toEqual({ status: 'not_found' })
    expect(await linkByCode(store, 'telegram', 'ZZZZ2222', '42', at(1))).toEqual({ status: 'not_found' })
    expect(await linkByCode(store, 'telegram', 'AB2CD3EF', '42', at(61))).toEqual({ status: 'expired' })
    expect((await store.listChannels('p1'))[0]).toMatchObject({ verified: false, linkCode: 'AB2CD3EF' })
    const ok = await linkByCode(store, 'telegram', 'AB2CD3EF', '42', at(59))
    expect(ok).toMatchObject({ status: 'linked', channel: { target: '42', verified: true, linkCode: null } })
    store.close()
  })

  it('validates each channel type', async () => {
    const v = (type: Channel['type'], raw: unknown) => validateChannelTarget(type, raw, { lookup: fakeLookup })
    expect(await v('ntfy', 'fm-home_01')).toEqual({ ok: true, target: 'fm-home_01' })
    expect(await v('ntfy', 'https://ntfy.example.org/my-topic/')).toEqual({ ok: true, target: 'https://ntfy.example.org/my-topic' })
    expect((await v('ntfy', 'http://ntfy.example.org/t')).ok).toBe(false)
    expect((await v('ntfy', 'https://127.0.0.1/t')).ok).toBe(false)
    expect((await v('ntfy', 'https://localhost/t')).ok).toBe(false)
    expect((await v('ntfy', 'has space')).ok).toBe(false)
    expect(await v('ntfy', undefined)).toEqual({ ok: false, error: 'กรุณาระบุชื่อหัวข้อ (topic) ของ ntfy' })

    expect(await v('email', ' Someone@Example.COM ')).toEqual({ ok: true, target: 'someone@example.com' })
    expect((await v('email', 'not-an-email')).ok).toBe(false)
    expect((await v('email', 'a@b')).ok).toBe(false)

    const hook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123'
    expect(await v('discord', hook)).toEqual({ ok: true, target: hook })
    expect((await v('discord', 'https://example.com/api/webhooks/1/2')).ok).toBe(false)

    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
    }
    const r = await v('webpush', sub)
    expect(r.ok).toBe(true)
    expect((await v('webpush', JSON.stringify(sub))).ok).toBe(true)
    expect((await v('webpush', { ...sub, endpoint: 'http://fcm.googleapis.com/x' })).ok).toBe(false)
    expect((await v('webpush', { ...sub, endpoint: 'https://192.168.1.2/push' })).ok).toBe(false)
    expect((await v('webpush', { endpoint: 'https://x.example/y' })).ok).toBe(false)

    expect(await v('line', 'ignored')).toEqual({ ok: true, target: '' })
  })

  it('refuses URLs whose host resolves to a private address (SSRF)', async () => {
    const v = (type: Channel['type'], raw: unknown) => validateChannelTarget(type, raw, { lookup: fakeLookup })
    for (const host of ['rebind.evil.example', 'loopback.evil.example', 'metadata.evil.example', 'v6.evil.example']) {
      const r = await v('ntfy', `https://${host}/topic`)
      expect(r).toEqual({ ok: false, error: expect.stringContaining('ไม่รองรับที่อยู่ภายในเครือข่าย') })
    }
    expect(await v('ntfy', 'https://nowhere.example.org/topic')).toEqual({ ok: false, error: expect.stringContaining('ไม่พบเซิร์ฟเวอร์') })
    const sub = {
      endpoint: 'https://loopback.evil.example/push/abc',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
    }
    expect((await v('webpush', sub)).ok).toBe(false)
    // Discord URLs are pinned to discord.com and still DNS-checked.
    const evilDiscord: LookupFn = async () => ['10.1.2.3']
    const hook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123'
    expect((await validateChannelTarget('discord', hook, { lookup: evilDiscord })).ok).toBe(false)
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
    expect(await readJson(new Request('http://x/', { method: 'POST', body: '{"a":"น้ำ"}' }))).toEqual({ a: 'น้ำ' })
  })

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(1024))
      },
    })
    const req = new Request('http://x/', { method: 'POST', body, duplex: 'half', headers: { 'content-length': String(10 * 1024 * 1024) } } as RequestInit)
    await expect(readBodyCapped(req, 1024)).rejects.toMatchObject({ status: 413 })
    expect(pulled).toBeLessThanOrEqual(1) // the stream may prime one chunk; it is never drained
  })

  it('stops reading a chunked body as soon as it passes the cap', async () => {
    let pulled = 0
    let cancelled = false
    // An endless upload without Content-Length.
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(16 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const req = new Request('http://x/', { method: 'POST', body, duplex: 'half' } as RequestInit)
    const err = await readBodyCapped(req, 64 * 1024).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
    const small = new Request('http://x/', { method: 'POST', body: 'hello' })
    expect(new TextDecoder().decode(await readBodyCapped(small, 5))).toBe('hello')
  })

  it('reads the client IP only from the header of the trusted proxy (TRUST_PROXY)', () => {
    const r = (headers: Record<string, string>) => new Request('http://x/', { headers })
    const spoofed = { 'cf-connecting-ip': '5.6.7.8', 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }
    expect(clientIp(r(spoofed), 'none')).toBe('unknown')
    expect(clientIp(r(spoofed), 'cloudflare')).toBe('5.6.7.8')
    expect(clientIp(r(spoofed), 'vercel')).toBe('9.9.9.9')
    expect(clientIp(r({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'cf-connecting-ip': '5.6.7.8' }), 'vercel')).toBe('1.2.3.4')
    expect(clientIp(r(spoofed), 'xff')).toBe('1.2.3.4')
    // A client-chosen header the proxy does not set is ignored.
    expect(clientIp(r({ 'cf-connecting-ip': '5.6.7.8' }), 'vercel')).toBe('unknown')
    expect(clientIp(r({ 'x-forwarded-for': '1.2.3.4' }), 'cloudflare')).toBe('unknown')
    // Garbage and IPv4-mapped forms are normalised.
    expect(clientIp(r({ 'x-forwarded-for': 'not-an-ip' }), 'xff')).toBe('unknown')
    expect(clientIp(r({ 'x-forwarded-for': '::ffff:203.0.113.9' }), 'xff')).toBe('203.0.113.9')
    expect(clientIp(r({ 'cf-connecting-ip': '2001:DB8::1' }), 'cloudflare')).toBe('2001:db8::1')
  })

  it('defaults TRUST_PROXY to vercel on Vercel and none elsewhere', () => {
    expect(loadConfig({}).TRUST_PROXY).toBe('none')
    expect(loadConfig({ VERCEL: '1' }).TRUST_PROXY).toBe('vercel')
    expect(loadConfig({ VERCEL: '1', TRUST_PROXY: 'cloudflare' }).TRUST_PROXY).toBe('cloudflare')
    expect(loadConfig({ TRUST_PROXY: ' XFF ' }).TRUST_PROXY).toBe('xff')
    expect(loadConfig({ TRUST_PROXY: '' }).TRUST_PROXY).toBe('none')
    expect(() => loadConfig({ TRUST_PROXY: 'everything' })).toThrow()
  })

  it('formats log stamps in Bangkok time', () => {
    expect(bangkokStamp(new Date('2026-10-03T17:05:09Z'))).toBe('2026-10-04 00:05:09')
  })
})

describe('SSRF guard (net)', () => {
  it('classifies private and public addresses', () => {
    const priv = [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.254',
      '169.254.169.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '255.255.255.255', '198.18.0.1',
      '::', '::1', '[::1]', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1',
      '2001:db8::1', 'not-an-ip', '',
    ]
    const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '142.250.4.95', '2606:4700::1111', '2001:4860:4860::8888', '64:ff9b::808:808', '2002:808:808::1']
    for (const ip of priv) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true])
    for (const ip of pub) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false])
  })

  it('rejects LAN-style and literal-IP host names before any DNS lookup', () => {
    expect(isPublicHostname('ntfy.example.org')).toBe(true)
    for (const h of ['localhost', 'nas.local', 'router.lan', 'svc.internal', '10.0.0.1', '[::1]', 'intranet', 'printer.home']) {
      expect([h, isPublicHostname(h)]).toEqual([h, false])
    }
  })

  it('assertPublicUrl requires https, no credentials and only public resolved addresses', async () => {
    await expect(assertPublicUrl('https://ntfy.example.org/x', { lookup: fakeLookup })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicUrl('http://ntfy.example.org/x', { lookup: fakeLookup })).rejects.toMatchObject({ reason: 'protocol' })
    await expect(assertPublicUrl('https://u:p@ntfy.example.org/x', { lookup: fakeLookup })).rejects.toMatchObject({ reason: 'credentials' })
    await expect(assertPublicUrl('https://127.0.0.1.nip.io/x', { lookup: async () => ['127.0.0.1'] })).rejects.toMatchObject({ reason: 'private-address' })
    // One private address among public ones is enough to refuse (fetch may pick any).
    await expect(assertPublicUrl('https://rebind.evil.example/', { lookup: fakeLookup })).rejects.toMatchObject({ reason: 'private-address' })
    await expect(assertPublicUrl('https://nowhere.example.org/', { lookup: fakeLookup })).rejects.toMatchObject({ reason: 'dns' })
    await expect(assertPublicUrl('https://empty.example.org/', { lookup: async () => [] })).rejects.toMatchObject({ reason: 'dns' })
    await expect(assertPublicUrl('https://localhost:8080/', { lookup: fakeLookup })).rejects.toMatchObject({ reason: 'hostname' })
    await expect(assertPublicUrl('not a url')).rejects.toMatchObject({ reason: 'invalid' })
  })

  it('recognises redirects from redirect: manual', () => {
    expect(isRedirect(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }))).toBe(true)
    expect(isRedirect(new Response(null, { status: 307 }))).toBe(true)
    expect(isRedirect(new Response(null, { status: 200 }))).toBe(false)
    expect(isRedirect(new Response(null, { status: 404 }))).toBe(false)
  })
})

describe('RateLimiter', () => {
  it('takeAll consumes from every bucket or from none', () => {
    let t = 0
    const rl = new RateLimiter(() => t)
    const a = { capacity: 1, windowMs: 60_000 }
    const b = { capacity: 3, windowMs: 3_600_000 }
    expect(rl.takeAll([['a', a], ['b', b]]).ok).toBe(true)
    const denied = rl.takeAll([['a', a], ['b', b]])
    expect(denied).toMatchObject({ ok: false, blocked: ['a'] })
    expect(denied.retryAfterSec).toBe(60)
    // 'b' was not charged for the refused request: 2 tokens left.
    expect(rl.take('b', b).ok).toBe(true)
    expect(rl.take('b', b).ok).toBe(true)
    expect(rl.take('b', b).ok).toBe(false)
    t += 60_000
    expect(rl.takeAll([['a', a], ['b', b]])).toMatchObject({ ok: false, blocked: ['b'] })
  })

  it('never evicts server-wide buckets when many client keys rotate', () => {
    const rl = new RateLimiter(() => 0)
    const global = { capacity: 2, windowMs: 3_600_000 }
    expect(rl.take('place:*', global).ok).toBe(true)
    expect(rl.take('place:*', global).ok).toBe(true)
    for (let i = 0; i < 10_050; i++) rl.take(`place:10.0.${i >> 8}.${i & 255}`, { capacity: 1, windowMs: 1000 })
    expect(rl.take('place:*', global).ok).toBe(false)
  })

  it('groups IPv6 clients by /64', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9')
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  it('skips the per-IP bucket for unknown clients but keeps the global backstop', () => {
    rateLimiter().reset()
    const perIp = { capacity: 1, windowMs: 3_600_000 }
    const global = { capacity: 3, windowMs: 3_600_000 }
    enforceClientLimit('t', '198.51.100.1', perIp, global)
    expect(() => enforceClientLimit('t', '198.51.100.1', perIp, global)).toThrow(HttpError)
    enforceClientLimit('t', 'unknown', perIp, global)
    enforceClientLimit('t', 'unknown', perIp, global)
    const err = (() => {
      try {
        enforceClientLimit('t', '198.51.100.2', perIp, global)
      } catch (e) {
        return e
      }
    })()
    expect(err).toMatchObject({ status: 429 })
    expect(LIMITS.placeCreateGlobal.capacity).toBeGreaterThan(LIMITS.placeCreate.capacity)
    rateLimiter().reset()
  })

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

  it('snaps coordinates to the grid for both the key and the upstream request', async () => {
    expect(snapToWeatherGrid(13.7563, 100.5018)).toEqual({ lat: 13.76, lng: 100.5 })
    expect(snapToWeatherGrid(13.7299, 100.6901)).toEqual({ lat: 13.72, lng: 100.7 })
    const load = vi.fn(async () => sample)
    await cachedWeather(13.7299, 100.6901, { load, now: () => 0 })
    expect(load.mock.calls[0]!.slice(0, 2)).toEqual([13.72, 100.7])
  })

  it('asks the upstream budget only on a cache miss and caches nothing when refused', async () => {
    const load = vi.fn(async () => sample)
    let allow = false
    const allowUpstream = vi.fn(() => allow)
    expect(await cachedWeather(14.0, 100.6, { load, now: () => 0, allowUpstream })).toBeNull()
    expect(load).not.toHaveBeenCalled()
    allow = true
    expect(await cachedWeather(14.0, 100.6, { load, now: () => 0, allowUpstream })).toEqual(sample)
    expect(await cachedWeather(14.0, 100.6, { load, now: () => 0, allowUpstream })).toEqual(sample)
    expect(allowUpstream).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(1)
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

  it('relays BMA sources one at a time (same host), other hosts in parallel', async () => {
    let active = 0
    let maxBmaActive = 0
    const order: string[] = []
    const slow = (id: SourceAdapter['id']): SourceAdapter => ({
      ...fakeSource(id),
      async fetch(ctx) {
        if (id.startsWith('bma-')) {
          active++
          maxBmaActive = Math.max(maxBmaActive, active)
        }
        order.push(`start:${id}`)
        await new Promise((r) => setTimeout(r, 5))
        if (id.startsWith('bma-')) active--
        return fakeSource(id).fetch(ctx)
      },
    })
    const res = await runRelayCycle({
      baseUrl: 'https://flood.example.org',
      token: 'tok',
      config: loadConfig({}),
      sources: [slow('bma-canal'), slow('bma-rain'), slow('bma-roadflood'), slow('thaiwater-canal')],
      fetch: (async () => Response.json({ inserted: 4 })) as unknown as typeof fetch,
      log: () => {},
      sleep: async () => {},
    })
    expect(res.ok).toBe(true)
    expect(maxBmaActive).toBe(1)
    expect(res.results.map((r) => r.source)).toEqual(['bma-canal', 'bma-rain', 'bma-roadflood', 'thaiwater-canal'])
    // ThaiWater did not wait for the BMA queue.
    expect(order.indexOf('start:thaiwater-canal')).toBeLessThan(order.indexOf('start:bma-rain'))
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
