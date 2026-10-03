import { getConfig } from '@/lib/config'
import { availableChannels } from '@/lib/notify'
import { confirmationEmail, sendEmail } from '@/lib/notify/email'
import { parseSubscription } from '@/lib/notify/webpush'
import { emailConfirmCode, generateLinkCode, validateChannelTarget } from '@/lib/server/channels'
import { lateFetch } from '@/lib/server/context'
import { clientIp, handler, HttpError, json, publicOrigin, readJson, type RouteCtx } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { authorizePlace } from '@/lib/server/places'
import { maskTarget, toPublicChannel, type ChannelLink } from '@/lib/server/public'
import { enforceLimit, LIMITS } from '@/lib/server/rate-limit'
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
  enforceLimit(`channel:${clientIp(req)}`, LIMITS.channelCreate)
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  const input = ChannelInputSchema.parse(await readJson(req, 16 * 1024))
  const config = getConfig()
  if (!availableChannels(config)[input.type]) {
    throw new HttpError(400, 'ช่องทางแจ้งเตือนนี้ยังไม่เปิดใช้งานบนเซิร์ฟเวอร์นี้')
  }
  const target = validateChannelTarget(input.type, input.target)
  if (!target.ok) throw new HttpError(400, target.error)

  const existing = await store.listChannels(place.id)
  const now = new Date().toISOString()
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
  } else {
    // LINE / Telegram: hand out the pending code again rather than piling up channels.
    const pending = existing.find((c) => c.type === input.type && !c.verified && c.linkCode)
    if (pending) return respond(pending, 200, chatLink(input.type, pending.linkCode!, config))
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
    // Drop an older unconfirmed request for the same address; the new link replaces it.
    for (const c of existing) {
      if (c.type === 'email' && !c.verified && c.target === channel.target) await store.deleteChannel(c.id)
    }
    channel.linkCode = emailConfirmCode()
    await store.addChannel(channel)
    const url = `${publicOrigin(req, config.PUBLIC_BASE_URL)}/api/email/confirm?code=${encodeURIComponent(channel.linkCode)}`
    const sent = await sendEmail(lateFetch, config, confirmationEmail(channel.target, place.label, url))
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
