import type { Level, StationStatus } from '../types'
import { LEVEL_LABEL_TH } from '../types'
import { formatAgeTh } from '../time'

/** "1.19" — metres with 2 decimals, "-" when missing. */
export function m2(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(2)
}

/** "20.6" — one decimal, "-" when missing. */
export function d1(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(1)
}

/** "+5 ซม./ชม." / "-3 ซม./ชม." / "" when unknown or flat (|x| < 1). */
export function trendTh(cmPerHour: number | null | undefined): string {
  if (cmPerHour === null || cmPerHour === undefined || !Number.isFinite(cmPerHour)) return ''
  if (Math.abs(cmPerHour) < 1) return 'ทรงตัว'
  const r = Math.round(cmPerHour)
  return `${r > 0 ? 'ขึ้น' : 'ลง'} ${Math.abs(r)} ซม./ชม.`
}

export function levelTh(level: Level): string {
  return LEVEL_LABEL_TH[level]
}

export function stationDisplayName(s: StationStatus): string {
  return s.station.name || s.station.shortName || s.station.id
}

/**
 * One situation line in the style of the reference dashboard, e.g.
 * "ปตร. คลองประเวศบุรีรมย์ ตอนลาดกระบัง: น้ำ 0.79 ม. ตลิ่ง 1.98 ม. ห่างตลิ่ง 1.19 ม. ขึ้น 4 ซม./ชม. (กทม.: วิกฤต)"
 */
export function waterLineTh(s: StationStatus, now: Date = new Date()): string {
  const name = stationDisplayName(s)
  const r = s.reading
  if (!r || s.stale) {
    return `${name}: ไม่มีข้อมูลล่าสุด${r ? ` (อัปเดต${formatAgeTh(r.observedAt, now)})` : ''}`
  }
  const parts = [`น้ำ ${m2(r.waterLevel)} ม.`]
  if (s.station.bankLevel !== null && s.station.bankLevel !== undefined) parts.push(`ตลิ่ง ${m2(s.station.bankLevel)} ม.`)
  if (r.freeboard !== null && r.freeboard !== undefined) {
    parts.push(r.freeboard < 0 ? `สูงกว่าตลิ่ง ${m2(-r.freeboard)} ม.` : `ห่างตลิ่ง ${m2(r.freeboard)} ม.`)
  } else {
    parts.push('ไม่มีข้อมูลความสูงตลิ่ง')
  }
  const trend = trendTh(s.trendCmPerHour)
  if (trend) parts.push(trend)
  const official = r.officialStatus ? ` (${agencyShort(s.station.agency)}: ${r.officialStatus})` : ''
  return `${name}: ${parts.join(' ')}${official}`
}

export function agencyShort(agency: string): string {
  if (agency.includes('กทม') || agency.includes('กรุงเทพ')) return 'กทม.'
  if (agency.includes('สสน') || agency.toLowerCase().includes('thaiwater')) return 'สสน.'
  return agency
}

export function distanceTh(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return ''
  return km < 1 ? `${Math.round(km * 1000)} ม.` : `${km.toFixed(1)} กม.`
}
