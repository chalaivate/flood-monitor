'use client'

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, ApiError, type PublicChannel, type PublicPlace } from '@/lib/ui/api'
import { usePolled } from '@/lib/ui/hooks'
import { isPlaceId, parseHashToken, setPlace, updateStoredPlace, usePlace } from '@/lib/ui/place'
import { usePublicConfig } from '@/lib/ui/public-config'
import { Banner } from '../Banner'
import { ChannelsStep } from './ChannelsStep'
import { EventsList } from './EventsList'
import { PlaceStep } from './PlaceStep'
import { ThresholdStep } from './ThresholdStep'

interface Claim {
  placeId: string
  token: string
}

/** "/alerts?place=<id>#token=<t>" — a manage link opened on this device. */
function readClaim(): string {
  const token = parseHashToken(window.location.hash)
  const id = new URLSearchParams(window.location.search).get('place')
  return token && isPlaceId(id) ? `${id}\u0000${token}` : ''
}

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

function readConfirmed(): boolean {
  return new URLSearchParams(window.location.search).get('confirmed') === '1'
}

/** Step-by-step alert setup: place → thresholds → channels → history. */
export function AlertsSetup() {
  const { place } = usePlace()
  const cfg = usePublicConfig()
  const claimRaw = useSyncExternalStore(subscribeHash, readClaim, () => '')
  const confirmed = useSyncExternalStore(subscribeHash, readConfirmed, () => false)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // Adopt a manage link: verify the token, store {placeId, manageToken}, scrub the URL.
  useEffect(() => {
    if (!claimRaw) return
    const [placeId, token] = claimRaw.split('\u0000') as [string, string]
    const claim: Claim = { placeId, token }
    let cancelled = false
    api
      .getPlace(claim.placeId, claim.token)
      .then(({ place: p }) => {
        if (cancelled) return
        setPlace({ label: p.label, lat: p.lat, lng: p.lng, radiusKm: p.radiusKm, maxStations: p.maxStations, placeId: p.id, manageToken: claim.token })
        window.history.replaceState(null, '', window.location.pathname)
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setClaimError(e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404) ? 'ลิงก์จัดการไม่ถูกต้อง หรือจุดเฝ้าระวังนี้ถูกลบไปแล้ว' : e instanceof Error ? e.message : String(e))
        window.history.replaceState(null, '', window.location.pathname)
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
    return () => {
      cancelled = true
    }
  }, [claimRaw])

  const placeId = place?.placeId ?? null
  const token = place?.manageToken ?? null
  const key = placeId && token && !claimRaw ? `place:${placeId}:${nonce}` : null

  const detail = usePolled<{ place: PublicPlace; channels: PublicChannel[] }>(
    key,
    async () => {
      const r = await api.getPlace(placeId!, token!)
      const channels = r.channels ?? (await api.listChannels(placeId!, token!))
      return { place: r.place, channels }
    },
    15_000,
  )
  // Poll the channel list every 4 s while a LINE / Telegram / e-mail link waits for confirmation.
  const pending = detail.data?.channels.some((c) => !c.verified) ?? false
  const fast = usePolled<PublicChannel[]>(pending && key ? `${key}:pending` : null, () => api.listChannels(placeId!, token!), 4_000)
  const channels = (pending && fast.data) || detail.data?.channels || []
  const events = usePolled(key ? `${key}:events` : null, () => api.events(placeId!, token!, 50), 60_000)

  const gone = detail.errorStatus === 401 || detail.errorStatus === 403 || detail.errorStatus === 404
  const server = gone ? null : (detail.data?.place ?? null)
  const refresh = () => setNonce((n) => n + 1)

  const forget = () => {
    updateStoredPlace({ placeId: undefined, manageToken: undefined })
    refresh()
  }

  const remove = async () => {
    if (!placeId || !token) return
    if (!window.confirm('ลบจุดเฝ้าระวังนี้และยกเลิกการแจ้งเตือนทุกช่องทางหรือไม่ การลบไม่สามารถย้อนกลับได้')) return
    try {
      await api.deletePlace(placeId, token)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        window.alert(e instanceof Error ? e.message : String(e))
        return
      }
    }
    forget()
  }

  const loadingServer = !!key && !detail.data && !detail.error

  return (
    <main className="mx-auto w-full max-w-[960px] px-3 pt-4 pb-16 sm:px-4">
      <h1 className="text-2xl font-medium">ตั้งค่าการแจ้งเตือน</h1>
      <p className="mt-1 text-text-2">รับข้อความเมื่อระดับน้ำใกล้ตลิ่ง ฝนตกหนัก หรือมีน้ำท่วมถนนใกล้บ้าน ทำตามขั้นตอนด้านล่าง</p>

      <div className="mt-4 flex flex-col gap-2">
        {cfg.config?.dataMode === 'fixture' && (
          <Banner tone="demo" title="ระบบอยู่ในโหมดสาธิต">
            ข้อความแจ้งเตือนที่ได้รับจะมาจากข้อมูลจำลอง ไม่ใช่สถานการณ์จริง
          </Banner>
        )}
        {confirmed && (
          <Banner tone="normal" title="ยืนยันอีเมลเรียบร้อยแล้ว" role="status">
            ระบบจะส่งการแจ้งเตือนไปยังอีเมลนี้เมื่อสถานการณ์เปลี่ยน
          </Banner>
        )}
        {claimRaw && !claimError && <Banner title="กำลังตรวจสอบลิงก์จัดการ…" />}
        {claimError && (
          <Banner tone="warning" title="ใช้ลิงก์จัดการไม่ได้" role="alert">
            {claimError}
          </Banner>
        )}
        {gone && (
          <Banner
            tone="warning"
            title="ไม่พบจุดเฝ้าระวังที่บันทึกไว้"
            role="alert"
            action={
              <button type="button" className="fm-btn fm-btn-quiet" onClick={forget}>
                เริ่มตั้งค่าใหม่
              </button>
            }
          >
            จุดนี้อาจถูกลบไปแล้ว หรือรหัสจัดการในเบราว์เซอร์นี้ไม่ถูกต้อง
          </Banner>
        )}
        {detail.error && !gone && (
          <Banner tone="watch" title="เชื่อมต่อเซิร์ฟเวอร์ไม่ได้" role="alert">
            {detail.error}
          </Banner>
        )}
      </div>

      <Step n={1} title="ตำแหน่งที่ต้องการเฝ้าระวัง" done={!!server}>
        {loadingServer ? (
          <p className="text-sm text-muted">กำลังโหลด…</p>
        ) : (
          <PlaceStep
            // Remount when the local place resolves after hydration so the form is prefilled with it.
            key={server ? `s:${server.id}` : `new:${place ? `${place.origin}:${place.lat}:${place.lng}` : 'pending'}`}
            local={place}
            server={server}
            token={server ? token : null}
            onChanged={refresh}
          />
        )}
      </Step>

      <Step n={2} title="เกณฑ์และระดับที่ต้องการรับแจ้งเตือน" done={false} disabled={!server}>
        {server && token ? (
          <ThresholdStep key={server.id} server={server} token={token} onChanged={refresh} />
        ) : (
          <p className="text-sm text-muted">สร้างจุดเฝ้าระวังในขั้นที่ 1 ก่อน</p>
        )}
      </Step>

      <Step n={3} title="ช่องทางรับการแจ้งเตือน" done={channels.some((c) => c.verified)} disabled={!server}>
        {server && token ? (
          <ChannelsStep placeId={server.id} token={token} config={cfg.config} channels={channels} onChanged={refresh} />
        ) : (
          <p className="text-sm text-muted">สร้างจุดเฝ้าระวังในขั้นที่ 1 ก่อน</p>
        )}
      </Step>

      {server && token && (
        <>
          <Step title="ประวัติการแจ้งเตือน">
            <EventsList events={events.data} error={events.error} />
          </Step>
          <section className="mt-6 rounded-xl border border-border px-4 py-4">
            <h2 className="font-medium">ยกเลิกการแจ้งเตือน</h2>
            <p className="mt-1 text-sm text-text-2">ลบจุดเฝ้าระวังนี้ออกจากเซิร์ฟเวอร์ พร้อมช่องทางแจ้งเตือนและประวัติทั้งหมด ตำแหน่งบ้านในเครื่องนี้ยังคงอยู่</p>
            <button type="button" className="fm-btn fm-btn-danger mt-3" onClick={() => void remove()}>
              ลบจุดเฝ้าระวังและการแจ้งเตือนทั้งหมด
            </button>
          </section>
        </>
      )}
    </main>
  )
}

function Step({ n, title, children, done, disabled }: { n?: number; title: string; children: ReactNode; done?: boolean; disabled?: boolean }) {
  return (
    <section className={`card mt-4 ${disabled ? 'opacity-60' : ''}`} aria-labelledby={`step-${n ?? title}`}>
      <header className="flex items-center gap-3 px-4 pt-4 sm:px-5">
        {n !== undefined && (
          <span
            className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? 'bg-accent-fill text-white' : 'border border-border text-text-2'}`}
            aria-hidden="true"
          >
            {done ? '✓' : n}
          </span>
        )}
        <h2 id={`step-${n ?? title}`} className="text-lg font-medium">
          {n !== undefined && <span className="sr-only">ขั้นที่ {n}: </span>}
          {title}
          {done && <span className="sr-only"> (เสร็จแล้ว)</span>}
        </h2>
      </header>
      <div className="px-4 pt-3 pb-5 sm:px-5">{children}</div>
    </section>
  )
}
