'use client'

import dynamic from 'next/dynamic'
import { useId, useState } from 'react'
import { isInThailand, parseLatLng } from '@/lib/geo'
import { distanceTh } from '@/lib/engine/format'
import { coordsTh } from '@/lib/ui/format'
import { FALLBACK_PLACE, RADIUS_MAX_KM, RADIUS_MIN_KM, STATIONS_MAX, STATIONS_MIN } from '@/lib/ui/place'
import { usePublicConfig } from '@/lib/ui/public-config'
import { nearestWaterKm, suggestRadiusKm, useStations, waterStationsWithin } from '@/lib/ui/stations'
import { IconCrosshair, IconMapPin } from './icons'

const PickerMap = dynamic(() => import('./map/PickerMap'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">กำลังโหลดแผนที่…</div>,
})

export interface PlaceDraft {
  label: string
  lat: number | null
  lng: number | null
  radiusKm: number
  maxStations: number
}

type GeoState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

/**
 * Location form shared by the dashboard dialog and /alerts: map click, current
 * position, pasted coordinates / Google Maps / OSM link, label, radius and station count.
 */
export function LocationPicker({ value, onChange, mapHeight = 280 }: { value: PlaceDraft; onChange: (d: PlaceDraft) => void; mapHeight?: number }) {
  const uid = useId()
  const cfg = usePublicConfig()
  const stations = useStations()
  const [paste, setPaste] = useState('')
  const [pasteMsg, setPasteMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [geo, setGeo] = useState<GeoState>({ kind: 'idle' })

  const def = cfg.config?.defaultPlace ?? FALLBACK_PLACE
  const lat = value.lat ?? def.lat
  const lng = value.lng ?? def.lng
  const hasPoint = value.lat !== null && value.lng !== null
  const all = stations.data?.stations ?? []
  const within = hasPoint ? waterStationsWithin(all, lat, lng, value.radiusKm) : []
  const nearestKm = hasPoint ? nearestWaterKm(all, lat, lng) : null
  const suggestion = hasPoint && within.length === 0 ? suggestRadiusKm(all, lat, lng, RADIUS_MAX_KM) : null

  const set = (patch: Partial<PlaceDraft>) => onChange({ ...value, ...patch })

  const usePosition = () => {
    if (!('geolocation' in navigator)) {
      setGeo({ kind: 'error', message: 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง' })
      return
    }
    setGeo({ kind: 'busy' })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ kind: 'idle' })
        set({ lat: Math.round(pos.coords.latitude * 1e6) / 1e6, lng: Math.round(pos.coords.longitude * 1e6) / 1e6 })
      },
      (err) => {
        setGeo({
          kind: 'error',
          message:
            err.code === err.PERMISSION_DENIED
              ? 'ไม่ได้รับอนุญาตให้เข้าถึงตำแหน่ง กรุณาเปิดสิทธิ์ตำแหน่งในการตั้งค่าเบราว์เซอร์แล้วลองใหม่'
              : 'ระบุตำแหน่งไม่สำเร็จ ลองใหม่อีกครั้งหรือแตะบนแผนที่แทน',
        })
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  const applyPaste = (text: string) => {
    setPaste(text)
    const s = text.trim()
    if (!s) {
      setPasteMsg(null)
      return
    }
    const p = parseLatLng(s)
    if (p) {
      set({ lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 })
      setPasteMsg(
        isInThailand(p.lat, p.lng)
          ? { ok: true, text: `ใช้พิกัด ${coordsTh(p.lat, p.lng)} แล้ว` }
          : { ok: false, text: 'พิกัดนี้อยู่นอกประเทศไทย ระบบมีข้อมูลเฉพาะในประเทศไทย' },
      )
    } else if (/goo\.gl|maps\.app/i.test(s)) {
      setPasteMsg({ ok: false, text: 'ลิงก์แบบย่อใช้ไม่ได้ กรุณาเปิดลิงก์ในเบราว์เซอร์ แล้วคัดลอกที่อยู่เต็มหรือพิกัดมาวางแทน' })
    } else {
      setPasteMsg({ ok: false, text: 'อ่านพิกัดไม่ได้ ตัวอย่างที่ใช้ได้: 13.7246, 100.6938 หรือลิงก์ Google Maps ที่มี @ละติจูด,ลองจิจูด' })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor={`${uid}-label`} className="mb-1 block text-sm font-medium text-text-2">
          ชื่อสถานที่
        </label>
        <input
          id={`${uid}-label`}
          type="text"
          value={value.label}
          maxLength={80}
          placeholder="เช่น บ้าน ประเวศ"
          onChange={(e) => set({ label: e.target.value })}
          className="fm-input w-full"
          autoComplete="off"
        />
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-2">แตะบนแผนที่เพื่อเลือกตำแหน่ง</span>
          <button type="button" onClick={usePosition} className="fm-btn fm-btn-quiet" disabled={geo.kind === 'busy'}>
            <IconCrosshair size={18} />
            {geo.kind === 'busy' ? 'กำลังหาตำแหน่ง…' : 'ใช้ตำแหน่งปัจจุบัน'}
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-border" style={{ height: mapHeight }}>
          <PickerMap lat={lat} lng={lng} radiusKm={value.radiusKm} stations={all} onPick={(la, ln) => set({ lat: la, lng: ln })} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <IconMapPin size={14} />
            {hasPoint ? coordsTh(lat, lng) : 'ยังไม่ได้เลือกตำแหน่ง'}
          </span>
          <span className="inline-flex items-center gap-1">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <circle cx="5" cy="5" r="4" fill="var(--text-2)" stroke="var(--card)" strokeWidth="1.5" />
            </svg>
            จุดวัดระดับน้ำ
          </span>
        </div>
        {geo.kind === 'error' && (
          <p role="alert" className="mt-1.5 text-sm text-text">
            {geo.message}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={`${uid}-paste`} className="mb-1 block text-sm font-medium text-text-2">
          หรือวางพิกัด / ลิงก์ Google Maps / OpenStreetMap
        </label>
        <input
          id={`${uid}-paste`}
          type="text"
          inputMode="url"
          value={paste}
          onChange={(e) => applyPaste(e.target.value)}
          placeholder="13.7246, 100.6938"
          className="fm-input w-full"
          autoComplete="off"
          aria-describedby={pasteMsg ? `${uid}-paste-msg` : undefined}
        />
        {pasteMsg && (
          <p id={`${uid}-paste-msg`} className={`mt-1 text-sm ${pasteMsg.ok ? 'text-text-2' : 'text-text'}`} role={pasteMsg.ok ? 'status' : 'alert'}>
            {pasteMsg.text}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-radius`} className="mb-1 flex items-baseline justify-between text-sm font-medium text-text-2">
            <span>รัศมีค้นหาจุดวัด</span>
            <span className="tabular text-base text-text">{value.radiusKm.toLocaleString('th-TH', { maximumFractionDigits: 1 })} กม.</span>
          </label>
          <input
            id={`${uid}-radius`}
            type="range"
            min={RADIUS_MIN_KM}
            max={RADIUS_MAX_KM}
            step={0.5}
            value={value.radiusKm}
            onChange={(e) => set({ radiusKm: Number(e.target.value) })}
            className="fm-range w-full"
          />
          <div className="flex justify-between text-xs text-muted">
            <span>{RADIUS_MIN_KM} กม.</span>
            <span>{RADIUS_MAX_KM} กม.</span>
          </div>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-text-2">จำนวนจุดวัดที่ติดตาม</legend>
          <div className="flex flex-wrap gap-1" role="radiogroup">
            {Array.from({ length: STATIONS_MAX - STATIONS_MIN + 1 }, (_, i) => i + STATIONS_MIN).map((n) => (
              <label key={n} className="fm-seg">
                <input type="radio" name={`${uid}-n`} value={n} checked={value.maxStations === n} onChange={() => set({ maxStations: n })} />
                <span className="tabular">{n}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {hasPoint && stations.data && (
        <div className="rounded-xl bg-card-2 px-3 py-2 text-sm text-text-2" role="status">
          {within.length > 0 ? (
            <>
              พบจุดวัดระดับน้ำ <b className="text-text">{within.length}</b> จุดในรัศมี
              {within.length > value.maxStations ? ` · แดชบอร์ดจะแสดง ${value.maxStations} จุดที่ใกล้ที่สุด` : ''}
              {within[0] ? ` · ใกล้สุด ${within[0].name} (${distanceTh(within[0].distanceKm)})` : ''}
            </>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span>
                ไม่พบจุดวัดระดับน้ำในรัศมีนี้
                {nearestKm !== null ? ` · จุดที่ใกล้ที่สุดห่าง ${distanceTh(nearestKm)}` : ''}
              </span>
              {suggestion !== null && (
                <button type="button" className="fm-btn fm-btn-quiet" onClick={() => set({ radiusKm: suggestion })}>
                  ขยายรัศมีเป็น {suggestion} กม.
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
