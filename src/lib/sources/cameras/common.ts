import { createHash } from 'node:crypto'
import type { Camera, CameraSourceId } from '../../types'
import { request } from '../http'
import type { SourceContext } from '../types'

// Helpers shared by the camera catalogue adapters. Upstream bodies can embed private stream
// addresses and credentials, so nothing here ever puts upstream text into an error or log.

/** Allowed shape of a native camera id; anything else is replaced by a sha1 prefix. */
export const NATIVE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Largest catalogue response we read (the BMA list is ~200 KB). */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024

/** Upstream id → our native id: kept when already safe, else a stable 16-hex sha1 prefix. */
export function cameraNativeId(raw: unknown): string | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  return NATIVE_ID_RE.test(s) ? s : createHash('sha1').update(s).digest('hex').slice(0, 16)
}

/** One site = one spot (several angles share it). */
export function siteIdFor(source: CameraSourceId, lat: number, lng: number): string {
  return `${source}:${lat.toFixed(5)},${lng.toFixed(5)}`
}

/** A coordinate given as a number or a numeric string (upstream types are unverified). */
export function coordinate(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || !/^-?\d+(?:\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export interface BBox {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export function inBox(lat: number, lng: number, box: BBox): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng
}

/**
 * Coordinates inside `box`, accepting swapped lat/lng (a common data-entry slip).
 * Null when neither order fits.
 */
export function pointIn(latRaw: unknown, lngRaw: unknown, box: BBox): { lat: number; lng: number } | null {
  const lat = coordinate(latRaw)
  const lng = coordinate(lngRaw)
  if (lat === null || lng === null) return null
  if (inBox(lat, lng, box)) return { lat, lng }
  if (inBox(lng, lat, box)) return { lat: lng, lng: lat }
  return null
}

/** Collapse whitespace and drop control characters; null when empty. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s || null
}

/**
 * Remove anything that looks like a URL or `user:pass@host` from text that may be stored or
 * logged (error messages, warnings). Upstream payloads embed credentials.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\S+@\S+/g, '<redacted>')
    .slice(0, 300)
}

/**
 * GET/POST an upstream catalogue and parse its JSON. Errors never quote the body: a truncated
 * camera list would otherwise leak stream addresses into source health and logs.
 */
export async function fetchCatalogJson(
  ctx: SourceContext,
  url: string,
  init: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const host = new URL(url).host
  const res = await request(ctx.fetch, url, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: { Accept: 'application/json', ...init.headers },
    timeoutMs: ctx.timeoutMs,
    sleep: ctx.sleep,
    signal: ctx.signal,
    redirect: 'error',
  })
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_CATALOG_BYTES) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`camera list from ${host} is too large (${declared} bytes)`)
  }
  const text = await res.text()
  if (text.length > MAX_CATALOG_BYTES) throw new Error(`camera list from ${host} is too large`)
  const type = res.headers.get('content-type') ?? ''
  if (/text\/html/i.test(type) || /^\s*</.test(text)) {
    throw new Error(`HTML instead of JSON from ${host} (blocked or challenge page)`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error(`invalid JSON from ${host} (${text.length} bytes)`)
  }
}

/** Assign "มุม N" labels within each site (null when the site has one camera). */
export function labelAngles(cameras: Camera[], angleNo: Map<string, number | null>, stemOf: (c: Camera) => string): void {
  const bySite = new Map<string, Camera[]>()
  for (const c of cameras) bySite.set(c.siteId, [...(bySite.get(c.siteId) ?? []), c])
  for (const group of bySite.values()) {
    if (group.length < 2) {
      group[0]!.angle = null
      continue
    }
    const nums = group.map((c) => angleNo.get(c.id) ?? null)
    const oneStem = new Set(group.map(stemOf)).size === 1
    const distinct = nums.every((n) => n !== null) && new Set(nums).size === nums.length
    if (oneStem && distinct) {
      group.forEach((c, i) => (c.angle = `มุม ${nums[i]}`))
      continue
    }
    // Different poles at one spot, or missing numbers: number them in a stable order.
    const sorted = [...group].sort(
      (a, b) =>
        (a.code ?? '').localeCompare(b.code ?? '') ||
        (angleNo.get(a.id) ?? 0) - (angleNo.get(b.id) ?? 0) ||
        a.nativeId.localeCompare(b.nativeId),
    )
    sorted.forEach((c, i) => (c.angle = `มุม ${i + 1}`))
  }
}
