'use client'

import type { LeafletEventHandlerFnMap, Path } from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Tooltip, useMapEvents } from 'react-leaflet'
import type { MapStation } from '@/lib/ui/api'
import { BaseTiles, Recenter, SizeFix, homeMarkerIcon } from './leaflet-bits'

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6)
    },
  })
  return null
}

/**
 * Station dots are context only (named on hover; the legend under the map explains them).
 * Leaflet adds focus listeners to a layer with a tooltip, which makes Chromium put every
 * SVG dot in the tab order as an unnamed stop ahead of the form, so take them out of the
 * tab order and the accessibility tree once they are on the map.
 */
const DECORATIVE_DOT: LeafletEventHandlerFnMap = {
  add: (e) => {
    const el = (e.target as Path).getElement()
    el?.setAttribute('tabindex', '-1')
    el?.setAttribute('aria-hidden', 'true')
    el?.setAttribute('focusable', 'false')
  },
}

/** Small map for choosing a point: click to move the pin, radius circle, nearby gauges in grey. */
export default function PickerMap({
  lat,
  lng,
  radiusKm,
  stations,
  hasPoint = true,
  onPick,
}: {
  lat: number
  lng: number
  radiusKm: number
  stations: MapStation[]
  /** false until the user chose a point (the map is then only centred on the default). */
  hasPoint?: boolean
  onPick: (lat: number, lng: number) => void
}) {
  const water = stations.filter((s) => s.kind === 'canal' || s.kind === 'river')
  return (
    <MapContainer center={[lat, lng]} zoom={13} scrollWheelZoom className="h-full w-full" attributionControl>
      <BaseTiles />
      <SizeFix />
      <Recenter lat={lat} lng={lng} onlyIfOutside />
      <ClickToPick onPick={onPick} />
      {hasPoint && (
        <Circle
          center={[lat, lng]}
          radius={radiusKm * 1000}
          pathOptions={{ color: 'var(--accent)', weight: 1.5, fillColor: 'var(--accent)', fillOpacity: 0.08 }}
          interactive={false}
        />
      )}
      {water.map((s) => (
        <CircleMarker
          key={s.id}
          center={[s.lat, s.lng]}
          radius={4}
          pathOptions={{ color: 'var(--card)', weight: 1.5, fillColor: 'var(--text-2)', fillOpacity: 1 }}
          eventHandlers={DECORATIVE_DOT}
        >
          <Tooltip direction="top" offset={[0, -4]}>
            {s.name}
          </Tooltip>
        </CircleMarker>
      ))}
      {hasPoint && <Marker position={[lat, lng]} icon={homeMarkerIcon()} interactive={false} keyboard={false} />}
    </MapContainer>
  )
}
