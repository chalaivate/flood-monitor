import type { CameraCatalog, CameraCatalogResult, CameraSourceId } from '../../types'
import type { SourceContext } from '../types'

/** What a catalogue adapter gets: the usual source context plus the list stored before. */
export interface CameraCatalogContext extends SourceContext {
  /**
   * The list in use before this refresh (public fields), when there is one. DWR keeps a
   * station's last known position when its lookup fails, so a transient error never drops it.
   */
  previous?: CameraCatalog | null
}

/** Fetches one agency's camera list (not images). Sibling of SourceAdapter. */
export interface CameraCatalogAdapter {
  id: CameraSourceId
  /** Thai agency label for attribution, e.g. "สำนักการระบายน้ำ กทม.". */
  label: string
  /** True when the upstream only answers requests from Thai IP addresses. */
  thaiIpOnly: boolean
  /** How often the list is refreshed, hours (camera lists change rarely). */
  refreshHours: number
  fetchCatalog(ctx: CameraCatalogContext): Promise<CameraCatalogResult>
}
