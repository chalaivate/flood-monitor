import { getConfig } from '@/lib/config'
import { telegramSendMessage } from '@/lib/notify/telegram'
import { safeEqual } from '@/lib/server/auth'
import { handleChatText, handleUnlink, replyStatus } from '@/lib/server/bots'
import { lateFetch } from '@/lib/server/context'
import { HttpError, json, jsonError, readTextCapped } from '@/lib/server/http'
import { BOT_TEXT } from '@/lib/server/linking'
import { log } from '@/lib/server/log'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 1024 * 1024

interface TgChat {
  id?: number | string
  type?: string
}

interface TgUpdate {
  message?: { chat?: TgChat; text?: string }
  my_chat_member?: { chat?: TgChat; new_chat_member?: { status?: string } }
}

/**
 * POST /api/telegram/webhook — Telegram Bot API webhook. Register it with
 * setWebhook(url, secret_token=TELEGRAM_WEBHOOK_SECRET); Telegram then sends the
 * secret in X-Telegram-Bot-Api-Secret-Token.
 */
export async function POST(req: Request): Promise<Response> {
  const config = getConfig()
  const token = config.TELEGRAM_BOT_TOKEN
  const secret = config.TELEGRAM_WEBHOOK_SECRET
  if (!token || !secret) return jsonError(503, 'ระบบยังไม่ได้ตั้งค่า Telegram')
  const given = req.headers.get('x-telegram-bot-api-secret-token') ?? ''
  if (!safeEqual(given, secret)) return jsonError(401, 'ไม่มีสิทธิ์เข้าถึง')

  let raw: string
  try {
    raw = await readTextCapped(req, MAX_BODY)
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.message)
    throw err
  }
  let update: TgUpdate
  try {
    update = JSON.parse(raw) as TgUpdate
  } catch {
    return jsonError(400, 'รูปแบบข้อมูลไม่ถูกต้อง')
  }

  const store = await getStore()
  const send = async (chatId: string, texts: string[]) => {
    for (const text of texts) {
      const res = await telegramSendMessage(lateFetch, token, chatId, text)
      if (!res.ok) log(`[telegram] reply failed: ${res.error ?? 'unknown'}`)
    }
  }

  try {
    // The user blocked the bot or removed it from a group.
    const member = update.my_chat_member
    if (member?.chat?.id !== undefined && ['kicked', 'left'].includes(member.new_chat_member?.status ?? '')) {
      await handleUnlink(store, 'telegram', String(member.chat.id))
      return json({ ok: true })
    }

    const msg = update.message
    if (msg?.chat?.id === undefined || typeof msg.text !== 'string') return json({ ok: true })
    const chatId = String(msg.chat.id)
    const isPrivate = msg.chat.type === 'private'
    const text = msg.text.slice(0, 2000).trim()
    // "/start@MyBot CODE" → command "/start", argument "CODE".
    const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i)
    const command = m?.[1]?.toLowerCase()
    const arg = m?.[2]?.trim() ?? ''

    let replies: string[]
    if (command === 'start' || command === 'help') {
      replies = arg
        ? await handleChatText({ store, config, type: 'telegram', target: chatId, text: arg, isPrivate: true })
        : [BOT_TEXT.greeting]
    } else if (command === 'status') {
      replies = await replyStatus({ store, config, type: 'telegram', target: chatId })
    } else if (command === 'stop') {
      replies = [await handleUnlink(store, 'telegram', chatId)]
    } else if (command) {
      replies = isPrivate ? [BOT_TEXT.help] : []
    } else {
      replies = await handleChatText({ store, config, type: 'telegram', target: chatId, text, isPrivate })
    }
    await send(chatId, replies)
  } catch (err) {
    log(`[telegram] update failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Always 200 after auth: Telegram retries non-2xx updates indefinitely.
  return json({ ok: true })
}
