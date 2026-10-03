import type { DashboardSnapshot, StationStatus } from '@/lib/types'
import { distanceTh } from '@/lib/engine/format'
import { freeboardGauge, metresTh } from '@/lib/ui/gauge'
import { ageTh, stationShort, trendInfo } from '@/lib/ui/format'
import { LEVEL_COLOR, levelLabel } from '@/lib/ui/levels'
import { openLocationDialog } from '@/lib/ui/dialog'
import { EmptyState } from '../Card'
import { Gauge } from '../Gauge'
import { LevelBadge } from '../LevelBadge'

/** 2×2 grid of freeboard gauges for the nearest water-level stations. */
export function GaugeGrid({ snapshot, nowMs }: { snapshot: DashboardSnapshot; nowMs: number }) {
  if (snapshot.water.length === 0) {
    return (
      <section className="card p-4" aria-label="จุดวัดระดับน้ำใกล้บ้าน">
        <EmptyState title={`ไม่พบจุดวัดระดับน้ำในรัศมี ${snapshot.place.radiusKm} กม.`}>
          <p>ลองขยายรัศมีค้นหา หรือเลือกตำแหน่งที่ใกล้คลองหรือแม่น้ำมากขึ้น</p>
          <button
            type="button"
            className="fm-btn fm-btn-primary mt-3"
            onClick={() => openLocationDialog({ initial: { ...snapshot.place, radiusKm: Math.min(20, snapshot.place.radiusKm * 2) } })}
          >
            ขยายรัศมีค้นหา
          </button>
        </EmptyState>
      </section>
    )
  }
  return (
    <section aria-label="ระยะห่างตลิ่งของจุดวัดใกล้บ้าน" className="grid grid-cols-2 gap-3">
      {snapshot.water.map((w) => (
        <GaugeCard key={w.station.id} s={w} snapshot={snapshot} nowMs={nowMs} />
      ))}
    </section>
  )
}

function GaugeCard({ s, snapshot, nowMs }: { s: StationStatus; snapshot: DashboardSnapshot; nowMs: number }) {
  const fb = s.reading?.freeboard
  const hasFb = typeof fb === 'number' && Number.isFinite(fb)
  const usable = hasFb && !s.stale
  const spec = freeboardGauge(usable ? fb : null, snapshot.place.freeboard)
  const segments = spec.segments.map((g) => ({ from: g.from, to: g.to, color: LEVEL_COLOR[g.level] }))
  const short = stationShort(s.station)
  const trend = usable ? trendInfo(s.trendCmPerHour) : null
  const rapid = trend?.dir === 'up' && (s.trendCmPerHour ?? 0) >= snapshot.place.rapidRiseCm
  const age = ageTh(s.reading?.observedAt, nowMs)
  const display = usable ? metresTh(fb) : s.stale ? 'ไม่มีข้อมูล' : 'ไม่มีตลิ่ง'
  const aria = usable
    ? `${s.station.name}: ระยะห่างตลิ่ง ${fb.toFixed(2)} เมตร ระดับ${levelLabel(s.level)}${trend ? ` ${trend.text}` : ''}`
    : `${s.station.name}: ไม่มีข้อมูลล่าสุด`

  return (
    <article className="card flex min-w-0 flex-col items-center px-2 pt-3 pb-3 text-center sm:px-3" title={s.station.name}>
      <Gauge value={usable ? fb : null} min={spec.min} max={spec.max} segments={segments} display={display} ariaLabel={aria} muted={!usable} maxWidth={220}>
        <h3 className="mt-0.5 w-full truncate px-1 text-[0.95rem] font-medium" title={s.station.name}>
          {short}
        </h3>
      </Gauge>
      <div className="mt-1 flex min-h-[1.5rem] flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-xs">
        {usable ? (
          <LevelBadge level={s.level} size={10} className="text-text-2" />
        ) : (
          <span className="text-text-2">{s.stale ? 'ไม่มีข้อมูลล่าสุด' : 'ไม่มีข้อมูลความสูงตลิ่ง'}</span>
        )}
        {trend && (
          <span className={`inline-flex items-center gap-0.5 ${rapid ? 'font-semibold text-text' : 'text-text-2'}`}>
            <TrendArrow dir={trend.dir} />
            {trend.text}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[0.7rem] text-muted">
        {[distanceTh(s.distanceKm), s.reading ? age : 'ยังไม่มีข้อมูล'].filter(Boolean).join(' · ')}
      </p>
      {!usable && s.reading && typeof s.reading.waterLevel === 'number' && !s.stale && (
        <p className="text-[0.7rem] text-muted">น้ำ {s.reading.waterLevel.toFixed(2)} ม.</p>
      )}
      {s.station.bankUncertain && usable && <p className="text-[0.7rem] text-muted">ค่าตลิ่งไม่แน่นอน</p>}
    </article>
  )
}

export function TrendArrow({ dir }: { dir: 'up' | 'down' | 'flat' }) {
  const d = dir === 'up' ? 'M6 10V2M2.5 5.5 6 2l3.5 3.5' : dir === 'down' ? 'M6 2v8M2.5 6.5 6 10l3.5-3.5' : 'M2 6h8M6.5 2.5 10 6 6.5 9.5'
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
