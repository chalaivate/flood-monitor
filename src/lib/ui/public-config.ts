import { useSyncExternalStore } from 'react'
import { apiFetch, type PublicConfig } from './api'

// One shared, memoised GET /api/config/public for the whole page.

interface ConfigState {
  config: PublicConfig | null
  error: string | null
}

let state: ConfigState = { config: null, error: null }
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
const SERVER_STATE: ConfigState = { config: null, error: null }

function set(next: ConfigState) {
  state = next
  for (const l of listeners) l()
}

export function loadPublicConfig(force = false): Promise<void> {
  if (inflight && !force) return inflight
  inflight = apiFetch<PublicConfig>('/api/config/public')
    .then((config) => set({ config: normalise(config), error: null }))
    .catch((e: unknown) => {
      set({ config: state.config, error: e instanceof Error ? e.message : String(e) })
      // Allow a retry on the next subscriber.
      inflight = null
    })
  return inflight
}

function normalise(c: PublicConfig): PublicConfig {
  return {
    dataMode: c?.dataMode === 'fixture' ? 'fixture' : 'live',
    defaultPlace: c?.defaultPlace,
    pollMinutes: Number.isFinite(c?.pollMinutes) && c.pollMinutes > 0 ? c.pollMinutes : 10,
    channels: {
      webpush: !!c?.channels?.webpush,
      line: !!c?.channels?.line,
      telegram: !!c?.channels?.telegram,
      ntfy: !!c?.channels?.ntfy,
      email: !!c?.channels?.email,
      discord: !!c?.channels?.discord,
    },
    telegramBot: c?.telegramBot ?? null,
    lineAddFriendUrl: c?.lineAddFriendUrl ?? null,
    vapidPublicKey: c?.vapidPublicKey ?? null,
  }
}

/** Seed the store (used by /dev/preview so it renders without the API). */
export function primePublicConfig(config: PublicConfig): void {
  inflight = Promise.resolve()
  set({ config, error: null })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!state.config && !inflight) void loadPublicConfig()
  return () => {
    listeners.delete(cb)
  }
}

export function usePublicConfig(): ConfigState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  )
}
