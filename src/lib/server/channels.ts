import { randomBytes } from 'node:crypto'
import { isDiscordWebhookUrl } from '../notify/discord'
import { NTFY_TOPIC_RE } from '../notify/ntfy'
import { parseSubscription } from '../notify/webpush'
import type { Store } from '../store/types'
import type { Channel, ChannelType } from '../types'
import { assertPublicUrl, isPublicHostname, UnsafeUrlError, type LookupFn } from './net'
import { LINK_CODE_TTL_MS } from './public'

export { LINK_CODE_TTL_MS }

// Channel target validation and link codes.

/** No I, O, 0, 1 — easy to read aloud and type on a phone. 32 symbols ⇒ unbiased from one byte. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** 8 symbols × 5 bits = 40 bits; with attempt limits and a 60-minute lifetime that is not guessable. */
export const LINK_CODE_LENGTH = 8
export const LINK_CODE_RE = new RegExp(`^[${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}}$`)

/** Pending LINE/Telegram codes stop working LINK_CODE_TTL_MS after the channel was created. */
export function isLinkCodeExpired(channel: Pick<Channel, 'createdAt'>, now: Date = new Date()): boolean {
  const t = Date.parse(channel.createdAt)
  // An unreadable timestamp counts as expired: fail closed.
  return !Number.isFinite(t) || now.getTime() >= t + LINK_CODE_TTL_MS
}

export function randomLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH)
  let out = ''
  for (const b of bytes) out += LINK_CODE_ALPHABET[b & 31]
  return out
}

/** A link code not used by any pending channel. */
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

/**
 * The link code in a chat message, or null. Only a message that *is* one code counts
 * (case-insensitive, optionally after the word "รหัส" / "code"), so each message is at
 * most one guess: scanning every token of a long message made codes brute-forceable.
 */
export function parseLinkCode(text: string): string | null {
  const m = text.trim().match(/^(?:(?:รหัส(?:เชื่อมต่อ)?|code)\s*[:：]?\s*)?([A-Za-z0-9]+)$/i)
  const code = m?.[1]?.toUpperCase()
  return code && LINK_CODE_RE.test(code) ? code : null
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export function isEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v)
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/**
 * The mailbox an address delivers to, for de-duplication and rate limits only (the
 * channel keeps the address as typed): lower case, the domain without a trailing dot,
 * any `+tag` removed, and for Gmail the dots in the local part removed and googlemail.com
 * mapped to gmail.com. Without this, `a.b+1@gmail.com`, `ab+2@googlemail.com`, … would
 * each get a fresh per-address bucket and flood one inbox with confirmation mails.
 */
export function mailboxKey(address: string): string {
  const a = address.trim().toLowerCase()
  const at = a.lastIndexOf('@')
  if (at <= 0) return a
  let local = a.slice(0, at)
  let domain = a.slice(at + 1).replace(/\.+$/, '')
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com'
    local = local.replaceAll('.', '')
  }
  return `${local}@${domain}`
}

export type TargetResult = { ok: true; target: string } | { ok: false; error: string }

export interface ValidateTargetOptions {
  /** DNS resolver for the SSRF check (tests). */
  lookup?: LookupFn
}

/** Thai message for a URL the SSRF guard refused. */
function unsafeUrlMessage(err: unknown, what: string): string {
  if (err instanceof UnsafeUrlError && (err.reason === 'dns' || err.reason === 'dns-timeout')) {
    return `ไม่พบเซิร์ฟเวอร์ปลายทางของ${what} กรุณาตรวจสอบที่อยู่แล้วลองใหม่อีกครั้ง`
  }
  return `ปลายทางของ ${what} ต้องเป็นเซิร์ฟเวอร์สาธารณะบนอินเทอร์เน็ต (ไม่รองรับที่อยู่ภายในเครือข่าย)`
}

/** SSRF check: the URL's host must resolve to public addresses only. */
async function publicUrlError(url: string, what: string, opts: ValidateTargetOptions): Promise<string | null> {
  try {
    await assertPublicUrl(url, { lookup: opts.lookup })
    return null
  } catch (err) {
    return unsafeUrlMessage(err, what)
  }
}

/**
 * Validate and normalise the user-supplied target for channels that are verified
 * immediately (webpush, ntfy, discord) or by confirmation link (email). URLs are
 * checked against the SSRF guard (DNS included) here and again at every send.
 * LINE / Telegram targets come from the bot webhook, never from the user.
 */
export async function validateChannelTarget(type: ChannelType, raw: unknown, opts: ValidateTargetOptions = {}): Promise<TargetResult> {
  if (type === 'line' || type === 'telegram') return { ok: true, target: '' }

  if (type === 'webpush') {
    const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : ''
    const sub = parseSubscription(text)
    if (!sub) return { ok: false, error: 'ข้อมูลการสมัครรับแจ้งเตือนของเบราว์เซอร์ไม่ถูกต้อง' }
    if (!isPublicHostname(new URL(sub.endpoint).hostname)) {
      return { ok: false, error: 'ปลายทาง Web Push ไม่ถูกต้อง' }
    }
    const unsafe = await publicUrlError(sub.endpoint, ' Web Push', opts)
    if (unsafe) return { ok: false, error: unsafe }
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
          const unsafe = await publicUrlError(u.origin, ' ntfy', opts)
          if (unsafe) return { ok: false, error: unsafe }
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
    case 'discord': {
      if (!isDiscordWebhookUrl(v)) {
        return { ok: false, error: 'Webhook URL ต้องเป็นของ discord.com เช่น https://discord.com/api/webhooks/…' }
      }
      const unsafe = await publicUrlError(v, ' Discord', opts)
      return unsafe ? { ok: false, error: unsafe } : { ok: true, target: v.replace(/\/+$/, '') }
    }
  }
}
