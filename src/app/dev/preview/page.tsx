import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { DashboardSnapshot } from '@/lib/types'
import { isPreviewVariant, rebaseSnapshot } from '@/lib/ui/preview'
import { PreviewDashboard } from '@/components/dashboard/PreviewDashboard'
import sample from '../../../../tests/fixtures/snapshot-sample.json'

export const metadata: Metadata = { title: 'พรีวิวแดชบอร์ด', robots: { index: false } }

/** Request time snapped to the minute so the server render and hydration agree. */
function requestMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000
}

/** Dev-only visual check of the dashboard with fixture data. 404 in production builds. */
export default async function PreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const q = await searchParams
  const v = typeof q.variant === 'string' && isPreviewVariant(q.variant) ? q.variant : 'normal'
  const snapshot = rebaseSnapshot(sample as unknown as DashboardSnapshot, requestMinute())
  return <PreviewDashboard snapshot={snapshot} variant={v} />
}
