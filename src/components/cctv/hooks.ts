'use client'

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { fetchCameras, type CamerasResponse } from '@/lib/ui/api'
import {
  CAMERA_LIST_REFRESH_MS,
  UNAVAILABLE_MIN_RETRY_SEC,
  WATCHDOG_MS,
  WATCHDOG_REASON,
  activeHold,
  cardQuery,
  frameUrl,
  isLinkOnlyFailure,
  listReloadGate,
  loadFrame,
  nextAttemptDelay,
  noteRetryHold,
  readPaused,
  reloadDelay,
  writePaused,
  type FrameDeps,
  type FrameFailure,
  type FrameMeta,
  type RetryHolds,
} from '@/lib/ui/cctv'
import { usePolled, type Polled } from '@/lib/ui/hooks'

// Browser hooks behind the CCTV UI. The rules they apply live in src/lib/ui/cctv.ts.

// --- global pause (localStorage 'fm-cctv-paused', shared by every tile on the page) ------------

let paused: boolean | null = null
const pauseListeners = new Set<() => void>()

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function getPaused(): boolean {
  if (paused === null) paused = readPaused(storage)
  return paused
}

export function setCctvPaused(next: boolean): void {
  paused = next
  writePaused(storage, next)
  for (const l of pauseListeners) l()
}

function subscribePaused(cb: () => void) {
  pauseListeners.add(cb)
  // Another tab changed the setting.
  const onStorage = () => {
    paused = readPaused(storage)
    cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    pauseListeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function useCctvPaused(): boolean {
  return useSyncExternalStore(subscribePaused, getPaused, () => false)
}

// --- Save-Data / page visibility / on screen -------------------------------------------------

interface NetworkInformationLike extends EventTarget {
  saveData?: boolean
}

function connection(): NetworkInformationLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection ?? null
}

export function useSaveData(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const c = connection()
      c?.addEventListener?.('change', cb)
      return () => c?.removeEventListener?.('change', cb)
    },
    () => connection()?.saveData === true,
    () => false,
  )
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('visibilitychange', cb)
      return () => document.removeEventListener('visibilitychange', cb)
    },
    () => document.visibilityState === 'visible',
    () => true,
  )
}

/** true while the element intersects the viewport (with a small margin). */
export function useOnScreen(ref: RefObject<Element | null>, rootMargin = '100px'): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      const t = setTimeout(() => setOn(true), 0)
      return () => clearTimeout(t)
    }
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)), { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, rootMargin])
  return on
}

// --- camera list reload (a still turned link-only) ------------------------------------------------

const listReloadListeners = new Set<() => void>()
const listReloadAllowed = listReloadGate()

/**
 * A still answered "link-only now" (503 unavailable / 404): ask every camera list on the page
 * (dashboard card, map layer, Chao Phraya chain) to reload, so tiles and markers switch to
 * agency links instead of waiting for the 30-minute refresh. Coalesced: tiles fail together.
 */
export function requestCameraListReload(): void {
  if (!listReloadAllowed(Date.now())) return
  for (const l of [...listReloadListeners]) l()
}

export function subscribeCameraListReload(cb: () => void): () => void {
  listReloadListeners.add(cb)
  return () => {
    listReloadListeners.delete(cb)
  }
}

/** Calls `reload` (e.g. usePolled's refresh) whenever a still turned link-only. */
export function useCameraListReload(reload: () => void): void {
  const latest = useRef(reload)
  useEffect(() => {
    latest.current = reload
  })
  useEffect(() => subscribeCameraListReload(() => latest.current()), [])
}

// --- camera list for the dashboard card -----------------------------------------------------

/** Cameras around a place: loaded once per place, then every 30 minutes (and when a still turns link-only). */
export function useNearbyCameras(p: { lat: number; lng: number; radiusKm: number } | null): Polled<CamerasResponse> {
  const key = p ? `cctv:${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.radiusKm}` : null
  const polled = usePolled<CamerasResponse>(key, (signal) => fetchCameras(p ? cardQuery(p) : null, { signal }), CAMERA_LIST_REFRESH_MS)
  useCameraListReload(polled.refresh)
  return polled
}

// --- one camera's still -------------------------------------------------------------------------

export interface FrameState {
  /** Object URL of the still on screen. */
  src: string | null
  meta: FrameMeta | null
  loading: boolean
  /** Last attempt failed (the previous still, if any, stays on screen). */
  failure: FrameFailure | null
}

const EMPTY: FrameState = { src: null, meta: null, loading: false, failure: null }

/** Retry-After holds of this page (every tile and the viewer honour them). */
const holds: RetryHolds = new Map()

function browserDeps(): FrameDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    decode: (url) => {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      if (typeof img.decode === 'function') return img.decode()
      return new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('decode'))
      })
    },
    now: () => Date.now(),
  }
}

export interface FrameOptions {
  /** May the first still be requested now (on screen, or tapped under Save-Data)? */
  enabled: boolean
  /** Keep refreshing every `intervalMs` (measured from the end of the previous request). */
  auto: boolean
  intervalMs: number
  /** Cache-key bucket of the still URL, seconds (the source's cache TTL). */
  bucketSec: number
}

function clearTimer(t: RefObject<ReturnType<typeof setTimeout> | null>) {
  if (t.current) clearTimeout(t.current)
  t.current = null
}

/**
 * Load a camera's still and keep it fresh. One request at a time (the next is scheduled when the
 * previous finishes, with a 50 s watchdog); the new still replaces the old one only after it has
 * decoded, and the old object URL is revoked once the new one is on screen. A new `imageUrl`
 * (another angle, or the camera turned link-only: null) aborts the request in flight and drops
 * the old still. Retry-After (429 limited, 503 busy/budget/unavailable) delays the next
 * automatic attempt and a manual reload, and holds every other still it applies to (the whole
 * client for 429, the source for 503). "unavailable" (link-only for now) also reloads the
 * camera list and stops automatic attempts for at least UNAVAILABLE_MIN_RETRY_SEC.
 */
export function useCameraFrame(imageUrl: string | null, opts: FrameOptions): FrameState & { reload: () => void } {
  const [state, setState] = useState<FrameState>(EMPTY)
  /** Bumped by the refresh timer and by "load now"; each bump runs one request. */
  const [due, setDue] = useState(0)
  const inflight = useRef<AbortController | null>(null)
  const finishedAt = useRef<number | null>(null)
  const retryAfter = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A manual reload waiting out Retry-After. */
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const auto = useRef(opts.auto)
  const interval = useRef(opts.intervalMs)

  const schedule = useEffectEvent(() => {
    clearTimer(timer)
    if (!imageUrl || !auto.current || inflight.current) return
    const wait = nextAttemptDelay(finishedAt.current, interval.current, Date.now(), retryAfter.current)
    timer.current = setTimeout(() => setDue((n) => n + 1), wait)
  })

  const run = useEffectEvent(async () => {
    if (!imageUrl || inflight.current) return
    clearTimer(timer)
    clearTimer(reloadTimer)
    // The server asked this client (or everyone, for this source) to wait: show why, ask later.
    const held = activeHold(holds, imageUrl, Date.now())
    if (held) {
      setState((s) => ({ ...s, loading: false, failure: held.failure }))
      timer.current = setTimeout(() => setDue((n) => n + 1), held.waitMs)
      return
    }
    const ctrl = new AbortController()
    inflight.current = ctrl
    const watchdog = setTimeout(() => ctrl.abort(WATCHDOG_REASON), WATCHDOG_MS)
    setState((s) => ({ ...s, loading: true }))
    try {
      const out = await loadFrame(frameUrl(imageUrl, Date.now(), opts.bucketSec), ctrl.signal, browserDeps())
      if (ctrl.signal.aborted && ctrl.signal.reason !== WATCHDOG_REASON) {
        if (out.ok) URL.revokeObjectURL(out.src)
        return
      }
      if (out.ok) {
        retryAfter.current = null
        setState({ src: out.src, meta: out.meta, loading: false, failure: null })
      } else {
        const linkOnly = isLinkOnlyFailure(out.failure)
        noteRetryHold(holds, out.failure, imageUrl, out.retryAfterSec, Date.now())
        retryAfter.current = linkOnly ? Math.max(out.retryAfterSec ?? 0, UNAVAILABLE_MIN_RETRY_SEC) : out.retryAfterSec
        setState((s) => ({ ...s, loading: false, failure: out.failure }))
        if (linkOnly) requestCameraListReload()
      }
    } catch {
      // Aborted by unmount / camera switch: nothing to update.
      return
    } finally {
      clearTimeout(watchdog)
      if (inflight.current === ctrl) inflight.current = null
    }
    finishedAt.current = Date.now()
    schedule()
  })

  // Revoke a still's object URL once a newer one is on screen (or on unmount).
  useEffect(() => {
    const src = state.src
    return () => {
      if (src) URL.revokeObjectURL(src)
    }
  }, [state.src])

  // On unmount / camera change: abort the request in flight and forget the old still (a camera
  // that turned link-only must not keep showing its last picture, undimmed and unlabelled).
  useEffect(() => {
    const flight = inflight
    const t = timer
    const r = reloadTimer
    return () => {
      flight.current?.abort()
      flight.current = null
      clearTimer(t)
      clearTimer(r)
      finishedAt.current = null
      retryAfter.current = null
      setState(EMPTY)
    }
  }, [imageUrl])

  useEffect(() => {
    auto.current = opts.auto
    interval.current = opts.intervalMs
    if (!imageUrl) return
    if (finishedAt.current === null) {
      // First still: as soon as it may load.
      if (!opts.enabled) return
      const t = setTimeout(() => void run(), 0)
      return () => clearTimeout(t)
    }
    if (opts.auto) schedule()
    else clearTimer(timer)
  }, [imageUrl, opts.enabled, opts.auto, opts.intervalMs])

  useEffect(() => {
    if (due === 0) return
    const t = setTimeout(() => void run(), 0)
    return () => clearTimeout(t)
  }, [due])

  const reload = () => {
    clearTimer(reloadTimer)
    const wait = reloadDelay(finishedAt.current, retryAfter.current, Date.now())
    if (wait <= 0) setDue((n) => n + 1)
    else reloadTimer.current = setTimeout(() => setDue((n) => n + 1), wait)
  }
  return { ...state, reload }
}
