// Shared in-memory image cache with single-flight upstream fetches, generalised from
// radar-proxy.ts (the radar keeps its own copy for now). Values live only in this process's
// memory: never on disk, in the database or in logs. Concurrent requests for one key share a
// single upstream fetch; failures are remembered briefly so a dead upstream is not hammered;
// the last good value is served (marked stale) until it is too old, then it is dropped.

export interface CachePolicy {
  /** A value younger than this is served without asking upstream. */
  ttlMs: number
  /** After a failed fetch, upstream is not asked again for this long. */
  failTtlMs: number
  /** The last good value is served, marked stale, until it is this old; then it is forgotten. */
  staleMaxMs: number
}

export interface Timestamped {
  /** When the value was fetched from upstream, epoch ms. */
  fetchedAt: number
}

/**
 * A loader error meaning "upstream was not asked" (a budget or concurrency refusal made
 * before any request). It is not remembered as a failure, so the next request may try again.
 */
export class NotAttemptedError extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'NotAttemptedError'
  }
}

export type CacheResult<T> = { ok: true; value: T; stale: boolean } | { ok: false; error: Error }

interface Entry<T> {
  value: T | null
  /** Last attempted-and-failed fetch (cleared by a success). */
  error: Error | null
  checkedAt: number
  inflight: Promise<Error | null> | null
  /** From the latest request: when the entry may be forgotten. */
  staleMaxMs: number
  failTtlMs: number
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err.name === 'TimeoutError' ? new Error('timeout') : err
  return new Error(String(err))
}

export class ImageCache<T extends Timestamped> {
  private entries = new Map<string, Entry<T>>()

  /** `maxEntries` bounds memory: the least recently used entries are evicted first. */
  constructor(private maxEntries: number) {}

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  /**
   * The value for `key`: from memory while fresh, else from `load` (single-flight: callers
   * that arrive while a load is running wait for that same load). `load` receives the
   * previous good value, if any. A failed or refused load falls back to the last good value
   * while it is younger than `staleMaxMs`.
   */
  async get(key: string, policy: CachePolicy, load: (prev: T | null) => Promise<T>, now: () => number = Date.now): Promise<CacheResult<T>> {
    this.sweep(now())
    let entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key) // re-insert ⇒ Map order = least recently used first
    } else {
      entry = { value: null, error: null, checkedAt: 0, inflight: null, staleMaxMs: policy.staleMaxMs, failTtlMs: policy.failTtlMs }
    }
    entry.staleMaxMs = policy.staleMaxMs
    entry.failTtlMs = policy.failTtlMs
    this.entries.set(key, entry)
    this.evict()

    const t = now()
    const fresh = entry.value !== null && t - entry.value.fetchedAt < policy.ttlMs
    const recentlyFailed = entry.error !== null && t - entry.checkedAt < policy.failTtlMs
    let outcome: Error | null = recentlyFailed ? entry.error : null
    if (!fresh && (!recentlyFailed || entry.inflight)) {
      const e = entry
      e.inflight ??= load(e.value)
        .then((value): Error | null => {
          e.value = value
          e.error = null
          e.checkedAt = now()
          return null
        })
        .catch((err: unknown): Error => {
          const error = toError(err)
          // A refusal says nothing about the upstream: do not block the next attempt.
          if (!(error instanceof NotAttemptedError)) {
            e.error = error
            e.checkedAt = now()
          }
          return error
        })
        .finally(() => {
          e.inflight = null
        })
      outcome = await e.inflight
    }

    const v = entry.value
    const age = v ? now() - v.fetchedAt : Number.POSITIVE_INFINITY
    if (v && age < policy.ttlMs) return { ok: true, value: v, stale: false }
    if (v && age < policy.staleMaxMs) return { ok: true, value: v, stale: true }
    return { ok: false, error: outcome ?? entry.error ?? new Error('unavailable') }
  }

  /** Forget values older than their stale limit (nothing old lingers in memory). */
  private sweep(t: number): void {
    for (const [key, e] of this.entries) {
      if (e.inflight) continue
      if (e.value && t - e.value.fetchedAt >= e.staleMaxMs) e.value = null
      if (!e.value && (e.error === null || t - e.checkedAt >= e.failTtlMs)) this.entries.delete(key)
    }
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return
    for (const [key, e] of this.entries) {
      if (this.entries.size <= this.maxEntries) break
      // An entry with a running load is kept: its waiters still hold it.
      if (!e.inflight) this.entries.delete(key)
    }
  }
}
