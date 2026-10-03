import type { ReactNode } from 'react'
import { gaugeAngle } from '@/lib/ui/gauge'

export interface GaugeSegment {
  from: number
  to: number
  color: string
}

export interface GaugeProps {
  value: number | null
  min: number
  max: number
  segments: GaugeSegment[]
  /** Text shown in the middle, e.g. "1.19 ม.". */
  display: string
  /** Accessible description, e.g. "ระยะห่างตลิ่ง 1.19 เมตร ระดับปกติ". */
  ariaLabel: string
  /** Render the arc in grey (stale or missing data) while keeping the needle hidden. */
  muted?: boolean
  /** Max rendered width in px. */
  maxWidth?: number
  children?: ReactNode
}

const CX = 100
const CY = 100
const R = 78
const STROKE = 20
/** Angular gap between segments in degrees (the 2px "surface gap"). */
const GAP_DEG = 1.4

function point(deg: number, r: number) {
  const rad = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY - r * Math.sin(rad) }
}

function arcPath(fromDeg: number, toDeg: number, r: number) {
  const a = point(fromDeg, r)
  const b = point(toDeg, r)
  const large = Math.abs(fromDeg - toDeg) > 180 ? 1 : 0
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

/** Shrink long readouts ("วิกฤต", "-0.15 ม.") so they never touch the arc. */
function fontSizeFor(text: string): number {
  const n = [...text].length
  if (n <= 6) return 30
  if (n <= 8) return 26
  if (n <= 10) return 22
  return 18
}

/** Semicircular gauge with a needle, in the style of a Home Assistant gauge card. */
export function Gauge({ value, min, max, segments, display, ariaLabel, muted = false, maxWidth = 240, children }: GaugeProps) {
  const hasValue = value !== null && Number.isFinite(value) && !muted
  const needleDeg = hasValue ? gaugeAngle(value, min, max) : null
  const fs = fontSizeFor(display)

  let needle: string | null = null
  if (needleDeg !== null) {
    const tip = point(needleDeg, R - STROKE / 2 - 6)
    const baseL = point(needleDeg + 5.5, R + STROKE / 2 + 3)
    const baseR = point(needleDeg - 5.5, R + STROKE / 2 + 3)
    const ctrl = point(needleDeg, R + STROKE / 2 + 8)
    needle = `M ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} L ${baseL.x.toFixed(2)} ${baseL.y.toFixed(2)} Q ${ctrl.x.toFixed(2)} ${ctrl.y.toFixed(2)} ${baseR.x.toFixed(2)} ${baseR.y.toFixed(2)} Z`
  }

  return (
    <div
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={hasValue ? Math.min(max, Math.max(min, value)) : undefined}
      aria-valuetext={display}
      className="flex w-full flex-col items-center"
    >
      <svg viewBox="0 0 200 112" className="w-full" style={{ maxWidth }} aria-hidden="true">
        {hasValue ? (
          segments.map((s, i) => {
            const from = gaugeAngle(s.from, min, max) - (i === 0 ? 0 : GAP_DEG / 2)
            const to = gaugeAngle(s.to, min, max) + (i === segments.length - 1 ? 0 : GAP_DEG / 2)
            if (from <= to) return null
            return <path key={i} d={arcPath(from, to, R)} stroke={s.color} strokeWidth={STROKE} fill="none" />
          })
        ) : (
          <path d={arcPath(180, 0, R)} stroke="var(--lv-unknown)" strokeOpacity={0.4} strokeWidth={STROKE} fill="none" />
        )}
        {needle && <path d={needle} fill="var(--text)" stroke="var(--card)" strokeWidth={2} strokeLinejoin="round" />}
        <text
          x={CX}
          y={CY - 4}
          textAnchor="middle"
          fontSize={fs}
          fontWeight={500}
          fill={hasValue ? 'var(--text)' : 'var(--muted)'}
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          {display}
        </text>
      </svg>
      {children}
    </div>
  )
}
