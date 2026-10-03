import type { Level } from '@/lib/types'
import { LEVEL_COLOR, levelLabel } from '@/lib/ui/levels'

/**
 * Coloured status mark whose SHAPE also differs by level, so status never relies on
 * colour alone: ● ปกติ · ▲ เฝ้าระวัง · ◆ เตือนภัย · ■ วิกฤต · ○ ไม่มีข้อมูล.
 */
export function LevelDot({
  level,
  size = 12,
  title,
  decorative = false,
}: {
  level: Level
  size?: number
  title?: string
  /** true when a Thai label is rendered right next to it (avoids double announcement). */
  decorative?: boolean
}) {
  const color = LEVEL_COLOR[level]
  const label = title ?? levelLabel(level)
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label }
  const common = { width: size, height: size, flex: 'none' as const, display: 'inline-block', verticalAlign: 'middle' }
  return (
    <svg viewBox="0 0 12 12" style={common} {...a11y}>
      {!decorative && <title>{label}</title>}
      <LevelShape level={level} color={color} />
    </svg>
  )
}

/** The bare shape, for embedding inside other SVGs (chart legends, map markers). */
export function LevelShape({ level, color, x = 0, y = 0 }: { level: Level; color: string; x?: number; y?: number }) {
  const t = `translate(${x} ${y})`
  if (level === 'watch') return <path transform={t} d="M6 .8 11.4 10.6H.6Z" fill={color} />
  if (level === 'warning') return <path transform={t} d="M6 .3 11.7 6 6 11.7.3 6Z" fill={color} />
  if (level === 'critical') return <rect transform={t} x="1" y="1" width="10" height="10" rx="1.5" fill={color} />
  if (level === 'unknown') return <circle transform={t} cx="6" cy="6" r="4.25" fill="none" stroke={color} strokeWidth={1.5} />
  return <circle transform={t} cx="6" cy="6" r="5" fill={color} />
}

/** SVG markup string of a level shape (for Leaflet divIcons, built outside React). */
export function levelShapeSvg(level: Level, size = 14, ring = true): string {
  const c = LEVEL_COLOR[level]
  const stroke = ring ? ' stroke="var(--card)" stroke-width="1.6" paint-order="stroke"' : ''
  let shape: string
  if (level === 'watch') shape = `<path d="M6 .8 11.4 10.6H.6Z" fill="${c}"${stroke}/>`
  else if (level === 'warning') shape = `<path d="M6 .3 11.7 6 6 11.7.3 6Z" fill="${c}"${stroke}/>`
  else if (level === 'critical') shape = `<rect x="1" y="1" width="10" height="10" rx="1.5" fill="${c}"${stroke}/>`
  else if (level === 'unknown') shape = `<circle cx="6" cy="6" r="4.2" fill="var(--card)" stroke="${c}" stroke-width="1.8"/>`
  else shape = `<circle cx="6" cy="6" r="5" fill="${c}"${stroke}/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 14 14" width="${size}" height="${size}" aria-hidden="true">${shape}</svg>`
}

export function LevelBadge({
  level,
  className = '',
  size = 12,
  label,
}: {
  level: Level
  className?: string
  size?: number
  /** Override the visible text (defaults to the Thai level name). */
  label?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <LevelDot level={level} size={size} decorative />
      <span>{label ?? levelLabel(level)}</span>
    </span>
  )
}
