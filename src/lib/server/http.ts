import { isIP } from 'node:net'
import { ZodError } from 'zod'
import { getConfig, type TrustProxy } from '../config'
import { log } from './log'

// JSON response helpers for route handlers. Error bodies are always `{ error }`
// with a Thai message the UI can show as-is.

export const NO_STORE = { 'Cache-Control': 'no-store' } as const

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(data, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } })
}

export function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: message }, { status, headers })
}

export const MSG = {
  badJson: 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)',
  tooLarge: 'ข้อมูลมีขนาดใหญ่เกินไป',
  unauthorized: 'ไม่มีสิทธิ์เข้าถึง กรุณาตรวจสอบรหัสจัดการ',
  placeNotFound: 'ไม่พบจุดเฝ้าระวังนี้',
  channelNotFound: 'ไม่พบช่องทางแจ้งเตือนนี้',
  rateLimited: 'ส่งคำขอบ่อยเกินไป กรุณาลองใหม่ภายหลัง',
  internal: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง',
  invalid: 'ข้อมูลไม่ถูกต้อง',
} as const

/** First zod issue as a Thai message (schemas carry Thai messages). */
export function zodMessage(err: ZodError): string {
  const issue = err.issues[0]
  if (!issue) return MSG.invalid
  const msg = issue.message
  // zod's built-in English messages are not useful to end users.
  return /[฀-๿]/.test(msg) ? msg : `${MSG.invalid}${issue.path.length ? ` (${issue.path.join('.')})` : ''}`
}

/**
 * Read a request body with a hard byte cap. A declared Content-Length over the cap is
 * refused before reading; otherwise the stream is read chunk by chunk and cancelled as
 * soon as the total passes `maxBytes` (chunked uploads have no Content-Length), so an
 * unauthenticated client cannot make the server buffer an arbitrarily large body.
 * Throws HttpError(413).
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get('content-length')
  if (declared !== null && declared.trim() !== '') {
    const n = Number(declared)
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, MSG.invalid)
    if (n > maxBytes) throw new HttpError(413, MSG.tooLarge)
  }
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError(413, MSG.tooLarge)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
}

/** Request body as UTF-8 text, capped like readBodyCapped. */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(req, maxBytes))
}

/** Parse a JSON request body with a size cap. Throws HttpError(400/413). */
export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await readTextCapped(req, maxBytes)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, MSG.badJson)
  }
}

/** Map thrown errors to JSON responses; unexpected errors are logged and hidden. */
export function errorResponse(err: unknown, where: string): Response {
  if (err instanceof HttpError) return jsonError(err.status, err.message, err.headers)
  if (err instanceof ZodError) return jsonError(400, zodMessage(err))
  log(`[api] ${where} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  return jsonError(500, MSG.internal)
}

/** Wrap a route handler so every failure becomes a JSON `{ error }` response. */
export function handler<A extends unknown[]>(where: string, fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch (err) {
      return errorResponse(err, where)
    }
  }
}

/** A syntactically valid IP (IPv4-mapped IPv6 reduced to IPv4), else null. */
function normalizeIp(raw: string | null | undefined): string | null {
  const v = raw?.trim().replace(/^\[|\]$/g, '')
  if (!v) return null
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  const ip = mapped ? mapped[1]! : v
  return isIP(ip) ? ip.toLowerCase() : null
}

/** First entry of a comma-separated header (X-Forwarded-For: client, proxy1, proxy2). */
function firstOf(v: string | null): string | null {
  return v?.split(',')[0] ?? null
}

/**
 * Client IP for rate limiting, read only from the header the configured proxy sets
 * (TRUST_PROXY): `cloudflare` → CF-Connecting-IP (Cloudflare Tunnel / proxy),
 * `vercel` → X-Real-IP, then the first X-Forwarded-For (Vercel overwrites both),
 * `xff` → the first X-Forwarded-For (a reverse proxy that *replaces* the header),
 * `none` → 'unknown'. Any other header is client-controlled and ignored, so it cannot
 * be used to pick a fresh rate-limit bucket per request. Returns 'unknown' when the
 * header is missing or not an IP.
 */
export function clientIp(req: Request, trust: TrustProxy = getConfig().TRUST_PROXY): string {
  const h = req.headers
  let ip: string | null = null
  switch (trust) {
    case 'cloudflare':
      ip = normalizeIp(h.get('cf-connecting-ip'))
      break
    case 'vercel':
      ip = normalizeIp(h.get('x-real-ip')) ?? normalizeIp(firstOf(h.get('x-forwarded-for')))
      break
    case 'xff':
      ip = normalizeIp(firstOf(h.get('x-forwarded-for')))
      break
    case 'none':
      break
  }
  return ip ?? 'unknown'
}

/**
 * Absolute base URL for links that leave the site (confirmation e-mails): PUBLIC_BASE_URL
 * without its trailing slash, or null when it is unset or not an http(s) URL.
 *
 * Never derived from the request. In Next.js 16 `req.url` carries the server's bind
 * address (0.0.0.0 / localhost:3000 in Docker), not the public host, and the Host /
 * X-Forwarded-Host headers are client-controlled: building an e-mailed link from them
 * would let anyone send our confirmation mail pointing at their own site. Redirects and
 * links on our own pages use relative paths instead, which work without this setting.
 */
export function publicOrigin(publicBaseUrl: string | undefined): string | null {
  const raw = publicBaseUrl?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password || u.search || u.hash) return null
  } catch {
    return null
  }
  return raw.replace(/\/+$/, '')
}

/** Route params are a Promise in Next.js 16. */
export interface RouteCtx<P extends Record<string, string>> {
  params: Promise<P>
}
