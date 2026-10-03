import { HttpError, MSG } from './http'

// In-memory token buckets (per process). Good enough for a single container or a
// warm serverless instance; it is an abuse brake, not a hard quota.

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
}

export const LIMITS = {
  placeCreate: { capacity: 10, windowMs: 3_600_000 },
  channelCreate: { capacity: 20, windowMs: 3_600_000 },
  placeTest: { capacity: 6, windowMs: 600_000 },
  webhookStatus: { capacity: 30, windowMs: 600_000 },
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

  private set(key: string, b: Bucket): void {
    this.buckets.delete(key) // re-insert ⇒ Map order = least recently used first
    this.buckets.set(key, b)
    if (this.buckets.size > MAX_KEYS) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) this.buckets.delete(oldest)
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
