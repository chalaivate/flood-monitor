import type { Level, SourceId, StationKind } from '../types'
import { LEVEL_LABEL_TH } from '../types'

/** CSS colour (token) per level. Always render next to an icon or label, never colour alone. */
export const LEVEL_COLOR: Record<Level, string> = {
  normal: 'var(--lv-normal)',
  watch: 'var(--lv-watch)',
  warning: 'var(--lv-warning)',
  critical: 'var(--lv-critical)',
  unknown: 'var(--lv-unknown)',
}

/**
 * Text glyph that differs by level so meaning survives colour-blindness and grayscale.
 * Matches the LevelDot shapes: circle, triangle, diamond, square, hollow circle.
 */
export const LEVEL_GLYPH: Record<Level, string> = {
  normal: '●',
  watch: '▲',
  warning: '◆',
  critical: '■',
  unknown: '○',
}

/** Levels from least to most severe (for legends and pickers). */
export const LEVEL_LADDER: Exclude<Level, 'unknown'>[] = ['normal', 'watch', 'warning', 'critical']

export function levelLabel(level: Level): string {
  return LEVEL_LABEL_TH[level]
}

export const KIND_LABEL_TH: Record<StationKind, string> = {
  canal: 'คลอง',
  river: 'แม่น้ำ',
  pump: 'สถานีสูบน้ำ',
  roadflood: 'น้ำท่วมถนน',
  rain: 'สถานีวัดฝน',
}

export const SOURCE_LABEL_TH: Record<SourceId, string> = {
  'bma-canal': 'สำนักการระบายน้ำ กทม.',
  'bma-pump': 'สำนักการระบายน้ำ กทม.',
  'bma-roadflood': 'สำนักการระบายน้ำ กทม.',
  'bma-rain': 'สำนักการระบายน้ำ กทม.',
  'thaiwater-canal': 'สสน. (ThaiWater)',
  'thaiwater-wl': 'สสน. (ThaiWater)',
  'thaiwater-rain': 'สสน. (ThaiWater)',
  'thaiwater-road': 'สสน. (ThaiWater)',
}

export function sourceLabel(source: string): string {
  return (SOURCE_LABEL_TH as Record<string, string>)[source] ?? source
}
