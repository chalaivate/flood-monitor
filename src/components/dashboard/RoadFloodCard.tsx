import type { StationStatus } from '@/lib/types'
import { distanceTh } from '@/lib/engine/format'
import { ageTh } from '@/lib/ui/format'
import { levelLabel } from '@/lib/ui/levels'
import { Card } from '../Card'
import { LevelDot } from '../LevelBadge'

/** Road flood sensors near home (rendered only when the snapshot has some). */
export function RoadFloodCard({ items, nowMs }: { items: StationStatus[]; nowMs: number }) {
  if (items.length === 0) return null
  return (
    <Card title="น้ำท่วมถนนใกล้บ้าน">
      <ul className="divide-y divide-border">
        {items.map((f) => {
          const cm = f.reading?.roadFloodCm
          const wet = !f.stale && typeof cm === 'number' && cm > 0
          return (
            <li key={f.station.id} className="flex items-center gap-3 py-2.5">
              <LevelDot level={f.stale ? 'unknown' : f.level} size={12} />
              <div className="min-w-0 flex-1">
                <p className="truncate" title={f.station.name}>
                  {f.station.name}
                </p>
                <p className="text-xs text-muted">
                  {distanceTh(f.distanceKm)} · {f.stale ? 'ไม่มีข้อมูลล่าสุด' : ageTh(f.reading?.observedAt, nowMs)}
                </p>
              </div>
              <div className="text-right">
                <p className="tabular font-medium">{f.stale || typeof cm !== 'number' ? '-' : `${Math.round(cm)} ซม.`}</p>
                <p className="text-xs text-text-2">{f.stale ? levelLabel('unknown') : wet ? levelLabel(f.level) : 'ถนนแห้ง'}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
