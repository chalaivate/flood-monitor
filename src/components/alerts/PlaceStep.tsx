'use client'

import { useState } from 'react'
import { api, type PublicPlace } from '@/lib/ui/api'
import { coordsTh } from '@/lib/ui/format'
import { DEFAULT_MAX_STATIONS, DEFAULT_RADIUS_KM, manageUrl, readStoredPlace, setPlace, type ResolvedPlace } from '@/lib/ui/place'
import { CopyButton } from '../CopyButton'
import { IconAlert, IconMapPin } from '../icons'
import { LocationPicker, type PlaceDraft } from '../LocationPicker'

function draftFrom(p: ResolvedPlace | PublicPlace | null): PlaceDraft {
  const own = p && (!('origin' in p) || p.origin !== 'default') ? p : null
  return {
    label: own?.label ?? 'บ้าน',
    lat: own?.lat ?? null,
    lng: own?.lng ?? null,
    radiusKm: own?.radiusKm ?? DEFAULT_RADIUS_KM,
    maxStations: own?.maxStations ?? DEFAULT_MAX_STATIONS,
  }
}

/** Step 1: create (POST /api/places) or edit (PATCH) the watched place; shows the manage link. */
export function PlaceStep({
  local,
  server,
  token,
  onChanged,
}: {
  local: ResolvedPlace | null
  server: PublicPlace | null
  token: string | null
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<PlaceDraft>(() => draftFrom(server ?? local))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = draft.lat !== null && draft.lng !== null && draft.label.trim().length > 0

  const create = async () => {
    if (draft.lat === null || draft.lng === null) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.createPlace({
        label: draft.label.trim(),
        lat: draft.lat,
        lng: draft.lng,
        radiusKm: draft.radiusKm,
        maxStations: draft.maxStations,
      })
      setPlace({
        label: r.place.label,
        lat: r.place.lat,
        lng: r.place.lng,
        radiusKm: r.place.radiusKm,
        maxStations: r.place.maxStations,
        placeId: r.place.id,
        manageToken: r.manageToken,
      })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!server || !token || draft.lat === null || draft.lng === null) return
    setBusy(true)
    setError(null)
    try {
      const p = await api.updatePlace(server.id, token, {
        label: draft.label.trim(),
        lat: draft.lat,
        lng: draft.lng,
        radiusKm: draft.radiusKm,
        maxStations: draft.maxStations,
      })
      const stored = readStoredPlace()
      setPlace({ label: p.label, lat: p.lat, lng: p.lng, radiusKm: p.radiusKm, maxStations: p.maxStations, placeId: p.id, manageToken: stored?.manageToken ?? token })
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!server) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-text-2">
          เลือกตำแหน่งบ้านหรือสถานที่ที่ต้องการให้ระบบเฝ้าระวัง ระบบจะติดตามจุดวัดระดับน้ำที่ใกล้ที่สุดในรัศมีที่กำหนด แล้วแจ้งเตือนเมื่อสถานการณ์เปลี่ยน
        </p>
        <LocationPicker value={draft} onChange={setDraft} />
        {error && (
          <p role="alert" className="rounded-xl border border-border bg-card-2 px-3 py-2 text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="fm-btn fm-btn-primary" disabled={!valid || busy} onClick={() => void create()}>
            {busy ? 'กำลังสร้าง…' : 'สร้างจุดเฝ้าระวัง'}
          </button>
          <p className="text-xs text-muted">เมื่อสร้างแล้ว ตำแหน่งนี้จะถูกเก็บบนเซิร์ฟเวอร์เพื่อใช้ส่งการแจ้งเตือน</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {!editing ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-card-2 px-4 py-3">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 text-accent">
              <IconMapPin />
            </span>
            <div className="min-w-0">
              <p className="font-medium">{server.label}</p>
              <p className="text-sm text-text-2">
                {coordsTh(server.lat, server.lng)} · รัศมี {server.radiusKm} กม. · ติดตาม {server.maxStations} จุดวัด
              </p>
            </div>
          </div>
          <button
            type="button"
            className="fm-btn fm-btn-quiet"
            onClick={() => {
              setDraft(draftFrom(server))
              setEditing(true)
            }}
          >
            แก้ไขตำแหน่ง
          </button>
        </div>
      ) : (
        <>
          <LocationPicker value={draft} onChange={setDraft} />
          {error && (
            <p role="alert" className="rounded-xl border border-border bg-card-2 px-3 py-2 text-sm">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className="fm-btn fm-btn-primary" disabled={!valid || busy} onClick={() => void save()}>
              {busy ? 'กำลังบันทึก…' : 'บันทึกตำแหน่ง'}
            </button>
            <button type="button" className="fm-btn fm-btn-quiet" onClick={() => setEditing(false)}>
              ยกเลิก
            </button>
          </div>
        </>
      )}
      {token && <ManageLink placeId={server.id} token={token} />}
    </div>
  )
}

function ManageLink({ placeId, token }: { placeId: string; token: string }) {
  const [shown, setShown] = useState(false)
  const url = typeof window === 'undefined' ? '' : manageUrl(window.location.origin, placeId, token)
  return (
    <div className="rounded-xl border border-border px-4 py-3" style={{ borderLeft: '4px solid var(--lv-watch)' }}>
      <p className="flex items-center gap-2 font-medium">
        <IconAlert size={18} /> เก็บลิงก์จัดการไว้ให้ดี
      </p>
      <p className="mt-1 text-sm text-text-2">
        ลิงก์นี้ใช้แก้ไขหรือยกเลิกการแจ้งเตือนจากอุปกรณ์อื่น และจะแสดงเฉพาะในเบราว์เซอร์นี้ หากล้างข้อมูลเบราว์เซอร์โดยไม่ได้เก็บลิงก์ไว้ จะจัดการจุดนี้ไม่ได้อีก อย่าแชร์ลิงก์นี้ให้ผู้อื่น
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CopyButton getText={() => manageUrl(window.location.origin, placeId, token)} label="คัดลอกลิงก์จัดการ" />
        <button type="button" className="fm-btn fm-btn-quiet" onClick={() => setShown((s) => !s)} aria-expanded={shown}>
          {shown ? 'ซ่อนลิงก์' : 'แสดงลิงก์'}
        </button>
      </div>
      {shown && <p className="mt-2 rounded-lg bg-card-2 px-3 py-2 font-mono text-xs break-all text-text-2">{url}</p>}
    </div>
  )
}
