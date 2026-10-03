import { z } from 'zod'
import { isInThailand } from '../geo'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '../types'

// Request schemas. Messages are Thai because the UI shows `{ error }` verbatim.

export const PLACE_DEFAULTS = {
  radiusKm: 3,
  maxStations: 4,
  rapidRiseCm: 10,
  notifyMinLevel: 'warning' as const,
}

const finite = (msg: string) => z.number({ error: msg }).finite({ error: msg })

export const FreeboardSchema = z
  .object({
    watch: finite('ค่าระยะห่างตลิ่งต้องเป็นตัวเลข').max(10, 'ค่าเฝ้าระวังต้องไม่เกิน 10 เมตร'),
    warning: finite('ค่าระยะห่างตลิ่งต้องเป็นตัวเลข'),
    critical: finite('ค่าระยะห่างตลิ่งต้องเป็นตัวเลข').min(-1, 'ค่าวิกฤตต้องไม่ต่ำกว่า -1 เมตร'),
  })
  .refine((t) => t.watch > t.warning && t.warning > t.critical, {
    error: 'เกณฑ์ระยะห่างตลิ่งต้องเรียงจากมากไปน้อย: เฝ้าระวัง > เตือนภัย > วิกฤต',
  })

export const RainSchema = z
  .object({
    watch: finite('ค่าปริมาณฝนต้องเป็นตัวเลข').positive('ค่าปริมาณฝนต้องมากกว่า 0'),
    warning: finite('ค่าปริมาณฝนต้องเป็นตัวเลข'),
    critical: finite('ค่าปริมาณฝนต้องเป็นตัวเลข').max(1000, 'ค่าปริมาณฝนต้องไม่เกิน 1000 มม.'),
  })
  .refine((t) => t.watch < t.warning && t.warning < t.critical, {
    error: 'เกณฑ์ปริมาณฝนต้องเรียงจากน้อยไปมาก: เฝ้าระวัง < เตือนภัย < วิกฤต',
  })

const label = z
  .string({ error: 'กรุณาระบุชื่อสถานที่' })
  .trim()
  .min(1, 'กรุณาระบุชื่อสถานที่')
  .max(60, 'ชื่อสถานที่ยาวได้ไม่เกิน 60 ตัวอักษร')
  // Control characters would break plain-text notifications.
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { error: 'ชื่อสถานที่มีอักขระที่ไม่รองรับ' })

const lat = finite('กรุณาระบุละติจูดเป็นตัวเลข')
const lng = finite('กรุณาระบุลองจิจูดเป็นตัวเลข')
const radiusKm = finite('รัศมีต้องเป็นตัวเลข').min(0.5, 'รัศมีต้องไม่น้อยกว่า 0.5 กม.').max(20, 'รัศมีต้องไม่เกิน 20 กม.')
const maxStations = z
  .number({ error: 'จำนวนจุดวัดต้องเป็นตัวเลข' })
  .int('จำนวนจุดวัดต้องเป็นจำนวนเต็ม')
  .min(1, 'ต้องติดตามอย่างน้อย 1 จุดวัด')
  .max(8, 'ติดตามได้สูงสุด 8 จุดวัด')
const rapidRiseCm = finite('เกณฑ์น้ำขึ้นเร็วต้องเป็นตัวเลข').min(3, 'เกณฑ์น้ำขึ้นเร็วต้องไม่น้อยกว่า 3 ซม./ชม.').max(50, 'เกณฑ์น้ำขึ้นเร็วต้องไม่เกิน 50 ซม./ชม.')
const notifyMinLevel = z.enum(['watch', 'warning', 'critical'], { error: 'ระดับขั้นต่ำที่แจ้งเตือนไม่ถูกต้อง' })

const inThailand = (p: { lat: number; lng: number }) => isInThailand(p.lat, p.lng)
const thailandMsg = { error: 'ตำแหน่งต้องอยู่ในประเทศไทย', path: ['lat'] }

export const PlaceInputSchema = z
  .object({
    label,
    lat,
    lng,
    radiusKm: radiusKm.default(PLACE_DEFAULTS.radiusKm),
    maxStations: maxStations.default(PLACE_DEFAULTS.maxStations),
    freeboard: FreeboardSchema.default({ ...DEFAULT_FREEBOARD }),
    rain: RainSchema.default({ ...DEFAULT_RAIN }),
    rapidRiseCm: rapidRiseCm.default(PLACE_DEFAULTS.rapidRiseCm),
    notifyMinLevel: notifyMinLevel.default(PLACE_DEFAULTS.notifyMinLevel),
  })
  .refine(inThailand, thailandMsg)

export type PlaceInput = z.infer<typeof PlaceInputSchema>

/** PATCH body: any subset; merged with the stored place and re-validated with PlaceInputSchema. */
export const PlacePatchSchema = z.object({
  label: label.optional(),
  lat: lat.optional(),
  lng: lng.optional(),
  radiusKm: radiusKm.optional(),
  maxStations: maxStations.optional(),
  freeboard: FreeboardSchema.optional(),
  rain: RainSchema.optional(),
  rapidRiseCm: rapidRiseCm.optional(),
  notifyMinLevel: notifyMinLevel.optional(),
})

export type PlacePatch = z.infer<typeof PlacePatchSchema>

export const ChannelInputSchema = z.object({
  type: z.enum(['webpush', 'line', 'telegram', 'ntfy', 'email', 'discord'], { error: 'ประเภทช่องทางแจ้งเตือนไม่ถูกต้อง' }),
  /** webpush: PushSubscription JSON (object or string); ntfy topic/URL; email; Discord webhook URL. */
  target: z.union([z.string().max(4000, 'ข้อมูลปลายทางยาวเกินไป'), z.record(z.string(), z.unknown())]).optional(),
})

export type ChannelInput = z.infer<typeof ChannelInputSchema>

// --- relay ingest payload -------------------------------------------------------

const SOURCE_IDS = [
  'bma-canal',
  'bma-pump',
  'bma-roadflood',
  'bma-rain',
  'thaiwater-canal',
  'thaiwater-wl',
  'thaiwater-rain',
  'popnix',
] as const

const optNum = z.number().finite().nullable().optional()
const optStr = (max: number) => z.string().max(max).nullable().optional()
const isoTime = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), { error: 'invalid timestamp' })

export const StationSchema = z
  .object({
    id: z.string().min(1).max(200),
    source: z.enum(SOURCE_IDS),
    kind: z.enum(['canal', 'river', 'pump', 'roadflood', 'rain']),
    code: optStr(100),
    name: z.string().min(1).max(300),
    shortName: optStr(200),
    nameEn: optStr(300),
    waterway: optStr(200),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    district: optStr(200),
    province: optStr(200),
    agency: z.string().max(200),
    bankLevel: optNum,
    bankUncertain: z.boolean().optional(),
    groundLevel: optNum,
    officialWarning: optNum,
    officialCritical: optNum,
  })
  // Keep optional fields added to Station later instead of silently dropping them.
  .loose()

export const ReadingSchema = z
  .object({
    stationId: z.string().min(1).max(200),
    observedAt: isoTime,
    waterLevel: optNum,
    freeboard: optNum,
    rain1h: optNum,
    rain24h: optNum,
    roadFloodCm: optNum,
    pumpsRunning: optNum,
    pumpsTotal: optNum,
    officialStatus: optStr(100),
  })
  .loose()

export const SourceFetchResultSchema = z.object({
  source: z.enum(SOURCE_IDS),
  stations: z.array(StationSchema).max(20_000),
  readings: z.array(ReadingSchema).max(100_000),
  fetchedAt: isoTime,
  warnings: z.array(z.string().max(1000)).max(1000).default([]),
})

export const IngestPayloadSchema = z.object({
  results: z.array(SourceFetchResultSchema).max(20),
  /** Sources the relay tried but could not fetch (recorded as unhealthy). */
  failures: z
    .array(z.object({ source: z.enum(SOURCE_IDS), error: z.string().max(1000), attemptedAt: isoTime.optional() }))
    .max(20)
    .default([]),
})

export type IngestPayload = z.infer<typeof IngestPayloadSchema>

// --- query helpers ---------------------------------------------------------------

/** Parse a numeric query parameter; undefined when missing/blank, NaN when not a number. */
export function queryNumber(params: URLSearchParams, key: string): number | undefined {
  const v = params.get(key)
  if (v === null || v.trim() === '') return undefined
  return Number(v)
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
