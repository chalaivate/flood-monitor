import type {
  AlertEvent,
  AlertKind,
  AlertState,
  DashboardSnapshot,
  Level,
  Place,
  StationStatus,
} from '../types'
import { LEVEL_ORDER } from '../types'
import { formatShortBkk } from '../time'
import { d1, distanceTh, levelTh, m2, stationDisplayName, trendTh, waterLineTh } from './format'
import { freeboardThresholdFor, rainClassTh, ROAD_FLOOD_CM } from './status'

/** Water must recede this far past a threshold before we step a level down (avoids flapping). */
export const HYSTERESIS_M = 0.05
/** Rain total must fall this far below a threshold before stepping down. */
export const RAIN_MARGIN_MM = 5
/** Road flood depth must fall this far below a threshold before stepping down. */
export const ROAD_MARGIN_CM = 3
/** Minimum minutes between two rapid-rise alerts for the same station. */
export const RAPID_RISE_COOLDOWN_MIN = 120
/** While a station stays critical, remind at most this often. */
export const CRITICAL_REMINDER_MIN = 180
/** Rapid-rise alerts fire when the station is already ≥ watch, or will reach watch within this horizon. */
export const RAPID_RISE_HORIZON_H = 3

/** Appended to every alert: this is the system's own assessment, not an official warning. */
export const ALERT_DISCLAIMER = 'ประเมินอัตโนมัติจากข้อมูลหน่วยงาน ไม่ใช่ประกาศทางการ · กทม. 1555 · ปภ. 1784'

export type AlertEventDraft = Omit<AlertEvent, 'id' | 'deliveries'>

export interface AlertInput {
  place: Place
  water: StationStatus[]
  roadFlood: StationStatus[]
  rainMax24h: DashboardSnapshot['rainMax24h']
  prev: AlertState[]
  now: Date
  /** Link appended to messages, e.g. https://host/?place=<id>. */
  dashboardUrl?: string
}

export interface AlertOutput {
  /** At most one merged event per evaluation (or none). */
  event: AlertEventDraft | null
  /** Individual findings before merging (useful for tests / logs). */
  findings: Finding[]
  /** Full new state list for the place (unchanged keys carried over). */
  states: AlertState[]
}

export interface Finding {
  kind: AlertKind
  level: Level
  title: string
  line: string
  stationIds: string[]
  key: string
}

const gte = (a: Level, b: Level) => LEVEL_ORDER[a] >= LEVEL_ORDER[b]
const minutesSince = (iso: string | null | undefined, now: Date) =>
  iso ? (now.getTime() - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY

function shortName(s: StationStatus): string {
  return s.station.shortName || stationDisplayName(s)
}

/**
 * Decide the level we should hold given the previous level and the raw level, applying
 * hysteresis on the way down. `recededPast(prevLevel)` must say whether the value has moved
 * far enough past the boundary of `prevLevel` to leave it.
 */
function settleLevel(prev: Level | undefined, raw: Level, recededPast: (lvl: Level) => boolean): Level {
  if (!prev || prev === 'unknown' || LEVEL_ORDER[raw] >= LEVEL_ORDER[prev]) return raw
  // Stepping down: walk down one level at a time while the margin is satisfied.
  let held: Level = prev
  while (LEVEL_ORDER[held] > LEVEL_ORDER[raw] && recededPast(held)) {
    held = held === 'critical' ? 'warning' : held === 'warning' ? 'watch' : 'normal'
  }
  return held
}

export function evaluateAlerts(input: AlertInput): AlertOutput {
  const { place, now } = input
  const nowIso = now.toISOString()
  const prevByKey = new Map(input.prev.map((s) => [s.key, s]))
  const next = new Map(prevByKey)
  const findings: Finding[] = []
  const minLevel = place.notifyMinLevel

  const touch = (key: string, level: Level, lastValue: number | null, notified: boolean) => {
    const prev = prevByKey.get(key)
    next.set(key, {
      placeId: place.id,
      key,
      level,
      lastValue,
      lastNotifiedAt: notified ? nowIso : (prev?.lastNotifiedAt ?? null),
      updatedAt: nowIso,
    })
  }

  // --- Water level stations: escalate / de-escalate / critical reminders --------------
  for (const s of input.water) {
    const key = `station:${s.station.id}`
    const fb = s.reading?.freeboard
    if (s.stale || s.level === 'unknown' || fb === null || fb === undefined) continue
    const prev = prevByKey.get(key)
    const level = settleLevel(prev?.level, s.level, (lvl) => {
      const boundary = freeboardThresholdFor(lvl, place.freeboard)
      return boundary === null ? true : fb >= boundary + HYSTERESIS_M
    })
    const prevLevel = prev?.level
    let notified = false
    if (!prevLevel || prevLevel === 'unknown') {
      if (gte(level, minLevel)) {
        findings.push({
          kind: 'escalate',
          level,
          key,
          stationIds: [s.station.id],
          title: `${levelTh(level)}: ${shortName(s)} ห่างตลิ่ง ${m2(fb)} ม.`,
          line: `${levelTh(level)} · ${waterLineTh(s, now)}`,
        })
        notified = true
      }
    } else if (LEVEL_ORDER[level] > LEVEL_ORDER[prevLevel]) {
      if (gte(level, minLevel)) {
        findings.push({
          kind: 'escalate',
          level,
          key,
          stationIds: [s.station.id],
          title: `${levelTh(level)}: ${shortName(s)} ห่างตลิ่ง ${m2(fb)} ม.`,
          line: `${levelTh(prevLevel)} → ${levelTh(level)} · ${waterLineTh(s, now)}`,
        })
        notified = true
      }
    } else if (LEVEL_ORDER[level] < LEVEL_ORDER[prevLevel]) {
      if (gte(prevLevel, minLevel)) {
        findings.push({
          kind: 'deescalate',
          level,
          key,
          stationIds: [s.station.id],
          title: `คลี่คลาย: ${shortName(s)} ลดเป็น${levelTh(level)}`,
          line: `${levelTh(prevLevel)} → ${levelTh(level)} · ${waterLineTh(s, now)}`,
        })
        notified = true
      }
    } else if (level === 'critical' && minutesSince(prev?.lastNotifiedAt, now) >= CRITICAL_REMINDER_MIN) {
      findings.push({
        kind: 'escalate',
        level,
        key,
        stationIds: [s.station.id],
        title: `ยังวิกฤต: ${shortName(s)} ห่างตลิ่ง ${m2(fb)} ม.`,
        line: `ยังอยู่ระดับวิกฤต · ${waterLineTh(s, now)}`,
      })
      notified = true
    }
    touch(key, level, fb, notified)
  }

  // --- Rapid rise -------------------------------------------------------------------
  for (const s of input.water) {
    const key = `rise:${s.station.id}`
    const trend = s.trendCmPerHour
    const fb = s.reading?.freeboard
    if (s.stale || trend === null || trend === undefined || fb === null || fb === undefined) continue
    if (trend < place.rapidRiseCm) continue
    const hoursToWatch = (fb - place.freeboard.watch) / (trend / 100)
    const relevant = gte(s.level, 'watch') || hoursToWatch <= RAPID_RISE_HORIZON_H
    if (!relevant) continue
    const prev = prevByKey.get(key)
    if (minutesSince(prev?.lastNotifiedAt, now) < RAPID_RISE_COOLDOWN_MIN) continue
    const eta =
      s.level === 'normal' && hoursToWatch > 0
        ? ` คาดว่าจะถึงระดับเฝ้าระวังในราว ${hoursToWatch < 1 ? `${Math.max(10, Math.round(hoursToWatch * 60))} นาที` : `${d1(hoursToWatch)} ชม.`}`
        : ''
    findings.push({
      kind: 'rapid_rise',
      level: s.level === 'normal' ? 'watch' : s.level,
      key,
      stationIds: [s.station.id],
      title: `น้ำขึ้นเร็ว: ${shortName(s)} ${trendTh(trend)}`,
      line: `น้ำขึ้นเร็ว ${trendTh(trend)}${eta} · ${waterLineTh(s, now)}`,
    })
    touch(key, s.level, trend, true)
  }

  // --- Rain (max 24h total among nearest gauges) -------------------------------------
  if (input.rainMax24h) {
    const { valueMm, station, distanceKm, level: rawLevel } = input.rainMax24h
    const key = 'rain'
    const prev = prevByKey.get(key)
    if (rawLevel !== 'unknown') {
      const level = settleLevel(prev?.level, rawLevel, (lvl) => {
        const boundary = lvl === 'critical' ? place.rain.critical : lvl === 'warning' ? place.rain.warning : place.rain.watch
        return valueMm < boundary - RAIN_MARGIN_MM
      })
      const prevLevel = prev?.level
      const escalated = !prevLevel || prevLevel === 'unknown' ? gte(level, 'watch') : LEVEL_ORDER[level] > LEVEL_ORDER[prevLevel]
      let notified = false
      if (escalated && gte(level, minLevel)) {
        findings.push({
          kind: 'rain',
          level,
          key,
          stationIds: [station.id],
          title: `${rainClassTh(valueMm)}: ${d1(valueMm)} มม. ใน 24 ชม.`,
          line: `ฝนสะสม 24 ชม. ${d1(valueMm)} มม. (${rainClassTh(valueMm)}) ที่ ${station.name} (${distanceTh(distanceKm)})`,
        })
        notified = true
      }
      touch(key, level, valueMm, notified)
    }
  }

  // --- Road flood sensors -------------------------------------------------------------
  for (const s of input.roadFlood) {
    const key = `road:${s.station.id}`
    const cm = s.reading?.roadFloodCm
    if (s.stale || s.level === 'unknown' || cm === null || cm === undefined) continue
    const prev = prevByKey.get(key)
    const level = settleLevel(prev?.level, s.level, (lvl) => {
      const boundary = lvl === 'critical' ? ROAD_FLOOD_CM.critical : lvl === 'warning' ? ROAD_FLOOD_CM.warning : ROAD_FLOOD_CM.watch
      return cm < boundary - ROAD_MARGIN_CM
    })
    const prevLevel = prev?.level
    let notified = false
    const label = `${stationDisplayName(s)}${s.distanceKm !== null && s.distanceKm !== undefined ? ` (${distanceTh(s.distanceKm)})` : ''}`
    if ((!prevLevel || prevLevel === 'unknown' ? true : LEVEL_ORDER[level] > LEVEL_ORDER[prevLevel]) && gte(level, minLevel)) {
      findings.push({
        kind: 'escalate',
        level,
        key,
        stationIds: [s.station.id],
        title: `น้ำท่วมถนน: ${shortName(s)} ${Math.round(cm)} ซม.`,
        line: `น้ำท่วมขังผิวถนน ${Math.round(cm)} ซม. ที่ ${label}`,
      })
      notified = true
    } else if (prevLevel && prevLevel !== 'unknown' && LEVEL_ORDER[level] < LEVEL_ORDER[prevLevel] && gte(prevLevel, minLevel)) {
      findings.push({
        kind: 'deescalate',
        level,
        key,
        stationIds: [s.station.id],
        title: `คลี่คลาย: น้ำบนถนน ${shortName(s)} ลดลง`,
        line: `น้ำบนถนนลดลงเหลือ ${Math.round(cm)} ซม. ที่ ${label}`,
      })
      notified = true
    }
    touch(key, level, cm, notified)
  }

  return { event: mergeFindings(place, findings, now, input.dashboardUrl), findings, states: [...next.values()] }
}

const KIND_PRIORITY: Record<AlertKind, number> = {
  escalate: 4,
  rapid_rise: 3,
  rain: 2,
  deescalate: 1,
  stale: 0,
  test: 0,
}

/** Merge all findings of one evaluation into a single message so users get one push per cycle. */
export function mergeFindings(place: Place, findings: Finding[], now: Date, dashboardUrl?: string): AlertEventDraft | null {
  if (findings.length === 0) return null
  const sorted = [...findings].sort(
    (a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind],
  )
  const top = sorted[0]!
  const title = sorted.length > 1 ? `${top.title} (+อีก ${sorted.length - 1} รายการ)` : top.title
  const lines = sorted.map((f) => `• ${f.line}`)
  const footer = [`พื้นที่: ${place.label}`, `เวลา ${formatShortBkk(now.toISOString())} น.`]
  if (dashboardUrl) footer.push(dashboardUrl)
  footer.push(ALERT_DISCLAIMER)
  const body = [...lines, '', ...footer].join('\n')
  return {
    placeId: place.id,
    kind: top.kind,
    level: top.level,
    title,
    body: body.length > 1000 ? `${body.slice(0, 990)}…` : body,
    stationIds: [...new Set(sorted.flatMap((f) => f.stationIds))],
    createdAt: now.toISOString(),
  }
}
