// Shared domain contracts. Every module (sources, engine, store, notify, API, UI)
// speaks these types. Keep this file dependency-free so it can be imported from
// server code, client components, the worker and tests alike.

/**
 * Data sources we ingest. Station ids are `${source}:${nativeId}`, except BMA gauges that
 * ThaiWater also republishes, which use the BMA code so both feeds merge into one station:
 * `canal:WL.KJN.02`, `rain:RF.LSI.03`, `road:FL.WTL.04` (tunnels: `road:TN.BKA.01:ขาเข้า`).
 */
export type SourceId =
  | 'bma-canal' // สำนักการระบายน้ำ กทม. — canal / gate water level (weather.bangkok.go.th)
  | 'bma-pump' // สำนักการระบายน้ำ กทม. — pump stations
  | 'bma-roadflood' // สำนักการระบายน้ำ กทม. — road flood depth sensors
  | 'bma-rain' // สำนักการระบายน้ำ กทม. — rain gauges
  | 'thaiwater-canal' // สสน. ThaiWater — mirror of BMA canal gauges (cloud-reachable fallback)
  | 'thaiwater-wl' // สสน. ThaiWater — water level (nationwide)
  | 'thaiwater-rain' // สสน. ThaiWater — rainfall 24h (nationwide)
  | 'thaiwater-road' // สสน. ThaiWater — mirror of BMA road flood sensors

export type StationKind = 'canal' | 'river' | 'pump' | 'roadflood' | 'rain'

/**
 * Severity ladder used everywhere (colour, sorting, alerts).
 * unknown = no usable data (sensor offline, stale, or no bank height).
 */
export type Level = 'normal' | 'watch' | 'warning' | 'critical' | 'unknown'

export const LEVEL_ORDER: Record<Level, number> = {
  unknown: -1,
  normal: 0,
  watch: 1,
  warning: 2,
  critical: 3,
}

export const LEVEL_LABEL_TH: Record<Level, string> = {
  normal: 'ปกติ',
  watch: 'เฝ้าระวัง',
  warning: 'เตือนภัย',
  critical: 'วิกฤต',
  unknown: 'ไม่มีข้อมูล',
}

export interface Station {
  /** `${source}:${nativeId}` — stable across polls. */
  id: string
  source: SourceId
  kind: StationKind
  /** Agency code, e.g. BMA `water_code` "WL.KJN.02". */
  code?: string | null
  /** Full Thai name, e.g. "ปตร. คลองประเวศบุรีรมย์ ตอนลาดกระบัง". */
  name: string
  /** Short Thai name for gauges, e.g. "ประเวศฯ ลาดกระบัง". */
  shortName?: string | null
  nameEn?: string | null
  /** Canal / river name, e.g. "คลองแสนแสบ". */
  waterway?: string | null
  lat: number
  lng: number
  district?: string | null
  province?: string | null
  /** Human readable agency for attribution, e.g. "สำนักการระบายน้ำ กทม.". */
  agency: string
  /**
   * Lower of the two bank heights (same datum as water level), metres.
   * null when the agency has no plausible bank height.
   */
  bankLevel?: number | null
  /**
   * The agency's bank heights look implausible (left/right differ by > 1 m or lower bank < 0.3 m).
   * Status is capped at "watch" so a bad bank value alone never raises a red alert.
   */
  bankUncertain?: boolean
  groundLevel?: number | null
  /**
   * Minutes after which this station's latest reading counts as stale, when the feed is slower
   * than the per-kind default (e.g. hourly RID gauges relayed with ~80 min lag → 180).
   */
  staleMinutes?: number | null
  /** Agency thresholds, informational only (often unreliable for BMA). */
  officialWarning?: number | null
  officialCritical?: number | null
}

export interface Reading {
  stationId: string
  /** ISO-8601 UTC instant the sensor measured (not when we fetched). */
  observedAt: string
  /** Water level in metres, same datum as Station.bankLevel. */
  waterLevel?: number | null
  /** bankLevel − waterLevel in metres. Negative = water above bank. */
  freeboard?: number | null
  /** Rainfall in mm. */
  rain1h?: number | null
  rain24h?: number | null
  /** Water depth on the road in cm (road flood sensors). */
  roadFloodCm?: number | null
  pumpsRunning?: number | null
  pumpsTotal?: number | null
  /** Agency's own status text, e.g. "ปกติ", "เตือนภัย", "วิกฤต", "ขัดข้อง". */
  officialStatus?: string | null
}

export interface SourceFetchResult {
  source: SourceId
  stations: Station[]
  readings: Reading[]
  /** ISO time we completed the fetch. */
  fetchedAt: string
  /** Non-fatal data quality notes (skipped records etc). */
  warnings: string[]
}

export interface SourceHealth {
  source: SourceId
  ok: boolean
  lastAttemptAt: string
  lastSuccessAt?: string | null
  error?: string | null
  stationCount?: number
  /**
   * Newest observation time in the last successful fetch. A source can answer HTTP 200 while
   * every sensor is frozen, so freshness is judged on this, not on lastSuccessAt.
   */
  latestObservationAt?: string | null
}

/** Freeboard (distance water→bank) thresholds in metres. Below value ⇒ level. */
export interface FreeboardThresholds {
  watch: number
  warning: number
  critical: number
}

/** 24h rainfall thresholds in mm. At or above value ⇒ level. */
export interface RainThresholds {
  watch: number
  warning: number
  critical: number
}

export const DEFAULT_FREEBOARD: FreeboardThresholds = { watch: 0.6, warning: 0.3, critical: 0.1 }

/**
 * Based on TMD 24h rainfall classes: หนัก 35.1–90.0 mm, หนักมาก ≥ 90.1 mm.
 * critical is our own escalation for extreme totals.
 */
export const DEFAULT_RAIN: RainThresholds = { watch: 35.1, warning: 90.1, critical: 150 }

/** A location a user watches. */
export interface Place {
  id: string
  label: string
  lat: number
  lng: number
  /** Search radius for nearby stations, km. */
  radiusKm: number
  /** How many nearest water-level stations to track. */
  maxStations: number
  freeboard: FreeboardThresholds
  rain: RainThresholds
  /** Alert when water rises at least this many cm within 60 minutes. */
  rapidRiseCm: number
  /** Minimum level that triggers a push (normal ⇒ also send "all clear"). */
  notifyMinLevel: Exclude<Level, 'unknown' | 'normal'>
  /** sha256 of the secret manage token handed to the browser that created it. */
  manageTokenHash: string
  createdAt: string
  updatedAt: string
}

export type ChannelType = 'webpush' | 'line' | 'telegram' | 'ntfy' | 'email' | 'discord'

export interface Channel {
  id: string
  placeId: string
  type: ChannelType
  /**
   * Channel-specific target:
   * webpush: JSON PushSubscription; line: userId/groupId; telegram: chat_id;
   * ntfy: topic (or full URL); email: address; discord: webhook URL.
   */
  target: string
  /** false until the owner proved control (LINE/Telegram link code, email confirm). */
  verified: boolean
  /** One-time code used to link LINE/Telegram/email; null once verified. */
  linkCode?: string | null
  createdAt: string
}

export type AlertKind = 'escalate' | 'deescalate' | 'rapid_rise' | 'rain' | 'stale' | 'test'

/** Persisted per (place, key) so we only notify on changes. */
export interface AlertState {
  placeId: string
  /** e.g. `station:bma-canal:209`, `rise:bma-canal:209`, `rain`, `overall`. */
  key: string
  level: Level
  lastValue?: number | null
  lastNotifiedAt?: string | null
  updatedAt: string
  /** alertSettingsKey() of the place when this state was saved (absent on older states). */
  settings?: string
}

export interface AlertEvent {
  id: string
  placeId: string
  kind: AlertKind
  level: Level
  /** Short Thai title, e.g. "วิกฤต: คลองประเวศฯ ห่างตลิ่ง 0.08 ม.". */
  title: string
  /** Multi-line Thai body (plain text, ≤ 1000 chars). */
  body: string
  stationIds: string[]
  createdAt: string
  /** Per-channel delivery results. */
  deliveries?: { channelId: string; type: ChannelType; ok: boolean; error?: string | null }[]
}

/** Station + its latest reading + computed status, relative to a place. */
export interface StationStatus {
  station: Station
  reading: Reading | null
  level: Level
  /** true when reading is older than the stale window. */
  stale: boolean
  /** Water level change in cm over the last 60 minutes (positive = rising). */
  trendCmPerHour?: number | null
  distanceKm?: number | null
}

export interface WeatherNow {
  observedAt: string
  /** Thai condition text, e.g. "มีเมฆมาก". */
  condition: string
  /** WMO weather code. */
  weatherCode: number
  isDay: boolean
  temperatureC?: number | null
  humidityPct?: number | null
  /** Current precipitation intensity, mm/h. */
  precipitationMmH?: number | null
  /** Max precipitation probability over the next 3 hours, %. */
  precipitationProbabilityPct?: number | null
  /** Forecast rain total next 3 h / 24 h, mm. */
  rainNext3hMm?: number | null
  rainNext24hMm?: number | null
  /** Hourly forecast for the next 12 h; `time` is the START of each one-hour interval. */
  hourly?: { time: string; precipitationMm: number; probabilityPct: number | null }[]
  source: string
}

export interface RadarImage {
  id: string
  /** Thai title, e.g. "เรดาร์ฝน กทม. (หนองจอก)". */
  title: string
  /** Short tab label, e.g. "หนองจอก". */
  tabLabel?: string
  /** true for forecasts (nowcast): never present as "ตอนนี้". */
  forecast?: boolean
  url: string
  /** Where the image comes from, for attribution. */
  source: string
  /** Approx refresh cadence in minutes. */
  refreshMinutes: number
}

export interface SituationLine {
  level: Level
  /** e.g. "ปตร. คลองประเวศบุรีรมย์ ตอนลาดกระบัง: น้ำ 0.79 ม. ตลิ่ง 1.98 ม. ห่างตลิ่ง 1.19 ม. (กทม.: วิกฤต)" */
  text: string
  stationId?: string
}

/** Everything the dashboard needs for one place, produced by /api/snapshot. */
export interface DashboardSnapshot {
  generatedAt: string
  place: Pick<Place, 'label' | 'lat' | 'lng' | 'radiusKm' | 'maxStations' | 'freeboard' | 'rain' | 'rapidRiseCm'>
  overall: {
    level: Level
    /** e.g. "ปกติ" or "เตือนภัย — น้ำใกล้ล้นตลิ่ง 1 จุด". */
    headline: string
    lines: SituationLine[]
  }
  /** Nearest water-level stations (canal/river), sorted by distance. */
  water: StationStatus[]
  /** Nearest rain gauges with 24h totals, sorted by distance. */
  rain: StationStatus[]
  /** Highest 24h rain among the nearest 3 rain gauges. */
  rainMax24h: { valueMm: number; station: Station; distanceKm: number; level: Level } | null
  roadFlood: StationStatus[]
  weather: WeatherNow | null
  radar: RadarImage[]
  sources: SourceHealth[]
  /**
   * Distance (km) from the place to the nearest station with recent data, per kind, regardless of
   * the place radius — lets the UI tell "outside coverage" apart from "radius too small".
   */
  coverage?: { nearestWaterKm: number | null; nearestRainKm: number | null }
  /** Last time the ingest worker completed a cycle. */
  lastIngestAt: string | null
  /** Polling cadence the worker is configured with, minutes. */
  pollMinutes: number
}

/** One series point for history charts. */
export interface HistoryPoint {
  t: string
  waterLevel?: number | null
  freeboard?: number | null
  rain24h?: number | null
}

// --- CCTV cameras -------------------------------------------------------------------
// Cameras are not Stations: they carry no readings, status or alerts. Images are stills
// fetched on demand through our proxy (never stored); they never influence status.

export type CameraSourceId =
  | 'bma-floodcam' // สำนักการระบายน้ำ กทม. — flood-watch cameras (floodbangkok), Thai IP only
  | 'bma-ddscam' // สำนักการระบายน้ำ กทม. — water-level cameras (dds cctv.php), static table; images Thai IP only
  | 'dwr-cctv' // กรมทรัพยากรน้ำ — river telemetry station cameras
  | 'demo-cam' // DATA_MODE=fixture — simulated cameras with generated images

export const CAMERA_SOURCE_IDS: readonly CameraSourceId[] = ['bma-floodcam', 'bma-ddscam', 'dwr-cctv', 'demo-cam']

/**
 * Camera lists a Thai relay may push: lists fetched from an agency. Never the simulated set, nor
 * the static DDS table (every server builds it itself and holds its own image references).
 */
export type RelayableCameraSourceId = Exclude<CameraSourceId, 'demo-cam' | 'bma-ddscam'>

export interface Camera {
  /** `${source}:${nativeId}` (same convention as station ids). */
  id: string
  source: CameraSourceId
  /** Upstream id, sanitised to ^[A-Za-z0-9_-]{1,64}$. */
  nativeId: string
  /** Groups the angles of one site: `${source}:${lat.toFixed(5)},${lng.toFixed(5)}`. */
  siteId: string
  /** Thai display name without the internal code prefix, e.g. "ปากซอยงามวงศ์วาน 62". */
  name: string
  /** Agency code, e.g. "CM3-JJ-70-C2". */
  code: string | null
  /** e.g. "มุม 2" when the site has several cameras. */
  angle: string | null
  /** Thai agency name for attribution, e.g. "สำนักการระบายน้ำ กทม.". */
  owner: string
  lat: number
  lng: number
  /** What the camera looks at (best effort, from agency data or the name). */
  facing: 'water' | 'road' | 'unknown'
  /** Stations at the same spot (road:FL.* ≤ 50 m, canal/river ≤ 150 m), computed at catalogue time. */
  nearStationIds: string[]
  /** Official page where people can see this camera themselves. */
  officialUrl: string
  /** Upstream image cadence in minutes when known (DWR ≈ 15). */
  cadenceMin: number | null
}

/**
 * Server-only upstream reference used to fetch a camera's image (BMA LiveStream address,
 * DDS image number, DWR reportCctv snapshot id, demo station id). Never part of an API response,
 * never logged, never relayed.
 */
export interface CameraRef {
  cameraId: string
  ref: string
}

/** One source's camera list as stored (public part only). */
export interface CameraCatalog {
  source: CameraSourceId
  fetchedAt: string
  cameras: Camera[]
}

/** What a camera catalogue adapter returns. */
export interface CameraCatalogResult extends CameraCatalog {
  refs: CameraRef[]
  /** Non-fatal notes (skipped rows etc.). */
  warnings: string[]
}
