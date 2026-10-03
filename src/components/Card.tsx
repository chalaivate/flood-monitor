import type { ReactNode } from 'react'

/** Dashboard tile: a titled surface. `action` renders at the right of the title row. */
export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
  bodyClassName = '',
  as: Tag = 'section',
  id,
  labelledBy,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  as?: 'section' | 'div' | 'article'
  id?: string
  labelledBy?: string
}) {
  const headingId = labelledBy ?? (id ? `${id}-title` : undefined)
  return (
    <Tag className={`card min-w-0 ${className}`} id={id} aria-labelledby={title && headingId ? headingId : undefined}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
          <div className="min-w-0">
            {title && (
              <h2 id={headingId} className="text-[1.3rem] leading-snug font-medium text-text sm:text-[1.45rem]">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-sm text-text-2">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
        </header>
      )}
      <div className={`px-4 pt-3 pb-4 sm:px-5 sm:pb-5 ${bodyClassName}`}>{children}</div>
    </Tag>
  )
}

/** Quiet empty / unavailable state inside a card. */
export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-medium text-text">{title}</p>
      {children && <div className="text-sm text-text-2">{children}</div>}
    </div>
  )
}
