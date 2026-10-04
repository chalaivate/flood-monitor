import { useEffect, useEffectEvent, useState, type RefObject } from 'react'
import { ApiError } from './api'
import { onRefresh, trackActivity } from './bus'

/**
 * Current time that ticks every `everyMs`. The first render uses `initial` (a fixed
 * instant such as the snapshot's generatedAt) so server and client markup agree.
 */
export function useNow(initial: number | string | null | undefined, everyMs = 30_000): number {
  const seed = typeof initial === 'string' ? Date.parse(initial) : typeof initial === 'number' ? initial : 0
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, everyMs)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [everyMs])
  return now ?? (Number.isFinite(seed) ? seed : 0)
}

/** Width of an element in CSS px, tracked with ResizeObserver (0 before mount). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

export interface Polled<T> {
  data: T | null
  /** Thai error text of the last failed attempt (data keeps the last good value). */
  error: string | null
  errorStatus: number | null
  /** Epoch ms of the last successful load. */
  updatedAt: number | null
  /** true while `data` belongs to a previous key (e.g. the place just changed). */
  carriedOver: boolean
  refresh: () => void
}

interface PollState<T> {
  key: string | null
  data: T | null
  error: string | null
  errorStatus: number | null
  updatedAt: number | null
}

/**
 * Load `key` with `load()` now, every `intervalMs`, when the tab regains focus and
 * when the top-bar refresh is pressed. Keeps the last good data on failure.
 * `key` null pauses loading.
 */
export function usePolled<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, intervalMs = 60_000): Polled<T> {
  const [state, setState] = useState<PollState<T>>({ key: null, data: null, error: null, errorStatus: null, updatedAt: null })
  const [nonce, setNonce] = useState(0)
  const doLoad = useEffectEvent((signal: AbortSignal) => load(signal))

  useEffect(() => {
    if (key === null) return
    let ctrl: AbortController | null = null
    let last = 0
    let disposed = false
    const run = async () => {
      ctrl?.abort()
      const c = new AbortController()
      ctrl = c
      last = Date.now()
      const done = trackActivity()
      try {
        const data = await doLoad(c.signal)
        if (disposed || c.signal.aborted) return
        setState({ key, data, error: null, errorStatus: null, updatedAt: Date.now() })
      } catch (e) {
        if (disposed || c.signal.aborted) return
        const msg = e instanceof Error ? e.message : String(e)
        const status = e instanceof ApiError ? e.status : null
        setState((s) => ({ ...s, error: msg || 'โหลดข้อมูลไม่สำเร็จ', errorStatus: status }))
      } finally {
        done()
      }
    }
    void run()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void run()
    }, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 10_000) void run()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    const offRefresh = onRefresh(() => void run())
    return () => {
      disposed = true
      ctrl?.abort()
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      offRefresh()
    }
  }, [key, intervalMs, nonce])

  // A paused hook (key null) exposes nothing, so callers never act on data of a key they dropped.
  if (key === null) {
    return { data: null, error: null, errorStatus: null, updatedAt: null, carriedOver: false, refresh: () => setNonce((n) => n + 1) }
  }
  return {
    data: state.data,
    error: state.error,
    errorStatus: state.errorStatus,
    updatedAt: state.updatedAt,
    carriedOver: state.key !== key && state.data !== null,
    refresh: () => setNonce((n) => n + 1),
  }
}

/** navigator.onLine, kept in sync with online/offline events (true during SSR). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    const first = setTimeout(() => setOnline(navigator.onLine), 0)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      clearTimeout(first)
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
