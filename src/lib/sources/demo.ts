import type { Reading, SourceFetchResult, SourceId, Station, StationKind, WeatherNow } from '../types'
import { haversineKm } from '../geo'
import { canalStationId } from './bma-canal'
import { round2 } from './http'
import type { SourceAdapter } from './types'

// DATA_MODE=fixture: a deterministic synthetic data set for demos, development and screenshots
// when the real upstreams are unreachable. Station names, positions and bank heights are real
// BMA gauges (captured 28 Sep 2026); every water level, rain total and sensor value is SIMULATED.
// The UI shows a "ข้อมูลตัวอย่าง" banner whenever this mode is on.

export const DEMO_AGENCY = 'ข้อมูลสาธิต (จำลอง)'
const STEP_MIN = 10
const HISTORY_H = 72
const HOUR = 3_600_000

interface DemoCanal {
  code: string
  name: string
  shortName: string
  waterway: string
  district: string
  lat: number
  lng: number
  bank: number
  /** Freeboard on a calm day (m). */
  calmFb: number
  /** Extra rise at the peak of a storm (m). */
  stormGain: number
}

// Real gauges (สำนักการระบายน้ำ กทม.) in Prawet / Suan Luang / Bang Kapi.
const CANALS: DemoCanal[] = [
  { code: 'WL.PWT.03', name: 'ปตร. คลองประเวศบุรีรมย์ ตอนวัดกระทุ่มเสือปลา', shortName: 'ประเวศฯ วัดกระทุ่มฯ', waterway: 'คลองประเวศบุรีรมย์', district: 'ประเวศ', lat: 13.72396, lng: 100.68956, bank: 1.05, calmFb: 0.66, stormGain: 0.42 },
  { code: 'WL.SLL.01', name: 'คลองศาลาลอย ตอนถนนอ่อนนุช 61', shortName: 'ศาลาลอย อ่อนนุช 61', waterway: 'คลองศาลาลอย', district: 'ประเวศ', lat: 13.71599, lng: 100.67942, bank: 0.5, calmFb: 0.72, stormGain: 0.36 },
  { code: 'WL.MKT.01', name: 'คลองมะขามเทศ ตอนถนนพัฒนาการ', shortName: 'มะขามเทศ พัฒนาการ', waterway: 'คลองมะขามเทศ', district: 'ประเวศ', lat: 13.70015, lng: 100.67492, bank: 0.77, calmFb: 1.08, stormGain: 0.3 },
  { code: 'WL.MTG.01', name: 'บึงรับน้ำหมู่บ้านเมืองทองการ์เด้น', shortName: 'บึง ม.เมืองทองฯ', waterway: 'บึงรับน้ำหมู่บ้านเมืองทองการ์เด้น', district: 'ประเวศ', lat: 13.72417, lng: 100.66429, bank: 1.83, calmFb: 1.2, stormGain: 0.35 },
  { code: 'WL.TPK.02', name: 'คลองตาพุก ตอนถนนลาดกระบัง', shortName: 'ตาพุก ลาดกระบัง', waterway: 'คลองตาพุก', district: 'ประเวศ', lat: 13.72193, lng: 100.70919, bank: 1.0, calmFb: 0.46, stormGain: 0.4 },
  { code: 'WL.JKK.01', name: 'คลองจระเข้ขบ ตอนถนนสุขาภิบาล 2 ซอย 2', shortName: 'จระเข้ขบ สุขาภิบาล 2', waterway: 'คลองจระเข้ขบ', district: 'ประเวศ', lat: 13.71579, lng: 100.70241, bank: 0.85, calmFb: 0.58, stormGain: 0.38 },
  { code: 'WL.PWT.02', name: 'คลองประเวศบุรีรมย์ ตอนวัดขจรศิริ', shortName: 'ประเวศฯ วัดขจรฯ', waterway: 'คลองประเวศบุรีรมย์', district: 'สวนหลวง', lat: 13.71537, lng: 100.64117, bank: 2.5, calmFb: 2.05, stormGain: 0.45 },
  { code: 'WL.HMK.01', name: 'คลองหัวหมาก ตอนถนนศรีนครินทร์', shortName: 'หัวหมาก ศรีนครินทร์', waterway: 'คลองหัวหมาก', district: 'สวนหลวง', lat: 13.73309, lng: 100.64107, bank: 1.0, calmFb: 0.62, stormGain: 0.34 },
  { code: 'WL.HMK.03', name: 'คลองหัวหมาก ตอนซอยพัฒนาการ 32', shortName: 'หัวหมาก พัฒนาการ 32', waterway: 'คลองหัวหมาก', district: 'สวนหลวง', lat: 13.71858, lng: 100.62618, bank: 1.03, calmFb: 0.7, stormGain: 0.3 },
  { code: 'WL.KLA.01', name: 'คลองลาว ตอนถนนพัฒนาการ', shortName: 'ลาว พัฒนาการ', waterway: 'คลองลาว', district: 'สวนหลวง', lat: 13.73722, lng: 100.62499, bank: 1.26, calmFb: 0.85, stormGain: 0.33 },
  { code: 'WL.KKD.01', name: 'คลองเคล็ด ตอนถนนสุขุมวิท 77', shortName: 'เคล็ด สุขุมวิท 77', waterway: 'คลองเคล็ด', district: 'สวนหลวง', lat: 13.7091, lng: 100.6307, bank: 0.9, calmFb: 0.75, stormGain: 0.28 },
  { code: 'WL.KSK.01', name: 'คลองขุนสกล ตอนซอยศรีนครินทร์ 36', shortName: 'ขุนสกล ศรีนครินทร์ 36', waterway: 'คลองขุนสกล', district: 'สวนหลวง', lat: 13.70346, lng: 100.64388, bank: 0.9, calmFb: 0.8, stormGain: 0.3 },
  { code: 'WL.SOL.01', name: 'คลองสวนอ้อย ตอนถนนอ่อนนุช ซอย 28', shortName: 'สวนอ้อย อ่อนนุช 28', waterway: 'คลองสวนอ้อย', district: 'สวนหลวง', lat: 13.70696, lng: 100.6159, bank: 0.81, calmFb: 0.78, stormGain: 0.27 },
  { code: 'WL.KNB.02', name: 'คลองหนองบอน ตอนถนนเฉลิมพระเกียรติรัชกาลที่ 9', shortName: 'หนองบอน เฉลิมพระเกียรติ', waterway: 'คลองหนองบอน', district: 'ประเวศ', lat: 13.678, lng: 100.66295, bank: 1.5, calmFb: 1.3, stormGain: 0.35 },
  { code: 'WL.SSB.07', name: 'คลองแสนแสบ ตอนสำนักงานเขตบางกะปิ', shortName: 'แสนแสบ สนข.บางกะปิ', waterway: 'คลองแสนแสบ', district: 'บางกะปิ', lat: 13.76509, lng: 100.64791, bank: 0.75, calmFb: 0.52, stormGain: 0.36 },
  { code: 'WL.BMA.02', name: 'คลองบ้านม้า ตอนถนนรามคำแหง', shortName: 'บ้านม้า รามคำแหง', waterway: 'คลองบ้านม้า', district: 'บางกะปิ', lat: 13.77281, lng: 100.66569, bank: 2.68, calmFb: 1.95, stormGain: 0.4 },
  { code: 'WL.KJG.01', name: 'คลองจิก ตอนถนนหัวหมาก', shortName: 'จิก หัวหมาก', waterway: 'คลองจิก', district: 'บางกะปิ', lat: 13.7528, lng: 100.63296, bank: 1.0, calmFb: 0.68, stormGain: 0.32 },
]

interface DemoPoint {
  code: string
  name: string
  district: string
  lat: number
  lng: number
  /** Rain: storm intensity multiplier. Road: depth multiplier (0 = stays dry). */
  factor: number
}

// Rain gauge positions are approximate (demo only).
const RAIN: DemoPoint[] = [
  { code: 'DEMO.RF.01', name: 'กรุงเทพฯ บางนา สกษ.', district: 'บางนา', lat: 13.6667, lng: 100.6056, factor: 1.0 },
  { code: 'DEMO.RF.02', name: 'สนข.ประเวศ', district: 'ประเวศ', lat: 13.7177, lng: 100.6948, factor: 1.25 },
  { code: 'DEMO.RF.03', name: 'สนข.สวนหลวง', district: 'สวนหลวง', lat: 13.7305, lng: 100.6512, factor: 0.85 },
  { code: 'DEMO.RF.04', name: 'สนข.บางกะปิ', district: 'บางกะปิ', lat: 13.7655, lng: 100.6475, factor: 0.7 },
  { code: 'DEMO.RF.05', name: 'สนข.ลาดกระบัง', district: 'ลาดกระบัง', lat: 13.7225, lng: 100.7596, factor: 1.4 },
]

const ROADS: DemoPoint[] = [
  { code: 'DEMO.FL.01', name: 'ถ.พัฒนาการ (แยกศรีนครินทร์)', district: 'สวนหลวง', lat: 13.73602, lng: 100.63801, factor: 1.0 },
  { code: 'DEMO.FL.02', name: 'ถ.อ่อนนุช (ซ.อ่อนนุช 65)', district: 'ประเวศ', lat: 13.7168, lng: 100.6851, factor: 1.3 },
  { code: 'DEMO.FL.03', name: 'ถ.ลาดกระบัง (ซ.ลาดกระบัง 30/1)', district: 'ลาดกระบัง', lat: 13.7223, lng: 100.73718, factor: 0.8 },
]

// --- deterministic signal model ------------------------------------------------------------

/** Storms repeat every 61 h (anchored to a fixed epoch) so the demo always has some history. */
const STORM_PERIOD_H = 61
const STORM_ANCHOR_MS = Date.UTC(2026, 0, 1, 9, 0, 0)

function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return ((h >>> 0) % 10_000) / 10_000
}

/** Hours since the most recent storm onset (0..STORM_PERIOD_H). */
function hoursSinceStorm(tMs: number): number {
  const h = (tMs - STORM_ANCHOR_MS) / HOUR
  return ((h % STORM_PERIOD_H) + STORM_PERIOD_H) % STORM_PERIOD_H
}

/** Normalised canal response to the storm: rises over ~3 h, recedes over ~18 h (peak ≈ 1). */
export function stormResponse(tMs: number): number {
  const dt = hoursSinceStorm(tMs)
  return Math.min(1, (1 - Math.exp(-dt / 1.6)) * Math.exp(-dt / 16) * 1.45)
}

/** Rain rate in mm/h: a 4-hour burst at storm onset. */
export function rainRate(tMs: number, factor: number): number {
  const dt = hoursSinceStorm(tMs)
  const burst = Math.exp(-(((dt - 1.2) / 0.9) ** 2)) * 26 + Math.exp(-(((dt - 3) / 1.1) ** 2)) * 9
  return Math.max(0, burst * factor)
}

function rain24hAt(tMs: number, factor: number): number {
  let sum = 0
  for (let m = 0; m < 24 * 60; m += STEP_MIN) sum += (rainRate(tMs - m * 60_000, factor) * STEP_MIN) / 60
  return Math.round(sum * 10) / 10
}

function waterLevelAt(c: DemoCanal, idx: number, tMs: number): number {
  const tideH = (tMs - STORM_ANCHOR_MS) / HOUR
  const tide = 0.05 * Math.sin((2 * Math.PI * tideH) / 12.42 + idx)
  const noise = (hash01(idx, Math.floor(tMs / (STEP_MIN * 60_000))) - 0.5) * 0.012
  return round2(c.bank - c.calmFb + tide + stormResponse(tMs) * c.stormGain + noise)
}

function gridTimes(now: Date, hours: number): number[] {
  const step = STEP_MIN * 60_000
  const last = Math.floor(now.getTime() / step) * step
  const out: number[] = []
  // Start strictly inside the window so pruning (older than now − hours) never removes a point
  // that the next cycle would insert again.
  const first = Math.ceil((now.getTime() - hours * HOUR + 1) / step) * step
  for (let t = Math.min(first, last); t <= last; t += step) out.push(t)
  return out
}

function demoStation(source: SourceId, kind: StationKind, p: { code: string; name: string; district: string; lat: number; lng: number }, extra: Partial<Station> = {}): Station {
  return {
    id: kind === 'canal' ? canalStationId(p.code) : kind === 'rain' ? `rain:${p.code}` : kind === 'roadflood' ? `road:${p.code}` : `${source}:${p.code}`,
    source,
    kind,
    code: p.code,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    district: p.district,
    province: 'กรุงเทพมหานคร',
    agency: DEMO_AGENCY,
    ...extra,
  }
}

function result(source: SourceId, stations: Station[], readings: Reading[], now: Date): SourceFetchResult {
  return { source, stations, readings, fetchedAt: now.toISOString(), warnings: [] }
}

export function demoCanal(now: Date, hours = HISTORY_H): SourceFetchResult {
  const times = gridTimes(now, hours)
  const stations: Station[] = []
  const readings: Reading[] = []
  CANALS.forEach((c, idx) => {
    const st = demoStation('bma-canal', 'canal', c, { shortName: c.shortName, waterway: c.waterway, bankLevel: c.bank })
    stations.push(st)
    for (const t of times) {
      const wl = waterLevelAt(c, idx, t)
      readings.push({ stationId: st.id, observedAt: new Date(t).toISOString(), waterLevel: wl, freeboard: round2(c.bank - wl) })
    }
  })
  return result('bma-canal', stations, readings, now)
}

export function demoRain(now: Date, hours = HISTORY_H): SourceFetchResult {
  // Rain totals are expensive to integrate; sample history every 30 min.
  const times = gridTimes(now, hours).filter((t) => t % (30 * 60_000) === 0 || t === gridTimes(now, 0)[0])
  const stations: Station[] = []
  const readings: Reading[] = []
  for (const r of RAIN) {
    const st = demoStation('bma-rain', 'rain', r)
    stations.push(st)
    for (const t of times) {
      const rate1h = Math.round(rainRate(t, r.factor) * 10) / 10
      readings.push({ stationId: st.id, observedAt: new Date(t).toISOString(), rain24h: rain24hAt(t, r.factor), rain1h: rate1h })
    }
  }
  return result('bma-rain', stations, readings, now)
}

export function demoRoadFlood(now: Date, hours = HISTORY_H): SourceFetchResult {
  const times = gridTimes(now, hours)
  const stations: Station[] = []
  const readings: Reading[] = []
  for (const r of ROADS) {
    const st = demoStation('bma-roadflood', 'roadflood', r)
    stations.push(st)
    for (const t of times) {
      const depth = Math.max(0, Math.round((stormResponse(t) - 0.55) * 70 * r.factor * 10) / 10)
      readings.push({
        stationId: st.id,
        observedAt: new Date(t).toISOString(),
        roadFloodCm: depth,
        officialStatus: depth > 0 ? 'น้ำท่วม' : 'ปกติ',
      })
    }
  }
  return result('bma-roadflood', stations, readings, now)
}

/** Demo weather consistent with the simulated rain at the nearest demo gauge. */
export function demoWeather(lat: number, lng: number, now: Date): WeatherNow {
  const gauge = [...RAIN].sort((a, b) => haversineKm(lat, lng, a.lat, a.lng) - haversineKm(lat, lng, b.lat, b.lng))[0]!
  const t = now.getTime()
  const rate = Math.round(rainRate(t, gauge.factor) * 10) / 10
  const hourly = Array.from({ length: 12 }, (_, i) => {
    const ht = Math.floor(t / HOUR) * HOUR + i * HOUR
    const mm = Math.round(rainRate(ht + HOUR / 2, gauge.factor) * 10) / 10
    return { time: new Date(ht).toISOString(), precipitationMm: mm, probabilityPct: Math.min(95, Math.round(20 + mm * 6)) }
  })
  const next3 = hourly.slice(0, 3)
  const code = rate >= 10 ? 65 : rate >= 2.5 ? 63 : rate > 0.2 ? 61 : stormResponse(t) > 0.4 ? 3 : 2
  return {
    observedAt: new Date(Math.floor(t / (15 * 60_000)) * 15 * 60_000).toISOString(),
    condition: code === 65 ? 'ฝนตกหนัก' : code === 63 ? 'ฝนตกปานกลาง' : code === 61 ? 'ฝนตกเล็กน้อย' : code === 3 ? 'มีเมฆมาก' : 'มีเมฆบางส่วน',
    weatherCode: code,
    isDay: ((now.getUTCHours() + 7) % 24) >= 6 && ((now.getUTCHours() + 7) % 24) < 18,
    temperatureC: 29 + Math.round(Math.sin((((now.getUTCHours() + 7) % 24) - 9) / 24 * 2 * Math.PI) * 30) / 10,
    humidityPct: Math.round(66 + stormResponse(t) * 20),
    precipitationMmH: rate,
    precipitationProbabilityPct: Math.max(...next3.map((h) => h.probabilityPct)),
    rainNext3hMm: Math.round(next3.reduce((s, h) => s + h.precipitationMm, 0) * 10) / 10,
    rainNext24hMm: Math.round(hourly.reduce((s, h) => s + h.precipitationMm, 0) * 10) / 10,
    hourly,
    source: 'ข้อมูลสาธิต (จำลอง)',
  }
}

function demoAdapter(id: SourceId, build: (now: Date) => SourceFetchResult): SourceAdapter {
  return {
    id,
    label: DEMO_AGENCY,
    thaiIpOnly: false,
    async fetch(ctx) {
      return build(ctx.now)
    },
  }
}

export const DEMO_SOURCES: SourceAdapter[] = [
  demoAdapter('bma-canal', (now) => demoCanal(now)),
  demoAdapter('bma-rain', (now) => demoRain(now)),
  demoAdapter('bma-roadflood', (now) => demoRoadFlood(now)),
]

/** Centre of the demo area (Prawet), handy as the default place in fixture mode. */
export const DEMO_CENTER = { label: 'บ้าน (ตัวอย่าง) ประเวศ', lat: 13.7208, lng: 100.6830 }
