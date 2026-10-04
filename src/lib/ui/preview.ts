import type { DashboardSnapshot, HistoryPoint, Level } from '../types'
import { LEVEL_ORDER } from '../types'

// Helpers for /dev/preview: render the dashboard from a static fixture without the API.

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/** Shift every ISO-8601 UTC timestamp in a JSON value by `deltaMs`. */
export function shiftTimes<T>(value: T, deltaMs: number): T {
  if (typeof value === 'string') {
    return (ISO_RE.test(value) ? new Date(Date.parse(value) + deltaMs).toISOString() : value) as T
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, deltaMs)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = shiftTimes(v, deltaMs)
    return out as T
  }
  return value
}

/** Move the fixture so that it was generated at `nowMs` (ages stay realistic). */
export function rebaseSnapshot(s: DashboardSnapshot, nowMs: number): DashboardSnapshot {
  return shiftTimes(s, nowMs - Date.parse(s.generatedAt))
}

/** Deterministic pseudo-random in [0, 1). */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/**
 * 48 h of 10-minute freeboard history per water station that ends exactly at the
 * snapshot reading, with a semi-diurnal tide, a storm dip and (for the 2nd series)
 * a sensor outage so the chart's gap handling is visible.
 */
export function synthHistory(s: DashboardSnapshot, hours = 48): Record<string, HistoryPoint[]> {
  const out: Record<string, HistoryPoint[]> = {}
  s.water.forEach((w, si) => {
    const end = w.reading?.observedAt ? Date.parse(w.reading.observedAt) : Date.parse(s.generatedAt)
    const fbEnd = w.reading?.freeboard
    const bank = w.station.bankLevel
    if (typeof fbEnd !== 'number' || typeof bank !== 'number') {
      out[w.station.id] = []
      return
    }
    const pts: HistoryPoint[] = []
    const step = 10 * 60_000
    const n = Math.round((hours * 3_600_000) / step)
    const amp = 0.04 + 0.02 * si
    const shape = (t: number) => {
      const h = (end - t) / 3_600_000
      const tide = amp * Math.sin((h / 12.4) * 2 * Math.PI + si)
      const storm = -0.16 * Math.exp(-(((h - 30) / 5) ** 2)) * (1 + 0.3 * si)
      const noise = (rand(si * 1000 + Math.round(t / step)) - 0.5) * 0.012
      return tide + storm + noise
    }
    const offset = fbEnd - shape(end)
    for (let i = n; i >= 0; i--) {
      const t = end - i * step
      const h = i / 6
      if (si === 1 && h > 20 && h < 23) continue // outage
      const fb = i === 0 ? fbEnd : Math.round((offset + shape(t)) * 100) / 100
      pts.push({ t: new Date(t).toISOString(), freeboard: fb, waterLevel: Math.round((bank - fb) * 100) / 100 })
    }
    out[w.station.id] = pts
  })
  return out
}

export type PreviewVariant = 'normal' | 'critical' | 'empty' | 'stale' | 'noweather'

export const PREVIEW_VARIANTS: { id: PreviewVariant; label: string }[] = [
  { id: 'normal', label: 'ตัวอย่างปกติ' },
  { id: 'critical', label: 'วิกฤต' },
  { id: 'empty', label: 'ไม่พบจุดวัด' },
  { id: 'stale', label: 'ข้อมูลค้าง' },
  { id: 'noweather', label: 'ไม่มีอากาศ/ฝน' },
]

export function isPreviewVariant(v: unknown): v is PreviewVariant {
  return PREVIEW_VARIANTS.some((p) => p.id === v)
}

/** Derive the alternative states used for visual checks. */
export function applyVariant(s: DashboardSnapshot, variant: PreviewVariant): DashboardSnapshot {
  const c: DashboardSnapshot = structuredClone(s)
  if (variant === 'critical') {
    const first = c.water[0]
    if (first?.reading && typeof first.station.bankLevel === 'number') {
      first.reading.freeboard = 0.06
      first.reading.waterLevel = Math.round((first.station.bankLevel - 0.06) * 100) / 100
      first.level = 'critical'
      first.trendCmPerHour = 12
    }
    const second = c.water[1]
    if (second?.reading && typeof second.station.bankLevel === 'number') {
      second.reading.freeboard = 0.24
      second.reading.waterLevel = Math.round((second.station.bankLevel - 0.24) * 100) / 100
      second.level = 'warning'
      second.trendCmPerHour = 6
    }
    if (c.rainMax24h) {
      c.rainMax24h.valueMm = 96.4
      c.rainMax24h.level = 'warning'
    }
    c.overall.level = 'critical'
    c.overall.headline = 'วิกฤต — น้ำใกล้ตลิ่ง 2 จุด · น้ำท่วมถนน 1 จุด · ฝนหนักมาก'
    c.overall.lines = c.overall.lines.map((l) => {
      if (first && l.stationId === first.station.id) {
        return { ...l, level: 'critical' as Level, text: `${first.station.name}: น้ำ ${first.reading?.waterLevel?.toFixed(2)} ม. ตลิ่ง ${first.station.bankLevel?.toFixed(2)} ม. ห่างตลิ่ง 0.06 ม. ขึ้น 12 ซม./ชม.` }
      }
      if (second && l.stationId === second.station.id) {
        return { ...l, level: 'warning' as Level, text: `${second.station.name}: น้ำ ${second.reading?.waterLevel?.toFixed(2)} ม. ตลิ่ง ${second.station.bankLevel?.toFixed(2)} ม. ห่างตลิ่ง 0.24 ม. ขึ้น 6 ซม./ชม.` }
      }
      if (l.stationId === c.rainMax24h?.station.id) {
        return { ...l, level: 'warning' as Level, text: l.text.replace(/[\d.]+ มม\. \([^)]*\)/, '96.4 มม. (ฝนหนักมาก)') }
      }
      return l
    })
    c.overall.lines.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level])
  } else if (variant === 'empty') {
    c.water = []
    c.roadFlood = []
    c.overall = { level: 'unknown', headline: 'ไม่พบจุดวัดระดับน้ำในรัศมีที่กำหนด', lines: c.overall.lines.filter((l) => l.stationId === c.rainMax24h?.station.id) }
  } else if (variant === 'stale') {
    const old = new Date(Date.parse(c.generatedAt) - 3 * 3_600_000).toISOString()
    c.lastIngestAt = old
    c.water = c.water.map((w, i) => (i % 2 === 0 ? { ...w, stale: true, level: 'unknown' as Level, trendCmPerHour: null, reading: w.reading ? { ...w.reading, observedAt: old } : null } : w))
  } else if (variant === 'noweather') {
    c.weather = null
    c.rainMax24h = null
    c.radar = []
  }
  return c
}
