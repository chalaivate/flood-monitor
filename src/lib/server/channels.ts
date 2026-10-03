import { randomBytes } from 'node:crypto'
import { isDiscordWebhookUrl } from '../notify/discord'
import { NTFY_TOPIC_RE } from '../notify/ntfy'
import { parseSubscription } from '../notify/webpush'
import type { Store } from '../store/types'
import type { ChannelType } from '../types'

// Channel target validation and link codes.

/** No I, O, 0, 1 — easy to read aloud and type on a phone. 32 symbols ⇒ unbiased from one byte. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const LINK_CODE_LENGTH = 6
export const LINK_CODE_RE = new RegExp(`^[${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}}$`)

export function randomLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH)
  let out = ''
  for (const b of bytes) out += LINK_CODE_ALPHABET[b & 31]
  return out
}

/** A 6-character code not used by any pending channel. */
export async function generateLinkCode(store: Store, attempts = 10): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = randomLinkCode()
    if (!(await store.findChannelByLinkCode(code))) return code
  }
  throw new Error('could not allocate a unique link code')
}

/** Long single-use token for e-mail confirmation links (not typed by people). */
export function emailConfirmCode(): string {
  return randomBytes(24).toString('base64url')
}

/** Link codes the user may have typed inside a longer chat message ("รหัส ab12cd"). */
export function extractLinkCodes(text: string): string[] {
  const tokens = text.toUpperCase().match(/[A-Z0-9]+/g) ?? []
  return [...new Set(tokens.filter((t) => LINK_CODE_RE.test(t)))]
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export function isEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v)
}

/** Literal IPs, localhost and internal-looking names are refused for user-supplied URLs (SSRF). */
function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h.includes('.')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return false
  return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h)
}

export type TargetResult = { ok: true; target: string } | { ok: false; error: string }

/**
 * Validate and normalise the user-supplied target for channels that are verified
 * immediately (webpush, ntfy, discord) or by confirmation link (email).
 * LINE / Telegram targets come from the bot webhook, never from the user.
 */
export function validateChannelTarget(type: ChannelType, raw: unknown): TargetResult {
  if (type === 'line' || type === 'telegram') return { ok: true, target: '' }

  if (type === 'webpush') {
    const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : ''
    const sub = parseSubscription(text)
    if (!sub) return { ok: false, error: 'ข้อมูลการสมัครรับแจ้งเตือนของเบราว์เซอร์ไม่ถูกต้อง' }
    if (!isPublicHostname(new URL(sub.endpoint).hostname)) {
      return { ok: false, error: 'ปลายทาง Web Push ไม่ถูกต้อง' }
    }
    return { ok: true, target: JSON.stringify(sub) }
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    const need: Record<'ntfy' | 'email' | 'discord', string> = {
      ntfy: 'กรุณาระบุชื่อหัวข้อ (topic) ของ ntfy',
      email: 'กรุณาระบุอีเมล',
      discord: 'กรุณาระบุ Webhook URL ของ Discord',
    }
    return { ok: false, error: need[type] }
  }
  const v = raw.trim()

  switch (type) {
    case 'ntfy': {
      if (NTFY_TOPIC_RE.test(v)) return { ok: true, target: v }
      try {
        const u = new URL(v)
        const topic = u.pathname.replace(/^\/+|\/+$/g, '')
        if (u.protocol === 'https:' && isPublicHostname(u.hostname) && !u.username && !u.password && !u.search && NTFY_TOPIC_RE.test(topic)) {
          return { ok: true, target: `${u.origin}/${topic}` }
        }
      } catch {
        // fall through
      }
      return {
        ok: false,
        error: 'ชื่อหัวข้อ ntfy ใช้ได้เฉพาะ A-Z a-z 0-9 - _ (ไม่เกิน 64 ตัว) หรือ URL แบบ https://เซิร์ฟเวอร์/หัวข้อ',
      }
    }
    case 'email':
      return isEmail(v) ? { ok: true, target: v.toLowerCase() } : { ok: false, error: 'รูปแบบอีเมลไม่ถูกต้อง' }
    case 'discord':
      return isDiscordWebhookUrl(v)
        ? { ok: true, target: v.replace(/\/+$/, '') }
        : { ok: false, error: 'Webhook URL ต้องเป็นของ discord.com เช่น https://discord.com/api/webhooks/…' }
  }
}
