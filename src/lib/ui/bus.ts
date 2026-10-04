import { useSyncExternalStore } from 'react'

// Tiny page-wide event bus: the top bar's refresh button asks every data hook to
// refetch, and data hooks report in-flight requests so the button can spin.

const REFRESH_EVENT = 'fm:refresh'

export function requestRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT))
}

export function onRefresh(cb: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, cb)
  return () => window.removeEventListener(REFRESH_EVENT, cb)
}

let active = 0
const listeners = new Set<() => void>()

/** Mark a request as started; call the returned function when it settles. */
export function trackActivity(): () => void {
  active++
  for (const l of listeners) l()
  let done = false
  return () => {
    if (done) return
    done = true
    active = Math.max(0, active - 1)
    for (const l of listeners) l()
  }
}

export function useBusy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => active > 0,
    () => false,
  )
}
