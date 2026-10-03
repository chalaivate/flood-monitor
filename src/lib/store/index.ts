import { join } from 'node:path'
import { getConfig, type AppConfig } from '../config'
import type { Store } from './types'

// Process-wide Store singleton. Server-only: route handlers, the worker and
// instrumentation import this; client components must never do so.
//
// Both implementations are loaded lazily so that:
// - a Supabase deployment (e.g. Vercel) never evaluates `node:sqlite`, and
// - a SQLite deployment never loads supabase-js.
// The cache lives on globalThis so Next.js dev HMR re-evaluating this module does
// not open a second SQLite handle.

export type { LatestRow, Store } from './types'

interface StoreGlobal {
  __floodStore?: Promise<Store>
}

const g = globalThis as typeof globalThis & StoreGlobal

/** Build a new store for the given configuration (no caching). */
export async function createStore(config: AppConfig): Promise<Store> {
  if (config.STORE === 'supabase') {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
    }
    const { SupabaseStore } = await import('./supabase')
    return new SupabaseStore({ url: config.SUPABASE_URL, serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY })
  }
  const { SqliteStore } = await import('./sqlite')
  return new SqliteStore(join(config.DATA_DIR, 'flood.db'))
}

/** The shared store for this process. */
export function getStore(): Promise<Store> {
  if (!g.__floodStore) {
    const pending = createStore(getConfig())
    g.__floodStore = pending
    // A failed init (bad credentials, unwritable DATA_DIR) must not be cached forever.
    pending.catch(() => {
      if (g.__floodStore === pending) g.__floodStore = undefined
    })
  }
  return g.__floodStore
}

/** Tests: inject a store (e.g. `new SqliteStore(':memory:')`), or pass null to reset. */
export function __setStoreForTests(store: Store | null): void {
  g.__floodStore = store ? Promise.resolve(store) : undefined
}
