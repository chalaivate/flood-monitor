import type { AppConfig } from '../config'
import type { Store } from '../store/types'
import { BOT_TEXT, isStatusRequest, linkByCode, placesForTarget, unlinkTarget } from './linking'
import { log } from './log'
import { LIMITS, rateLimiter } from './rate-limit'
import { statusForTargets } from './snapshot'

// Chat-bot conversation logic shared by the LINE and Telegram webhooks. Returns
// the reply texts; the caller sends them with its platform's API.

export interface ChatTextInput {
  store: Store
  config: AppConfig
  type: 'line' | 'telegram'
  /** LINE userId/groupId/roomId or Telegram chat id. */
  target: string
  text: string
  /** 1:1 chat (we stay quiet about unrecognised messages in groups). */
  isPrivate: boolean
  now?: Date
}

export async function replyStatus(input: Omit<ChatTextInput, 'text' | 'isPrivate'>): Promise<string[]> {
  const { store, config, type, target } = input
  if (!rateLimiter().take(`status:${type}:${target}`, LIMITS.webhookStatus).ok) return [BOT_TEXT.busy]
  const places = await placesForTarget(store, type, target)
  if (places.length === 0) return [BOT_TEXT.noPlaces]
  try {
    return await statusForTargets(store, config, places.slice(0, 5), { now: input.now })
  } catch (err) {
    log(`[bot] ${type} status failed: ${err instanceof Error ? err.message : String(err)}`)
    return [BOT_TEXT.statusError]
  }
}

/** Handle one text message (after any platform command prefix was handled). */
export async function handleChatText(input: ChatTextInput): Promise<string[]> {
  const { store, type, target, text } = input
  if (isStatusRequest(text)) return replyStatus(input)
  const out = await linkByCode(store, type, text, target)
  if (out.status === 'linked') {
    log(`[bot] ${type} channel ${out.channel.id} linked to place ${out.channel.placeId}`)
    return [BOT_TEXT.linked(out.place?.label ?? 'จุดเฝ้าระวัง')]
  }
  if (out.status === 'not_found') return input.isPrivate || text.trim().length <= 8 ? [BOT_TEXT.notFound] : []
  return input.isPrivate ? [BOT_TEXT.help] : []
}

/** /stop, unfollow, bot kicked: forget every channel bound to this chat. */
export async function handleUnlink(store: Store, type: 'line' | 'telegram', target: string): Promise<string> {
  const n = await unlinkTarget(store, type, target)
  if (n > 0) log(`[bot] removed ${n} ${type} channel(s) for a chat that left`)
  return BOT_TEXT.stopped(n)
}
