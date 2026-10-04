// Standalone poller.
//
//   npm run worker                      loop every POLL_MINUTES: fetch → store → alerts → prune
//   npm run worker:once                 one cycle, then exit (exit 1 when every source failed)
//   npm run worker -- --relay <baseUrl> fetch only the Thai-IP-only sources and POST them to
//                                       <baseUrl>/api/ingest (Bearer INGEST_TOKEN); no local store.
//                                       CCTV camera lists (CCTV_SOURCES) are pushed when due,
//                                       public fields only (stream addresses stay here)
//   (--once combines with --relay)
//
// Reads .env from the working directory when present (real env vars win).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/lib/config'
import { getSenders, logChannelConfigWarnings } from '../src/lib/notify'
import { log } from '../src/lib/server/log'
import {
  parseRelayCameraState,
  pollIntervalMs,
  runPollCycle,
  runRelayCycle,
  serializeRelayCameraState,
  startLoop,
  summarize,
  type LoopHandle,
} from '../src/lib/server/poller'
import { getSources } from '../src/lib/sources'
import { getCameraSources, RELAYABLE_CAMERA_SOURCES } from '../src/lib/sources/cameras'
import { getStore } from '../src/lib/store'

interface Args {
  once: boolean
  relay: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = { once: false, relay: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--once') args.once = true
    else if (a === '--relay') args.relay = argv[++i] ?? ''
    else if (a.startsWith('--relay=')) args.relay = a.slice('--relay='.length)
    else if (a === '--help' || a === '-h') {
      console.log('usage: tsx worker/poll.ts [--once] [--relay <baseUrl>]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return args
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
  // POLL_MINUTES below 1 (0 would poll every second) is raised to 1, with a warning below 5.
  const intervalMs = pollIntervalMs(config.POLL_MINUTES, log)

  /** Resolves true when the cycle was a total failure; `signal` aborts on shutdown. */
  let cycle: (signal?: AbortSignal) => Promise<boolean>

  if (args.relay !== null) {
    let base: URL
    try {
      base = new URL(args.relay)
      if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('protocol')
    } catch {
      console.error('--relay needs a base URL, e.g. --relay https://flood.example.org')
      process.exit(2)
    }
    if (!config.INGEST_TOKEN) {
      console.error('relay mode needs INGEST_TOKEN (same value as on the receiving server)')
      process.exit(2)
    }
    const sources = getSources(config).filter((s) => s.thaiIpOnly)
    if (sources.length === 0) {
      console.error('relay mode: no Thai-IP-only source is enabled (check SOURCES / DATA_MODE)')
      process.exit(2)
    }
    const cameraSources = getCameraSources(config).filter((a) => RELAYABLE_CAMERA_SOURCES.includes(a.id))
    // When each camera list was last fetched (no lists, no refs), kept across --once runs.
    const cameraStateFile = join(config.DATA_DIR, 'relay-camera-schedule.json')
    let savedSchedule: string | null = null
    try {
      savedSchedule = readFileSync(cameraStateFile, 'utf8')
    } catch {
      // first run, or unreadable: start with an empty schedule
    }
    const cameraState = parseRelayCameraState(savedSchedule)
    let stateWriteWarned = false
    log(
      `[relay] relaying ${sources.map((s) => s.id).join(', ')} → ${base.origin}/api/ingest every ${intervalMs / 60_000} min` +
        (cameraSources.length ? `; camera lists: ${cameraSources.map((a) => a.id).join(', ')}` : ''),
    )
    cycle = async () => {
      const s = await runRelayCycle({
        baseUrl: base.toString(),
        token: config.INGEST_TOKEN!,
        config,
        sources,
        fetch: fetchImpl,
        log,
        cameraSources,
        cameraState,
      })
      if (cameraSources.length) {
        try {
          mkdirSync(config.DATA_DIR, { recursive: true })
          writeFileSync(cameraStateFile, serializeRelayCameraState(cameraState))
        } catch (err) {
          if (!stateWriteWarned) log(`[relay] cannot save ${cameraStateFile}: ${err instanceof Error ? err.message : String(err)}`)
          stateWriteWarned = true
        }
      }
      return s.allFailed
    }
  } else {
    const store = await getStore()
    const sources = getSources(config)
    const deps = { store, config, sources, senders: getSenders(), fetch: fetchImpl, log }
    log(
      `[worker] sources: ${sources.map((s) => s.id).join(', ') || '(none)'}; store=${config.STORE}; ` +
        `alerts=${config.RUN_ALERTS === '1' ? 'on' : 'off'}; data=${config.DATA_MODE}; ` +
        `cameras=${config.enabledCameraSources.join(',') || 'off'}; every ${intervalMs / 60_000} min`,
    )
    if (config.RUN_ALERTS === '1') logChannelConfigWarnings(config, log)
    cycle = async (signal) => {
      const s = await runPollCycle(deps, { signal, cameras: true })
      log(summarize(s))
      return s.allFailed
    }
  }

  if (args.once) {
    const allFailed = await cycle()
    process.exitCode = allFailed ? 1 : 0
    return
  }

  const loop: LoopHandle = startLoop(
    async (signal) => {
      await cycle(signal)
    },
    { intervalMs, log },
  )
  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) {
      log(`[worker] ${signal} again, exiting now`)
      process.exit(130)
    }
    stopping = true
    log(`[worker] ${signal} received, finishing current cycle…`)
    void loop.stop().then(() => {
      log('[worker] stopped')
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  await loop.done
}

main().catch((err: unknown) => {
  log(`[worker] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
