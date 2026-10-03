// Small HTTP helpers shared by source adapters: timeouts, polite retries, JSON parsing.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 flood-monitor/0.1'

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} from ${new URL(url).host}`)
    this.name = 'HttpError'
  }
}

export interface RequestOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs: number
  /** Cycle-wide deadline; combined with the per-request timeout. No retries once it fired. */
  signal?: AbortSignal | null
  /** Delays (ms) before each retry on network errors / 403 / 5xx. Empty = no retries. */
  retryDelaysMs?: number[]
  /** Hook run once before the first retry after a 403 (e.g. cookie warm-up). */
  on403?: () => Promise<Record<string, string> | void>
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function retryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 403 || err.status >= 500
  return true // network error / timeout
}

/** fetch with timeout + retries. 429 is never retried (back off for the whole cycle). */
export async function request(fetchImpl: typeof fetch, url: string, opts: RequestOptions): Promise<Response> {
  const { timeoutMs, retryDelaysMs = [], on403, sleep = defaultSleep, signal: cycleSignal, ...init } = opts
  let headers = { ...(init.headers as Record<string, string> | undefined) }
  let warmedUp = false
  for (let attempt = 0; ; attempt++) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = cycleSignal ? AbortSignal.any([cycleSignal, timeout]) : timeout
      const res = await fetchImpl(url, { ...init, headers, signal })
      if (!res.ok) {
        // Drain the body so the connection can be reused.
        await res.arrayBuffer().catch(() => undefined)
        throw new HttpError(res.status, url)
      }
      return res
    } catch (err) {
      const delay = retryDelaysMs[attempt]
      if (delay === undefined || !retryable(err) || cycleSignal?.aborted) throw err
      if (err instanceof HttpError && err.status === 403 && on403 && !warmedUp) {
        warmedUp = true
        const extra = await on403().catch(() => undefined)
        if (extra) headers = { ...headers, ...extra }
      }
      await sleep(delay)
    }
  }
}

export async function requestJson<T = unknown>(fetchImpl: typeof fetch, url: string, opts: RequestOptions): Promise<T> {
  const res = await request(fetchImpl, url, opts)
  const text = await res.text()
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T
  } catch {
    throw new Error(`invalid JSON from ${new URL(url).host}: ${text.slice(0, 80)}`)
  }
}

/** Collect `name=value` pairs from Set-Cookie headers into a Cookie header value. */
export function cookieHeaderFrom(res: Response): string | null {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const raw = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : []
  const pairs = raw.map((c) => c.split(';')[0]?.trim()).filter((c): c is string => !!c && c.includes('='))
  return pairs.length ? pairs.join('; ') : null
}

/**
 * Parse a numeric field. Returns null for null/''/non-numeric, BMA's −99 sentinel (≤ −90),
 * and HII's 999999-style sentinels (≥ 9999).
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim())
  if (!Number.isFinite(n) || n <= -90 || n >= 9999) return null
  return n
}

/** Water level / bank / threshold in metres: rejects |v| ≥ 10 (bad units or sentinels). */
export function metres(v: unknown): number | null {
  const n = num(v)
  return n === null || Math.abs(n) >= 10 ? null : n
}

export function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s || null
}

export const round2 = (n: number) => Math.round(n * 100) / 100
