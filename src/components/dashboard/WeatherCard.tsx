'use client'

import { useState, type ReactNode } from 'react'
import type { WeatherNow } from '@/lib/types'
import { bkkTime } from '@/lib/ui/chart'
import { ageTh } from '@/lib/ui/format'
import { Card, EmptyState } from '../Card'
import { IconCloud, IconDroplet, IconRain, IconTable, IconThermometer, IconUmbrella, IconChart } from '../icons'

function fmt(v: number | null | undefined, digits: number, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return `${v.toLocaleString('th-TH', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}${unit}`
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="text-accent">{icon}</span>
      <span className="flex-1 text-text-2">{label}</span>
      <span className="tabular text-right font-medium">{value}</span>
    </div>
  )
}

/** "อากาศที่บ้านตอนนี้": current conditions + next-12-hour rain forecast columns. */
export function WeatherCard({ weather, nowMs }: { weather: WeatherNow | null; nowMs: number }) {
  if (!weather) {
    return (
      <Card title="อากาศที่บ้านตอนนี้">
        <EmptyState title="ไม่มีข้อมูลอากาศ">ไม่สามารถติดต่อผู้ให้บริการพยากรณ์อากาศได้ในขณะนี้</EmptyState>
      </Card>
    )
  }
  return (
    <Card title="อากาศที่บ้านตอนนี้">
      <div className="divide-y divide-border">
        <Row icon={<IconCloud />} label="สภาพอากาศ" value={weather.condition || '-'} />
        <Row icon={<IconUmbrella />} label="โอกาสฝนตก (3 ชม.)" value={fmt(weather.precipitationProbabilityPct, 0, '%')} />
        <Row icon={<IconRain />} label="ความแรงฝน" value={fmt(weather.precipitationMmH, 1, ' มม./ชม.')} />
        <Row icon={<IconDroplet />} label="ความชื้น" value={fmt(weather.humidityPct, 0, '%')} />
        <Row icon={<IconThermometer />} label="อุณหภูมิ" value={fmt(weather.temperatureC, 1, ' °C')} />
      </div>
      {weather.hourly && weather.hourly.length > 0 && <RainForecast hourly={weather.hourly} total24={weather.rainNext24hMm} />}
      <p className="mt-3 text-xs text-muted">
        ข้อมูล: {weather.source} · {ageTh(weather.observedAt, nowMs)}
      </p>
    </Card>
  )
}

const H = 92
const PAD_TOP = 16
const PAD_BOTTOM = 18

/** Small column chart of forecast rain per hour; values also available as a table. */
function RainForecast({ hourly, total24 }: { hourly: NonNullable<WeatherNow['hourly']>; total24?: number | null }) {
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const data = hourly.slice(0, 12)
  const max = Math.max(1, ...data.map((d) => d.precipitationMm))
  const peak = data.reduce((best, d, i) => (d.precipitationMm > (data[best]?.precipitationMm ?? -1) ? i : best), 0)
  const n = data.length
  const W = 300
  const slot = W / n
  const barW = Math.min(16, slot - 4)
  const plotH = H - PAD_TOP - PAD_BOTTOM
  const anyRain = data.some((d) => d.precipitationMm > 0)

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm text-text-2">
          ฝนคาดการณ์ 12 ชม. ข้างหน้า
          {typeof total24 === 'number' && <span className="text-muted"> · 24 ชม. รวม {fmt(total24, 1, ' มม.')}</span>}
        </p>
        <button type="button" className="fm-icon-btn size-8" onClick={() => setTable((t) => !t)} aria-pressed={table} aria-label={table ? 'ดูเป็นกราฟ' : 'ดูเป็นตาราง'} title={table ? 'ดูเป็นกราฟ' : 'ดูเป็นตาราง'}>
          {table ? <IconChart size={16} /> : <IconTable size={16} />}
        </button>
      </div>
      {table ? (
        <table className="fm-table w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">เวลา</th>
              <th className="text-right">ฝน (มม.)</th>
              <th className="text-right">โอกาส</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.time}>
                <td className="tabular text-text-2">{bkkTime(Date.parse(d.time))}</td>
                <td className="tabular text-right">{d.precipitationMm.toFixed(1)}</td>
                <td className="tabular text-right">{d.probabilityPct === null ? '-' : `${d.probabilityPct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`ฝนคาดการณ์รายชั่วโมง สูงสุด ${data[peak]?.precipitationMm.toFixed(1)} มม. เวลา ${data[peak] ? bkkTime(Date.parse(data[peak].time)) : ''}`} onPointerLeave={() => setHover(null)}>
            <line x1={0} x2={W} y1={H - PAD_BOTTOM} y2={H - PAD_BOTTOM} stroke="var(--axis)" strokeWidth={1} shapeRendering="crispEdges" />
            {data.map((d, i) => {
              const h = (d.precipitationMm / max) * plotH
              const cx = slot * i + slot / 2
              const x = cx - barW / 2
              const yTop = H - PAD_BOTTOM - h
              const r = Math.min(4, h / 2, barW / 2)
              const path = h > 0.5 ? `M${x},${H - PAD_BOTTOM}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${H - PAD_BOTTOM}Z` : ''
              const t = Date.parse(d.time)
              return (
                <g key={d.time} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                  <rect x={slot * i} y={0} width={slot} height={H} fill="transparent" />
                  {path && <path d={path} fill="var(--s1)" opacity={hover === null || hover === i ? 1 : 0.55} />}
                  {i % 3 === 0 && (
                    <text x={cx} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">
                      {bkkTime(t)}
                    </text>
                  )}
                  {i === peak && anyRain && hover === null && (
                    <text x={cx} y={yTop - 4} textAnchor="middle" fontSize={10.5} fill="var(--text-2)">
                      {d.precipitationMm.toFixed(1)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {!anyRain && <p className="absolute inset-x-0 top-5 text-center text-sm text-muted">ไม่มีฝนในช่วงนี้</p>}
          {hover !== null && data[hover] && (
            <div
              className="fm-tooltip pointer-events-none absolute top-0"
              style={hover > n / 2 ? { right: `${((n - hover) / n) * 100}%` } : { left: `${((hover + 1) / n) * 100}%` }}
            >
              <div className="text-xs text-text-2">{bkkTime(Date.parse(data[hover].time))} น.</div>
              <div className="tabular font-semibold">{data[hover].precipitationMm.toFixed(1)} มม.</div>
              {data[hover].probabilityPct !== null && <div className="text-xs text-text-2">โอกาส {data[hover].probabilityPct}%</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
