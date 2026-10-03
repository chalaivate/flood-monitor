import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Secrets & tokens. Place owners get a random manage token once; we keep only its
// sha256. Machine endpoints (cron, ingest, webhooks) compare shared secrets in
// constant time.

/** 32 random bytes, base64url (43 chars). */
export function generateManageToken(): string {
  return randomBytes(32).toString('base64url')
}

/** sha256 hex of a token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time string comparison (length difference still returns false without early exit on content). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Compare against itself so the timing does not depend on where the strings differ.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/** Does `token` hash to `expectedHash` (hex)? */
export function verifyManageToken(token: string | null | undefined, expectedHash: string): boolean {
  if (!token || !expectedHash) return false
  return safeEqual(hashToken(token), expectedHash)
}

/** Token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1]!.trim() || null : null
}

/** True when the request carries `Bearer <secret>` and the secret is configured. */
export function hasBearerSecret(req: Request, secret: string | undefined): boolean {
  if (!secret) return false
  const token = bearerToken(req)
  return !!token && safeEqual(token, secret)
}

/** LINE webhook signature: base64(HMAC-SHA256(channelSecret, rawBody)). */
export function lineSignature(channelSecret: string, rawBody: string): string {
  return createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest('base64')
}

export function verifyLineSignature(channelSecret: string | undefined, rawBody: string, signature: string | null): boolean {
  if (!channelSecret || !signature) return false
  return safeEqual(lineSignature(channelSecret, rawBody), signature)
}
