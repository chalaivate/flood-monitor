import { createECDH, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfigCache } from '@/lib/config'
import { lineSignature } from '@/lib/server/auth'
import { clearRadarCache } from '@/lib/server/radar-proxy'
import { rateLimiter } from '@/lib/server/rate-limit'
import { clearWeatherCache } from '@/lib/server/weather-cache'
import { __setStoreForTests } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'
import type { DashboardSnapshot, Station } from '@/lib/types'

import * as configRoute from '@/app/api/config/public/route'
import * as cronRoute from '@/app/api/cron/poll/route'
import * as emailConfirmRoute from '@/app/api/email/confirm/route'
import * as healthRoute from '@/app/api/health/route'
import * as historyRoute from '@/app/api/history/route'
import * as ingestRoute from '@/app/api/ingest/route'
import * as lineRoute from '@/app/api/line/webhook/route'
import * as channelRoute from '@/app/api/places/[id]/channels/[channelId]/route'
import * as channelsRoute from '@/app/api/places/[id]/channels/route'
import * as eventsRoute from '@/app/api/places/[id]/events/route'
import * as placeRoute from '@/app/api/places/[id]/route'
import * as testRoute from '@/app/api/places/[id]/test/route'
import * as placesRoute from '@/app/api/places/route'
import * as radarRoute from '@/app/api/radar/bma/[site]/route'
import * as snapshotRoute from '@/app/api/snapshot/route'
import * as stationsRoute from '@/app/api/stations/route'
import * as telegramRoute from '@/app/api/telegram/webhook/route'

// Route handlers are invoked directly with Request objects against an in-memory
// SQLite store. Outbound HTTP goes to a stubbed global fetch.

vi.mock('@/lib/weather', () => ({ getWeather: vi.fn(async () => null) }))
vi.mock('@/lib/sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sources')>()),
  getSources: () => [
    {
      id: 'bma-canal',
      label: 'สำนักการระบายน้ำ กทม.',
      thaiIpOnly: true,
      async fetch({ now }: { now: Date }) {
        return {
          source: 'bma-canal',
          fetchedAt: now.toISOString(),
          warnings: [],
          stations: [
            { id: 'canal:WL.CRON.01', source: 'bma-canal', kind: 'canal', name: 'จุดวัดจาก cron', lat: 13.76, lng: 100.5, agency: 'สำนักการระบายน้ำ กทม.', bankLevel: 1.2 },
          ],
          readings: [{ stationId: 'canal:WL.CRON.01', observedAt: now.toISOString(), waterLevel: 0.5, freeboard: 0.7 }],
        }
      },
    },
  ],
}))

const ENV = {
  DATA_MODE: 'live',
  STORE: 'sqlite',
  CRON_SECRET: 'cron-secret',
  INGEST_TOKEN: 'ingest-token',
  PUBLIC_BASE_URL: 'https://flood.example.org',
  LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
  LINE_CHANNEL_SECRET: 'line-secret',
  LINE_ADD_FRIEND_URL: 'https://lin.ee/abcdef',
  TELEGRAM_BOT_TOKEN: '123:ABC',
  TELEGRAM_BOT_USERNAME: 'flood_bot',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'Flood Monitor <alerts@example.org>',
  RUN_ALERTS: '1',
  POLL_MINUTES: '10',
  STALE_MINUTES: '60',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
}
const saved: Record<string, string | undefined> = {}

interface Outbound {
  url: string
  method: string
  headers: Headers
  body: string
}
let outbound: Outbound[] = []
let store: SqliteStore

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])
let radarMode: 'jpeg' | 'down' = 'jpeg'

function stubFetch() {
  outbound = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? String(init.body) : '' }
    outbound.push(call)
    if (url.startsWith('https://api.line.me/')) return Response.json({})
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: {} })
    if (url.startsWith('https://ntfy.sh')) return Response.json({ id: 'n1' })
    if (url.startsWith('https://api.resend.com/')) return Response.json({ id: 'e1' })
    if (url.includes('weather.bangkok.go.th/FTPCustomer/radar')) {
      if (radarMode === 'down') throw new TypeError('fetch failed')
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
    }
    throw new TypeError(`fetch failed (blocked in tests): ${url}`)
  })
}

const BASE = 'http://localhost'

function req(path: string, init: { method?: string; json?: unknown; body?: string; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  let body: string | undefined = init.body
  if (init.json !== undefined) {
    body = JSON.stringify(init.json)
    headers['content-type'] = 'application/json'
  }
  return new Request(`${BASE}${path}`, { method: init.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body })
}

const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) })

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function createPlace(extra: Record<string, unknown> = {}, ip = '203.0.113.1') {
  const res = await placesRoute.POST(
    req('/api/places', { json: { label: 'บ้านทดสอบ', lat: 13.7563, lng: 100.5018, ...extra }, headers: { 'x-forwarded-for': ip } }),
  )
  expect(res.status).toBe(201)
  const b = await body<{ place: { id: string; label: string }; manageToken: string }>(res)
  return { id: b.place.id, token: b.manageToken, place: b.place }
}

function lineWebhook(payload: unknown, secret = 'line-secret') {
  const raw = JSON.stringify(payload)
  return lineRoute.POST(req('/api/line/webhook', { body: raw, headers: { 'x-line-signature': lineSignature(secret, raw) } }))
}

function telegramWebhook(update: unknown, secret = 'tg-secret') {
  return telegramRoute.POST(req('/api/telegram/webhook', { json: update, headers: { 'x-telegram-bot-api-secret-token': secret } }))
}

const nearStation: Station = {
  id: 'canal:WL.TEST.01',
  source: 'bma-canal',
  kind: 'canal',
  name: 'ปตร. คลองทดสอบ',
  shortName: 'คลองทดสอบ',
  lat: 13.7573,
  lng: 100.5028,
  agency: 'สำนักการระบายน้ำ กทม.',
  bankLevel: 1.0,
  district: 'พระนคร',
}

async function seedReadings(freeboard = 0.2) {
  const t = Date.now()
  await store.upsertStations([nearStation])
  await store.insertReadings([
    { stationId: nearStation.id, observedAt: new Date(t - 70 * 60_000).toISOString(), waterLevel: 0.7, freeboard: 0.3 },
    { stationId: nearStation.id, observedAt: new Date(t - 5 * 60_000).toISOString(), waterLevel: 1 - freeboard, freeboard },
  ])
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  resetConfigCache()
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetConfigCache()
  __setStoreForTests(null)
  vi.unstubAllGlobals()
})

beforeEach(() => {
  store = new SqliteStore(':memory:')
  __setStoreForTests(store)
  rateLimiter().reset()
  clearWeatherCache()
  clearRadarCache()
  radarMode = 'jpeg'
  stubFetch()
})

describe('places API', () => {
  it('creates a place and returns the manage token once', async () => {
    const { id, token, place } = await createPlace()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(place).not.toHaveProperty('manageTokenHash')
    const stored = await store.getPlace(id)
    expect(stored?.manageTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.manageTokenHash).not.toContain(token)
    expect(stored).toMatchObject({ radiusKm: 3, maxStations: 4, notifyMinLevel: 'warning' })
  })

  it('validates input with Thai error messages', async () => {
    const res = await placesRoute.POST(req('/api/places', { json: { label: 'โตเกียว', lat: 35.68, lng: 139.69 } }))
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ error: 'ตำแหน่งต้องอยู่ในประเทศไทย' })
    const bad = await placesRoute.POST(req('/api/places', { body: '{nope', headers: { 'content-type': 'application/json' } }))
    expect(bad.status).toBe(400)
    expect((await body(bad)).error).toContain('JSON')
  })

  it('requires the manage token for GET / PATCH / DELETE', async () => {
    const { id, token } = await createPlace()
    expect((await placeRoute.GET(req(`/api/places/${id}`), ctx({ id }))).status).toBe(401)
    expect((await placeRoute.GET(req(`/api/places/${id}`, { token: 'wrong' }), ctx({ id }))).status).toBe(401)
    expect((await placeRoute.GET(req('/api/places/00000000-0000-0000-0000-000000000000', { token }), ctx({ id: '00000000-0000-0000-0000-000000000000' }))).status).toBe(404)

    const got = await placeRoute.GET(req(`/api/places/${id}`, { token }), ctx({ id }))
    expect(got.status).toBe(200)
    const g = await body<{ place: { label: string }; channels: unknown[] }>(got)
    expect(g.place.label).toBe('บ้านทดสอบ')
    expect(g.channels).toEqual([])

    const patched = await placeRoute.PATCH(req(`/api/places/${id}`, { method: 'PATCH', token, json: { radiusKm: 5, label: 'คอนโด' } }), ctx({ id }))
    expect(patched.status).toBe(200)
    expect((await body<{ place: { radiusKm: number; label: string } }>(patched)).place).toMatchObject({ radiusKm: 5, label: 'คอนโด' })
    const invalid = await placeRoute.PATCH(req(`/api/places/${id}`, { method: 'PATCH', token, json: { maxStations: 20 } }), ctx({ id }))
    expect(invalid.status).toBe(400)
    expect((await body(invalid)).error).toBe('ติดตามได้สูงสุด 8 จุดวัด')

    const del = await placeRoute.DELETE(req(`/api/places/${id}`, { method: 'DELETE', token }), ctx({ id }))
    expect(await body(del)).toEqual({ ok: true })
    expect(await store.getPlace(id)).toBeNull()
  })

  it('rate-limits place creation to 10 per hour per IP', async () => {
    for (let i = 0; i < 10; i++) await createPlace({}, '198.51.100.7')
    const res = await placesRoute.POST(
      req('/api/places', { json: { label: 'x', lat: 13.7, lng: 100.5 }, headers: { 'x-forwarded-for': '198.51.100.7' } }),
    )
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await body(res)).error).toContain('บ่อยเกินไป')
    await createPlace({}, '198.51.100.8')
  })
})

describe('channels API', () => {
  it('adds ntfy immediately (masked) and de-duplicates', async () => {
    const { id, token } = await createPlace()
    const res = await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'ntfy', target: 'fm-home-8842' } }), ctx({ id }))
    expect(res.status).toBe(201)
    const b = await body<{ channel: { id: string; verified: boolean; target: string } }>(res)
    expect(b.channel).toMatchObject({ verified: true, target: 'fm-***' })
    const again = await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'ntfy', target: 'fm-home-8842' } }), ctx({ id }))
    expect(again.status).toBe(200)
    expect((await body<{ channel: { id: string } }>(again)).channel.id).toBe(b.channel.id)
    const list = await body<{ channels: unknown[] }>(await channelsRoute.GET(req(`/api/places/${id}/channels`, { token }), ctx({ id })))
    expect(list.channels).toHaveLength(1)
  })

  it('rejects invalid targets and channels the server cannot send', async () => {
    const { id, token } = await createPlace()
    const bad = await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'discord', target: 'https://example.com/hook' } }), ctx({ id }))
    expect(bad.status).toBe(400)
    expect((await body(bad)).error).toContain('discord.com')
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    }
    // VAPID keys are not configured in this test environment.
    const push = await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'webpush', target: sub } }), ctx({ id }))
    expect(push.status).toBe(400)
    expect((await body(push)).error).toContain('ยังไม่เปิดใช้งาน')
    const noAuth = await channelsRoute.POST(req(`/api/places/${id}/channels`, { json: { type: 'ntfy', target: 'abc' } }), ctx({ id }))
    expect(noAuth.status).toBe(401)
  })

  it('returns a Telegram deep link with a link code and reuses the pending one', async () => {
    const { id, token } = await createPlace()
    const res = await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'telegram' } }), ctx({ id }))
    expect(res.status).toBe(201)
    const b = await body<{ channel: { verified: boolean; linkCode: string }; link: { code: string; url: string; instructions: string } }>(res)
    expect(b.channel.verified).toBe(false)
    expect(b.link.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(b.link.url).toBe(`https://t.me/flood_bot?start=${b.link.code}`)
    expect(b.channel.linkCode).toBe(b.link.code)
    const again = await body<{ link: { code: string } }>(
      await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'telegram' } }), ctx({ id })),
    )
    expect(again.link.code).toBe(b.link.code)
  })

  it('deletes only channels of the authorised place', async () => {
    const a = await createPlace()
    const bPlace = await createPlace()
    const created = await body<{ channel: { id: string } }>(
      await channelsRoute.POST(req(`/api/places/${a.id}/channels`, { token: a.token, json: { type: 'ntfy', target: 'topic-a' } }), ctx({ id: a.id })),
    )
    const chId = created.channel.id
    const wrong = await channelRoute.DELETE(req(`/api/places/${bPlace.id}/channels/${chId}`, { method: 'DELETE', token: bPlace.token }), ctx({ id: bPlace.id, channelId: chId }))
    expect(wrong.status).toBe(404)
    const ok = await channelRoute.DELETE(req(`/api/places/${a.id}/channels/${chId}`, { method: 'DELETE', token: a.token }), ctx({ id: a.id, channelId: chId }))
    expect(ok.status).toBe(200)
    expect(await store.listChannels(a.id)).toEqual([])
  })

  it('sends a test message and records it in the history', async () => {
    const { id, token } = await createPlace()
    await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'ntfy', target: 'fm-test-1' } }), ctx({ id }))
    const res = await testRoute.POST(req(`/api/places/${id}/test`, { token, json: {} }), ctx({ id }))
    expect(res.status).toBe(200)
    const b = await body<{ deliveries: { type: string; ok: boolean }[] }>(res)
    expect(b.deliveries).toEqual([expect.objectContaining({ type: 'ntfy', ok: true })])
    const ntfy = outbound.find((c) => c.url.startsWith('https://ntfy.sh'))!
    expect(JSON.parse(ntfy.body)).toMatchObject({ topic: 'fm-test-1' })
    expect(String(JSON.parse(ntfy.body).title)).toContain('ทดสอบการแจ้งเตือน')

    const events = await body<{ events: { kind: string }[] }>(await eventsRoute.GET(req(`/api/places/${id}/events?limit=5`, { token }), ctx({ id })))
    expect(events.events.map((e) => e.kind)).toEqual(['test'])
  })

  it('refuses a test when nothing is verified', async () => {
    const { id, token } = await createPlace()
    const res = await testRoute.POST(req(`/api/places/${id}/test`, { token, json: {} }), ctx({ id }))
    expect(res.status).toBe(400)
  })

  it('confirms e-mail channels through the emailed link', async () => {
    const { id, token } = await createPlace()
    const res = await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'email', target: 'Owner@Example.com' } }), ctx({ id }))
    expect(res.status).toBe(201)
    const b = await body<{ channel: { id: string; verified: boolean; target: string }; link: { instructions: string; code?: string } }>(res)
    expect(b.channel).toMatchObject({ verified: false, target: 'ow***@example.com' })
    expect(b.link.code).toBeUndefined()
    const mail = outbound.find((c) => c.url === 'https://api.resend.com/emails')!
    const sent = JSON.parse(mail.body) as { to: string; text: string }
    expect(sent.to).toBe('owner@example.com')
    const link = sent.text.match(/https:\/\/flood\.example\.org\/api\/email\/confirm\?code=([A-Za-z0-9_-]+)/)
    expect(link).not.toBeNull()

    const bad = await emailConfirmRoute.GET(req('/api/email/confirm?code=wrong-code-wrong-code'))
    expect(bad.status).toBe(303)
    expect(bad.headers.get('location')).toBe('https://flood.example.org/alerts?confirmed=0')

    const ok = await emailConfirmRoute.GET(req(`/api/email/confirm?code=${link![1]}`))
    expect(ok.headers.get('location')).toBe('https://flood.example.org/alerts?confirmed=1')
    const [ch] = await store.listChannels(id)
    expect(ch).toMatchObject({ verified: true, linkCode: null })
    // Single use.
    const again = await emailConfirmRoute.GET(req(`/api/email/confirm?code=${link![1]}`))
    expect(again.headers.get('location')).toContain('confirmed=0')
  })
})

describe('LINE webhook', () => {
  it('rejects bad signatures', async () => {
    const raw = JSON.stringify({ events: [] })
    const res = await lineRoute.POST(req('/api/line/webhook', { body: raw, headers: { 'x-line-signature': 'bogus' } }))
    expect(res.status).toBe(401)
    expect((await lineWebhook({ events: [] }, 'other-secret')).status).toBe(401)
    expect((await lineWebhook({ destination: 'U0', events: [] })).status).toBe(200)
  })

  it('greets on follow, links with a code, answers "สถานะ", unlinks on unfollow', async () => {
    const { id, token } = await createPlace()
    await seedReadings(0.2)
    const created = await body<{ link: { code: string; url: string } }>(
      await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'line' } }), ctx({ id })),
    )
    expect(created.link.url).toBe('https://lin.ee/abcdef')
    const source = { type: 'user', userId: 'U1234567890abcdef' }

    await lineWebhook({ events: [{ type: 'follow', replyToken: 'rt-follow', source }] })
    const greet = outbound.find((c) => c.url === 'https://api.line.me/v2/bot/message/reply')!
    expect(greet.headers.get('authorization')).toBe('Bearer line-token')
    expect(JSON.parse(greet.body)).toMatchObject({ replyToken: 'rt-follow', messages: [{ type: 'text' }] })
    expect(JSON.parse(greet.body).messages[0].text).toContain('รหัสเชื่อมต่อ')

    outbound = []
    const res = await lineWebhook({
      events: [{ type: 'message', replyToken: 'rt-link', source, message: { type: 'text', text: `รหัส ${created.link.code.toLowerCase()}` } }],
    })
    expect(res.status).toBe(200)
    const [ch] = await store.listChannels(id)
    expect(ch).toMatchObject({ type: 'line', verified: true, target: 'U1234567890abcdef', linkCode: null })
    const confirm = JSON.parse(outbound[0]!.body) as { replyToken: string; messages: { text: string }[] }
    expect(confirm.replyToken).toBe('rt-link')
    expect(confirm.messages[0]!.text).toContain('บ้านทดสอบ')

    outbound = []
    await lineWebhook({ events: [{ type: 'message', replyToken: 'rt-status', source, message: { type: 'text', text: 'สถานะ' } }] })
    const status = JSON.parse(outbound[0]!.body) as { messages: { text: string }[] }
    expect(status.messages[0]!.text).toContain('สถานการณ์ล่าสุด: บ้านทดสอบ')
    expect(status.messages[0]!.text).toContain('เตือนภัย')
    expect(status.messages[0]!.text).toContain('ปตร. คลองทดสอบ')

    outbound = []
    await lineWebhook({ events: [{ type: 'message', replyToken: 'rt-x', source, message: { type: 'text', text: 'ZZZZ22' } }] })
    expect(JSON.parse(outbound[0]!.body).messages[0].text).toContain('ไม่พบรหัสเชื่อมต่อ')

    await lineWebhook({ events: [{ type: 'unfollow', source }] })
    expect(await store.listChannels(id)).toEqual([])
  })

  it('stays quiet about chatter in groups', async () => {
    await lineWebhook({
      events: [{ type: 'message', replyToken: 'rt-g', source: { type: 'group', groupId: 'C1', userId: 'U1' }, message: { type: 'text', text: 'สวัสดีทุกคน วันนี้ฝนตกหนักมาก' } }],
    })
    expect(outbound).toEqual([])
  })
})

describe('Telegram webhook', () => {
  it('requires the secret header', async () => {
    expect((await telegramWebhook({ update_id: 1 }, 'nope')).status).toBe(401)
    const res = await telegramRoute.POST(req('/api/telegram/webhook', { json: { update_id: 1 } }))
    expect(res.status).toBe(401)
  })

  it('links with /start CODE, answers /status, unlinks when blocked', async () => {
    const { id, token } = await createPlace()
    const created = await body<{ link: { code: string } }>(
      await channelsRoute.POST(req(`/api/places/${id}/channels`, { token, json: { type: 'telegram' } }), ctx({ id })),
    )
    const chat = { id: 555123, type: 'private' }
    const res = await telegramWebhook({ update_id: 2, message: { message_id: 1, chat, text: `/start ${created.link.code}` } })
    expect(res.status).toBe(200)
    const [ch] = await store.listChannels(id)
    expect(ch).toMatchObject({ type: 'telegram', verified: true, target: '555123' })
    const sent = outbound.find((c) => c.url === 'https://api.telegram.org/bot123:ABC/sendMessage')!
    expect(JSON.parse(sent.body)).toMatchObject({ chat_id: '555123' })
    expect(JSON.parse(sent.body).text).toContain('เชื่อมต่อการแจ้งเตือน')

    outbound = []
    await telegramWebhook({ update_id: 3, message: { message_id: 2, chat, text: '/status@flood_bot' } })
    expect(JSON.parse(outbound[0]!.body).text).toContain('สถานการณ์ล่าสุด: บ้านทดสอบ')

    outbound = []
    await telegramWebhook({ update_id: 4, message: { message_id: 3, chat, text: '/start' } })
    expect(JSON.parse(outbound[0]!.body).text).toContain('ขอบคุณที่เพิ่ม')

    await telegramWebhook({ update_id: 5, my_chat_member: { chat, new_chat_member: { status: 'kicked' } } })
    expect(await store.listChannels(id)).toEqual([])
  })
})

describe('machine endpoints', () => {
  const payload = {
    results: [
      {
        source: 'bma-canal',
        fetchedAt: new Date().toISOString(),
        warnings: [],
        stations: [nearStation],
        readings: [{ stationId: nearStation.id, observedAt: new Date().toISOString(), waterLevel: 0.5, freeboard: 0.5 }],
      },
    ],
    failures: [{ source: 'bma-rain', error: 'HTTP 403' }],
  }

  it('ingest requires the token and validates the payload', async () => {
    expect((await ingestRoute.POST(req('/api/ingest', { json: payload }))).status).toBe(401)
    expect((await ingestRoute.POST(req('/api/ingest', { json: payload, token: 'wrong' }))).status).toBe(401)
    const invalid = await ingestRoute.POST(req('/api/ingest', { json: { results: [{ source: 'x' }] }, token: 'ingest-token' }))
    expect(invalid.status).toBe(400)

    const ok = await ingestRoute.POST(req('/api/ingest', { json: payload, token: 'ingest-token' }))
    expect(ok.status).toBe(200)
    expect(await body(ok)).toMatchObject({ ok: true, inserted: 1, alerts: { places: 0, events: [] } })
    expect((await store.listStations()).map((s) => s.id)).toEqual([nearStation.id])
    const health = await store.listSourceHealth()
    expect(health.find((h) => h.source === 'bma-canal')).toMatchObject({ ok: true, stationCount: 1 })
    expect(health.find((h) => h.source === 'bma-rain')).toMatchObject({ ok: false, error: 'HTTP 403' })
    expect(await store.getMeta('lastIngestAt')).not.toBeNull()
    expect(health.find((h) => h.source === 'bma-canal')?.latestObservationAt).toBe(payload.results[0]!.readings[0]!.observedAt)
  })

  it('cron requires CRON_SECRET and runs a cycle', async () => {
    expect((await cronRoute.GET(req('/api/cron/poll'))).status).toBe(401)
    expect((await cronRoute.POST(req('/api/cron/poll', { method: 'POST', token: 'nope' }))).status).toBe(401)
    const res = await cronRoute.GET(req('/api/cron/poll', { token: 'cron-secret' }))
    expect(res.status).toBe(200)
    const b = await body<{ ok: boolean; ingest: { results: { source: string; inserted: number }[] }; alerts: unknown }>(res)
    expect(b.ok).toBe(true)
    expect(b.ingest.results).toEqual([expect.objectContaining({ source: 'bma-canal', inserted: 1 })])
    expect(b.alerts).not.toBeNull()
    expect((await store.listStations()).map((s) => s.id)).toEqual(['canal:WL.CRON.01'])
  })

  it('cron skips alerts when RUN_ALERTS=0', async () => {
    process.env.RUN_ALERTS = '0'
    resetConfigCache()
    try {
      const b = await body<{ alerts: unknown }>(await cronRoute.POST(req('/api/cron/poll', { method: 'POST', token: 'cron-secret' })))
      expect(b.alerts).toBeNull()
    } finally {
      process.env.RUN_ALERTS = '1'
      resetConfigCache()
    }
  })
})

describe('public read endpoints', () => {
  it('snapshot for coordinates uses defaults and caches publicly', async () => {
    await seedReadings(0.2)
    const res = await snapshotRoute.GET(req('/api/snapshot?lat=13.7563&lng=100.5018&label=%E0%B8%9A%E0%B9%89%E0%B8%B2%E0%B8%99'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=60')
    const snap = await body<DashboardSnapshot>(res)
    expect(snap.place).toMatchObject({ label: 'บ้าน', radiusKm: 3, maxStations: 4 })
    expect(snap.water.map((w) => w.station.id)).toEqual([nearStation.id])
    expect(snap.water[0]!.level).toBe('warning')
    expect(snap.water[0]!.trendCmPerHour).not.toBeNull()
    expect(snap.overall.level).toBe('warning')
    expect(snap.pollMinutes).toBe(10)
    expect(snap.weather).toBeNull()
  })

  it('snapshot resolves ?place= and validates parameters', async () => {
    const { id } = await createPlace({ label: 'ร้านค้า', radiusKm: 1 })
    const snap = await body<DashboardSnapshot>(await snapshotRoute.GET(req(`/api/snapshot?place=${id}`)))
    expect(snap.place).toMatchObject({ label: 'ร้านค้า', radiusKm: 1 })
    expect((await snapshotRoute.GET(req('/api/snapshot?place=00000000-0000-0000-0000-000000000000'))).status).toBe(404)
    expect((await snapshotRoute.GET(req('/api/snapshot?lat=13.7'))).status).toBe(400)
    expect((await snapshotRoute.GET(req('/api/snapshot?lat=abc&lng=100'))).status).toBe(400)
    const def = await body<DashboardSnapshot>(await snapshotRoute.GET(req('/api/snapshot?r=99&n=0')))
    expect(def.place).toMatchObject({ label: 'กรุงเทพมหานคร', radiusKm: 20, maxStations: 1 })
  })

  it('stations lists map rows with levels', async () => {
    await seedReadings(0.05)
    const b = await body<{ generatedAt: string; stations: Record<string, unknown>[] }>(await stationsRoute.GET())
    expect(b.stations).toEqual([
      expect.objectContaining({ id: nearStation.id, kind: 'canal', level: 'critical', stale: false, freeboard: 0.05, bankLevel: 1, district: 'พระนคร' }),
    ])
  })

  it('history returns series and enforces limits', async () => {
    await seedReadings(0.2)
    const ok = await body<{ series: Record<string, { t: string; freeboard: number }[]> }>(
      await historyRoute.GET(req(`/api/history?ids=${nearStation.id},canal:none&hours=48`)),
    )
    expect(ok.series[nearStation.id]!.map((p) => p.freeboard)).toEqual([0.3, 0.2])
    expect(ok.series['canal:none']).toEqual([])
    expect((await historyRoute.GET(req('/api/history'))).status).toBe(400)
    const many = Array.from({ length: 9 }, (_, i) => `s${i}`).join(',')
    expect((await historyRoute.GET(req(`/api/history?ids=${many}`))).status).toBe(400)
  })

  it('public config exposes no secrets', async () => {
    const res = await configRoute.GET()
    const b = await body<Record<string, unknown>>(res)
    expect(b).toEqual({
      dataMode: 'live',
      defaultPlace: { label: 'กรุงเทพมหานคร', lat: 13.7563, lng: 100.5018 },
      pollMinutes: 10,
      channels: { webpush: false, line: true, telegram: true, ntfy: true, email: true, discord: true },
      telegramBot: 'flood_bot',
      lineAddFriendUrl: 'https://lin.ee/abcdef',
      vapidPublicKey: null,
    })
    expect(JSON.stringify(b)).not.toMatch(/secret|line-token|re_test/)
  })

  it('health reports ingest status', async () => {
    const b = await body<{ ok: boolean; lastIngestAt: string | null; ingestStale: boolean }>(await healthRoute.GET())
    expect(b).toMatchObject({ ok: true, lastIngestAt: null, ingestStale: true })
    await store.setMeta('lastIngestAt', new Date().toISOString())
    expect((await body<{ ingestStale: boolean }>(await healthRoute.GET())).ingestStale).toBe(false)
  })

  it('proxies BMA radar images and fails with 502 JSON', async () => {
    const res = await radarRoute.GET(req('/api/radar/bma/nongchok'), ctx({ site: 'nongchok' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('public, max-age=240')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG)
    expect((await radarRoute.GET(req('/api/radar/bma/x'), ctx({ site: 'x' }))).status).toBe(404)
    radarMode = 'down'
    const down = await radarRoute.GET(req('/api/radar/bma/nongkhaem'), ctx({ site: 'nongkhaem' }))
    expect(down.status).toBe(502)
    expect((await body(down)).error).toContain('เรดาร์')
  })
})
