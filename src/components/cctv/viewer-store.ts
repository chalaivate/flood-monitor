'use client'

import { useSyncExternalStore } from 'react'
import type { CameraSite, SensorInfo } from '@/lib/ui/cctv'

// The camera viewer (one per page: the dashboard and the map each render <CameraViewer />),
// opened from dashboard tiles, map markers and station popups.

export type ViewerRequest =
  | {
      kind: 'sites'
      /** Sites the prev/next buttons step through. */
      sites: CameraSite[]
      index: number
      /** Angle to show first (default: the site's first camera). */
      cameraId?: string | null
      /** What the list is, e.g. "กล้องใกล้บ้าน". */
      listLabel?: string
      /** Joined sensors by station id (their readings, shown next to the picture). */
      sensors?: Record<string, SensorInfo>
    }
  /** Step through the DWR cameras on the Chao Phraya (loaded on demand). */
  | { kind: 'chain' }

interface ViewerState {
  request: ViewerRequest
  /** Element focused when the viewer opened; focus returns there on close. */
  opener: HTMLElement | null
  /** Distinguishes two opens of the same request. */
  seq: number
}

let state: ViewerState | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function openCameraViewer(request: ViewerRequest): void {
  const active = typeof document !== 'undefined' ? document.activeElement : null
  // Keep the original opener when the viewer replaces its own request (e.g. the chain chip).
  const opener = state?.opener ?? (active instanceof HTMLElement && active !== document.body ? active : null)
  state = { request, opener, seq: ++seq }
  emit()
}

export function closeCameraViewer(): void {
  const opener = state?.opener ?? null
  if (!state) return
  state = null
  emit()
  if (opener && opener.isConnected) {
    // After the dialog has closed (native close may move focus first).
    setTimeout(() => opener.focus({ preventScroll: true }), 0)
  }
}

export function useCameraViewer(): ViewerState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => state,
    () => null,
  )
}
