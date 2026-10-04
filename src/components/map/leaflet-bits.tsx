'use client'

// Shared Leaflet pieces. Import ONLY from modules loaded with next/dynamic { ssr: false }
// (Leaflet touches `window` at import time).

import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useEffect } from 'react'
import { TileLayer, useMap } from 'react-leaflet'
import type { Level } from '@/lib/types'
import { levelShapeSvg } from '@/components/LevelBadge'
import { cameraMarkerSvg } from '@/components/cctv/CameraGlyph'

export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'

/** OSM base map. Dark theme inverts it with CSS (class fm-basemap) so it matches the UI. */
export function BaseTiles() {
  return (
    <TileLayer
      url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      attribution={OSM_ATTRIBUTION}
      maxZoom={19}
      className="fm-basemap"
    />
  )
}

/**
 * Keep the map centred on a point when it changes (MapContainer only reads `center` once).
 * With `onlyIfOutside` the map pans only when the point left the visible area, so a
 * click-to-pick does not make the map jump.
 */
export function Recenter({ lat, lng, zoom, onlyIfOutside = false }: { lat: number; lng: number; zoom?: number; onlyIfOutside?: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (onlyIfOutside && map.getBounds().pad(-0.1).contains([lat, lng])) return
    map.setView([lat, lng], zoom ?? map.getZoom(), { animate: true })
  }, [map, lat, lng, zoom, onlyIfOutside])
  return null
}

/** Invalidate size after the container becomes visible (dialogs, tabs). */
export function SizeFix() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

const iconCache = new Map<string, L.DivIcon>()

/** Level-shaped marker (circle / triangle / diamond / square / hollow circle). */
export function levelIcon(level: Level, size = 14): L.DivIcon {
  const key = `${level}:${size}`
  let icon = iconCache.get(key)
  if (!icon) {
    icon = L.divIcon({
      className: 'fm-level-icon',
      html: levelShapeSvg(level, size),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    })
    iconCache.set(key, icon)
  }
  return icon
}

let camIcon: L.DivIcon | null = null

/**
 * Camera site marker: neutral badge drawn up and to the right of its point, so the road-flood
 * sensor it usually shares a pole with stays visible underneath.
 */
export function cameraIcon(): L.DivIcon {
  if (!camIcon) {
    camIcon = L.divIcon({
      className: 'fm-cam-icon',
      html: cameraMarkerSvg(22),
      iconSize: [22, 22],
      iconAnchor: [-3, 25],
      popupAnchor: [14, -25],
    })
  }
  return camIcon
}

let homeIcon: L.DivIcon | null = null

/** "บ้าน" marker: accent pin with a ring in the surface colour. */
export function homeMarkerIcon(): L.DivIcon {
  if (!homeIcon) {
    homeIcon = L.divIcon({
      className: 'fm-home-icon',
      html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 36" width="28" height="36" aria-hidden="true"><path d="M14 35s11-10.2 11-19A11 11 0 0 0 3 16c0 8.8 11 19 11 19Z" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/><circle cx="14" cy="15.5" r="4.2" fill="var(--card)"/></svg>`,
      iconSize: [28, 36],
      iconAnchor: [14, 35],
      popupAnchor: [0, -32],
    })
  }
  return homeIcon
}

/** Resolve a CSS custom property to a concrete colour (Leaflet path styles). */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}
