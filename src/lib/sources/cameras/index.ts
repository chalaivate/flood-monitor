import type { AppConfig } from '../../config'
import type { CameraSourceId } from '../../types'
import { bmaFloodcamSource } from './bma-floodcam'
import { demoCamSource } from './demo'
import { dwrCctvSource } from './dwr'
import type { CameraCatalogAdapter } from './types'

/** Every camera catalogue adapter by id. */
export const CAMERA_ADAPTERS: Record<CameraSourceId, CameraCatalogAdapter> = {
  'bma-floodcam': bmaFloodcamSource,
  'dwr-cctv': dwrCctvSource,
  'demo-cam': demoCamSource,
}

/** Sources whose catalogues a Thai relay may push (never the simulated one). */
export const RELAYABLE_CAMERA_SOURCES: readonly CameraSourceId[] = ['bma-floodcam', 'dwr-cctv']

/** Adapters enabled by configuration (CCTV_SOURCES; DATA_MODE=fixture ⇒ demo-cam only). */
export function getCameraSources(config: Pick<AppConfig, 'enabledCameraSources'>): CameraCatalogAdapter[] {
  return config.enabledCameraSources.map((id) => CAMERA_ADAPTERS[id]).filter((a): a is CameraCatalogAdapter => !!a)
}
