import type { ReactNode } from 'react'
import type { Level } from '@/lib/types'
import { LEVEL_COLOR } from '@/lib/ui/levels'
import { IconAlert, IconInfo } from './icons'

/** Full-width notice above the dashboard. `tone` picks the accent stripe (never colour alone: icon + text). */
export function Banner({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: 'info' | 'demo' | Level
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  role?: 'status' | 'alert'
}) {
  const stripe = tone === 'info' ? 'var(--accent)' : tone === 'demo' ? 'var(--lv-watch)' : LEVEL_COLOR[tone]
  const Icon = tone === 'info' ? IconInfo : IconAlert
  return (
    <div
      role={role}
      className="card flex flex-col gap-3 border-l-4 px-4 py-3 sm:flex-row sm:items-center"
      style={{ borderLeftColor: stripe }}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 shrink-0 text-text-2">
          <Icon size={20} />
        </span>
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {children && <div className="mt-0.5 text-sm text-text-2">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">{action}</div>}
    </div>
  )
}
