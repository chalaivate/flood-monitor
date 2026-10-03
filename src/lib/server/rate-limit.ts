import { HttpError, MSG } from './http'

// In-memory token buckets (per process). Good enough for a single container or a
// warm serverless instance; it is an abuse brake, not a hard quota. State is lost on
// restart and is not shared between serverless instances.

export interface Bucket {
  tokens: number
  updatedAt: number
}

export interface LimitRule {
  /** Burst size. */
  capacity: number
  /** Window in which `capacity` tokens are refilled, ms. */
  windowMs: number
}

export interface LimitResult {
  ok: boolean
  /** Seconds until one token is available again (0 when ok). */
  retryAfterSec: number
  remaining: number
  /** takeAll: keys of the buckets that were empty. */
  blocked?: string[]
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const LIMITS = {
  /** Per client IP (skipped when the IP is unknown, see TRUST_PROXY). */
  placeCreate: { capacity: 10, windowMs: HOUR },
  /** Server-wide backstop that works without a trustworthy client IP. */
  placeCreateGlobal: { capacity: 120, windowMs: HOUR },
  channelCreate: { capacity: 20, windowMs: HOUR },
  channelCreateGlobal: { capacity: 300, windowMs: HOUR },
  placeTest: { capacity: 6, windowMs: 10 * MIN },
  webhookStatus: { capacity: 30, windowMs: 10 * MIN },
  /** Link-code attempts per LINE/Telegram chat, and per platform for all chats together. */
  linkAttemptChat: { capacity: 5, windowMs: 10 * MIN },
  linkAttemptPlatform: { capacity: 300, windowMs: 10 * MIN },
  /** Confirmation e-mails per recipient mailbox (keyed by the sha256 of mailboxKey()). */
  emailConfirmRecipient: { capacity: 1, windowMs: 15 * MIN },
  emailConfirmRecipientDay: { capacity: 3, windowMs: DAY },
  /** Confirmation e-mails requested from one place, whatever the addresses. */
  emailConfirmPlace: { capacity: 5, windowMs: DAY },
  /** Server-wide cap on confirmation e-mails (protects the Resend quota and sender reputation). */
  emailConfirmGlobal: { capacity: 100, windowMs: HOUR },
  /** GET /api/snapshot per client IP. */
  snapshot: { capacity: 120, windowMs: MIN },
  /**
   * Server-wide upstream weather requests (cache misses), saved places and ad-hoc
   * coordinates together. Open-Meteo's free tier allows 10,000 calls/day per server IP;
   * 400/hour stays under it. When it is spent, the last cached value is served (stale).
   */
  weatherUpstream: { capacity: 400, windowMs: HOUR },
  /**
   * The share of weatherUpstream that ad-hoc snapshot coordinates (map browsing) may use,
   * so they can never starve saved places.
   */
  weatherAdHoc: { capacity: 200, windowMs: HOUR },
} satisfies Record<string, LimitRule>

const MAX_KEYS = 10_000

export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(private now: () => number = Date.now) {}

  take(key: string, rule: LimitRule, cost = 1): LimitResult {
    const t = this.now()
    const ratePerMs = rule.capacity / rule.windowMs
    const prev = this.buckets.get(key)
    const tokens = prev ? Math.min(rule.capacity, prev.tokens + (t - prev.updatedAt) * ratePerMs) : rule.capacity
    if (tokens >= cost) {
      this.set(key, { tokens: tokens - cost, updatedAt: t })
      return { ok: true, retryAfterSec: 0, remaining: Math.floor(tokens - cost) }
    }
    this.set(key, { tokens, updatedAt: t })
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cost - tokens) / ratePerMs / 1000)), remaining: 0 }
  }

  /**
   * Take one token from every bucket, or from none: when any bucket is empty nothing is
   * consumed and the longest wait is reported.
   */
  takeAll(entries: [key: string, rule: LimitRule][], cost = 1): LimitResult {
    const t = this.now()
    const state = entries.map(([key, rule]) => {
      const ratePerMs = rule.capacity / rule.windowMs
      const prev = this.buckets.get(key)
      const tokens = prev ? Math.min(rule.capacity, prev.tokens + (t - prev.updatedAt) * ratePerMs) : rule.capacity
      return { key, tokens, ratePerMs }
    })
    const short = state.filter((b) => b.tokens < cost)
    if (short.length > 0) {
      const wait = Math.max(...short.map((b) => (cost - b.tokens) / b.ratePerMs / 1000))
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(wait)), remaining: 0, blocked: short.map((b) => b.key) }
    }
    for (const b of state) this.set(b.key, { tokens: b.tokens - cost, updatedAt: t })
    return { ok: true, retryAfterSec: 0, remaining: Math.floor(Math.min(...state.map((b) => b.tokens - cost))) }
  }

  private set(key: string, b: Bucket): void {
    this.buckets.delete(key) // re-insert ⇒ Map order = least recently used first
    this.buckets.set(key, b)
    if (this.buckets.size > MAX_KEYS) {
      // Evict the least recently used per-client bucket. Server-wide buckets (`…:*`) are
      // never evicted: rotating client keys must not reset the global backstops.
      for (const k of this.buckets.keys()) {
        if (!k.endsWith(':*')) {
          this.buckets.delete(k)
          break
        }
      }
    }
  }

  reset(): void {
    this.buckets.clear()
  }
}

const g = globalThis as typeof globalThis & { __floodRateLimiter?: RateLimiter }

/** Shared limiter for this process. */
export function rateLimiter(): RateLimiter {
  if (!g.__floodRateLimiter) g.__floodRateLimiter = new RateLimiter()
  return g.__floodRateLimiter
}

/** Consume one token or throw HttpError 429 with Retry-After. */
export function enforceLimit(key: string, rule: LimitRule): void {
  const r = rateLimiter().take(key, rule)
  if (!r.ok) throw new HttpError(429, MSG.rateLimited, { 'Retry-After': String(r.retryAfterSec) })
}

/** Consume one token from every bucket (or none) or throw HttpError 429. */
export function enforceLimits(entries: [key: string, rule: LimitRule][], message: string = MSG.rateLimited): void {
  if (entries.length === 0) return
  const r = rateLimiter().takeAll(entries)
  if (!r.ok) throw new HttpError(429, message, { 'Retry-After': String(r.retryAfterSec) })
}

/**
 * Rate-limit key for a client IP: IPv6 clients are grouped by /64 (one subscriber
 * usually owns a whole /64), IPv4 addresses are used as-is.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip
  const groups = ip.toLowerCase().split('::')
  const head = groups[0] ? groups[0].split(':') : []
  const tail = groups.length > 1 && groups[1] ? groups[1].split(':') : []
  const full = groups.length > 1 ? [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  return `${full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * Per-client limit plus an optional server-wide backstop, consumed together. When the
 * client IP is 'unknown' (no trusted proxy header, see TRUST_PROXY) the per-IP bucket is
 * skipped: it would be one bucket shared by every visitor, so a single client could lock
 * everybody out. The global bucket still applies.
 */
export function enforceClientLimit(scope: string, ip: string, perClient: LimitRule, global?: LimitRule): void {
  const entries: [string, LimitRule][] = []
  if (ip !== 'unknown') entries.push([`${scope}:${ipBucket(ip)}`, perClient])
  if (global) entries.push([`${scope}:*`, global])
  enforceLimits(entries)
}
