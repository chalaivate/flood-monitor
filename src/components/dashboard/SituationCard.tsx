import type { DashboardSnapshot } from '@/lib/types'
import { formatShortBkk } from '@/lib/time'
import { LEVEL_COLOR, levelLabel } from '@/lib/ui/levels'
import { Card } from '../Card'
import { LevelDot } from '../LevelBadge'

/** "สถานการณ์ตอนนี้": overall level, headline and one bullet per tracked station. */
export function SituationCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { overall } = snapshot
  const checked = snapshot.lastIngestAt ?? snapshot.generatedAt
  const headline = overall.headline.includes('—') ? overall.headline.split('—').slice(1).join('—').trim() : null

  return (
    <Card title="สถานการณ์ตอนนี้" id="situation">
      <div className="flex items-center gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-full"
          style={{ background: `color-mix(in srgb, ${LEVEL_COLOR[overall.level]} 18%, transparent)` }}
        >
          <LevelDot level={overall.level} size={24} decorative />
        </span>
        <div className="min-w-0">
          <p className="text-[1.6rem] leading-tight font-semibold">{levelLabel(overall.level)}</p>
          {overall.level === 'unknown' || !headline ? (
            overall.level !== 'normal' && <p className="text-sm text-text-2">{overall.headline}</p>
          ) : (
            <p className="text-sm text-text-2">{headline}</p>
          )}
        </div>
      </div>

      {overall.lines.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2.5">
          {overall.lines.map((l, i) => (
            <li key={l.stationId ?? i} className="flex gap-2 leading-relaxed">
              <span className="mt-[0.42em] shrink-0">
                <LevelDot level={l.level} size={12} decorative />
              </span>
              <p className="min-w-0 text-[0.95rem] text-text">
                <span className="font-medium">{levelLabel(l.level)}</span> <span className="text-text-2">{l.text}</span>
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-muted">
        ตรวจล่าสุด {formatShortBkk(checked)} น. · อัปเดตทุก {snapshot.pollMinutes} นาที
      </p>
    </Card>
  )
}
