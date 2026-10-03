import { ZodError } from 'zod'
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

/** Parse a JSON request body with a size cap. Throws HttpError(400/413). */
export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new HttpError(413, MSG.tooLarge)
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new HttpError(413, MSG.tooLarge)
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

/**
 * Best-effort client IP for rate limiting. Behind Cloudflare Tunnel / a reverse
 * proxy the edge sets these headers; directly exposed servers can be spoofed, so
 * the limiter is a soft abuse brake, not a security boundary.
 */
export function clientIp(req: Request): string {
  const h = req.headers
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null
  return first(h.get('cf-connecting-ip')) ?? first(h.get('x-real-ip')) ?? first(h.get('x-forwarded-for')) ?? 'unknown'
}

/** Origin for links we generate (confirmation e-mails, redirects). */
export function publicOrigin(req: Request, publicBaseUrl: string | undefined): string {
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, '')
  return new URL(req.url).origin
}

/** Route params are a Promise in Next.js 16. */
export interface RouteCtx<P extends Record<string, string>> {
  params: Promise<P>
}
