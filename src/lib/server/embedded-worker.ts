import { getConfig } from '../config'
import { getSenders } from '../notify'
import { getSources } from '../sources'
import { getStore } from '../store'
import { log } from './log'
import { runPollCycle, startLoop, summarize, type LoopHandle } from './poller'

// Poller running inside the Next.js server process (all-in-one Docker,
// EMBEDDED_WORKER=1). Started from src/instrumentation.ts.

const g = globalThis as typeof globalThis & { __floodEmbeddedWorker?: Promise<LoopHandle | null> }

/** Start once per process (instrumentation can run again after dev HMR). Never throws. */
export function startEmbeddedWorker(): Promise<LoopHandle | null> {
  if (g.__floodEmbeddedWorker) return g.__floodEmbeddedWorker
  g.__floodEmbeddedWorker = (async () => {
    try {
      const config = getConfig()
      const store = await getStore()
      const sources = getSources(config)
      const deps = { store, config, sources, senders: getSenders(), fetch: globalThis.fetch.bind(globalThis), log }
      log(
        `[embedded-worker] polling ${sources.map((s) => s.id).join(', ') || '(no sources)'} every ${config.POLL_MINUTES} min` +
          ` (store=${config.STORE}, alerts=${config.RUN_ALERTS === '1' ? 'on' : 'off'}, data=${config.DATA_MODE})`,
      )
      return startLoop(
        async () => {
          log(summarize(await runPollCycle(deps)))
        },
        { intervalMs: config.POLL_MINUTES * 60_000, log },
      )
    } catch (err) {
      log(`[embedded-worker] failed to start: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })()
  return g.__floodEmbeddedWorker
}
