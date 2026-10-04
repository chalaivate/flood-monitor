import type { DashboardSnapshot } from '@/lib/types'
import { distanceTh } from '@/lib/engine/format'
import { rainClassTh } from '@/lib/engine/status'
import { rainGauge } from '@/lib/ui/gauge'
import { farDistanceTh, rainCoverage, type Coverage } from '@/lib/ui/coverage'
import { LEVEL_COLOR, levelLabel } from '@/lib/ui/levels'
import { Gauge } from '../Gauge'
import { LevelBadge } from '../LevelBadge'

/** "ฝนสะสม 24 ชม. รอบบ้าน": highest 24 h total among the nearest rain gauges. */
export function RainGaugeCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const r = snapshot.rainMax24h
  const spec = rainGauge(r?.valueMm ?? null, snapshot.place.rain)
  const segments = spec.segments.map((g) => ({ from: g.from, to: g.to, color: LEVEL_COLOR[g.level] }))
  const display = r ? `${r.valueMm.toFixed(1)} มม.` : 'ไม่มีข้อมูล'
  const n = snapshot.rain.filter((s) => !s.stale).length

  return (
    <section className="card flex flex-col items-center px-4 pt-4 pb-4 text-center" aria-labelledby="rain-title">
      <Gauge
        value={r?.valueMm ?? null}
        min={spec.min}
        max={spec.max}
        segments={segments}
        display={display}
        muted={!r}
        maxWidth={300}
        ariaLabel={r ? `ฝนสะสม 24 ชั่วโมง ${r.valueMm.toFixed(1)} มิลลิเมตร ${rainClassTh(r.valueMm)} ระดับ${levelLabel(r.level)}` : 'ไม่มีข้อมูลฝนสะสม'}
      >
        <h2 id="rain-title" className="mt-1 text-[1.05rem] font-medium">
          ฝนสะสม 24 ชม. รอบบ้าน
        </h2>
      </Gauge>
      {r ? (
        <>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 text-sm text-text-2">
            <LevelBadge level={r.level} size={11} />
            <span>· {rainClassTh(r.valueMm)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            สูงสุดจาก {n} สถานีใกล้บ้าน: {r.station.name} ({distanceTh(r.distanceKm)})
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-text-2">{noRainTh(rainCoverage(snapshot))}</p>
      )}
      <p className="mt-2 text-[0.7rem] text-muted">
        เกณฑ์กรมอุตุนิยมวิทยา: ฝนหนัก ≥ {snapshot.place.rain.watch} มม. · หนักมาก ≥ {snapshot.place.rain.warning} มม.
      </p>
    </section>
  )
}

/** Why there is no rain figure: nearby gauges without data, out of coverage, or an outage. */
function noRainTh(c: Coverage): string {
  switch (c.kind) {
    case 'outside':
      return `สถานีวัดฝนที่ใกล้ที่สุดอยู่ห่าง ${farDistanceTh(c.nearestKm)} — อยู่นอกพื้นที่ครอบคลุม`
    case 'expand':
      return `ไม่มีสถานีวัดฝนในระยะค้นหา สถานีที่ใกล้ที่สุดอยู่ห่าง ${farDistanceTh(c.nearestKm)}`
    case 'no-data':
      return 'ขณะนี้ยังไม่มีข้อมูลฝนล่าสุดจากสถานีวัดฝน'
    default:
      return 'ไม่พบสถานีวัดฝนที่มีข้อมูลล่าสุดใกล้บ้าน'
  }
}
