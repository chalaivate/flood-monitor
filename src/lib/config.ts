import { isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { CameraSourceId, SourceId } from './types'

// Server-side configuration from environment variables. Never import this from
// client components: it reads secrets.

const ALL_SOURCES: SourceId[] = [
  'thaiwater-canal',
  'thaiwater-wl',
  'thaiwater-rain',
  'thaiwater-road',
  // BMA last: when both answer, the primary agency feed overwrites mirror metadata.
  'bma-canal',
  'bma-rain',
  'bma-roadflood',
  'bma-pump',
]

/** Numbers outside [min, max] are clamped (with a warning) rather than crashing every route. */
const num = (def: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().finite())
    .transform((n) => Math.min(max, Math.max(min, n)))

/** Valid ranges; values outside are clamped. */
export const CONFIG_RANGES = {
  // BMA's WAF bans bursts and most feeds update every 5–15 minutes.
  POLL_MINUTES: [2, 120],
  STALE_MINUTES: [5, 1440],
  // The 48 h chart and the trend window need at least this much history.
  HISTORY_HOURS: [48, 24 * 90],
  FETCH_TIMEOUT_MS: [1000, 120_000],
  DEFAULT_LAT: [-90, 90],
  DEFAULT_LNG: [-180, 180],
} as const satisfies Record<string, readonly [number, number]>

/** Reverse proxies whose client-IP header the rate limiter may trust. */
export const TRUST_PROXY_VALUES = ['none', 'cloudflare', 'vercel', 'xff'] as const
export type TrustProxy = (typeof TRUST_PROXY_VALUES)[number]

const str = () =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))

const schema = z.object({
  DATA_MODE: z.enum(['live', 'fixture']).default('live'),
  STORE: z.enum(['sqlite', 'supabase']).default('sqlite'),
  DATA_DIR: z.string().default('./data'),
  SUPABASE_URL: str(),
  SUPABASE_SERVICE_ROLE_KEY: str(),
  POLL_MINUTES: num(10, ...CONFIG_RANGES.POLL_MINUTES),
  STALE_MINUTES: num(60, ...CONFIG_RANGES.STALE_MINUTES),
  HISTORY_HOURS: num(72, ...CONFIG_RANGES.HISTORY_HOURS),
  SOURCES: str(),
  CRON_SECRET: str(),
  INGEST_TOKEN: str(),
  PUBLIC_BASE_URL: str(),
  DEFAULT_LAT: num(13.7563, ...CONFIG_RANGES.DEFAULT_LAT),
  DEFAULT_LNG: num(100.5018, ...CONFIG_RANGES.DEFAULT_LNG),
  DEFAULT_LABEL: z.string().default('กรุงเทพมหานคร'),
  VAPID_PUBLIC_KEY: str(),
  VAPID_PRIVATE_KEY: str(),
  VAPID_SUBJECT: str(),
  LINE_CHANNEL_ACCESS_TOKEN: str(),
  LINE_CHANNEL_SECRET: str(),
  LINE_ADD_FRIEND_URL: str(),
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_BOT_USERNAME: str(),
  TELEGRAM_WEBHOOK_SECRET: str(),
  NTFY_BASE_URL: z.string().default('https://ntfy.sh'),
  RESEND_API_KEY: str(),
  EMAIL_FROM: str(),
  FETCH_TIMEOUT_MS: num(30_000, ...CONFIG_RANGES.FETCH_TIMEOUT_MS),
  /** ThaiWater province codes to ingest (10 = กรุงเทพฯ), or "all" for the national feeds. */
  THAIWATER_PROVINCES: z.string().default('10,11,12,13'),
  /** 0 disables alert evaluation in this process (when another process owns alerting). */
  RUN_ALERTS: z.enum(['0', '1']).default('1'),
  /**
   * 1 shows the animated RainViewer radar. RainViewer's free API is for personal/educational use
   * only (since 2026-01-01): set 0 for public or commercial deployments without an agreement.
   */
  RAINVIEWER: z.enum(['0', '1']).default('1'),
  /** 1 runs the poller inside the Next.js server process (all-in-one Docker). */
  EMBEDDED_WORKER: z.enum(['0', '1']).default('0'),
  /**
   * Which proxy header carries the real client IP for rate limiting: cloudflare
   * (CF-Connecting-IP), vercel (X-Real-IP / X-Forwarded-For), xff (first X-Forwarded-For
   * from a proxy that overwrites it) or none. Unset: vercel on Vercel, otherwise none.
   */
  TRUST_PROXY: z.enum(TRUST_PROXY_VALUES).default('none'),
  /**
   * CCTV camera catalogues to load (comma separated: bma-floodcam, dwr-cctv), or "none".
   * DATA_MODE=fixture always uses the simulated demo-cam source instead.
   */
  CCTV_SOURCES: z.string().default('bma-floodcam,dwr-cctv'),
  /**
   * 1 lets this server fetch camera stills on demand (shared cache, strict budgets) for the
   * sources whose catalogue it fetched itself; 0 shows links to the agency pages only.
   */
  CCTV_IMAGES: z.enum(['0', '1']).default('1'),
  /** Contact for privacy / takedown requests, shown on the about page. */
  CONTACT_EMAIL: str(),
})

export type AppConfig = z.infer<typeof schema> & { enabledSources: SourceId[]; enabledCameraSources: CameraSourceId[] }

const LIVE_CAMERA_SOURCES: CameraSourceId[] = ['bma-floodcam', 'dwr-cctv']

let cached: AppConfig | null = null

/** Default place in DATA_MODE=fixture: the centre of the simulated data set (Prawet). */
const DEMO_DEFAULT = { DEFAULT_LAT: '13.7208', DEFAULT_LNG: '100.683', DEFAULT_LABEL: 'บ้าน (ตัวอย่าง) ประเวศ' }

export interface LoadConfigOptions {
  /** Where clamped values and path fixes are reported (default console.warn). */
  warn?: (msg: string) => void
  /** Working directory used to resolve a relative DATA_DIR (default process.cwd()). */
  cwd?: string
}

const insideNextDir = (p: string) => p.split(sep).includes('.next')

/**
 * A relative DATA_DIR resolved inside `.next` (the standalone server chdirs into
 * .next/standalone) would be wiped by the next build: resolve it against the directory the
 * process was launched from instead, or refuse to start.
 */
function resolveDataDir(dataDir: string, env: Record<string, string | undefined>, cwd: string, warn: (m: string) => void): string {
  if (isAbsolute(dataDir)) return dataDir
  const fromCwd = resolve(cwd, dataDir)
  if (!insideNextDir(fromCwd)) return fromCwd
  const launchDir = env.INIT_CWD || env.PWD
  if (launchDir && !insideNextDir(resolve(launchDir, dataDir))) {
    const fixed = resolve(launchDir, dataDir)
    warn(`[config] DATA_DIR=${dataDir} would resolve inside .next (${fromCwd}); using ${fixed}. Set an absolute DATA_DIR.`)
    return fixed
  }
  throw new Error(`DATA_DIR resolves inside .next (${fromCwd}), which the next build deletes. Set an absolute DATA_DIR.`)
}

export function loadConfig(env: Record<string, string | undefined> = process.env, opts: LoadConfigOptions = {}): AppConfig {
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  // A blank value means "use the default" for every key (as .env.example says), and
  // surrounding whitespace never makes an enum invalid.
  const cleaned: Record<string, string> = {}
  for (const key of Object.keys(schema.shape)) {
    const v = env[key]?.trim()
    if (v) cleaned[key] = v
  }
  if (cleaned.DATA_MODE === 'fixture') {
    cleaned.DEFAULT_LAT ??= DEMO_DEFAULT.DEFAULT_LAT
    cleaned.DEFAULT_LNG ??= DEMO_DEFAULT.DEFAULT_LNG
    cleaned.DEFAULT_LABEL ??= DEMO_DEFAULT.DEFAULT_LABEL
  }
  cleaned.TRUST_PROXY = cleaned.TRUST_PROXY?.toLowerCase() || (env.VERCEL ? 'vercel' : 'none')
  const parsed = schema.parse(cleaned)
  for (const [key, [min, max]] of Object.entries(CONFIG_RANGES)) {
    const raw = cleaned[key]
    if (raw !== undefined && Number(raw) !== parsed[key as keyof typeof CONFIG_RANGES]) {
      warn(`[config] ${key}=${raw} is outside ${min}–${max}; using ${parsed[key as keyof typeof CONFIG_RANGES]}`)
    }
  }
  const DATA_DIR = resolveDataDir(parsed.DATA_DIR, env, opts.cwd ?? process.cwd(), warn)
  const requested = parsed.SOURCES?.split(',').map((s) => s.trim()).filter(Boolean)
  const enabledSources = requested
    ? ALL_SOURCES.filter((s) => requested.includes(s))
    : ALL_SOURCES
  if (requested) {
    const unknown = requested.filter((s) => !ALL_SOURCES.includes(s as SourceId))
    if (unknown.length) warn(`[config] SOURCES: ignoring unknown ${unknown.join(', ')} (known: ${ALL_SOURCES.join(', ')})`)
  }
  const requestedCams = parsed.CCTV_SOURCES.split(',').map((s) => s.trim()).filter(Boolean)
  const enabledCameraSources: CameraSourceId[] =
    parsed.DATA_MODE === 'fixture' ? ['demo-cam'] : LIVE_CAMERA_SOURCES.filter((s) => requestedCams.includes(s))
  const unknownCams = requestedCams.filter((s) => s !== 'none' && !LIVE_CAMERA_SOURCES.includes(s as CameraSourceId))
  if (unknownCams.length) warn(`[config] CCTV_SOURCES: ignoring unknown ${unknownCams.join(', ')} (known: ${LIVE_CAMERA_SOURCES.join(', ')}, none)`)
  return { ...parsed, DATA_DIR, enabledSources, enabledCameraSources }
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig()
  return cached
}

/** For tests. */
export function resetConfigCache(): void {
  cached = null
}
