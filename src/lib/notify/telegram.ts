import type { Channel } from '../types'
import { SEND_TIMEOUT_MS, errorMessage, plainText, readErrorBody } from './format'
import { logHttpFailure } from './http'
import type { ChannelSender, NotifyMessage, SendResult } from './types'

// Telegram Bot API sendMessage (plain text, no parse_mode so user-supplied labels
// never break formatting).

export const TELEGRAM_API = 'https://api.telegram.org'
/** Telegram text message limit. */
export const TELEGRAM_TEXT_MAX = 4096

/** The chat can no longer receive messages from the bot. */
export function telegramChatGone(status: number, description: string): boolean {
  if (status === 403) return true // bot was blocked / kicked / user deactivated
  if (status === 400) return /chat not found|user not found|chat_id is empty|PEER_ID_INVALID|group chat was upgraded/i.test(description)
  return false
}

export async function telegramSendMessage(
  fetchImpl: typeof fetch,
  token: string,
  chatId: string,
  text: string,
): Promise<SendResult> {
  try {
    const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: Array.from(text).slice(0, TELEGRAM_TEXT_MAX).join(''),
        // Bot API 7+ replaced `disable_web_page_preview` with link_preview_options.
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'manual',
    })
    const raw = await readErrorBody(res, 2000)
    let description = raw
    let ok = res.ok
    try {
      const j = JSON.parse(raw) as { ok?: boolean; description?: string }
      if (typeof j.ok === 'boolean') ok = res.ok && j.ok
      description = j.description ?? raw
    } catch {
      // non-JSON body
    }
    if (ok) return { ok: true }
    // The description stays in the server log; deliveries only get the status.
    return {
      ok: false,
      error: logHttpFailure('Telegram', res.status, description.replaceAll(token, '<token>')),
      gone: telegramChatGone(res.status, description),
    }
  } catch (err) {
    // Never leak the bot token (it is part of the URL) through error text.
    return { ok: false, error: errorMessage(err).replaceAll(token, '<token>') }
  }
}

export const telegramSender: ChannelSender = {
  type: 'telegram',
  isConfigured: (config) => !!config.TELEGRAM_BOT_TOKEN,

  async send(channel: Channel, msg: NotifyMessage, ctx): Promise<SendResult> {
    const token = ctx.config.TELEGRAM_BOT_TOKEN
    if (!token) return { ok: false, error: 'Telegram not configured' }
    if (!channel.target) return { ok: false, error: 'Telegram channel not linked yet' }
    return telegramSendMessage(ctx.fetch, token, channel.target, plainText(msg, TELEGRAM_TEXT_MAX))
  },
}
