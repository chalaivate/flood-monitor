import { hasBearerSecret } from '@/lib/server/auth'
import { serverDeps } from '@/lib/server/context'
import { handler, json, jsonError } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { runPollCycle, summarize } from '@/lib/server/poller'
import { getConfig } from '@/lib/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Fetching every source (polite, one request at a time per host) plus alerts can take minutes. */
export const maxDuration = 300

/** In-process guard: overlapping cron calls on one instance return 409 instead of piling up. */
const g = globalThis as typeof globalThis & { __floodCronRunning?: boolean }

/**
 * GET|POST /api/cron/poll (Authorization: Bearer CRON_SECRET) → one poll cycle:
 * ingest → alerts (only when RUN_ALERTS=1) → prune.
 * Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET` automatically.
 */
const run = handler('cron/poll', async (req: Request) => {
  const config = getConfig()
  if (!config.CRON_SECRET) return jsonError(503, 'ยังไม่ได้ตั้งค่า CRON_SECRET')
  if (!hasBearerSecret(req, config.CRON_SECRET)) {
    return jsonError(401, 'ไม่มีสิทธิ์เข้าถึง', { 'WWW-Authenticate': 'Bearer' })
  }
  if (g.__floodCronRunning) return jsonError(409, 'กำลังดึงข้อมูลรอบก่อนหน้าอยู่ กรุณารอสักครู่')
  g.__floodCronRunning = true
  try {
    const summary = await runPollCycle(await serverDeps())
    log(`[cron] ${summarize(summary)}`)
    return json({ ok: !summary.allFailed, ...summary })
  } finally {
    g.__floodCronRunning = false
  }
})

export const GET = run
export const POST = run
