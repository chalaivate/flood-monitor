import type { Store } from '../store/types'
import type { Channel, ChannelType, Place } from '../types'
import { isLinkCodeExpired, LINK_CODE_LENGTH, LINK_CODE_TTL_MS } from './channels'

// Account linking for chat channels: the web UI creates an unverified LINE /
// Telegram channel with a link code; the user sends that code to our bot; the
// webhook binds the chat id to the channel.

export type LinkOutcome =
  | { status: 'linked'; channel: Channel; place: Place | null }
  | { status: 'not_found' }
  | { status: 'expired' }

/**
 * Link the pending channel of `type` whose code is `code` (see parseLinkCode) to the chat
 * `target`. Codes older than LINK_CODE_TTL_MS are refused: the owner requests a new one.
 * Callers rate-limit attempts (handleChatText).
 */
export async function linkByCode(store: Store, type: ChannelType, code: string, target: string, now: Date = new Date()): Promise<LinkOutcome> {
  const ch = await store.findChannelByLinkCode(code)
  if (!ch || ch.type !== type || ch.verified) return { status: 'not_found' }
  if (isLinkCodeExpired(ch, now)) return { status: 'expired' }
  const linked: Channel = { ...ch, target, verified: true, linkCode: null }
  await store.updateChannel(linked)
  // Avoid duplicate deliveries: one chat linked twice to the same place keeps one channel.
  for (const other of await store.listChannels(ch.placeId)) {
    if (other.id !== linked.id && other.type === type && other.verified && other.target === target) {
      await store.deleteChannel(other.id)
    }
  }
  return { status: 'linked', channel: linked, place: await store.getPlace(ch.placeId) }
}

/** Places whose verified channel of `type` points at `target`. */
export async function placesForTarget(store: Store, type: ChannelType, target: string): Promise<Place[]> {
  const ids = new Set(
    (await store.listChannels()).filter((c) => c.type === type && c.verified && c.target === target).map((c) => c.placeId),
  )
  const places: Place[] = []
  for (const id of ids) {
    const p = await store.getPlace(id)
    if (p) places.push(p)
  }
  return places
}

/** Remove every channel of `type` bound to `target` (user blocked the bot / sent /stop). */
export async function unlinkTarget(store: Store, type: ChannelType, target: string): Promise<number> {
  const mine = (await store.listChannels()).filter((c) => c.type === type && c.target === target)
  for (const c of mine) await store.deleteChannel(c.id)
  return mine.length
}

export const BOT_TEXT = {
  greeting: [
    'ขอบคุณที่เพิ่ม Flood Monitor เป็นเพื่อน',
    'ระบบนี้แจ้งเตือนเมื่อระดับน้ำในคลองใกล้บ้านใกล้ล้นตลิ่ง ฝนตกหนัก หรือมีน้ำท่วมถนน',
    '',
    'วิธีเชื่อมต่อ:',
    '1. เปิดเว็บไซต์ แล้วไปที่หน้า "ตั้งค่าแจ้งเตือน"',
    '2. กำหนดตำแหน่งบ้าน แล้วเลือกช่องทางนี้',
    `3. ส่งรหัสเชื่อมต่อ ${LINK_CODE_LENGTH} ตัวที่ได้รับมาในแชทนี้ (ส่งเฉพาะรหัสในข้อความเดียว)`,
    '',
    'พิมพ์ "สถานะ" เพื่อดูสถานการณ์ล่าสุด',
  ].join('\n'),
  linked: (label: string) =>
    `เชื่อมต่อการแจ้งเตือนสำหรับ "${label}" เรียบร้อยแล้ว\nระบบจะแจ้งเตือนในแชทนี้เมื่อสถานการณ์น้ำเปลี่ยนแปลง\nพิมพ์ "สถานะ" เพื่อดูสถานการณ์ล่าสุด`,
  notFound: 'ไม่พบรหัสเชื่อมต่อนี้ หรือรหัสถูกใช้ไปแล้ว\nกรุณาตรวจสอบรหัสในหน้า "ตั้งค่าแจ้งเตือน" แล้วลองใหม่อีกครั้ง',
  expired: `รหัสเชื่อมต่อนี้หมดอายุแล้ว (ใช้ได้ ${LINK_CODE_TTL_MS / 60_000} นาทีหลังสร้าง)\nกรุณาขอรหัสใหม่ที่หน้า "ตั้งค่าแจ้งเตือน" แล้วส่งรหัสใหม่ในแชทนี้`,
  tooManyAttempts: 'ส่งรหัสเชื่อมต่อบ่อยเกินไป กรุณารอประมาณ 10 นาทีแล้วลองใหม่อีกครั้ง',
  noPlaces: `แชทนี้ยังไม่ได้เชื่อมต่อกับจุดเฝ้าระวัง\nกรุณาสร้างจุดเฝ้าระวังที่หน้า "ตั้งค่าแจ้งเตือน" บนเว็บไซต์ แล้วส่งรหัสเชื่อมต่อ ${LINK_CODE_LENGTH} ตัวมาในแชทนี้`,
  help: `ส่งรหัสเชื่อมต่อ ${LINK_CODE_LENGTH} ตัวจากหน้า "ตั้งค่าแจ้งเตือน" เพื่อรับการแจ้งเตือน\nพิมพ์ "สถานะ" เพื่อดูสถานการณ์ล่าสุด`,
  stopped: (n: number) =>
    n > 0 ? `ยกเลิกการแจ้งเตือนในแชทนี้แล้ว (${n} รายการ)` : 'แชทนี้ไม่มีการแจ้งเตือนที่เชื่อมต่ออยู่',
  statusError: 'ขออภัย ไม่สามารถดึงสถานการณ์ล่าสุดได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
  busy: 'ขออภัย มีคำขอจำนวนมาก กรุณาลองใหม่ในอีกสักครู่',
} as const

/** Does the message ask for the current situation? */
export function isStatusRequest(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t === 'สถานะ' || t === 'status' || t === '/status' || t.startsWith('/status@') || t === 'สถานการณ์'
}
