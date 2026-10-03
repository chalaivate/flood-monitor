import { z } from 'zod'
import type { SourceId } from './types'

// Server-side configuration from environment variables. Never import this from
// client components: it reads secrets.

const ALL_SOURCES: SourceId[] = [
  'thaiwater-canal',
  'thaiwater-wl',
  'thaiwater-rain',
  'thaiwater-road',
  'popnix',
  // BMA last: when both answer, the primary agency feed overwrites mirror metadata.
  'bma-canal',
  'bma-rain',
  'bma-roadflood',
  'bma-pump',
]

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().finite())

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
  POLL_MINUTES: num(10),
  STALE_MINUTES: num(60),
  HISTORY_HOURS: num(72),
  SOURCES: str(),
  CRON_SECRET: str(),
  INGEST_TOKEN: str(),
  PUBLIC_BASE_URL: str(),
  DEFAULT_LAT: num(13.7563),
  DEFAULT_LNG: num(100.5018),
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
  FETCH_TIMEOUT_MS: num(30_000),
  /** ThaiWater province codes to ingest (10 = กรุงเทพฯ), or "all" for the national feeds. */
  THAIWATER_PROVINCES: z.string().default('10,11,12,13'),
  /** 0 disables alert evaluation in this process (when another process owns alerting). */
  RUN_ALERTS: z.enum(['0', '1']).default('1'),
  /** 1 runs the poller inside the Next.js server process (all-in-one Docker). */
  EMBEDDED_WORKER: z.enum(['0', '1']).default('0'),
  /**
   * Which proxy header carries the real client IP for rate limiting: cloudflare
   * (CF-Connecting-IP), vercel (X-Real-IP / X-Forwarded-For), xff (first X-Forwarded-For
   * from a proxy that overwrites it) or none. Unset: vercel on Vercel, otherwise none.
   */
  TRUST_PROXY: z.enum(TRUST_PROXY_VALUES).default('none'),
})

export type AppConfig = z.infer<typeof schema> & { enabledSources: SourceId[] }

let cached: AppConfig | null = null

/** Default place in DATA_MODE=fixture: the centre of the simulated data set (Prawet). */
const DEMO_DEFAULT = { DEFAULT_LAT: '13.7208', DEFAULT_LNG: '100.683', DEFAULT_LABEL: 'บ้าน (ตัวอย่าง) ประเวศ' }

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const withDemo =
    env.DATA_MODE === 'fixture'
      ? {
          ...env,
          DEFAULT_LAT: env.DEFAULT_LAT || DEMO_DEFAULT.DEFAULT_LAT,
          DEFAULT_LNG: env.DEFAULT_LNG || DEMO_DEFAULT.DEFAULT_LNG,
          DEFAULT_LABEL: env.DEFAULT_LABEL || DEMO_DEFAULT.DEFAULT_LABEL,
        }
      : env
  const trustProxy = env.TRUST_PROXY?.trim().toLowerCase() || (env.VERCEL ? 'vercel' : 'none')
  const parsed = schema.parse({ ...withDemo, TRUST_PROXY: trustProxy })
  const requested = parsed.SOURCES?.split(',').map((s) => s.trim()).filter(Boolean)
  const enabledSources = requested
    ? ALL_SOURCES.filter((s) => requested.includes(s))
    : ALL_SOURCES
  return { ...parsed, enabledSources }
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig()
  return cached
}

/** For tests. */
export function resetConfigCache(): void {
  cached = null
}
