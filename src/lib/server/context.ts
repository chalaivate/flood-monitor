import { getConfig } from '../config'
import { getSenders } from '../notify'
import type { CycleDeps } from '../pipeline'
import { getSources } from '../sources'
import { getStore } from '../store'
import { log } from './log'

/** fetch that resolves the global at call time, so tests can `vi.stubGlobal('fetch', …)`. */
export const lateFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

/** Dependencies for pipeline calls made from route handlers. */
export async function serverDeps(): Promise<CycleDeps> {
  const config = getConfig()
  return {
    store: await getStore(),
    config,
    sources: getSources(config),
    senders: getSenders(),
    fetch: lateFetch,
    log,
  }
}
