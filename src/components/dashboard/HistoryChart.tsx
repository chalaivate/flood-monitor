'use client'

import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { FreeboardThresholds, HistoryPoint, Level, StationStatus } from '@/lib/types'
import {
  bkkShort,
  freeboardDomain,
  hourlyRows,
  linePath,
  linearScale,
  niceTicks,
  seriesPoints,
  timeTicks,
  timeTickStep,
  unionTimes,
  valueAt,
  type XY,
} from '@/lib/ui/chart'
import { metresTh } from '@/lib/ui/gauge'
import { LEVEL_COLOR, levelLabel } from '@/lib/ui/levels'
import { stationShort } from '@/lib/ui/format'
import { useElementWidth } from '@/lib/ui/hooks'
import { Card, EmptyState } from '../Card'
import { IconChart, IconTable } from '../icons'
import { LevelDot, LevelShape } from '../LevelBadge'

/** Categorical slots; colour follows the station's position in the snapshot (stable). */
export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'] as const
const MAX_SERIES = SERIES_COLORS.length

const HEIGHT = 248
const M = { top: 14, right: 10, bottom: 26, left: 38 }

interface Series {
  id: string
  name: string
  short: string
  color: string
  level: Level
  stale: boolean
  points: XY[]
  latest: number | null
}

export interface HistoryChartProps {
  water: StationStatus[]
  series: Record<string, HistoryPoint[]> | null
  thresholds: FreeboardThresholds
  nowMs: number
  hours?: number
  error?: string | null
  /** Previous data while a new place loads: keep the frame, dim it. */
  dimmed?: boolean
}

export function HistoryChart({ water, series, thresholds, nowMs, hours = 48, error, dimmed }: HistoryChartProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const uid = useId()

  const list: Series[] = useMemo(
    () =>
      water.slice(0, MAX_SERIES).map((w, i) => {
        const points = seriesPoints(series?.[w.station.id]).filter((p) => p.t >= nowMs - hours * 3_600_000 - 600_000)
        const fb = w.reading?.freeboard
        return {
          id: w.station.id,
          name: w.station.name,
          short: stationShort(w.station),
          color: SERIES_COLORS[i] ?? SERIES_COLORS[0],
          level: w.level,
          stale: w.stale,
          points,
          latest: !w.stale && typeof fb === 'number' ? fb : (points[points.length - 1]?.v ?? null),
        }
      }),
    [water, series, nowMs, hours],
  )
  const hasData = list.some((s) => s.points.length > 0)

  const toggle = (
    <button
      type="button"
      className="fm-btn fm-btn-quiet"
      onClick={() => setView((v) => (v === 'chart' ? 'table' : 'chart'))}
      aria-pressed={view === 'table'}
      disabled={!hasData}
    >
      {view === 'chart' ? <IconTable size={18} /> : <IconChart size={18} />}
      {view === 'chart' ? 'ดูเป็นตาราง' : 'ดูเป็นกราฟ'}
    </button>
  )

  return (
    <Card title={`ระยะห่างตลิ่ง ${hours} ชม. (ม.)`} action={toggle} id={`${uid}-hist`}>
      {water.length === 0 ? (
        <EmptyState title="ไม่มีจุดวัดระดับน้ำให้แสดง">ขยายรัศมีค้นหาเพื่อดูกราฟย้อนหลัง</EmptyState>
      ) : series === null && !error ? (
        <div className="grid place-items-center text-sm text-muted" style={{ height: HEIGHT }}>
          กำลังโหลดข้อมูลย้อนหลัง…
        </div>
      ) : !hasData ? (
        <EmptyState title={error ? 'โหลดข้อมูลย้อนหลังไม่สำเร็จ' : 'ยังไม่มีข้อมูลย้อนหลัง'}>
          {error ? error : 'ระบบจะเริ่มแสดงกราฟเมื่อเก็บข้อมูลได้มากขึ้น'}
        </EmptyState>
      ) : (
        <div className={dimmed ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {view === 'chart' ? (
            <Plot list={list} thresholds={thresholds} t0={nowMs - hours * 3_600_000} t1={nowMs} />
          ) : (
            <HistoryTable list={list} />
          )}
          <Legend list={list} />
          {water.length > MAX_SERIES && (
            <p className="mt-2 text-xs text-muted">แสดง {MAX_SERIES} จุดที่ใกล้บ้านที่สุด</p>
          )}
        </div>
      )}
    </Card>
  )
}

function Plot({ list, thresholds, t0, t1 }: { list: Series[]; thresholds: FreeboardThresholds; t0: number; t1: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(wrapRef)
  const [hoverT, setHoverT] = useState<number | null>(null)

  const allValues = list.flatMap((s) => s.points.map((p) => p.v))
  const [y0, y1] = freeboardDomain(allValues, thresholds)
  const w = Math.max(width, 240)
  const x = linearScale([t0, t1], [M.left, w - M.right])
  const y = linearScale([y0, y1], [HEIGHT - M.bottom, M.top])
  const yTicks = niceTicks(y0, y1, HEIGHT > 200 ? 5 : 4)
  const xTicks = timeTicks(t0, t1, timeTickStep(t1 - t0, w - M.left - M.right))
  const times = unionTimes(list.map((s) => s.points))

  const thresholdLines = (
    [
      { level: 'watch', v: thresholds.watch },
      { level: 'warning', v: thresholds.warning },
      { level: 'critical', v: thresholds.critical },
    ] as const
  ).filter((l) => l.v >= y0 && l.v <= y1)

  const snap = (t: number): number | null => {
    if (times.length === 0) return null
    let best = times[0]!
    for (const tt of times) if (Math.abs(tt - t) < Math.abs(best - t)) best = tt
    return best
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * w
    if (px < M.left - 8 || px > w - M.right + 8) return setHoverT(null)
    const t = t0 + ((px - M.left) / (w - M.left - M.right)) * (t1 - t0)
    setHoverT(snap(t))
  }

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (times.length === 0) return
    const cur = hoverT === null ? -1 : times.indexOf(hoverT)
    const stepIdx = Math.max(1, Math.round(times.length / 48)) // ~1 h per key press
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = cur < 0 ? times.length - 1 : Math.max(0, cur - stepIdx)
    else if (e.key === 'ArrowRight') next = cur < 0 ? times.length - 1 : Math.min(times.length - 1, cur + stepIdx)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = times.length - 1
    else if (e.key === 'Escape') {
      setHoverT(null)
      return
    } else return
    e.preventDefault()
    setHoverT(times[next] ?? null)
  }

  const hx = hoverT !== null ? x(hoverT) : null
  const readout =
    hoverT !== null
      ? list.map((s) => ({ s, p: valueAt(s.points, hoverT) })).filter((r): r is { s: Series; p: XY } => r.p !== null)
      : []
  const tipLeft = hx !== null && hx > w * 0.58

  const summary = list
    .filter((s) => s.latest !== null)
    .map((s) => `${s.short} ${metresTh(s.latest)}`)
    .join(', ')

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg
          width={w}
          height={HEIGHT}
          viewBox={`0 0 ${w} ${HEIGHT}`}
          className="block touch-pan-y outline-none"
          role="img"
          aria-label={`กราฟระยะห่างตลิ่งย้อนหลัง ค่าล่าสุด: ${summary}. ใช้ปุ่มลูกศรซ้ายขวาเพื่ออ่านค่าแต่ละช่วงเวลา`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverT(null)}
          onKeyDown={onKey}
          onBlur={() => setHoverT(null)}
        >
          {/* horizontal grid + y ticks */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.left} x2={w - M.right} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
                {v.toFixed(1)}
              </text>
            </g>
          ))}
          {/* vertical grid + x ticks (Bangkok time) */}
          {xTicks.map((tk) => (
            <g key={`x${tk.t}`}>
              <line
                x1={x(tk.t)}
                x2={x(tk.t)}
                y1={M.top}
                y2={HEIGHT - M.bottom}
                stroke={tk.major ? 'var(--axis)' : 'var(--grid)'}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={x(tk.t)}
                y={HEIGHT - M.bottom + 16}
                textAnchor="middle"
                fontSize={11}
                fontWeight={tk.major ? 600 : 400}
                fill={tk.major ? 'var(--text-2)' : 'var(--muted)'}
              >
                {tk.label}
              </text>
            </g>
          ))}
          {/* bank line (freeboard 0) */}
          {y0 < 0 && y1 > 0 && (
            <g>
              <line x1={M.left} x2={w - M.right} y1={y(0)} y2={y(0)} stroke="var(--text-2)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left + 4} y={y(0) - 4} fontSize={10.5} fill="var(--text-2)" className="fm-halo">
                ขอบตลิ่ง
              </text>
            </g>
          )}
          {/* threshold reference lines, labelled at the right edge */}
          {thresholdLines.map((l) => (
            <g key={l.level}>
              <line
                x1={M.left}
                x2={w - M.right}
                y1={y(l.v)}
                y2={y(l.v)}
                stroke={LEVEL_COLOR[l.level]}
                strokeWidth={1}
                strokeDasharray="4 3"
                shapeRendering="crispEdges"
              />
              <g transform={`translate(${w - M.right - 2} ${y(l.v) - 13})`}>
                <g transform="translate(-10 1) scale(0.8)">
                  <LevelShape level={l.level} color={LEVEL_COLOR[l.level]} />
                </g>
                <text x={-14} y={9} textAnchor="end" fontSize={10.5} fill="var(--text-2)" className="fm-halo">
                  {levelLabel(l.level)} {l.v.toFixed(2)}
                </text>
              </g>
            </g>
          ))}
          {/* series */}
          {list.map((s) => (
            <path
              key={s.id}
              d={linePath(s.points, x, y)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={s.stale ? 0.55 : 1}
            />
          ))}
          {/* end markers */}
          {hoverT === null &&
            list.map((s) => {
              const last = s.points[s.points.length - 1]
              if (!last) return null
              return <circle key={`e${s.id}`} cx={x(last.t)} cy={y(last.v)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />
            })}
          {/* crosshair */}
          {hx !== null && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--text-2)" strokeWidth={1} shapeRendering="crispEdges" />
              {readout.map(({ s, p }) => (
                <circle key={`h${s.id}`} cx={x(p.t)} cy={y(p.v)} r={4.5} fill={s.color} stroke="var(--card)" strokeWidth={2} />
              ))}
            </g>
          )}
          <text x={M.left - 6} y={M.top - 4} textAnchor="end" fontSize={10.5} fill="var(--muted)">
            ม.
          </text>
        </svg>
      )}
      {hoverT !== null && hx !== null && (
        <div
          className="fm-tooltip pointer-events-none absolute top-1"
          style={tipLeft ? { right: w - hx + 10 } : { left: hx + 10 }}
          role="status"
          aria-live="polite"
        >
          <div className="mb-1 text-xs text-text-2">{bkkShort(hoverT)} น.</div>
          {readout.length === 0 && <div className="text-xs text-muted">ไม่มีข้อมูลช่วงนี้</div>}
          {readout.map(({ s, p }) => (
            <div key={s.id} className="flex items-center gap-2 whitespace-nowrap">
              <svg width="14" height="4" aria-hidden="true">
                <line x1="1" x2="13" y1="2" y2="2" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <span className="tabular font-semibold text-text">{p.v.toFixed(2)}</span>
              <span className="max-w-[11rem] truncate text-xs text-text-2">{s.short}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Legend({ list }: { list: Series[] }) {
  return (
    <ul className="mt-3 flex flex-col gap-1.5" aria-label="คำอธิบายเส้นกราฟ">
      {list.map((s) => (
        <li key={s.id} className="flex min-w-0 items-center gap-2 text-sm">
          <svg width="18" height="6" aria-hidden="true" className="shrink-0">
            <line x1="1" x2="17" y1="3" y2="3" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-text-2" title={s.name}>
            {s.name}
          </span>
          <span className="tabular shrink-0 font-medium text-text">{s.latest === null ? '-' : metresTh(s.latest)}</span>
          <LevelDot level={s.stale ? 'unknown' : s.level} size={11} />
        </li>
      ))}
    </ul>
  )
}

function HistoryTable({ list }: { list: Series[] }) {
  const rows = hourlyRows(list.map((s) => s.points))
  return (
    <div className="max-h-[248px] overflow-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="ตารางระยะห่างตลิ่งรายชั่วโมง">
      <table className="fm-table w-full text-sm">
        <caption className="sr-only">ระยะห่างตลิ่ง (เมตร) ค่าล่าสุดของแต่ละชั่วโมง เวลาประเทศไทย</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left">
              เวลา
            </th>
            {list.map((s) => (
              <th key={s.id} scope="col" className="text-right" title={s.name}>
                {s.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <th scope="row" className="tabular text-left font-normal text-text-2">
                {bkkShort(r.t)}
              </th>
              {r.values.map((v, i) => (
                <td key={i} className="tabular text-right">
                  {v === null ? '–' : v.toFixed(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

