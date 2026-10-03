import { useSyncExternalStore } from 'react'
import type { StoredPlace } from './place'

// Global "choose location" dialog, opened from the top bar chip, dashboard banners
// and the map ("ตั้งเป็นบ้าน"). Rendered once by AppShell.

export interface LocationDialogRequest {
  /** Prefill (e.g. the point the user clicked on the map). */
  initial?: Partial<StoredPlace>
  /** Optional Thai heading override. */
  title?: string
}

let request: LocationDialogRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function openLocationDialog(r: LocationDialogRequest = {}): void {
  request = r
  emit()
}

export function closeLocationDialog(): void {
  request = null
  emit()
}

export function useLocationDialog(): LocationDialogRequest | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => request,
    () => null,
  )
}
