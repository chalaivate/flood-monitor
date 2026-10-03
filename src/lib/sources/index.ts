import type { AppConfig } from '../config'
import type { SourceId } from '../types'
import { bmaCanalSource } from './bma-canal'
import { bmaPumpSource, bmaRainSource, bmaRoadFloodSource } from './bma-misc'
import { DEMO_SOURCES } from './demo'
import { makeThaiwaterRainSource, makeThaiwaterWaterlevelSource, thaiwaterCanalSource, thaiwaterRoadSource } from './thaiwater'
import type { SourceAdapter } from './types'

/**
 * Metadata priority when two sources describe the same station id (e.g. canal:WL.SSB.07 from
 * BMA directly and from the ThaiWater mirror). Higher wins; readings from both are kept.
 */
export const SOURCE_PRIORITY: Record<SourceId, number> = {
  'bma-canal': 3,
  'bma-rain': 3,
  'bma-roadflood': 3,
  'bma-pump': 3,
  'thaiwater-canal': 2,
  'thaiwater-road': 2,
  'thaiwater-rain': 2,
  'thaiwater-wl': 2,
  popnix: 1,
}

function liveSources(config: AppConfig): Partial<Record<SourceId, SourceAdapter>> {
  return {
    'bma-canal': bmaCanalSource,
    'bma-rain': bmaRainSource,
    'bma-roadflood': bmaRoadFloodSource,
    'bma-pump': bmaPumpSource,
    'thaiwater-canal': thaiwaterCanalSource,
    'thaiwater-wl': makeThaiwaterWaterlevelSource(config.THAIWATER_PROVINCES),
    'thaiwater-rain': makeThaiwaterRainSource(config.THAIWATER_PROVINCES),
    'thaiwater-road': thaiwaterRoadSource,
  }
}

/** Adapters enabled by configuration (DATA_MODE=fixture swaps in the demo generator). */
export function getSources(config: AppConfig): SourceAdapter[] {
  if (config.DATA_MODE === 'fixture') return DEMO_SOURCES
  const live = liveSources(config)
  return config.enabledSources.map((id) => live[id]).filter((s): s is SourceAdapter => !!s)
}
