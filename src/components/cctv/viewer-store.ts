'use client'

import { useSyncExternalStore } from 'react'
import type { CameraSite, SensorInfo } from '@/lib/ui/cctv'

// The camera viewer (one per page: the dashboard and the map each render <CameraViewer />),
// opened from dashboard tiles, map markers and station popups.
//
// The open state belongs to the <CameraViewer /> mounted when it opened (its "host"): another
// page's viewer never shows it, and it is dropped when that viewer unmounts (client navigation).
// Opening also adds a same-URL history entry, so the browser's Back closes the viewer instead of
// leaving the page; closing it from the page removes that entry again.

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

export interface ViewerState {
  request: ViewerRequest
  /** Element focused when the viewer opened; focus returns there on close. */
  opener: HTMLElement | null
  /** Distinguishes two opens of the same request. */
  seq: number
  /** The <CameraViewer /> that shows this state (0: none was mounted). */
  host: number
  /** Marker of the history entry pushed on open (null: none, e.g. no history API). */
  entry: number | null
}

/** History state key of the entry pushed when the viewer opens. */
export const VIEWER_HISTORY_KEY = '__fmCamViewer'

let state: ViewerState | null = null
let seq = 0
let hostSeq = 0
/** The mounted <CameraViewer /> (the latest to mount on this page). */
let host = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of [...listeners]) l()
}

function browser(): (Window & typeof globalThis) | null {
  return typeof window === 'undefined' || !window.history ? null : window
}

function historyEntry(): number | null {
  const w = browser()
  const v = (w?.history.state as Record<string, unknown> | null | undefined)?.[VIEWER_HISTORY_KEY]
  return typeof v === 'number' ? v : null
}

/** Back/Forward while the viewer is open: our entry is no longer current, so close (no history change). */
function onPopState() {
  if (state && state.entry !== null && historyEntry() !== state.entry) drop(true)
}

function listen(on: boolean) {
  const w = browser()
  if (!w) return
  if (on) w.addEventListener('popstate', onPopState)
  else w.removeEventListener('popstate', onPopState)
}

/** Forget the open state; optionally return focus to the opener. Never touches history. */
function drop(focusOpener: boolean) {
  if (!state) return
  const opener = state.opener
  state = null
  listen(false)
  emit()
  if (focusOpener && opener && opener.isConnected) {
    // After the dialog has closed (native close may move focus first).
    setTimeout(() => opener.focus({ preventScroll: true }), 0)
  }
}

export function openCameraViewer(request: ViewerRequest): void {
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (state) {
    // The viewer replaces its own request (e.g. the chain chip): keep the opener and the entry.
    state = { ...state, request, seq: ++seq }
    emit()
    return
  }
  const opener = typeof HTMLElement !== 'undefined' && active instanceof HTMLElement && active !== document.body ? active : null
  const next = ++seq
  const w = browser()
  // Same URL; Next.js copies its own router state into the entry (docs: Native History API).
  w?.history.pushState({ [VIEWER_HISTORY_KEY]: next }, '')
  state = { request, opener, seq: next, host, entry: w ? next : null }
  listen(true)
  emit()
}

/** Close from the page (close button, Escape, dialog close): focus returns to the opener. */
export function closeCameraViewer(): void {
  if (!state) return
  const pushed = state.entry !== null && historyEntry() === state.entry
  drop(true)
  // Remove the entry pushed on open, so Back then leaves the page as usual.
  if (pushed) browser()?.history.back()
}

/** Id of a new <CameraViewer /> instance (taken once, at its first render). */
export function newViewerHostId(): number {
  return ++hostSeq
}

/**
 * The viewer with this id is mounted (it shows what opens from now on); the returned function
 * runs on unmount.
 */
export function mountViewerHost(id: number): () => void {
  host = id
  return () => {
    if (host === id) host = 0
    // The page went away with its viewer open (client navigation): forget it without moving
    // focus or history, so the next page does not reopen it or load stills.
    if (state?.host === id) drop(false)
  }
}

/** The open state as the viewer with id `hostId` sees it (null when another page opened it). */
export function viewerStateFor(hostId: number | null): ViewerState | null {
  return state && hostId !== null && state.host === hostId ? state : null
}

/** Raw open state (tests, and pages that only need to know whether it is open). */
export function currentViewerState(): ViewerState | null {
  return state
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * The open state for the viewer with id `hostId`. Without an id: the state of whichever viewer
 * is mounted now (the page's own), e.g. to pause dashboard tiles behind it.
 */
export function useCameraViewer(hostId?: number | null): ViewerState | null {
  return useSyncExternalStore(
    subscribe,
    () => (hostId === undefined ? (state && state.host === host ? state : null) : viewerStateFor(hostId)),
    () => null,
  )
}

/** True while the page's own viewer is open (covering the page). */
export function useCameraViewerOpen(): boolean {
  return useCameraViewer() !== null
}
