import { z } from 'zod'
import type { SourceId } from './types'

// Server-side configuration from environment variables. Never import this from
// client components: it reads secrets.

const ALL_SOURCES: SourceId[] = [
  'thaiwater-canal',
  'thaiwater-wl',
  'thaiwater-rain',
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
})

export type AppConfig = z.infer<typeof schema> & { enabledSources: SourceId[] }

let cached: AppConfig | null = null

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.parse(env)
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
