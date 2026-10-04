import { getConfig } from '@/lib/config'
import { lineReply, lineText } from '@/lib/notify/line'
import { verifyLineSignature } from '@/lib/server/auth'
import { handleChatText, handleUnlink } from '@/lib/server/bots'
import { lateFetch } from '@/lib/server/context'
import { HttpError, json, jsonError, readTextCapped } from '@/lib/server/http'
import { BOT_TEXT } from '@/lib/server/linking'
import { log } from '@/lib/server/log'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 1024 * 1024

interface LineSource {
  type?: 'user' | 'group' | 'room'
  userId?: string
  groupId?: string
  roomId?: string
}

interface LineEvent {
  type?: string
  mode?: string
  replyToken?: string
  source?: LineSource
  message?: { type?: string; text?: string }
}

/** Where alerts for this chat go: the group/room when in one, else the user. */
function chatTarget(src: LineSource | undefined): string | null {
  if (!src) return null
  if (src.type === 'group') return src.groupId ?? null
  if (src.type === 'room') return src.roomId ?? null
  return src.userId ?? null
}

/**
 * POST /api/line/webhook — LINE Messaging API webhook.
 * Signature: X-Line-Signature = base64(HMAC-SHA256(LINE_CHANNEL_SECRET, raw body)).
 */
export async function POST(req: Request): Promise<Response> {
  const config = getConfig()
  const secret = config.LINE_CHANNEL_SECRET
  const token = config.LINE_CHANNEL_ACCESS_TOKEN
  if (!secret || !token) return jsonError(503, 'ระบบยังไม่ได้ตั้งค่า LINE')

  // Cheap checks before touching the body: an unsigned request is refused outright and
  // the body is read with a hard cap (declared Content-Length first, then while streaming).
  const signature = req.headers.get('x-line-signature')
  if (!signature) return jsonError(401, 'ลายเซ็นไม่ถูกต้อง')
  let raw: string
  try {
    raw = await readTextCapped(req, MAX_BODY)
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.message)
    throw err
  }
  if (!verifyLineSignature(secret, raw, signature)) {
    return jsonError(401, 'ลายเซ็นไม่ถูกต้อง')
  }

  let events: LineEvent[] = []
  try {
    const body = JSON.parse(raw) as { events?: unknown }
    events = Array.isArray(body.events) ? (body.events as LineEvent[]) : []
  } catch {
    return jsonError(400, 'รูปแบบข้อมูลไม่ถูกต้อง')
  }

  const store = await getStore()
  const reply = async (replyToken: string | undefined, texts: string[]) => {
    if (!replyToken || texts.length === 0) return
    const res = await lineReply(lateFetch, token, replyToken, texts.slice(0, 5).map(lineText))
    if (!res.ok) log(`[line] reply failed: ${res.error ?? 'unknown'}`)
  }

  for (const ev of events) {
    try {
      // Another channel (e.g. LINE OA chat mode) owns the conversation.
      if (ev.mode === 'standby') continue
      const target = chatTarget(ev.source)
      if (!target) continue
      switch (ev.type) {
        case 'follow':
        case 'join':
          await reply(ev.replyToken, [BOT_TEXT.greeting])
          break
        case 'unfollow':
        case 'leave':
          await handleUnlink(store, 'line', target)
          break
        case 'message':
          if (ev.message?.type === 'text' && typeof ev.message.text === 'string') {
            const texts = await handleChatText({
              store,
              config,
              type: 'line',
              target,
              text: ev.message.text.slice(0, 2000),
              isPrivate: (ev.source?.type ?? 'user') === 'user',
            })
            await reply(ev.replyToken, texts)
          }
          break
        default:
          break
      }
    } catch (err) {
      log(`[line] event ${ev.type ?? '?'} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // LINE only needs a 2xx; errors were logged per event.
  return json({ ok: true })
}
