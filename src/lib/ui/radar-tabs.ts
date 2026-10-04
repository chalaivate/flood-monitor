import type { RadarImage } from '../types'

// Pure helpers for the dashboard radar card (tab labels, title, ARIA tabs keyboard model).

/** Id of the animated RainViewer tab. */
export const RAINVIEWER_TAB = 'rainviewer'

/** Short tab label: the explicit `tabLabel`, else (observed images only) the text in parentheses. */
export function radarTabLabel(img: RadarImage): string {
  const explicit = img.tabLabel?.trim()
  if (explicit) return explicit
  if (img.forecast) return img.title
  return img.title.match(/\(([^)]+)\)/)?.[1]?.trim() || img.title
}

/** Card title for the selected view. Observed radar says "ตอนนี้"; a forecast never does. */
export function radarTitle(img: RadarImage | undefined): string {
  if (!img) return 'เรดาร์ฝนตอนนี้'
  return img.forecast ? img.title : `${img.title} ตอนนี้`
}

/**
 * Index of the tab to move to for a key press inside a tablist (WAI-ARIA tabs pattern:
 * ArrowLeft/ArrowRight wrap around, Home/End jump to the ends), or null for other keys.
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  const i = Math.min(Math.max(index, 0), count - 1)
  switch (key) {
    case 'ArrowRight':
      return (i + 1) % count
    case 'ArrowLeft':
      return (i - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
