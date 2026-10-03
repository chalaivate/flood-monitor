'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import type { DashboardSnapshot } from '@/lib/types'
import { useNow } from '@/lib/ui/hooks'
import { PREVIEW_VARIANTS, applyVariant, synthHistory, type PreviewVariant } from '@/lib/ui/preview'
import type { ResolvedPlace } from '@/lib/ui/place'
import { Dashboard } from './Dashboard'

/** Dev-only dashboard rendered from tests/fixtures/snapshot-sample.json (no API needed). */
export function PreviewDashboard({ snapshot, variant }: { snapshot: DashboardSnapshot; variant: PreviewVariant }) {
  const data = useMemo(() => applyVariant(snapshot, variant), [snapshot, variant])
  const history = useMemo(() => synthHistory(data), [data])
  const nowMs = useNow(data.generatedAt)
  const place: ResolvedPlace = useMemo(
    () => ({ origin: 'storage', label: data.place.label, lat: data.place.lat, lng: data.place.lng, radiusKm: data.place.radiusKm, maxStations: data.place.maxStations }),
    [data],
  )

  const toolbar = (
    <nav aria-label="สถานะตัวอย่าง" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">พรีวิว (dev):</span>
      {PREVIEW_VARIANTS.map((v) => (
        <Link key={v.id} href={`/dev/preview?variant=${v.id}`} className={`fm-chip ${v.id === variant ? 'fm-chip-accent' : ''}`} aria-current={v.id === variant ? 'page' : undefined}>
          {v.label}
        </Link>
      ))}
    </nav>
  )

  return (
    <Dashboard
      snapshot={data}
      place={place}
      dataMode="fixture"
      nowMs={nowMs}
      history={{ data: history, error: null }}
      status={{ error: null, updatedAt: Date.parse(data.generatedAt), carriedOver: false }}
      toolbar={toolbar}
    />
  )
}
