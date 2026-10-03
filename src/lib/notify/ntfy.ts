import type { Channel, Level } from '../types'
import { SEND_TIMEOUT_MS, bodyWithLink, titleLine, truncate, truncateBytes } from './format'
import { classifyResponse, fetchUserTarget, sendErrorText } from './http'
import type { ChannelSender, NotifyMessage, SendResult } from './types'

// ntfy JSON publishing: POST {topic, title, message, ...} to the server root.
// A channel target is either a topic on NTFY_BASE_URL or a full topic URL on a
// self-hosted server (https://ntfy.example.org/my-topic).

export const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/

const PRIORITY: Record<Level, number> = { critical: 5, warning: 4, watch: 3, normal: 3, unknown: 3 }
/** ntfy tags that match an emoji short code are shown as icons in the app. */
const TAGS: Record<Level, string[]> = {
  critical: ['rotating_light', 'flood'],
  warning: ['warning', 'flood'],
  watch: ['droplet', 'flood'],
  normal: ['white_check_mark', 'flood'],
  unknown: ['grey_question', 'flood'],
}

/**
 * Resolve a channel target to the server root and topic. `custom` marks a server the
 * user chose (full topic URL) as opposed to the operator's NTFY_BASE_URL.
 */
export function ntfyTarget(target: string, baseUrl: string): { server: string; topic: string; custom: boolean } | null {
  const t = target.trim()
  if (NTFY_TOPIC_RE.test(t)) return { server: baseUrl.replace(/\/+$/, ''), topic: t, custom: false }
  try {
    const u = new URL(t)
    // https only: a public API must not be usable to POST into a private network.
    if (u.protocol !== 'https:') return null
    const topic = u.pathname.replace(/^\/+|\/+$/g, '')
    if (!NTFY_TOPIC_RE.test(topic) || u.username || u.password) return null
    return { server: u.origin, topic, custom: true }
  } catch {
    return null
  }
}

export const ntfySender: ChannelSender = {
  type: 'ntfy',
  isConfigured: () => true,

  async send(channel: Channel, msg: NotifyMessage, ctx): Promise<SendResult> {
    const dest = ntfyTarget(channel.target, ctx.config.NTFY_BASE_URL)
    if (!dest) return { ok: false, error: 'invalid ntfy topic', gone: true }
    const payload: Record<string, unknown> = {
      topic: dest.topic,
      title: truncate(titleLine(msg), 250),
      // ntfy turns messages over 4096 bytes into file attachments.
      message: truncateBytes(bodyWithLink(msg), 3900),
      priority: PRIORITY[msg.level],
      tags: TAGS[msg.level],
    }
    if (msg.url) payload.click = msg.url
    try {
      // A user-chosen server gets the SSRF check; NTFY_BASE_URL is operator config and
      // may legitimately be a LAN host. Redirects are refused either way.
      const res = await fetchUserTarget(
        ctx,
        `${dest.server}/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
        { checkHost: dest.custom },
      )
      return (await classifyResponse('ntfy', res)).result
    } catch (err) {
      return { ok: false, error: sendErrorText(err) }
    }
  },
}
