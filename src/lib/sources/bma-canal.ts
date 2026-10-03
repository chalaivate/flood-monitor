import type { Reading, SourceFetchResult, Station } from '../types'
import { isInThailand } from '../geo'
import { parseBangkokLocal, parseDotNetDate } from '../time'
import { BROWSER_UA, cleanText, cookieHeaderFrom, metres, request, round2 } from './http'
import type { SourceAdapter, SourceContext } from './types'

// สำนักการระบายน้ำ กทม. — canal / gate water levels for ~312 gauges in one response.
// Undocumented internal endpoint of weather.bangkok.go.th/water; answers Thai IPs only.

export const BMA_ORIGIN = 'https://weather.bangkok.go.th'
export const BMA_CANAL_URL = `${BMA_ORIGIN}/water/PageMap/GoogleMap`
export const BMA_AGENCY = 'สำนักการระบายน้ำ กทม.'

/** Readings stamped further in the future than this are discarded; smaller skews are clamped. */
const FUTURE_TOLERANCE_MIN = 15
/** Placeholder threshold pairs BMA uses when no real value was configured. */
const PLACEHOLDER_PAIRS = new Set(['-0.2/0', '0/0.1', '-0.2/-0.1', '0/0'])

/** BMA name → display name: drop the "จุดวัด" prefix, abbreviate "ประตูระบายน้ำ" to "ปตร.". */
export function displayNameTh(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\*+$/, '')
    .replace(/^จุดวัด\s*/, '')
    .replace(/^ประตูระบายน้ำ\s*/, 'ปตร. ')
    .trim()
}

/** Station id shared by every source that reports a Bangkok canal gauge. */
export function canalStationId(waterCode: string): string {
  return `canal:${waterCode.trim().toUpperCase()}`
}

/**
 * Lower bank from left/right crest heights. Values ≤ 0 or ≥ 10 are placeholders.
 * uncertain = lower bank < 0.3 m or the two banks differ by more than 1 m.
 */
export function bankFrom(left: unknown, right: unknown): { bank: number | null; uncertain: boolean } {
  const vals = [metres(left), metres(right)].filter((v): v is number => v !== null && v > 0)
  if (vals.length === 0) return { bank: null, uncertain: false }
  const bank = Math.min(...vals)
  const uncertain = bank < 0.3 || (vals.length === 2 && Math.abs(vals[0]! - vals[1]!) > 1)
  return { bank: round2(bank), uncertain }
}

/** Keep agency thresholds only when they look like real metres-MSL values. */
export function validThresholds(warning: unknown, critical: unknown): { warning: number | null; critical: number | null } {
  const w = metres(warning)
  const c = metres(critical)
  if (w === null || c === null || c <= 0 || w > c || PLACEHOLDER_PAIRS.has(`${w}/${c}`)) {
    return { warning: null, critical: null }
  }
  return { warning: w, critical: c }
}

/** Water level in metres, null for sentinels and BMA's exact −2.00 dropout value. */
export function waterLevelFrom(v: unknown): number | null {
  const n = metres(v)
  if (n === null || n === -2) return null
  return n
}

type Row = Record<string, unknown>

export function parseBmaCanal(rows: unknown, now: Date): SourceFetchResult {
  if (!Array.isArray(rows)) throw new Error('BMA canal: expected a JSON array')
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const raw of rows as Row[]) {
    const code = cleanText(raw.water_code)
    const name = cleanText(raw.water_name)
    const lat = Number(raw.latitude)
    const lng = Number(raw.longitude)
    if (!code || !name) {
      warnings.push(`skip row without code/name (water_id ${String(raw.water_id)})`)
      continue
    }
    if (!isInThailand(lat, lng)) {
      warnings.push(`skip ${code}: invalid coordinates`)
      continue
    }
    const id = canalStationId(code)
    if (seen.has(id)) continue
    seen.add(id)

    const { bank, uncertain } = bankFrom(raw.left_bank, raw.right_bank)
    const thresholds = validThresholds(raw.warning, raw.critical)
    const waterway = cleanText(raw.river_name)
    const district = cleanText(raw.district_name)
    stations.push({
      id,
      source: 'bma-canal',
      kind: waterway?.startsWith('แม่น้ำ') ? 'river' : 'canal',
      code,
      name: displayNameTh(name),
      shortName: cleanText(raw.water_shortname)?.replace(/\*+$/, '').trim() ?? null,
      nameEn: cleanText(raw.water_name_en),
      waterway,
      lat,
      lng,
      district,
      province: district && /^อำเภอ/.test(district) ? null : 'กรุงเทพมหานคร',
      agency: BMA_AGENCY,
      bankLevel: bank,
      bankUncertain: uncertain || undefined,
      officialWarning: thresholds.warning,
      officialCritical: thresholds.critical,
    })

    const wl = waterLevelFrom(raw.wl_in)
    let observedAt = parseDotNetDate(raw.site_timestamp) ?? parseBangkokLocal(raw.site_timestampEN)
    if (wl === null || !observedAt) continue
    const aheadMin = (Date.parse(observedAt) - now.getTime()) / 60_000
    if (aheadMin > FUTURE_TOLERANCE_MIN) {
      warnings.push(`skip ${code}: timestamp ${Math.round(aheadMin)} min in the future`)
      continue
    }
    if (aheadMin > 0) observedAt = now.toISOString()
    readings.push({
      stationId: id,
      observedAt,
      waterLevel: wl,
      freeboard: bank === null ? null : round2(bank - wl),
      officialStatus: cleanText(raw.txtStatus),
    })
  }
  return { source: 'bma-canal', stations, readings, fetchedAt: now.toISOString(), warnings }
}

export const BMA_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  Referer: `${BMA_ORIGIN}/water`,
  Origin: BMA_ORIGIN,
  'X-Requested-With': 'XMLHttpRequest',
}

/** GET the public page once to pick up WAF cookies (used after a 403). */
export async function bmaCookieWarmup(ctx: SourceContext, path = '/water'): Promise<Record<string, string> | void> {
  const res = await ctx.fetch(`${BMA_ORIGIN}${path}`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(ctx.timeoutMs),
  })
  const cookie = cookieHeaderFrom(res)
  await res.arrayBuffer().catch(() => undefined)
  return cookie ? { Cookie: cookie } : undefined
}

export const bmaCanalSource: SourceAdapter = {
  id: 'bma-canal',
  label: BMA_AGENCY,
  thaiIpOnly: true,
  async fetch(ctx) {
    const res = await request(ctx.fetch, BMA_CANAL_URL, {
      method: 'POST',
      headers: { ...BMA_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'payload=',
      timeoutMs: ctx.timeoutMs,
      retryDelaysMs: [5_000, 15_000],
      on403: () => bmaCookieWarmup(ctx),
      sleep: ctx.sleep,
    })
    const text = await res.text()
    let rows: unknown
    try {
      rows = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      throw new Error(`BMA canal: non-JSON response (${text.slice(0, 60).replace(/\s+/g, ' ')})`)
    }
    return parseBmaCanal(rows, ctx.now)
  },
}
