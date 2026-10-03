'use client'

import { usePlace } from '@/lib/ui/place'
import { usePublicConfig } from '@/lib/ui/public-config'
import { useHistory, useSnapshot } from '@/lib/ui/snapshot'
import { useNow } from '@/lib/ui/hooks'
import { Dashboard } from './Dashboard'

/** Live dashboard for the current place (URL › localStorage › default). */
export function HomeDashboard() {
  const { place, ready } = usePlace()
  const cfg = usePublicConfig()
  const snap = useSnapshot(place, ready)
  const ids = (snap.data?.water ?? []).slice(0, 6).map((w) => w.station.id)
  const hist = useHistory(ids, 48)
  const nowMs = useNow(snap.data?.generatedAt ?? null)

  return (
    <Dashboard
      snapshot={snap.data}
      place={place}
      dataMode={cfg.config?.dataMode ?? null}
      nowMs={nowMs}
      history={{ data: hist.data, error: hist.error }}
      status={{ error: snap.error, updatedAt: snap.updatedAt, carriedOver: snap.carriedOver }}
      onRetry={snap.refresh}
    />
  )
}
