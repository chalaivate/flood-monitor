'use client'

import type L from 'leaflet'
import { useEffect, useRef, useState } from 'react'
import { Circle, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { haversineKm } from '@/lib/geo'
import type { MapStation } from '@/lib/ui/api'
import { coordsTh } from '@/lib/ui/format'
import { RAINVIEWER_ATTRIBUTION, RAINVIEWER_MAX_NATIVE_ZOOM } from '@/lib/ui/rainviewer'
import { LEVEL_ORDER } from '@/lib/types'
import { BaseTiles, SizeFix, homeMarkerIcon, levelIcon } from './leaflet-bits'
import { StationPopup } from './StationPopup'

export interface StationsMapProps {
  stations: MapStation[]
  center: { lat: number; lng: number }
  home: { lat: number; lng: number; radiusKm: number; label: string } | null
  radarUrl: string | null
  selectedId: string | null
  nowMs: number
  onSetHome: (lat: number, lng: number) => void
}

function PickPoint({ onPick }: { onPick: (p: { lat: number; lng: number }) => void }) {
  useMapEvents({ click: (e) => onPick({ lat: Math.round(e.latlng.lat * 1e6) / 1e6, lng: Math.round(e.latlng.lng * 1e6) / 1e6 }) })
  return null
}

/** Fly to and open the popup of the station chosen in the side list. */
function FocusStation({ id, stations, markers }: { id: string | null; stations: MapStation[]; markers: React.RefObject<Map<string, L.Marker>> }) {
  const map = useMap()
  useEffect(() => {
    if (!id) return
    const s = stations.find((x) => x.id === id)
    if (!s) return
    map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 15), { duration: 0.6 })
    const t = setTimeout(() => markers.current?.get(id)?.openPopup(), 650)
    return () => clearTimeout(t)
  }, [id, stations, map, markers])
  return null
}

/** Full-height station map: level-shaped markers, home + radius, optional rain radar. */
export default function StationsMap({ stations, center, home, radarUrl, selectedId, nowMs, onSetHome }: StationsMapProps) {
  const markers = useRef(new Map<string, L.Marker>())
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null)
  // Draw severe stations last so they sit on top of normal ones.
  const ordered = [...stations].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])

  return (
    <MapContainer center={[center.lat, center.lng]} zoom={13} minZoom={5} maxZoom={18} className="h-full w-full" zoomControl>
      <BaseTiles />
      <SizeFix />
      {radarUrl && (
        <TileLayer
          url={radarUrl}
          opacity={0.6}
          zIndex={10}
          maxNativeZoom={RAINVIEWER_MAX_NATIVE_ZOOM}
          maxZoom={18}
          attribution={RAINVIEWER_ATTRIBUTION}
        />
      )}
      <PickPoint onPick={setPicked} />
      <FocusStation id={selectedId} stations={stations} markers={markers} />
      {home && (
        <>
          <Circle
            center={[home.lat, home.lng]}
            radius={home.radiusKm * 1000}
            pathOptions={{ color: 'var(--accent)', weight: 1.5, fillColor: 'var(--accent)', fillOpacity: 0.06 }}
            interactive={false}
          />
          <Marker position={[home.lat, home.lng]} icon={homeMarkerIcon()} zIndexOffset={1000} title={home.label}>
            <Popup>
              <div className="font-medium">{home.label}</div>
              <div className="text-xs text-muted">รัศมีติดตาม {home.radiusKm} กม.</div>
            </Popup>
          </Marker>
        </>
      )}
      {ordered.map((s) => (
        <Marker
          key={s.id}
          position={[s.lat, s.lng]}
          icon={levelIcon(s.stale ? 'unknown' : s.level, s.kind === 'canal' || s.kind === 'river' ? 16 : 13)}
          title={s.name}
          alt={s.name}
          ref={(m) => {
            if (m) markers.current.set(s.id, m)
            else markers.current.delete(s.id)
          }}
        >
          <Popup>
            <StationPopup s={s} nowMs={nowMs} homeKm={home ? haversineKm(home.lat, home.lng, s.lat, s.lng) : null} />
          </Popup>
        </Marker>
      ))}
      {picked && (
        <Popup position={[picked.lat, picked.lng]} eventHandlers={{ remove: () => setPicked(null) }}>
          <div className="text-sm text-text-2">{coordsTh(picked.lat, picked.lng)}</div>
          <button
            type="button"
            className="fm-btn fm-btn-primary mt-2"
            onClick={() => {
              onSetHome(picked.lat, picked.lng)
              setPicked(null)
            }}
          >
            ตั้งเป็นบ้าน
          </button>
        </Popup>
      )}
    </MapContainer>
  )
}
