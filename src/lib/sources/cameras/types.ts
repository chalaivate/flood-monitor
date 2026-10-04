import type { CameraCatalogResult, CameraSourceId } from '../../types'
import type { SourceContext } from '../types'

/** Fetches one agency's camera list (not images). Sibling of SourceAdapter. */
export interface CameraCatalogAdapter {
  id: CameraSourceId
  /** Thai agency label for attribution, e.g. "สำนักการระบายน้ำ กทม.". */
  label: string
  /** True when the upstream only answers requests from Thai IP addresses. */
  thaiIpOnly: boolean
  /** How often the list is refreshed, hours (camera lists change rarely). */
  refreshHours: number
  fetchCatalog(ctx: SourceContext): Promise<CameraCatalogResult>
}
