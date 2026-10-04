import type { Reading, SourceFetchResult, SourceId, Station, StationKind } from '../types'
import { isInThailand } from '../geo'
import { parseBangkokLocal } from '../time'
import { canalStationId, displayNameTh } from './bma-canal'
import { cleanText, num, requestJson, round2 } from './http'
import type { SourceAdapter, SourceContext } from './types'

// คลังข้อมูลน้ำแห่งชาติ / ThaiWater (สถาบันสารสนเทศทรัพยากรน้ำ, สสน.) public API.
// Keyless, reachable from cloud hosts, so it is the fallback when no Thai collector runs.
// Payloads are large (rain_24h ≈ 2–5 MB nationally) — fetch server-side on a schedule only.

export const THAIWATER_API = 'https://api-v3.thaiwater.net/api/v1/thaiwater30'
export const HII_AGENCY = 'สสน. (ThaiWater)'
const FUTURE_TOLERANCE_MIN = 15
/** Older readings are dropped at parse time: ThaiWater keeps returning long-dead stations. */
const MAX_AGE_H = 72
/** ThaiWater needs long timeouts (national payloads take 10–60 s). */
/** National feeds are 2–5 MB and can take a minute from abroad; province feeds are small. */
const NATIONAL_TIMEOUT_MS = 120_000
const PROVINCE_TIMEOUT_MS = 30_000
/** Province requests run with this much parallelism (be polite to api-v3). */
const PROVINCE_PARALLEL = 2

type Row = Record<string, unknown>
type Obj = Record<string, unknown> | undefined

/** Positive integer id (ThaiWater ids exceed the numeric sentinel range used by num()). */
const idOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)
const th = (v: unknown): string | null => cleanText(obj(v)?.th) ?? cleanText(obj(v)?.en)

export function thaiwaterHeaders(): Record<string, string> {
  return {
    'User-Agent': 'flood-monitor/0.1 (+https://github.com/chalaivate/flood-monitor)',
    Accept: 'application/json',
    Referer: 'https://www.thaiwater.net/',
  }
}

/** 'YYYY-MM-DD HH:mm' Bangkok time → ISO; null when unparsable, too old or too far ahead. */
export function thaiwaterTime(v: unknown, now: Date): string | null {
  const iso = parseBangkokLocal(v)
  if (!iso) return null
  const ageMin = (now.getTime() - Date.parse(iso)) / 60_000
  if (ageMin > MAX_AGE_H * 60) return null
  if (ageMin < -FUTURE_TOLERANCE_MIN) return null
  return ageMin < 0 ? now.toISOString() : iso
}

function provinceCodes(spec: string): string[] | 'all' {
  if (spec.trim().toLowerCase() === 'all') return 'all'
  const codes = spec
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^\d{2}$/.test(c))
  return codes.length ? codes : ['10']
}

/** Accept {data:[…]}, {result,data:[…]} and {waterlevel_data:{data:[…]}} shapes; reject string bodies. */
export function rowsOf(body: unknown, wrapper?: string): Row[] {
  const b = obj(body)
  const inner = wrapper ? obj(b?.[wrapper]) : b
  const data = inner?.data ?? (wrapper ? b?.data : undefined)
  if (!Array.isArray(data)) {
    const hint = typeof data === 'string' ? `: ${data.slice(0, 60)}` : ''
    throw new Error(`ThaiWater: unexpected response shape${hint}`)
  }
  return data as Row[]
}

async function getJson(ctx: SourceContext, path: string, national = true): Promise<unknown> {
  return requestJson(ctx.fetch, `${THAIWATER_API}${path}`, {
    headers: thaiwaterHeaders(),
    timeoutMs: national ? Math.max(ctx.timeoutMs, NATIONAL_TIMEOUT_MS) : Math.min(ctx.timeoutMs, PROVINCE_TIMEOUT_MS),
    retryDelaysMs: national ? [3_000, 10_000] : [3_000],
    sleep: ctx.sleep,
    signal: ctx.signal,
  })
}

/**
 * Fetch one path per province with limited parallelism. A failing province only drops its own
 * rows (reported as a warning); the adapter fails only when every province failed.
 */
export async function fetchProvinces(
  ctx: SourceContext,
  codes: string[],
  path: (code: string) => string,
): Promise<{ rows: Row[]; warnings: string[] }> {
  const rows: Row[] = []
  const warnings: string[] = []
  let failures = 0
  let lastError: unknown = null
  for (let i = 0; i < codes.length; i += PROVINCE_PARALLEL) {
    const batch = codes.slice(i, i + PROVINCE_PARALLEL)
    const settled = await Promise.allSettled(batch.map((code) => getJson(ctx, path(code), false)))
    settled.forEach((res, j) => {
      if (res.status === 'fulfilled') {
        try {
          rows.push(...rowsOf(res.value))
          return
        } catch (err) {
          lastError = err
        }
      } else {
        lastError = res.reason
      }
      failures++
      const msg = lastError instanceof Error ? lastError.message : String(lastError)
      warnings.push(`province ${batch[j]} failed: ${msg}`)
    })
  }
  if (failures === codes.length) throw lastError instanceof Error ? lastError : new Error(String(lastError))
  return { rows, warnings }
}

/** Stale allowance for hourly ThaiWater feeds (cadence 60 min + publishing lag up to ~90 min). */
export const HOURLY_FEED_STALE_MIN = 180

function agencyCode(row: Row): string | null {
  return cleanText(obj(obj(row.agency)?.agency_shortname)?.en)?.toUpperCase() ?? null
}

function agencyOf(row: Row): string {
  const a = obj(row.agency)
  const short = cleanText(obj(a?.agency_shortname)?.th)
  return short ? `${short} via ThaiWater` : HII_AGENCY
}

function result(source: SourceId, stations: Station[], readings: Reading[], warnings: string[], now: Date): SourceFetchResult {
  return { source, stations, readings, fetchedAt: now.toISOString(), warnings }
}

// --- canal_waterlevel: BMA canal gauges republished by HII ---------------------------------

export function parseCanalWaterlevel(body: unknown, now: Date): SourceFetchResult {
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const row of rowsOf(body)) {
    const st = obj(row.station)
    const code = cleanText(st?.canal_oldcode)
    const lat = Number(st?.canal_lat)
    const lng = Number(st?.canal_long)
    if (!code || !isInThailand(lat, lng)) continue
    const id = canalStationId(code)
    if (seen.has(id)) continue
    seen.add(id)
    const bankRaw = num(st?.bank)
    const bank = bankRaw !== null && bankRaw > 0 && bankRaw < 10 ? round2(bankRaw) : null
    const warn = num(st?.warning_level)
    const crit = num(st?.critical_level)
    const thresholdsOk = warn !== null && crit !== null && crit > 0 && crit < 10 && warn <= crit
    const name = th(st?.canal_name) ?? code
    stations.push({
      id,
      source: 'thaiwater-canal',
      kind: 'canal',
      code,
      name: displayNameTh(name),
      lat,
      lng,
      district: th(obj(row.geocode)?.amphoe_name),
      province: th(obj(row.geocode)?.province_name) ?? 'กรุงเทพมหานคร',
      agency: 'สำนักการระบายน้ำ กทม. via ThaiWater',
      bankLevel: bank,
      // Same rule as the BMA feed: a lower bank under 0.3 m is a likely placeholder.
      bankUncertain: bank !== null && bank < 0.3 ? true : undefined,
      officialWarning: thresholdsOk ? warn : null,
      officialCritical: thresholdsOk ? crit : null,
    })
    const value = num(row.canal_value)
    const observedAt = thaiwaterTime(row.canal_datetime, now)
    if (value === null || Math.abs(value) >= 10 || value === -2 || !observedAt) continue
    readings.push({ stationId: id, observedAt, waterLevel: value, freeboard: bank === null ? null : round2(bank - value) })
  }
  return result('thaiwater-canal', stations, readings, warnings, now)
}

export const thaiwaterCanalSource: SourceAdapter = {
  id: 'thaiwater-canal',
  label: HII_AGENCY,
  thaiIpOnly: false,
  async fetch(ctx) {
    return parseCanalWaterlevel(await getJson(ctx, '/public/canal_waterlevel'), ctx.now)
  },
}

// --- waterlevel_load / provinces/waterlevel: river & canal telemetry (HII, RID, …) ----------

/** Bank used for freeboard: min_bank when it is real (≠ 0 and above the bed), else the lower bank. */
export function riverBank(st: Obj): number | null {
  const ground = num(st?.ground_level)
  const minBank = num(st?.min_bank)
  const groundKnown = ground !== null && ground !== 0
  if (minBank !== null && minBank !== 0 && (!groundKnown || minBank > ground)) return minBank
  const banks = [num(st?.left_bank), num(st?.right_bank)].filter((v): v is number => v !== null && v !== 0)
  const lower = banks.length ? Math.min(...banks) : null
  if (lower === null || (groundKnown && lower <= ground)) return null
  return lower
}

export function parseWaterlevel(rows: Row[], now: Date): SourceFetchResult {
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const st = obj(row.station)
    const nativeId = idOf(st?.id)
    const lat = Number(st?.tele_station_lat)
    const lng = Number(st?.tele_station_long)
    if (nativeId === null || !isInThailand(lat, lng)) continue
    const id = `thaiwater-wl:${nativeId}`
    if (seen.has(id)) continue
    seen.add(id)
    const bank = riverBank(st)
    const waterway = cleanText(row.river_name)
    const name = th(st?.tele_station_name) ?? cleanText(st?.tele_station_oldcode) ?? id
    const kind: StationKind = (waterway ?? name).startsWith('คลอง') ? 'canal' : 'river'
    stations.push({
      id,
      source: 'thaiwater-wl',
      kind,
      code: cleanText(st?.tele_station_oldcode),
      name,
      nameEn: cleanText(obj(st?.tele_station_name)?.en),
      waterway,
      lat,
      lng,
      district: th(obj(row.geocode)?.amphoe_name),
      province: th(obj(row.geocode)?.province_name),
      agency: agencyOf(row),
      bankLevel: bank === null ? null : round2(bank),
      groundLevel: num(st?.ground_level),
      // HII telemetry reports every 10 min; RID/EGAT/FOP rows are hourly and land ~80 min late.
      staleMinutes: agencyCode(row) === 'HII' ? null : HOURLY_FEED_STALE_MIN,
    })
    // Levels are metres above MSL and can be > 100 m upcountry — no |v| < 10 filter here.
    const wl = num(row.waterlevel_msl)
    const observedAt = thaiwaterTime(row.waterlevel_datetime, now)
    if (wl === null || !observedAt) continue
    readings.push({ stationId: id, observedAt, waterLevel: wl, freeboard: bank === null ? null : round2(bank - wl) })
  }
  return result('thaiwater-wl', stations, readings, warnings, now)
}

export function makeThaiwaterWaterlevelSource(provinces: string): SourceAdapter {
  const codes = provinceCodes(provinces)
  return {
    id: 'thaiwater-wl',
    label: HII_AGENCY,
    thaiIpOnly: false,
    async fetch(ctx) {
      if (codes === 'all') return parseWaterlevel(rowsOf(await getJson(ctx, '/public/waterlevel_load'), 'waterlevel_data'), ctx.now)
      const { rows, warnings } = await fetchProvinces(ctx, codes, (code) => `/provinces/waterlevel?province_code=${code}`)
      const out = parseWaterlevel(rows, ctx.now)
      return { ...out, warnings: [...warnings, ...out.warnings] }
    },
  }
}

// --- rain_24h / provinces/rain24 -------------------------------------------------------------

export function parseRain24(rows: Row[], now: Date): SourceFetchResult {
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const st = obj(row.station)
    const nativeId = idOf(st?.id)
    const lat = Number(st?.tele_station_lat)
    const lng = Number(st?.tele_station_long)
    if (nativeId === null || !isInThailand(lat, lng)) continue
    const oldcode = cleanText(st?.tele_station_oldcode)
    // BMA gauges (RF.*) share an id with the BMA rain feed so they never appear twice.
    const id = oldcode && /^RF\./i.test(oldcode) ? `rain:${oldcode.toUpperCase()}` : `thaiwater-rain:${nativeId}`
    if (seen.has(id)) continue
    seen.add(id)
    stations.push({
      id,
      source: 'thaiwater-rain',
      kind: 'rain',
      code: oldcode,
      name: th(st?.tele_station_name) ?? oldcode ?? id,
      nameEn: cleanText(obj(st?.tele_station_name)?.en),
      lat,
      lng,
      district: th(obj(row.geocode)?.amphoe_name),
      province: th(obj(row.geocode)?.province_name),
      agency: agencyOf(row),
      // rain_24h is published hourly with a 1–1.5 h lag.
      staleMinutes: HOURLY_FEED_STALE_MIN,
    })
    const rain24h = num(row.rain_24h)
    const observedAt = thaiwaterTime(row.rainfall_datetime, now)
    if (rain24h === null || rain24h < 0 || !observedAt) continue
    // rain_1h is ABSENT (not 0) for TMD/DISASTER rows — keep that as unknown.
    const rain1h = 'rain_1h' in row ? num(row.rain_1h) : null
    readings.push({ stationId: id, observedAt, rain24h, rain1h: rain1h !== null && rain1h >= 0 ? rain1h : null })
  }
  return result('thaiwater-rain', stations, readings, warnings, now)
}

export function makeThaiwaterRainSource(provinces: string): SourceAdapter {
  const codes = provinceCodes(provinces)
  return {
    id: 'thaiwater-rain',
    label: HII_AGENCY,
    thaiIpOnly: false,
    async fetch(ctx) {
      if (codes === 'all') return parseRain24(rowsOf(await getJson(ctx, '/public/rain_24h')), ctx.now)
      const { rows, warnings } = await fetchProvinces(ctx, codes, (code) => `/provinces/rain24?include_zero=1&province_code=${code}`)
      const out = parseRain24(rows, ctx.now)
      return { ...out, warnings: [...warnings, ...out.warnings] }
    },
  }
}

// --- flood_road: BMA road flood sensors republished by HII -----------------------------------

export function parseFloodRoad(body: unknown, now: Date): SourceFetchResult {
  const stations: Station[] = []
  const readings: Reading[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const row of rowsOf(body)) {
    const st = obj(row.station)
    const code = cleanText(st?.floodroad_oldcode)
    const nativeId = idOf(st?.id)
    const lat = Number(st?.floodroad_lat)
    const lng = Number(st?.floodroad_long)
    if ((!code && nativeId === null) || !isInThailand(lat, lng)) continue
    const id = code ? `road:${code.toUpperCase()}` : `thaiwater-road:${nativeId}`
    if (seen.has(id)) continue
    seen.add(id)
    const name = (th(st?.floodroad_name) ?? code ?? id).replace(/\s*\*+$/, '')
    stations.push({
      id,
      source: 'thaiwater-road',
      kind: 'roadflood',
      code,
      name: code && /^TN\./i.test(code) && !name.startsWith('อุโมงค์') ? `อุโมงค์ ${name}` : name,
      lat,
      lng,
      district: th(obj(row.geocode)?.amphoe_name),
      province: 'กรุงเทพมหานคร',
      agency: 'สำนักการระบายน้ำ กทม. via ThaiWater',
    })
    const cm = num(row.floodroad_value)
    const observedAt = thaiwaterTime(row.floodroad_datetime, now)
    if (cm === null || cm < 0 || cm >= 500 || !observedAt) continue
    readings.push({ stationId: id, observedAt, roadFloodCm: cm })
  }
  return result('thaiwater-road', stations, readings, warnings, now)
}

export const thaiwaterRoadSource: SourceAdapter = {
  id: 'thaiwater-road',
  label: HII_AGENCY,
  thaiIpOnly: false,
  async fetch(ctx) {
    return parseFloodRoad(await getJson(ctx, '/public/flood_road'), ctx.now)
  },
}
