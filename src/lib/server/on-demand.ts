import { getConfig } from '../config'
import { META_LAST_INGEST_ATTEMPT } from '../pipeline'
import { getStore } from '../store'
import { runAfterResponse } from './background'
import { serverDeps } from './context'
import { log } from './log'
import { runPollCycle, summarize } from './poller'

// Serverless deployments with a per-instance SQLite store (Vercel without Supabase) have no
// long-running poller and no shared database. INGEST_ON_REQUEST=1 makes a request that finds
// this instance's data older than POLL_MINUTES run one poll cycle first (single-flight per
// instance). The demo generator answers in milliseconds; live sources may take longer, so the
// request waits a bounded time and the cycle finishes after the response.

const g = globalThis as typeof globalThis & { __floodOnDemand?: Promise<void> | null }

/** How long a request waits for the cycle it started (or joined). */
const WAIT_MS = { fixture: 15_000, live: 8_000 }

export async function ensureFreshData(now: () => number = Date.now): Promise<void> {
  const config = getConfig()
  if (config.INGEST_ON_REQUEST !== '1') return
  if (!g.__floodOnDemand) {
    const store = await getStore()
    const last = Date.parse((await store.getMeta(META_LAST_INGEST_ATTEMPT)) ?? '')
    if (Number.isFinite(last) && now() - last < config.POLL_MINUTES * 60_000) return
    const cycle = (async () => {
      try {
        // Thai-IP-only camera lists cannot be fetched from a cloud instance (see the cron route).
        const summary = await runPollCycle(await serverDeps(), { cameras: true, skipThaiIpOnlyCameras: config.DATA_MODE !== 'fixture' })
        log(`[on-demand] ${summarize(summary)}`)
      } catch (err) {
        log(`[on-demand] cycle failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        g.__floodOnDemand = null
      }
    })()
    g.__floodOnDemand = cycle
    // Keep the function alive until the cycle ends, even when this request stops waiting.
    runAfterResponse('on-demand', () => cycle)
  }
  const pending = g.__floodOnDemand
  if (!pending) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    pending,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, config.DATA_MODE === 'fixture' ? WAIT_MS.fixture : WAIT_MS.live)
    }),
  ])
  clearTimeout(timer)
}
