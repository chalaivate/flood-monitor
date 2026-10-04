export const BANGKOK_TZ = 'Asia/Bangkok'

const MINUTE = 60_000

/** Parse ASP.NET JSON dates like "/Date(1790535900000)/" (optionally with offset) to ISO UTC. */
export function parseDotNetDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//)
  if (!m) return null
  const ms = Number(m[1])
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Parse a Bangkok local timestamp string to ISO UTC.
 * Accepts "2026-09-28 02:05[:ss]", "2026/09/28 02:05", "28/09/2569 02:05" (Buddhist year),
 * and ISO strings with explicit offsets (returned normalised).
 */
export function parseBangkokLocal(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const s = value.trim()
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  let y: number, mo: number, d: number, h = 0, mi = 0, se = 0
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (m) {
    ;[y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    h = Number(m[4] ?? 0); mi = Number(m[5] ?? 0); se = Number(m[6] ?? 0)
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
    if (!m) return null
    ;[d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    h = Number(m[4] ?? 0); mi = Number(m[5] ?? 0); se = Number(m[6] ?? 0)
  }
  if (y > 2400) y -= 543 // Buddhist Era → CE
  const utcMs = Date.UTC(y, mo - 1, d, h - 7, mi, se) // Bangkok is UTC+7, no DST
  return Number.isNaN(utcMs) ? null : new Date(utcMs).toISOString()
}

export function minutesBetween(aIso: string, b: Date | string): number {
  const bMs = typeof b === 'string' ? Date.parse(b) : b.getTime()
  return (bMs - Date.parse(aIso)) / MINUTE
}

export function isStale(observedAt: string | null | undefined, now: Date, staleMinutes: number): boolean {
  if (!observedAt) return true
  const age = minutesBetween(observedAt, now)
  return !Number.isFinite(age) || age > staleMinutes
}

const fmtShort = new Intl.DateTimeFormat('th-TH', {
  timeZone: BANGKOK_TZ,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const fmtTime = new Intl.DateTimeFormat('th-TH', {
  timeZone: BANGKOK_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** "03/10 11:35" in Bangkok time. */
export function formatShortBkk(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const parts = Object.fromEntries(fmtShort.formatToParts(d).map((p) => [p.type, p.value]))
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`
}

/** "11:35" in Bangkok time. */
export function formatTimeBkk(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : fmtTime.format(d)
}

/** Thai relative age: "เมื่อสักครู่", "12 นาทีที่แล้ว", "3 ชม. ที่แล้ว", "2 วันที่แล้ว". */
export function formatAgeTh(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'ไม่ทราบเวลา'
  const mins = Math.round(minutesBetween(iso, now))
  if (!Number.isFinite(mins)) return 'ไม่ทราบเวลา'
  if (mins < 2) return 'เมื่อสักครู่'
  if (mins < 60) return `${mins} นาทีที่แล้ว`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} ชม. ที่แล้ว`
  return `${Math.round(hours / 24)} วันที่แล้ว`
}
