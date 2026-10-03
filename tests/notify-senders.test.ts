import { createECDH, randomBytes } from 'node:crypto'
import webpush from 'web-push'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '@/lib/config'
import { discordSender, isDiscordWebhookUrl } from '@/lib/notify/discord'
import { emailSender, sendEmail, confirmationEmail } from '@/lib/notify/email'
import { htmlEmail, plainText, titleLine, truncate } from '@/lib/notify/format'
import { availableChannels, getSenders } from '@/lib/notify'
import { lineRecipientGone, lineSender } from '@/lib/notify/line'
import { ntfySender, ntfyTarget } from '@/lib/notify/ntfy'
import { telegramSender } from '@/lib/notify/telegram'
import type { NotifyMessage } from '@/lib/notify/types'
import { buildPayload, parseSubscription, topicFor, webPushSender } from '@/lib/notify/webpush'
import { readErrorBody } from '@/lib/notify/format'
import { setDefaultLookupForTests, type LookupFn } from '@/lib/server/net'
import type { Channel, ChannelType } from '@/lib/types'

// Senders resolve user-supplied hosts before connecting (SSRF guard). Tests never touch
// real DNS: this table stands in for the resolver.
const fakeLookup: LookupFn = async (host) => {
  const table: Record<string, string[]> = {
    'fcm.googleapis.com': ['142.250.4.95'],
    'ntfy.example.org': ['203.0.114.10'],
    'discord.com': ['162.159.128.233'],
    'internal.evil.example': ['192.168.1.10'],
  }
  const hit = table[host]
  if (!hit) throw new Error(`ENOTFOUND ${host}`)
  return hit
}

beforeAll(() => setDefaultLookupForTests(fakeLookup))
afterAll(() => setDefaultLookupForTests(null))

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | Uint8Array | null
  redirect: RequestRedirect | undefined
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => new Response('{}', { status: 200 })) {
  const calls: Call[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const body = init?.body === undefined || init.body === null ? null : init.body instanceof Uint8Array ? init.body : String(init.body)
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body, redirect: init?.redirect }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { fn, calls }
}

const vapid = webpush.generateVAPIDKeys()
const config = loadConfig({
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:ops@example.org',
  LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
  LINE_CHANNEL_SECRET: 'line-secret',
  TELEGRAM_BOT_TOKEN: '123:ABC',
  TELEGRAM_BOT_USERNAME: 'flood_bot',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'Flood Monitor <alerts@example.org>',
  NTFY_BASE_URL: 'https://ntfy.sh',
})

const msg: NotifyMessage = {
  title: 'วิกฤต: ประเวศฯ ลาดกระบัง ห่างตลิ่ง 0.08 ม.',
  body: '• วิกฤต · ปตร. คลองประเวศบุรีรมย์: น้ำ 1.90 ม. ตลิ่ง 1.98 ม. ห่างตลิ่ง 0.08 ม.\n\nพื้นที่: บ้าน',
  level: 'critical',
  url: 'https://flood.example.org/?place=p1',
  tag: 'place-p1',
}

function channel(type: ChannelType, target: string): Channel {
  return { id: `ch-${type}`, placeId: 'p1', type, target, verified: true, createdAt: '2026-10-03T00:00:00.000Z' }
}

function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = createECDH('prime256v1')
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  }
}

describe('format helpers', () => {
  it('builds plain text with title, body and link, truncating to the limit', () => {
    const text = plainText(msg)
    expect(text.startsWith(msg.title)).toBe(true)
    expect(text).toContain('ดูรายละเอียด: https://flood.example.org/?place=p1')
    const long = plainText({ ...msg, body: 'ก'.repeat(10_000) }, 2000)
    expect(Array.from(long).length).toBeLessThanOrEqual(2000)
    expect(long.endsWith(msg.url!)).toBe(true)
  })

  it('does not repeat the link when the body already has it', () => {
    const text = plainText({ ...msg, body: `ข้อความ\n${msg.url}` })
    expect(text.split(msg.url!).length - 1).toBe(1)
  })

  it('prefixes the level label only when the title lacks it', () => {
    expect(titleLine({ ...msg, title: 'น้ำขึ้นเร็ว: X', level: 'watch' })).toBe('[เฝ้าระวัง] น้ำขึ้นเร็ว: X')
    expect(titleLine(msg)).toBe(msg.title)
    expect(titleLine({ ...msg, level: 'normal', title: 'คลี่คลาย: X' })).toBe('คลี่คลาย: X')
  })

  it('escapes HTML in e-mails', () => {
    const html = htmlEmail({ ...msg, title: '<script>x</script>' })
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&lt;script&gt;')
    expect(truncate('abcdef', 4)).toBe('abc…')
  })
})

describe('webpush sender', () => {
  it('sends an encrypted VAPID request with TTL 6h and high urgency', async () => {
    const f = fakeFetch(() => new Response(null, { status: 201 }))
    const sub = subscription()
    const res = await webPushSender.send(channel('webpush', JSON.stringify(sub)), msg, { config, fetch: f.fn })
    expect(res).toEqual({ ok: true })
    expect(f.calls).toHaveLength(1)
    const c = f.calls[0]!
    expect(c.url).toBe(sub.endpoint)
    expect(c.method).toBe('POST')
    expect(c.headers.ttl).toBe('21600')
    expect(c.headers.urgency).toBe('high')
    expect(c.headers['content-encoding']).toBe('aes128gcm')
    expect(c.headers.authorization).toMatch(/^vapid t=.+, k=/)
    expect(c.headers.topic).toBe(topicFor('place-p1'))
    expect(c.headers['content-length']).toBeUndefined()
    expect(c.body).toBeInstanceOf(Uint8Array)
    expect(c.redirect).toBe('manual')
  })

  it('refuses endpoints that resolve to private addresses and never follows redirects', async () => {
    const f = fakeFetch()
    const internal = subscription('https://internal.evil.example/push/abc')
    const blocked = await webPushSender.send(channel('webpush', JSON.stringify(internal)), msg, { config, fetch: f.fn })
    expect(blocked).toEqual({ ok: false, error: 'blocked destination (private-address)' })
    expect(f.calls).toHaveLength(0)
    // An explicit resolver in the context wins over the default one.
    const viaCtx = await webPushSender.send(channel('webpush', JSON.stringify(subscription())), msg, {
      config,
      fetch: f.fn,
      lookup: async () => ['127.0.0.1'],
    })
    expect(viaCtx.ok).toBe(false)
    expect(f.calls).toHaveLength(0)

    const redirect = fakeFetch(() => new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }))
    const r = await webPushSender.send(channel('webpush', JSON.stringify(subscription())), msg, { config, fetch: redirect.fn })
    expect(r).toEqual({ ok: false, error: 'HTTP 307 (redirect not followed)', gone: false })
    expect(redirect.calls).toHaveLength(1)
  })

  it('uses normal urgency below warning', async () => {
    const f = fakeFetch(() => new Response(null, { status: 201 }))
    await webPushSender.send(channel('webpush', JSON.stringify(subscription())), { ...msg, level: 'watch' }, { config, fetch: f.fn })
    expect(f.calls[0]!.headers.urgency).toBe('normal')
  })

  it.each([404, 410])('marks HTTP %i as gone', async (status) => {
    const f = fakeFetch(() => new Response('expired', { status }))
    const res = await webPushSender.send(channel('webpush', JSON.stringify(subscription())), msg, { config, fetch: f.fn })
    expect(res.ok).toBe(false)
    expect(res.gone).toBe(true)
  })

  it('keeps the subscription on other errors and network failures', async () => {
    const f = fakeFetch(() => new Response('busy', { status: 429 }))
    const res = await webPushSender.send(channel('webpush', JSON.stringify(subscription())), msg, { config, fetch: f.fn })
    expect(res).toEqual({ ok: false, error: 'HTTP 429', gone: false })
    const boom = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const res2 = await webPushSender.send(channel('webpush', JSON.stringify(subscription())), msg, { config, fetch: boom })
    expect(res2).toMatchObject({ ok: false, error: 'ECONNRESET' })
    expect(res2.gone).toBeFalsy()
  })

  it('rejects malformed subscriptions as gone and validates key sizes', async () => {
    const f = fakeFetch()
    const res = await webPushSender.send(channel('webpush', '{"endpoint":"https://x"}'), msg, { config, fetch: f.fn })
    expect(res.gone).toBe(true)
    expect(f.calls).toHaveLength(0)
    expect(parseSubscription(JSON.stringify({ ...subscription(), endpoint: 'http://insecure.example/x' }))).toBeNull()
    expect(parseSubscription(JSON.stringify({ ...subscription(), keys: { p256dh: 'abc', auth: 'def' } }))).toBeNull()
    expect(parseSubscription(JSON.stringify(subscription()))).not.toBeNull()
  })

  it('is unconfigured without VAPID keys and keeps payloads under the size limit', () => {
    expect(webPushSender.isConfigured(loadConfig({}))).toBe(false)
    expect(webPushSender.isConfigured(config)).toBe(true)
    const p = buildPayload({ ...msg, body: 'น้ำ'.repeat(3000) })
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(3800)
    expect(JSON.parse(p)).toMatchObject({ title: msg.title, url: msg.url, level: 'critical' })
  })
})

describe('line sender', () => {
  it('pushes a text message with the channel token', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 200 }))
    const res = await lineSender.send(channel('line', 'U1234567890'), msg, { config, fetch: f.fn })
    expect(res.ok).toBe(true)
    const c = f.calls[0]!
    expect(c.url).toBe('https://api.line.me/v2/bot/message/push')
    expect(c.headers.authorization).toBe('Bearer line-token')
    expect(c.headers['x-line-retry-key']).toMatch(/^[0-9a-f-]{36}$/)
    const body = JSON.parse(String(c.body)) as { to: string; messages: { type: string; text: string }[] }
    expect(body.to).toBe('U1234567890')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]!.type).toBe('text')
    expect(body.messages[0]!.text).toContain(msg.title)
  })

  it('caps text at 5000 characters', async () => {
    const f = fakeFetch()
    await lineSender.send(channel('line', 'U1'), { ...msg, body: 'ก'.repeat(9000) }, { config, fetch: f.fn })
    const text = (JSON.parse(String(f.calls[0]!.body)) as { messages: { text: string }[] }).messages[0]!.text
    expect(Array.from(text).length).toBeLessThanOrEqual(5000)
  })

  it('marks clearly blocked / invalid recipients as gone only', async () => {
    const invalidTo = fakeFetch(
      () => new Response(JSON.stringify({ message: "The property, 'to', in the request body is invalid (line: -, column: -)" }), { status: 400 }),
    )
    expect((await lineSender.send(channel('line', 'Ubad'), msg, { config, fetch: invalidTo.fn })).gone).toBe(true)

    const quota = fakeFetch(() => new Response(JSON.stringify({ message: 'You have reached your monthly limit.' }), { status: 429 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = await lineSender.send(channel('line', 'U1'), msg, { config, fetch: quota.fn })
    // The upstream message goes to the server log, never into the delivery record.
    expect(r).toEqual({ ok: false, error: 'HTTP 429', gone: false })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('monthly limit')
    logSpy.mockRestore()

    const badToken = fakeFetch(() => new Response(JSON.stringify({ message: 'Authentication failed' }), { status: 401 }))
    expect((await lineSender.send(channel('line', 'U1'), msg, { config, fetch: badToken.fn })).gone).toBe(false)
    expect(lineRecipientGone(400, 'Failed to send messages')).toBe(false)
    expect(lineRecipientGone(403, "The user hasn't added the LINE Official Account as a friend")).toBe(true)
  })

  it('refuses unlinked channels and reports configuration', async () => {
    const f = fakeFetch()
    expect((await lineSender.send(channel('line', ''), msg, { config, fetch: f.fn })).ok).toBe(false)
    expect(f.calls).toHaveLength(0)
    expect(lineSender.isConfigured(loadConfig({}))).toBe(false)
  })
})

describe('telegram sender', () => {
  it('calls sendMessage with chat_id and link previews disabled', async () => {
    const f = fakeFetch(() => Response.json({ ok: true, result: {} }))
    const res = await telegramSender.send(channel('telegram', '987654'), msg, { config, fetch: f.fn })
    expect(res.ok).toBe(true)
    const c = f.calls[0]!
    expect(c.url).toBe('https://api.telegram.org/bot123:ABC/sendMessage')
    expect(JSON.parse(String(c.body))).toMatchObject({ chat_id: '987654', link_preview_options: { is_disabled: true } })
  })

  it('treats 403 (bot blocked) as gone, 429 as retryable', async () => {
    const blocked = fakeFetch(() => Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 }))
    const r1 = await telegramSender.send(channel('telegram', '1'), msg, { config, fetch: blocked.fn })
    expect(r1).toEqual({ ok: false, error: 'HTTP 403', gone: true })
    expect(blocked.calls[0]!.redirect).toBe('manual')

    const notFound = fakeFetch(() => Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 }))
    expect((await telegramSender.send(channel('telegram', '1'), msg, { config, fetch: notFound.fn })).gone).toBe(true)

    const limited = fakeFetch(() => Response.json({ ok: false, description: 'Too Many Requests: retry after 5' }, { status: 429 }))
    expect((await telegramSender.send(channel('telegram', '1'), msg, { config, fetch: limited.fn })).gone).toBe(false)
  })

  it('never leaks the bot token in network errors', async () => {
    const boom = (async (u: RequestInfo | URL) => {
      throw new Error(`request to ${String(u)} failed`)
    }) as typeof fetch
    const r = await telegramSender.send(channel('telegram', '1'), msg, { config, fetch: boom })
    expect(r.error).not.toContain('123:ABC')
  })
})

describe('ntfy sender', () => {
  it('publishes JSON to the server root with priority, tags and click', async () => {
    const f = fakeFetch(() => Response.json({ id: 'x' }))
    const res = await ntfySender.send(channel('ntfy', 'fm-home-1234'), msg, { config, fetch: f.fn })
    expect(res.ok).toBe(true)
    const c = f.calls[0]!
    expect(c.url).toBe('https://ntfy.sh/')
    const body = JSON.parse(String(c.body)) as Record<string, unknown>
    expect(body).toMatchObject({ topic: 'fm-home-1234', priority: 5, click: msg.url })
    expect(body.title).toBe(msg.title)
    expect(body.tags).toContain('rotating_light')
    expect(String(body.message)).toContain('พื้นที่: บ้าน')
  })

  it('maps priorities 4 for warning and 3 otherwise', async () => {
    for (const [level, p] of [['warning', 4], ['watch', 3], ['normal', 3]] as const) {
      const f = fakeFetch()
      await ntfySender.send(channel('ntfy', 'topic1'), { ...msg, level }, { config, fetch: f.fn })
      expect((JSON.parse(String(f.calls[0]!.body)) as { priority: number }).priority).toBe(p)
    }
  })

  it('keeps the message under ntfy\'s 4096-byte limit', async () => {
    const f = fakeFetch()
    await ntfySender.send(channel('ntfy', 'topic1'), { ...msg, body: 'น้ำท่วม'.repeat(1000) }, { config, fetch: f.fn })
    const message = (JSON.parse(String(f.calls[0]!.body)) as { message: string }).message
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(3900)
  })

  it('supports full https topic URLs on custom servers', async () => {
    const f = fakeFetch()
    await ntfySender.send(channel('ntfy', 'https://ntfy.example.org/alerts_home'), msg, { config, fetch: f.fn })
    expect(f.calls[0]!.url).toBe('https://ntfy.example.org/')
    expect(f.calls[0]!.redirect).toBe('manual')
    expect((JSON.parse(String(f.calls[0]!.body)) as { topic: string }).topic).toBe('alerts_home')
    expect(ntfyTarget('http://10.0.0.1/topic', 'https://ntfy.sh')).toBeNull()
    expect(ntfyTarget('bad topic!', 'https://ntfy.sh')).toBeNull()
    expect(ntfyTarget('topic1', 'https://ntfy.sh')).toEqual({ server: 'https://ntfy.sh', topic: 'topic1', custom: false })
  })

  it('refuses custom servers on private addresses and does not follow redirects', async () => {
    const f = fakeFetch()
    const r = await ntfySender.send(channel('ntfy', 'https://internal.evil.example/topic'), msg, { config, fetch: f.fn })
    expect(r).toEqual({ ok: false, error: 'blocked destination (private-address)' })
    expect(f.calls).toHaveLength(0)

    // PoC from the review: a public "ntfy server" answers 302 to an internal admin URL.
    const hop = fakeFetch((c) =>
      c.url.startsWith('https://ntfy.example.org')
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:18081/admin' } })
        : new Response('INTERNAL-SECRET', { status: 403 }),
    )
    const r2 = await ntfySender.send(channel('ntfy', 'https://ntfy.example.org/topic'), msg, { config, fetch: hop.fn })
    expect(r2).toEqual({ ok: false, error: 'HTTP 302 (redirect not followed)' })
    expect(hop.calls.map((c) => c.url)).toEqual(['https://ntfy.example.org/'])
  })

  it('topic-only channels use the operator\'s NTFY_BASE_URL without a DNS check', async () => {
    const lan = loadConfig({ NTFY_BASE_URL: 'http://ntfy.lan:8080' })
    const f = fakeFetch()
    const r = await ntfySender.send(channel('ntfy', 'topic1'), msg, { config: lan, fetch: f.fn, lookup: async () => ['10.0.0.2'] })
    expect(r.ok).toBe(true)
    expect(f.calls[0]!.url).toBe('http://ntfy.lan:8080/')
  })

  it('reports HTTP errors without the response body and without marking the topic gone', async () => {
    const f = fakeFetch(() => new Response('INTERNAL-SECRET: admin panel token=abc123', { status: 429 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = await ntfySender.send(channel('ntfy', 'topic1'), msg, { config, fetch: f.fn })
    expect(r).toEqual({ ok: false, error: 'HTTP 429' })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('INTERNAL-SECRET')
    logSpy.mockRestore()
  })

  it('reads at most a bounded excerpt of an error body', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new TextEncoder().encode('x'.repeat(4096)))
      },
    })
    const text = await readErrorBody(new Response(endless, { status: 500 }), 300)
    expect(text).toBe('x'.repeat(300))
    expect(pulled).toBeLessThan(5)
  })
})

describe('email sender (Resend)', () => {
  it('posts from/to/subject/text/html with the API key', async () => {
    const f = fakeFetch(() => Response.json({ id: 'em_1' }))
    const res = await emailSender.send(channel('email', 'someone@example.com'), msg, { config, fetch: f.fn })
    expect(res.ok).toBe(true)
    const c = f.calls[0]!
    expect(c.url).toBe('https://api.resend.com/emails')
    expect(c.headers.authorization).toBe('Bearer re_test')
    const body = JSON.parse(String(c.body)) as Record<string, string>
    expect(body.from).toBe('Flood Monitor <alerts@example.org>')
    expect(body.to).toBe('someone@example.com')
    expect(body.subject).toContain('วิกฤต')
    expect(body.text).toContain(msg.url)
    expect(body.html).toContain('<html')
  })

  it('reports Resend errors by status only and requires configuration', async () => {
    const f = fakeFetch(() => Response.json({ statusCode: 422, message: 'Invalid `to` field.' }, { status: 422 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = await emailSender.send(channel('email', 'x@example.com'), msg, { config, fetch: f.fn })
    expect(r).toEqual({ ok: false, error: 'HTTP 422' })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Invalid `to` field.')
    logSpy.mockRestore()
    expect(emailSender.isConfigured(loadConfig({ RESEND_API_KEY: 'k' }))).toBe(false)
    const none = await sendEmail(f.fn, loadConfig({}), confirmationEmail('a@b.co', 'https://x/confirm'))
    expect(none.ok).toBe(false)
  })

  it('builds a Thai confirmation e-mail with the link and no user-supplied text', () => {
    const mail = confirmationEmail('a@b.co', 'https://flood.example.org/api/email/confirm?code=abc')
    expect(mail.subject).toBe('Flood Monitor: ยืนยันการรับการแจ้งเตือนน้ำท่วม')
    expect(mail.text).toContain('https://flood.example.org/api/email/confirm?code=abc')
    expect(mail.text).toContain('ยืนยันการรับแจ้งเตือน')
    expect(mail.html).toContain('href="https://flood.example.org/api/email/confirm?code=abc"')
  })
})

describe('discord sender', () => {
  const hook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123456'

  it('posts content ≤ 2000 chars as "Flood Monitor" with mentions disabled', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }))
    const res = await discordSender.send(channel('discord', hook), { ...msg, body: 'x'.repeat(5000) }, { config, fetch: f.fn })
    expect(res.ok).toBe(true)
    const body = JSON.parse(String(f.calls[0]!.body)) as { content: string; username: string; allowed_mentions: unknown }
    expect(f.calls[0]!.url).toBe(hook)
    expect(body.username).toBe('Flood Monitor')
    expect(Array.from(body.content).length).toBeLessThanOrEqual(2000)
    expect(body.allowed_mentions).toEqual({ parse: [] })
  })

  it('does not follow redirects from the webhook URL', async () => {
    const f = fakeFetch(() => new Response(null, { status: 301, headers: { location: 'http://10.0.0.1/' } }))
    const r = await discordSender.send(channel('discord', hook), msg, { config, fetch: f.fn })
    expect(r).toEqual({ ok: false, error: 'HTTP 301 (redirect not followed)', gone: false })
    expect(f.calls[0]!.redirect).toBe('manual')
  })

  it('marks a deleted webhook (404) as gone', async () => {
    const f = fakeFetch(() => Response.json({ message: 'Unknown Webhook', code: 10015 }, { status: 404 }))
    expect(await discordSender.send(channel('discord', hook), msg, { config, fetch: f.fn })).toMatchObject({ ok: false, gone: true })
    const f2 = fakeFetch(() => new Response('oops', { status: 500 }))
    expect((await discordSender.send(channel('discord', hook), msg, { config, fetch: f2.fn })).gone).toBe(false)
  })

  it('accepts only discord.com webhook URLs', () => {
    expect(isDiscordWebhookUrl(hook)).toBe(true)
    expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(isDiscordWebhookUrl('https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')).toBe(false)
    expect(isDiscordWebhookUrl('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz')).toBe(false)
    expect(isDiscordWebhookUrl('https://discord.com.evil.example/api/webhooks/1/abc')).toBe(false)
  })
})

describe('getSenders / availableChannels', () => {
  it('has one sender per channel type', () => {
    expect(getSenders().map((s) => s.type).sort()).toEqual(['discord', 'email', 'line', 'ntfy', 'telegram', 'webpush'])
  })

  it('reports which channels the server can offer', () => {
    expect(availableChannels(loadConfig({}))).toEqual({
      webpush: false,
      line: false,
      telegram: false,
      ntfy: true,
      email: false,
      discord: true,
    })
    expect(availableChannels(config)).toEqual({ webpush: true, line: true, telegram: true, ntfy: true, email: true, discord: true })
    expect(availableChannels(loadConfig({ TELEGRAM_BOT_TOKEN: 't' })).telegram).toBe(false)
  })
})
