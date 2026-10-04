'use client'

import { useEffect, useState } from 'react'
import { Circle, MapContainer, Marker, TileLayer } from 'react-leaflet'
import { bkkTime } from '@/lib/ui/chart'
import { ageTh } from '@/lib/ui/format'
import { loadRadarFrames, RAINVIEWER_ATTRIBUTION, RAINVIEWER_MAX_NATIVE_ZOOM, type RadarFrame } from '@/lib/ui/rainviewer'
import { IconPause, IconPlay, IconRefresh } from '../icons'
import { BaseTiles, Recenter, SizeFix, homeMarkerIcon } from './leaflet-bits'

const FRAME_MS = 650
const HOLD_LAST_MS = 1800

/** Animated RainViewer radar centred on the place (past ~2 h of frames). */
export default function RadarMap({ lat, lng, radiusKm, nowMs }: { lat: number; lng: number; radiusKm: number; nowMs: number }) {
  const [frames, setFrames] = useState<RadarFrame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    loadRadarFrames(ctrl.signal)
      .then((f) => {
        setFrames(f)
        setIdx(f.length - 1)
        setError(null)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => ctrl.abort()
  }, [attempt])

  // Reload the frame list every 10 minutes.
  useEffect(() => {
    const id = setInterval(() => setAttempt((a) => a + 1), 10 * 60_000)
    return () => clearInterval(id)
  }, [])

  const n = frames?.length ?? 0
  useEffect(() => {
    if (!playing || n < 2) return
    const id = setTimeout(() => setIdx((i) => (i + 1) % n), idx === n - 1 ? HOLD_LAST_MS : FRAME_MS)
    return () => clearTimeout(id)
  }, [playing, idx, n])

  const current = frames?.[Math.min(idx, n - 1)]

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
        <MapContainer center={[lat, lng]} zoom={9} minZoom={5} maxZoom={12} scrollWheelZoom={false} className="h-full w-full">
          <BaseTiles />
          <SizeFix />
          <Recenter lat={lat} lng={lng} />
          {frames?.map((f, i) => (
            <TileLayer
              key={f.time}
              url={f.url}
              opacity={i === idx ? 0.78 : 0}
              zIndex={10}
              maxNativeZoom={RAINVIEWER_MAX_NATIVE_ZOOM}
              maxZoom={12}
              attribution={RAINVIEWER_ATTRIBUTION}
            />
          ))}
          <Circle
            center={[lat, lng]}
            radius={radiusKm * 1000}
            pathOptions={{ color: 'var(--accent)', weight: 1.5, fill: false }}
            interactive={false}
          />
          <Marker position={[lat, lng]} icon={homeMarkerIcon()} interactive={false} keyboard={false} />
        </MapContainer>
        {error && (
          <div className="absolute inset-0 z-[500] grid place-items-center bg-card/85 p-4 text-center">
            <div>
              <p className="font-medium">โหลดเรดาร์ฝนไม่ได้ในขณะนี้</p>
              <p className="mt-1 text-sm text-text-2">อาจเกิดจากเครือข่ายหรือผู้ให้บริการเรดาร์ขัดข้อง</p>
              <button type="button" className="fm-btn fm-btn-quiet mt-3" onClick={() => setAttempt((a) => a + 1)}>
                <IconRefresh size={16} /> ลองใหม่
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="fm-icon-btn size-9 shrink-0"
          onClick={() => setPlaying((p) => !p)}
          disabled={n < 2}
          aria-label={playing ? 'หยุดภาพเคลื่อนไหว' : 'เล่นภาพเคลื่อนไหว'}
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, n - 1)}
          value={Math.min(idx, Math.max(0, n - 1))}
          onChange={(e) => {
            setPlaying(false)
            setIdx(Number(e.target.value))
          }}
          className="fm-range min-w-0 flex-1"
          aria-label="เลือกเวลาภาพเรดาร์"
          aria-valuetext={current ? `${bkkTime(current.time)} น.` : undefined}
          disabled={n < 2}
        />
        <span className="tabular w-[8.5rem] shrink-0 text-right text-xs text-text-2" aria-live="off">
          {current ? (
            <>
              <span className="font-medium text-text">{bkkTime(current.time)} น.</span> · {ageTh(new Date(current.time).toISOString(), nowMs)}
            </>
          ) : error ? (
            'ไม่มีภาพ'
          ) : (
            'กำลังโหลด…'
          )}
        </span>
      </div>
    </div>
  )
}
