import { log } from '../server/log'
import { assertPublicUrl, isRedirect, UnsafeUrlError } from '../server/net'
import { errorMessage, readErrorBody } from './format'
import type { SendContext, SendResult } from './types'

// Outbound HTTP for notification senders.
//
// Upstream response bodies never reach SendResult.error: that string is stored in
// alert deliveries and returned by POST /api/places/[id]/test, so a body would let
// a user read whatever their URL (or a redirect) points at. Errors are just
// "HTTP <status>"; a bounded excerpt of the body goes to the server log.

/** Discard a response body without reading it (a hostile server could stream forever). */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined)
}

/** One-line, bounded excerpt for logs. */
function excerpt(text: string, max = 300): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Log a failed upstream response (status + body excerpt) and return the public error text. */
export function logHttpFailure(service: string, status: number, body: string): string {
  log(`[notify] ${service} HTTP ${status}${body ? `: ${excerpt(body)}` : ''}`)
  return `HTTP ${status}`
}

/**
 * POST to a URL that a user supplied (ntfy server, Web Push endpoint, Discord webhook):
 * the host must resolve to public addresses only and redirects are never followed.
 * Throws UnsafeUrlError for a refused destination.
 */
export async function fetchUserTarget(ctx: SendContext, url: string, init: RequestInit, opts: { checkHost?: boolean } = {}): Promise<Response> {
  if (opts.checkHost !== false) await assertPublicUrl(url, { lookup: ctx.lookup })
  return ctx.fetch(url, { ...init, redirect: 'manual' })
}

export interface ClassifiedResponse {
  result: SendResult
  status: number
}

/**
 * Turn a send response into a SendResult: 2xx ok (body discarded), 3xx refused
 * (redirects are not followed), anything else "HTTP <status>" with the body logged.
 */
export async function classifyResponse(service: string, res: Response): Promise<ClassifiedResponse> {
  if (res.ok) {
    await discardBody(res)
    return { status: res.status, result: { ok: true } }
  }
  if (isRedirect(res)) {
    await discardBody(res)
    log(`[notify] ${service} answered with a redirect (HTTP ${res.status}); not followed`)
    return { status: res.status, result: { ok: false, error: `HTTP ${res.status} (redirect not followed)` } }
  }
  const body = await readErrorBody(res, 300)
  return { status: res.status, result: { ok: false, error: logHttpFailure(service, res.status, body) } }
}

/** SendResult.error for a thrown error (network failure, timeout, refused destination). */
export function sendErrorText(err: unknown): string {
  if (err instanceof UnsafeUrlError) return `blocked destination (${err.reason})`
  return errorMessage(err)
}
