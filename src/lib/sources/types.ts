import type { SourceFetchResult, SourceId } from '../types'

export interface SourceContext {
  fetch: typeof fetch
  now: Date
  timeoutMs: number
  /** Optional abort signal for the whole cycle. */
  signal?: AbortSignal
  /** Injectable sleep for retry back-off (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

export interface SourceAdapter {
  id: SourceId
  /** Thai label for attribution, e.g. "สำนักการระบายน้ำ กทม.". */
  label: string
  /** True when the upstream only answers requests from Thai IP addresses. */
  thaiIpOnly: boolean
  fetch(ctx: SourceContext): Promise<SourceFetchResult>
}
