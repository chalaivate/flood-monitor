import type { Reading, SourceFetchResult, Station } from '../types'
import { isInThailand } from '../geo'
import { parseDotNetDate } from '../time'
import { BMA_AGENCY, BMA_HEADERS, BMA_ORIGIN, bmaCookieWarmup } from './bma-canal'
import { cleanText, metres, num, requestJson } from './http'
import type { SourceAdapter, SourceContext } from './types'

// Other สำนักการระบายน้ำ กทม. feeds on weather.bangkok.go.th (Thai IPs only):
// rain gauges, road / underpass flood sensors and pump stations.

export const BMA_RAIN_URL = `${BMA_ORIGIN}/rain/PageMap/GetDataForUpdate`
export const BMA_ROADFLOOD_URL = `${BMA_ORIGIN}/Flood/PageMap/GetData?id=0`
export const BMA_PUMP_URL = `${BMA_ORIGIN}/Station/Map/GetData?id=0`

const FUTURE_TOLERANCE_MIN = 15

type Row = Record<string, unknown>

/** Observation time from a '/Date(ms)/' field, clamped/skipped when in the future. */
function observedAtFrom(v: unknown, now: Date): string | null {
  const iso = parseDotNetDate(v)
  if (!iso) return null
  const aheadMin = (Date.parse(iso) - now.getTime()) / 60_000
  if (aheadMin > FUTURE_TOLERANCE_MIN) return null
  return aheadMin > 0 ? now.toISOString() : iso
}

function coords(raw: Row, latKey = 'latitude', lngKey = 'longitude'): { lat: number; lng: number } | null {
  const lat = Number(raw[latKey])
  const lng = Number(raw[lngKey])
  return isInThailand(lat, lng) ? { lat, lng } : null
}

async function bmaJson(ctx: SourceContext, url: string, init: RequestInit & { referer: string }): Promise<unknown> {
  const { referer, ...rest } = init
  return requestJson(ctx.fetch, url, {
    ...rest,
    headers: { ...BMA_HEADERS, Referer: referer, ...(rest.headers as Record<string, string> | undefined) },
    timeoutMs: ctx.timeoutMs,
    retryDelaysMs: [5_000, 15_000],
    on403: () => bmaCookieWarmup(ctx, new URL(referer).pathname),
    sleep: ctx.sleep,
  })
}

// --- Rain gauges ---------------------------------------------------------------------

export function parseBmaRain(rows: unknown, now: Date): SourceFetchResult {
  if (!Array.isArray(rows)) throw new Error('BMA rain: expected a JSON array')
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const raw of rows as Row[]) {
    const code = cleanText(raw.rain_code)
    const pos = coords(raw)
    if (!code || !pos) {
      warnings.push(`skip rain row ${String(raw.rain_code)}: missing code/coordinates`)
      continue
    }
    const id = `rain:${code}`
    if (seen.has(id)) continue
    seen.add(id)
    const name = cleanText(raw.rain_name) ?? cleanText(raw.rain_shortname) ?? code
    stations.push({
      id,
      source: 'bma-rain',
      kind: 'rain',
      code,
      name: name.replace(/^จุดวัด\s*/, ''),
      shortName: cleanText(raw.rain_shortname),
      ...pos,
      district: cleanText(raw.district_name),
      province: 'กรุงเทพมหานคร',
      agency: BMA_AGENCY,
    })
    // status !== 1 rows are offline and carry zeros — never treat them as "no rain".
    if (Number(raw.status) !== 1) continue
    const observedAt = observedAtFrom(raw.site_timestamp, now)
    const rain24h = num(raw.rf24hr)
    if (!observedAt || rain24h === null || rain24h < 0) continue
    const rain1h = num(raw.rf1hr)
    readings.push({ stationId: id, observedAt, rain24h, rain1h: rain1h !== null && rain1h >= 0 ? rain1h : null })
  }
  return { source: 'bma-rain', stations, readings, fetchedAt: now.toISOString(), warnings }
}

export const bmaRainSource: SourceAdapter = {
  id: 'bma-rain',
  label: BMA_AGENCY,
  thaiIpOnly: true,
  async fetch(ctx) {
    const rows = await bmaJson(ctx, BMA_RAIN_URL, { method: 'POST', referer: `${BMA_ORIGIN}/rain` })
    return parseBmaRain(rows, ctx.now)
  },
}

// --- Road / underpass flood sensors ---------------------------------------------------

/** chkStatustxt → depth: 'น้ำท่วม' keeps the reported cm, 'ปกติ' is dry (0 cm), anything else is offline. */
export function roadDepthFrom(statusText: string | null, flood: unknown): number | null | 'offline' {
  if (statusText === 'น้ำท่วม') {
    const cm = num(flood)
    return cm !== null && cm >= 0 && cm < 500 ? cm : null
  }
  if (statusText === 'ปกติ') return 0
  return 'offline'
}

export function parseBmaRoadFlood(body: unknown, now: Date): SourceFetchResult {
  const rows = (body as { dtTbl?: unknown })?.dtTbl
  if (!Array.isArray(rows)) throw new Error('BMA road flood: expected {dtTbl: [...]}')
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const raw of rows as Row[]) {
    const code = cleanText(raw.flood_code)
    const pos = coords(raw)
    if (!code || !pos) {
      warnings.push(`skip road row ${String(raw.flood_code)}: missing code/coordinates`)
      continue
    }
    const tunnel = Number(raw.typesite) === 2
    const direction = tunnel ? cleanText(raw.tunnel_sub_name) : null
    const id = `road:${code}${direction ? `:${direction}` : ''}`
    if (seen.has(id)) continue
    seen.add(id)
    const baseName = (cleanText(raw.flood_name) ?? cleanText(raw.flood_shortname) ?? code).replace(/\s*\*+$/, '')
    stations.push({
      id,
      source: 'bma-roadflood',
      kind: 'roadflood',
      code,
      name: `${tunnel ? 'อุโมงค์ ' : ''}${baseName}${direction ? ` (${direction})` : ''}`,
      shortName: cleanText(raw.flood_shortname)?.replace(/\s*\*+$/, '') ?? null,
      waterway: cleanText(raw.road_name),
      ...pos,
      district: cleanText(raw.districtName) ?? cleanText(raw.district_name),
      province: 'กรุงเทพมหานคร',
      agency: BMA_AGENCY,
    })
    const status = cleanText(raw.chkStatustxt)
    const depth = roadDepthFrom(status, raw.flood)
    const observedAt = observedAtFrom(raw.site_timestamp, now)
    if (depth === 'offline' || depth === null || !observedAt) continue
    readings.push({ stationId: id, observedAt, roadFloodCm: depth, officialStatus: status })
  }
  return { source: 'bma-roadflood', stations, readings, fetchedAt: now.toISOString(), warnings }
}

export const bmaRoadFloodSource: SourceAdapter = {
  id: 'bma-roadflood',
  label: BMA_AGENCY,
  thaiIpOnly: true,
  async fetch(ctx) {
    const body = await bmaJson(ctx, BMA_ROADFLOOD_URL, { method: 'GET', referer: `${BMA_ORIGIN}/flood/` })
    return parseBmaRoadFlood(body, ctx.now)
  },
}

// --- Pump stations ----------------------------------------------------------------------

export function parseBmaPump(body: unknown, now: Date): SourceFetchResult {
  const b = body as { waterTbl?: unknown; LastPump?: unknown }
  if (!Array.isArray(b?.LastPump)) throw new Error('BMA pump: expected {waterTbl, LastPump}')
  const meta = new Map<number, Row>()
  for (const r of (Array.isArray(b.waterTbl) ? b.waterTbl : []) as Row[]) meta.set(Number(r.pumpStation_id), r)
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const raw of b.LastPump as Row[]) {
    const m = meta.get(Number(raw.pumpStation_id)) ?? {}
    const code = cleanText(raw.pumpStation_code) ?? cleanText(m.pumpStation_code)
    const pos = coords(raw) ?? coords(m)
    if (!code || !pos) {
      warnings.push(`skip pump ${String(raw.pumpStation_id)}: missing code/coordinates`)
      continue
    }
    const id = `bma-pump:${code}`
    if (seen.has(id)) continue
    seen.add(id)
    const name = cleanText(raw.pumpStation_name) ?? cleanText(m.pumpStation_name) ?? code
    stations.push({
      id,
      source: 'bma-pump',
      kind: 'pump',
      code,
      name,
      shortName: cleanText(raw.pump_shortname) ?? cleanText(m.pump_shortname),
      nameEn: cleanText(raw.pumpStation_name_en),
      ...pos,
      district: cleanText(m.district_name) ?? cleanText(raw.district_name),
      province: 'กรุงเทพมหานคร',
      agency: BMA_AGENCY,
    })
    if (raw.rtu_status === false) continue // telemetry unit offline
    const observedAt = observedAtFrom(raw.site_timestamp_last ?? raw.site_timestamp_station, now)
    if (!observedAt) continue
    let running = 0
    let total = 0
    for (let i = 1; i <= 6; i++) {
      const s = raw[`pump_status${i}`]
      if (s === null || s === undefined) continue
      total++
      if (Number(s) === 1) running++
    }
    readings.push({
      stationId: id,
      observedAt,
      waterLevel: metres(raw.water_level),
      pumpsRunning: total ? running : null,
      pumpsTotal: total || null,
    })
  }
  return { source: 'bma-pump', stations, readings, fetchedAt: now.toISOString(), warnings }
}

export const bmaPumpSource: SourceAdapter = {
  id: 'bma-pump',
  label: BMA_AGENCY,
  thaiIpOnly: true,
  async fetch(ctx) {
    const body = await bmaJson(ctx, BMA_PUMP_URL, { method: 'GET', referer: `${BMA_ORIGIN}/station` })
    return parseBmaPump(body, ctx.now)
  },
}
