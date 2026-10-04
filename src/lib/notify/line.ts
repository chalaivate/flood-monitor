import type { Channel } from '../types'
import { SEND_TIMEOUT_MS, errorMessage, plainText, readErrorBody, truncate } from './format'
import { discardBody, logHttpFailure } from './http'
import type { ChannelSender, NotifyMessage, SendResult } from './types'

// LINE Messaging API. Push messages count against the Official Account's monthly
// quota; replies (webhook replyToken) are free.

export const LINE_API = 'https://api.line.me/v2/bot'
/** LINE text message limit. */
export const LINE_TEXT_MAX = 5000

export interface LineTextMessage {
  type: 'text'
  text: string
}

/** True when a LINE error clearly says the recipient can no longer receive pushes. */
export function lineRecipientGone(status: number, body: string): boolean {
  if (status !== 400 && status !== 403 && status !== 404) return false
  return /not (a )?friend|hasn't added|blocked|invalid user|user not found|'to'.*invalid|property, 'to'/i.test(body)
}

async function linePost(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<SendResult> {
  try {
    const res = await fetchImpl(`${LINE_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (res.ok) {
      await discardBody(res)
      return { ok: true }
    }
    const body = await readErrorBody(res)
    let detail = body
    try {
      const j = JSON.parse(body) as { message?: string; details?: { message?: string }[] }
      detail = [j.message, ...(j.details ?? []).map((d) => d.message)].filter(Boolean).join('; ') || body
    } catch {
      // keep raw body
    }
    // The detail stays in the server log; deliveries only get the status.
    return { ok: false, error: logHttpFailure('LINE', res.status, detail), gone: lineRecipientGone(res.status, body) }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

export function lineText(text: string): LineTextMessage {
  return { type: 'text', text: truncate(text, LINE_TEXT_MAX) }
}

/** POST /message/push to a userId / groupId. */
export function linePush(fetchImpl: typeof fetch, token: string, to: string, messages: LineTextMessage[]): Promise<SendResult> {
  // X-Line-Retry-Key makes a retried request idempotent on LINE's side.
  return linePost(fetchImpl, token, '/message/push', { to, messages }, { 'X-Line-Retry-Key': crypto.randomUUID() })
}

/** POST /message/reply with a webhook replyToken (free, valid ~1 minute). */
export function lineReply(fetchImpl: typeof fetch, token: string, replyToken: string, messages: LineTextMessage[]): Promise<SendResult> {
  return linePost(fetchImpl, token, '/message/reply', { replyToken, messages })
}

export const lineSender: ChannelSender = {
  type: 'line',
  isConfigured: (config) => !!config.LINE_CHANNEL_ACCESS_TOKEN,

  async send(channel: Channel, msg: NotifyMessage, ctx): Promise<SendResult> {
    const token = ctx.config.LINE_CHANNEL_ACCESS_TOKEN
    if (!token) return { ok: false, error: 'LINE not configured' }
    if (!channel.target) return { ok: false, error: 'LINE channel not linked yet' }
    return linePush(ctx.fetch, token, channel.target, [lineText(plainText(msg, LINE_TEXT_MAX))])
  },
}
