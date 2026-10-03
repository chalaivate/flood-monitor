import { getConfig } from '@/lib/config'
import { availableChannels } from '@/lib/notify'
import { confirmationEmail, sendEmail } from '@/lib/notify/email'
import { parseSubscription } from '@/lib/notify/webpush'
import { hashToken } from '@/lib/server/auth'
import { emailConfirmCode, generateLinkCode, isLinkCodeExpired, validateChannelTarget } from '@/lib/server/channels'
import { lateFetch } from '@/lib/server/context'
import { clientIp, handler, HttpError, json, MSG, publicOrigin, readJson, type RouteCtx } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { authorizePlace } from '@/lib/server/places'
import { maskTarget, toPublicChannel, type ChannelLink } from '@/lib/server/public'
import { enforceClientLimit, LIMITS, rateLimiter } from '@/lib/server/rate-limit'
import { ChannelInputSchema } from '@/lib/server/validation'
import { getStore } from '@/lib/store'
import type { Channel } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = RouteCtx<{ id: string }>

const MAX_CHANNELS_PER_PLACE = 10

/** GET /api/places/[id]/channels → { channels: PublicChannel[] } */
export const GET = handler('channels GET', async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  return json({ channels: (await store.listChannels(place.id)).map(toPublicChannel) })
})

/**
 * POST /api/places/[id]/channels body { type, target? } → { channel, link? }
 * webpush / ntfy / discord are active immediately; LINE / Telegram wait for the
 * link code to reach the bot; e-mail waits for the confirmation link.
 */
export const POST = handler('channels POST', async (req: Request, ctx: Ctx) => {
  // Per client IP (when a trusted proxy supplies it) plus a server-wide backstop.
  enforceClientLimit('channel', clientIp(req), LIMITS.channelCreate, LIMITS.channelCreateGlobal)
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  const input = ChannelInputSchema.parse(await readJson(req, 16 * 1024))
  const config = getConfig()
  if (!availableChannels(config)[input.type]) {
    throw new HttpError(400, 'ช่องทางแจ้งเตือนนี้ยังไม่เปิดใช้งานบนเซิร์ฟเวอร์นี้')
  }
  // URLs (ntfy server, push endpoint, Discord) are SSRF-checked here, DNS included.
  const target = await validateChannelTarget(input.type, input.target)
  if (!target.ok) throw new HttpError(400, target.error)

  let existing = await store.listChannels(place.id)
  let replacedEmail: Channel[] = []
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const respond = (channel: Channel, status: number, link?: ChannelLink) =>
    json({ channel: toPublicChannel(channel), ...(link ? { link } : {}) }, { status })

  // --- re-use instead of duplicating ------------------------------------------------
  if (input.type === 'webpush') {
    const endpoint = parseSubscription(target.target)?.endpoint
    const same = existing.find((c) => c.type === 'webpush' && parseSubscription(c.target)?.endpoint === endpoint)
    if (same) {
      const updated = { ...same, target: target.target, verified: true }
      await store.updateChannel(updated)
      return respond(updated, 200)
    }
  } else if (input.type === 'ntfy' || input.type === 'discord') {
    const same = existing.find((c) => c.type === input.type && c.target === target.target)
    if (same) return respond(same, 200)
  } else if (input.type === 'email') {
    const same = existing.find((c) => c.type === 'email' && c.target === target.target && c.verified)
    if (same) return respond(same, 200)
    // At most one pending e-mail channel per place: a new request replaces the old one
    // (deleted below, once the request passed the e-mail limits).
    replacedEmail = existing.filter((c) => c.type === 'email' && !c.verified)
    existing = existing.filter((c) => !replacedEmail.includes(c))
  } else {
    // LINE / Telegram: hand out the pending code again rather than piling up channels,
    // unless it expired: then it is replaced by a new pending channel with a fresh code.
    const pending = existing.filter((c) => c.type === input.type && !c.verified && c.linkCode)
    const live = pending.find((c) => !isLinkCodeExpired(c, nowDate))
    if (live) return respond(live, 200, chatLink(input.type, live.linkCode!, config))
    for (const c of pending) await store.deleteChannel(c.id)
    if (pending.length > 0) existing = existing.filter((c) => !pending.includes(c))
  }

  if (existing.length >= MAX_CHANNELS_PER_PLACE) {
    throw new HttpError(400, `เพิ่มช่องทางแจ้งเตือนได้สูงสุด ${MAX_CHANNELS_PER_PLACE} ช่องทางต่อจุดเฝ้าระวัง`)
  }

  const channel: Channel = {
    id: crypto.randomUUID(),
    placeId: place.id,
    type: input.type,
    target: target.target,
    verified: input.type === 'webpush' || input.type === 'ntfy' || input.type === 'discord',
    linkCode: null,
    createdAt: now,
  }

  if (input.type === 'line' || input.type === 'telegram') {
    channel.linkCode = await generateLinkCode(store)
    await store.addChannel(channel)
    return respond(channel, 201, chatLink(input.type, channel.linkCode, config))
  }

  if (input.type === 'email') {
    // Anyone can type any address here, so confirmation mail is limited per recipient
    // (1 per 15 min, 3 per day; keyed by a hash so the limiter holds no addresses) and
    // server-wide. In-memory: a restart or another serverless instance starts afresh.
    const recipient = `email:${hashToken(channel.target)}`
    const limited = rateLimiter().takeAll([
      [recipient, LIMITS.emailConfirmRecipient],
      [`${recipient}:day`, LIMITS.emailConfirmRecipientDay],
      ['email:*', LIMITS.emailConfirmGlobal],
    ])
    if (!limited.ok) {
      const perAddress = limited.blocked?.some((k) => k.startsWith(recipient)) ?? false
      throw new HttpError(
        429,
        perAddress
          ? 'ส่งอีเมลยืนยันไปยังที่อยู่นี้บ่อยเกินไป กรุณาตรวจสอบกล่องจดหมาย (รวมถึงจดหมายขยะ) หรือลองใหม่ภายหลัง'
          : MSG.rateLimited,
        { 'Retry-After': String(limited.retryAfterSec) },
      )
    }
    for (const c of replacedEmail) await store.deleteChannel(c.id)
    channel.linkCode = emailConfirmCode()
    await store.addChannel(channel)
    const url = `${publicOrigin(req, config.PUBLIC_BASE_URL)}/api/email/confirm?code=${encodeURIComponent(channel.linkCode)}`
    // The mail carries no user-supplied text (not even the place label).
    const sent = await sendEmail(lateFetch, config, confirmationEmail(channel.target, url))
    if (!sent.ok) {
      log(`[api] confirmation e-mail failed: ${sent.error ?? 'unknown'}`)
      await store.deleteChannel(channel.id)
      throw new HttpError(502, 'ไม่สามารถส่งอีเมลยืนยันได้ กรุณาตรวจสอบอีเมลแล้วลองใหม่อีกครั้ง')
    }
    return respond(channel, 201, {
      instructions: `ระบบได้ส่งลิงก์ยืนยันไปที่ ${maskTarget(channel)} แล้ว กรุณาเปิดอีเมลและกดยืนยันเพื่อเริ่มรับการแจ้งเตือน (หากไม่พบ โปรดตรวจสอบในกล่องจดหมายขยะ)`,
    })
  }

  await store.addChannel(channel)
  return respond(channel, 201)
})

function chatLink(type: 'line' | 'telegram', code: string, config: ReturnType<typeof getConfig>): ChannelLink {
  if (type === 'telegram') {
    const bot = config.TELEGRAM_BOT_USERNAME?.replace(/^@/, '')
    return {
      code,
      url: bot ? `https://t.me/${bot}?start=${code}` : undefined,
      instructions: bot
        ? `เปิดลิงก์เพื่อเริ่มแชทกับบอท @${bot} แล้วกด "เริ่ม" (Start) หรือส่งข้อความ /start ${code} ให้บอท`
        : `ส่งข้อความ /start ${code} ให้บอท Telegram ของระบบ`,
    }
  }
  return {
    code,
    url: config.LINE_ADD_FRIEND_URL,
    instructions: `เพิ่มเพื่อน LINE Official Account ของระบบ แล้วส่งรหัส ${code} ในแชท`,
  }
}
