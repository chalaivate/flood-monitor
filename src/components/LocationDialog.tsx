'use client'

import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '@/lib/ui/api'
import { closeLocationDialog, useLocationDialog, type LocationDialogRequest } from '@/lib/ui/dialog'
import { DEFAULT_MAX_STATIONS, DEFAULT_RADIUS_KM, readStoredPlace, setPlace, type ResolvedPlace, type StoredPlace } from '@/lib/ui/place'
import { IconClose } from './icons'
import { LocationPicker, type PlaceDraft } from './LocationPicker'

function initialDraft(req: LocationDialogRequest, current: ResolvedPlace | null): PlaceDraft {
  const base = current && current.origin !== 'default' ? current : null
  return {
    label: req.initial?.label ?? base?.label ?? 'บ้าน',
    lat: req.initial?.lat ?? base?.lat ?? null,
    lng: req.initial?.lng ?? base?.lng ?? null,
    radiusKm: req.initial?.radiusKm ?? base?.radiusKm ?? DEFAULT_RADIUS_KM,
    maxStations: req.initial?.maxStations ?? base?.maxStations ?? DEFAULT_MAX_STATIONS,
  }
}

/** Modal "เลือกตำแหน่งบ้าน" rendered once by AppShell; opened via openLocationDialog(). */
export function LocationDialog({ current }: { current: ResolvedPlace | null }) {
  const req = useLocationDialog()
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (req && !d.open) d.showModal()
    if (!req && d.open) d.close()
  }, [req])

  return (
    <dialog
      ref={ref}
      onClose={() => closeLocationDialog()}
      onCancel={() => closeLocationDialog()}
      className="fm-dialog"
      aria-labelledby="loc-dialog-title"
    >
      {req && <DialogBody key={JSON.stringify(req)} req={req} current={current} />}
    </dialog>
  )
}

function DialogBody({ req, current }: { req: LocationDialogRequest; current: ResolvedPlace | null }) {
  const [draft, setDraft] = useState<PlaceDraft>(() => initialDraft(req, current))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSave = draft.lat !== null && draft.lng !== null && draft.label.trim().length > 0

  const save = async (localOnly = false) => {
    if (draft.lat === null || draft.lng === null) return
    const stored = readStoredPlace()
    const next: StoredPlace = {
      label: draft.label.trim() || 'บ้าน',
      lat: draft.lat,
      lng: draft.lng,
      radiusKm: draft.radiusKm,
      maxStations: draft.maxStations,
    }
    if (stored?.placeId && stored.manageToken) {
      next.placeId = stored.placeId
      next.manageToken = stored.manageToken
      if (!localOnly) {
        setSaving(true)
        setError(null)
        try {
          await api.updatePlace(stored.placeId, stored.manageToken, {
            label: next.label,
            lat: next.lat,
            lng: next.lng,
            radiusKm: next.radiusKm,
            maxStations: next.maxStations,
          })
        } catch (e) {
          setSaving(false)
          if (e instanceof ApiError && e.status === 404) {
            // The alert place no longer exists on the server: keep only the local place.
            delete next.placeId
            delete next.manageToken
          } else {
            setError(e instanceof Error ? e.message : String(e))
            return
          }
        }
        setSaving(false)
      }
    }
    setPlace(next)
    closeLocationDialog()
  }

  return (
    <form
      method="dialog"
      className="flex max-h-[inherit] flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) void save()
      }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <h2 id="loc-dialog-title" className="text-lg font-medium">
          {req.title ?? 'ตั้งตำแหน่งที่ต้องการเฝ้าระวัง'}
        </h2>
        <button type="button" className="fm-icon-btn" aria-label="ปิด" onClick={() => closeLocationDialog()}>
          <IconClose />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        <LocationPicker value={draft} onChange={setDraft} />
        {current?.placeId && (
          <p className="mt-3 text-sm text-text-2">
            ตำแหน่งนี้ผูกกับการแจ้งเตือนของคุณ เมื่อบันทึก ระบบจะย้ายจุดแจ้งเตือนมาที่ตำแหน่งใหม่ด้วย
          </p>
        )}
        {error && (
          <div role="alert" className="mt-3 rounded-xl border border-border bg-card-2 px-3 py-2 text-sm">
            <p>ปรับจุดแจ้งเตือนบนเซิร์ฟเวอร์ไม่สำเร็จ: {error}</p>
            <button type="button" className="fm-btn fm-btn-quiet mt-2" onClick={() => void save(true)}>
              บันทึกเฉพาะในเครื่องนี้
            </button>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">ตำแหน่งจะถูกเก็บไว้ในเบราว์เซอร์นี้เท่านั้น จนกว่าคุณจะตั้งค่าการแจ้งเตือน</p>
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
        <button type="button" className="fm-btn fm-btn-quiet" onClick={() => closeLocationDialog()}>
          ยกเลิก
        </button>
        <button type="submit" className="fm-btn fm-btn-primary" disabled={!canSave || saving}>
          {saving ? 'กำลังบันทึก…' : 'บันทึกตำแหน่ง'}
        </button>
      </footer>
    </form>
  )
}
