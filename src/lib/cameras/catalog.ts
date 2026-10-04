import type { AppConfig } from '../config'
import type { Store } from '../store/types'
import type { CameraCatalog, CameraCatalogResult, CameraSourceId } from '../types'

// Camera catalogues: stored in Store meta (public part and server-only refs under separate
// keys), refreshed by the poller when due, joined to nearby stations at catalogue time.
// CONTRACT STUB — implemented by the catalogue agent; signatures are fixed.

export const CATALOG_META_PREFIX = 'cctv:catalog:'
export const REFS_META_PREFIX = 'cctv:refs:'

export interface CameraCatalogDeps {
  store: Store
  config: AppConfig
  fetch: typeof fetch
  now?: () => Date
  log?: (msg: string) => void
  signal?: AbortSignal
}

export interface CameraCatalogReport {
  source: CameraSourceId
  ok: boolean
  count: number
  skipped?: boolean
  error?: string
  warnings?: string[]
}

/** Stored catalogues for the given sources (missing ones omitted); memory-cached by fetchedAt. */
export async function loadCameraCatalogs(_store: Store, _sources: readonly CameraSourceId[]): Promise<CameraCatalog[]> {
  throw new Error('not implemented')
}

/** Server-only upstream reference for a camera id, or null when this host has none. */
export async function getCameraRef(_store: Store, _cameraId: string): Promise<string | null> {
  throw new Error('not implemented')
}

/** True when this host holds image references for the source (it fetched the list itself). */
export async function hasCameraRefs(_store: Store, _source: CameraSourceId): Promise<boolean> {
  throw new Error('not implemented')
}

/**
 * Persist a catalogue. `refs` present ⇒ stored server-side too. A list with fewer than half
 * the previous cameras is refused (partial responses must never wipe the catalogue).
 */
export async function saveCameraCatalog(
  _store: Store,
  _catalog: CameraCatalog | CameraCatalogResult,
  _now?: Date,
): Promise<{ saved: boolean; warning: string | null }> {
  throw new Error('not implemented')
}

/** Refresh the enabled catalogues that are due (or all with `force`). Never throws. */
export async function refreshCameraCatalogs(_deps: CameraCatalogDeps, _opts?: { force?: boolean }): Promise<CameraCatalogReport[]> {
  throw new Error('not implemented')
}
