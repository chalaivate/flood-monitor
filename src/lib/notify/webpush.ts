import { createHash } from 'node:crypto'
import webpush from 'web-push'
import type { AppConfig } from '../config'
import type { Channel } from '../types'
import { SEND_TIMEOUT_MS, errorMessage, readErrorBody, truncate } from './format'
import type { ChannelSender, NotifyMessage, SendResult } from './types'

// Web Push (VAPID). web-push only builds the encrypted request; we send it with the
// injected fetch so delivery is testable and shares the app's timeout handling.

/** Push services keep undelivered messages this long (seconds). */
export const WEBPUSH_TTL_S = 6 * 3600
/** Encrypted payload limit is 4096 bytes; leave room for the aes128gcm header. */
const MAX_PAYLOAD_BYTES = 3800

/** Payload the service worker (public/sw.js) receives in `event.data.json()`. */
export interface WebPushPayload {
  title: string
  body: string
  url?: string
  tag?: string
  level: NotifyMessage['level']
}

export interface PushSubscriptionJson {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

const b64urlBytes = (s: string): number => (/^[A-Za-z0-9_-]+={0,2}$/.test(s) ? Buffer.from(s, 'base64url').length : -1)

/**
 * Parse a stored PushSubscription JSON. Returns null unless the endpoint is https
 * and the keys have the sizes RFC 8291 requires (p256dh 65 bytes, auth 16 bytes).
 */
export function parseSubscription(target: string): PushSubscriptionJson | null {
  try {
    const v = JSON.parse(target) as Partial<PushSubscriptionJson> | null
    if (!v || typeof v.endpoint !== 'string' || !v.keys) return null
    const { p256dh, auth } = v.keys
    if (typeof p256dh !== 'string' || typeof auth !== 'string') return null
    if (b64urlBytes(p256dh) !== 65 || b64urlBytes(auth) !== 16) return null
    const url = new URL(v.endpoint)
    if (url.protocol !== 'https:') return null
    return { endpoint: v.endpoint, expirationTime: v.expirationTime ?? null, keys: { p256dh, auth } }
  } catch {
    return null
  }
}

/** JSON payload trimmed (body first) to fit the push service size limit. */
export function buildPayload(msg: NotifyMessage): string {
  const base: WebPushPayload = { title: truncate(msg.title, 120), body: msg.body, url: msg.url, tag: msg.tag, level: msg.level }
  let body = msg.body
  for (;;) {
    const json = JSON.stringify({ ...base, body })
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES || body.length === 0) return json
    const n = Array.from(body).length
    body = n <= 1 ? '' : truncate(body, Math.floor(n * 0.8))
  }
}

/** Push-service Topic header: ≤ 32 URL-safe base64 chars; same tag ⇒ same topic (replaces queued pushes). */
export function topicFor(tag: string | undefined): string | undefined {
  if (!tag) return undefined
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32)
}

export function vapidSubject(config: AppConfig): string {
  if (config.VAPID_SUBJECT) return config.VAPID_SUBJECT
  if (config.PUBLIC_BASE_URL?.startsWith('https://')) return config.PUBLIC_BASE_URL
  return 'mailto:flood-monitor@example.com'
}

export const webPushSender: ChannelSender = {
  type: 'webpush',
  isConfigured: (config) => !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY),

  async send(channel: Channel, msg: NotifyMessage, ctx): Promise<SendResult> {
    const sub = parseSubscription(channel.target)
    if (!sub) return { ok: false, error: 'invalid push subscription', gone: true }
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = ctx.config
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { ok: false, error: 'VAPID keys not configured' }

    let details: ReturnType<typeof webpush.generateRequestDetails>
    try {
      details = webpush.generateRequestDetails(sub, buildPayload(msg), {
        vapidDetails: { subject: vapidSubject(ctx.config), publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY },
        TTL: WEBPUSH_TTL_S,
        urgency: msg.level === 'warning' || msg.level === 'critical' ? 'high' : 'normal',
        topic: topicFor(msg.tag),
        contentEncoding: 'aes128gcm',
      })
    } catch (err) {
      // The subscription was validated above, so this is a server-side VAPID problem.
      return { ok: false, error: errorMessage(err) }
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(details.headers)) {
      // fetch computes Content-Length itself.
      if (k.toLowerCase() !== 'content-length') headers[k] = String(v)
    }
    try {
      const res = await ctx.fetch(details.endpoint, {
        method: 'POST',
        headers,
        body: details.body ? new Uint8Array(details.body) : undefined,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (res.ok) {
        await res.arrayBuffer().catch(() => undefined)
        return { ok: true }
      }
      const text = await readErrorBody(res, 200)
      const gone = res.status === 404 || res.status === 410
      return { ok: false, error: `push service HTTP ${res.status}${text ? `: ${text}` : ''}`, gone }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  },
}
