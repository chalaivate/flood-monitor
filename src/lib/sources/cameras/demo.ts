import type { Camera, CameraCatalogResult, CameraRef, Station } from '../../types'
import { DEMO_AGENCY, demoCanal, demoRoadFlood } from '../demo'
import type { CameraCatalogAdapter } from './types'
import { siteIdFor } from './common'

// DATA_MODE=fixture: simulated cameras, one per demo road-flood station plus two canal cameras.
// Their images are generated at request time (never real frames). The ref of each camera is
// the id of the demo station whose simulated water drives its picture.

/** Canals near the demo home (DEMO_CENTER) that get a simulated camera. */
export const DEMO_CANAL_CAMERA_CODES = ['WL.PWT.03', 'WL.SLL.01'] as const

/** Cameras sit ~20 m north of their station so map markers do not hide each other. */
const OFFSET_LAT = 0.0002

/** Where people read about the simulation (there is no agency page for a simulated camera). */
export const DEMO_CAMERA_PAGE = '/about'

function demoCamera(n: number, st: Station, facing: Camera['facing']): Camera {
  const nativeId = String(n)
  const lat = Math.round((st.lat + OFFSET_LAT) * 1e5) / 1e5
  const lng = st.lng
  return {
    id: `demo-cam:${nativeId}`,
    source: 'demo-cam',
    nativeId,
    siteId: siteIdFor('demo-cam', lat, lng),
    name: `กล้องจำลอง · ${st.shortName ?? st.name}`,
    code: `DEMO-CAM-${String(n).padStart(2, '0')}`,
    angle: null,
    owner: DEMO_AGENCY,
    lat,
    lng,
    facing,
    nearStationIds: [],
    officialUrl: DEMO_CAMERA_PAGE,
    cadenceMin: null,
  }
}

/** Deterministic simulated catalogue (same cameras for any `now`). */
export function demoCameraCatalog(now: Date): CameraCatalogResult {
  const roads = demoRoadFlood(now, 0).stations
  const canals = demoCanal(now, 0).stations
  const picked: { st: Station; facing: Camera['facing'] }[] = [
    ...roads.map((st) => ({ st, facing: 'road' as const })),
    ...DEMO_CANAL_CAMERA_CODES.flatMap((code) => canals.filter((s) => s.code === code).map((st) => ({ st, facing: 'water' as const }))),
  ]
  const cameras: Camera[] = []
  const refs: CameraRef[] = []
  picked.forEach(({ st, facing }, i) => {
    const cam = demoCamera(i + 1, st, facing)
    cameras.push(cam)
    refs.push({ cameraId: cam.id, ref: st.id })
  })
  return { source: 'demo-cam', fetchedAt: now.toISOString(), cameras, refs, warnings: [] }
}

export const demoCamSource: CameraCatalogAdapter = {
  id: 'demo-cam',
  label: DEMO_AGENCY,
  thaiIpOnly: false,
  // Built once (or when missing): the simulated set never changes.
  refreshHours: Number.POSITIVE_INFINITY,
  // Built from the demo tables in code: never partial.
  staticList: true,
  async fetchCatalog(ctx) {
    return demoCameraCatalog(ctx.now)
  },
}
