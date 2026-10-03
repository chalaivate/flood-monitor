'use client'

import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ChannelType } from '@/lib/types'
import { formatShortBkk } from '@/lib/time'
import { api, CHANNEL_LABEL_TH, type ChannelLink, type PublicChannel, type PublicConfig, type TestResponse } from '@/lib/ui/api'
import { linkCodeExpired, pickerChannels } from '@/lib/ui/channels'
import { bkkTime } from '@/lib/ui/chart'
import { useNow } from '@/lib/ui/hooks'
import { NEEDS_HTTPS_TH, pushSupport, randomTopic, subscribePush, type PushSupport } from '@/lib/ui/push'
import { CopyButton } from '../CopyButton'
import { IconBell, IconCheck, IconSend, IconTrash } from '../icons'

interface Props {
  placeId: string
  token: string
  config: PublicConfig | null
  channels: PublicChannel[]
  onChanged: () => void
}

const subscribeNoop = () => () => {}

/** Link instructions from POST /channels plus the expiry of the code they carry. */
type LinkState = ChannelLink & { expiresAt?: string | null }

const NOTES: Record<ChannelType, string> = {
  webpush: 'ได้รับแจ้งเตือนบนโทรศัพท์หรือคอมพิวเตอร์เครื่องนี้ แม้ไม่ได้เปิดหน้าเว็บ',
  line: 'รับข้อความผ่าน LINE Official Account ของระบบ',
  telegram: 'รับข้อความผ่านบอท Telegram',
  ntfy: 'แอปแจ้งเตือนฟรี ไม่ต้องสมัครสมาชิก (Android / iOS)',
  email: 'รับสรุปสถานการณ์ทางอีเมล',
  discord: 'ส่งเข้าห้องแชท Discord ของครอบครัวหรือชุมชน',
}

/** Step 3: add notification channels, list them, send a test message. */
export function ChannelsStep({ placeId, token, config, channels, onChanged }: Props) {
  const [links, setLinks] = useState<Partial<Record<ChannelType, LinkState>>>({})
  const [test, setTest] = useState<{ busy: boolean; result?: TestResponse; error?: string }>({ busy: false })
  const enabled = config?.channels
  const verified = channels.filter((c) => c.verified)

  const add = async (type: ChannelType, target?: string): Promise<void> => {
    const r = await api.addChannel(placeId, token, { type, target })
    if (r.link) setLinks((l) => ({ ...l, [type]: { ...r.link!, expiresAt: r.channel?.linkExpiresAt ?? null } }))
    onChanged()
  }

  const runTest = async (channelId?: string) => {
    setTest({ busy: true })
    try {
      setTest({ busy: false, result: await api.test(placeId, token, channelId) })
      onChanged()
    } catch (e) {
      setTest({ busy: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const forms: Record<ChannelType, ReactNode> = {
    webpush: <WebPushForm vapidKey={config?.vapidPublicKey ?? null} onAdd={(t) => add('webpush', t)} />,
    line: (
      <LinkCodeForm
        type="line"
        link={links.line}
        pending={channels.find((c) => c.type === 'line' && !c.verified)}
        addFriendUrl={config?.lineAddFriendUrl ?? null}
        onStart={() => add('line')}
      />
    ),
    telegram: (
      <LinkCodeForm
        type="telegram"
        link={links.telegram}
        pending={channels.find((c) => c.type === 'telegram' && !c.verified)}
        bot={config?.telegramBot ?? null}
        onStart={() => add('telegram')}
      />
    ),
    ntfy: <NtfyForm onAdd={(t) => add('ntfy', t)} />,
    email: <EmailForm link={links.email} onAdd={(t) => add('email', t)} />,
    discord: <DiscordForm onAdd={(t) => add('discord', t)} />,
  }

  const card = (type: ChannelType, body: ReactNode, note?: string) => (
    <ChannelCard key={type} type={type} enabled={!!enabled?.[type]} existing={channels.filter((c) => c.type === type)} note={note}>
      {body}
    </ChannelCard>
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Channels this server can send come first; e-mail only when the server offers it. */}
        {pickerChannels(enabled).map((type) => card(type, forms[type], NOTES[type]))}
      </div>

      <section aria-labelledby="ch-list" className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h3 id="ch-list" className="font-medium">
            ช่องทางที่ตั้งไว้ ({channels.length})
          </h3>
          <button type="button" className="fm-btn fm-btn-primary" disabled={verified.length === 0 || test.busy} onClick={() => void runTest()}>
            <IconSend size={16} />
            {test.busy ? 'กำลังส่ง…' : 'ส่งข้อความทดสอบ'}
          </button>
        </div>
        {channels.length === 0 ? (
          <p className="px-4 py-4 text-sm text-text-2">ยังไม่มีช่องทางแจ้งเตือน เลือกอย่างน้อยหนึ่งช่องทางด้านบน</p>
        ) : (
          <ul className="divide-y divide-border">
            {channels.map((c) => (
              <ChannelRow key={c.id} c={c} placeId={placeId} token={token} onChanged={onChanged} onTest={() => void runTest(c.id)} testBusy={test.busy} />
            ))}
          </ul>
        )}
        {(test.result || test.error) && (
          <div role="status" className="border-t border-border px-4 py-3 text-sm">
            {test.error ? (
              <p>{test.error}</p>
            ) : (
              <>
                <p className="font-medium">
                  ส่งสำเร็จ {test.result!.deliveries.filter((d) => d.ok).length} จาก {test.result!.deliveries.length} ช่องทาง
                </p>
                <ul className="mt-1 text-text-2">
                  {test.result!.deliveries.map((d) => (
                    <li key={d.channelId}>
                      {CHANNEL_LABEL_TH[d.type]}: {d.ok ? 'สำเร็จ' : `ไม่สำเร็จ${d.error ? ` (${d.error})` : ''}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function ChannelCard({ type, enabled, existing, note, children }: { type: ChannelType; enabled: boolean; existing: PublicChannel[]; note?: string; children: ReactNode }) {
  const active = existing.filter((c) => c.verified).length
  return (
    <article className={`flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card-2 px-4 py-3 ${enabled ? '' : 'opacity-70'}`}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{CHANNEL_LABEL_TH[type]}</h3>
        {active > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-text-2">
            <IconCheck size={14} /> ใช้งานอยู่ {active}
          </span>
        )}
      </header>
      {note && <p className="text-sm text-text-2">{note}</p>}
      {enabled ? children : <p className="text-sm text-muted">ผู้ดูแลระบบยังไม่ได้เปิดใช้ช่องทางนี้บนเซิร์ฟเวอร์</p>}
    </article>
  )
}

function useAction() {
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false })
  const run = async (fn: () => Promise<void>) => {
    setState({ busy: true, error: null, done: false })
    try {
      await fn()
      setState({ busy: false, error: null, done: true })
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e), done: false })
    }
  }
  return { ...state, run }
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-text">
      {error}
    </p>
  ) : null
}

function WebPushForm({ vapidKey, onAdd }: { vapidKey: string | null; onAdd: (subscription: string) => Promise<void> }) {
  const support = useSyncExternalStore<PushSupport | null>(subscribeNoop, pushSupport, () => null)
  const a = useAction()
  if (support === 'insecure') {
    return (
      <p className="text-sm text-text">
        การแจ้งเตือนบนอุปกรณ์{NEEDS_HTTPS_TH} ขณะนี้เว็บเปิดผ่าน http:// เบราว์เซอร์จึงไม่อนุญาต ให้ผู้ดูแลระบบตั้งค่า HTTPS หรือเลือกช่องทางอื่น เช่น ntfy, LINE หรือ Telegram
      </p>
    )
  }
  if (support === 'ios-needs-install') {
    return (
      <p className="text-sm text-text">
        บน iPhone/iPad ต้องเพิ่มลงหน้าจอโฮมก่อน: กดปุ่มแชร์ใน Safari เลือก “เพิ่มไปยังหน้าจอโฮม” แล้วเปิดเว็บจากไอคอนบนหน้าจอโฮม (iOS 16.4 ขึ้นไป) จากนั้นกลับมาที่หน้านี้
      </p>
    )
  }
  if (support === 'unsupported') return <p className="text-sm text-muted">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนแบบพุช ลองใช้ Chrome, Edge, Firefox หรือ Safari รุ่นใหม่</p>
  if (!vapidKey) return <p className="text-sm text-muted">เซิร์ฟเวอร์ยังไม่ได้ตั้งค่ากุญแจ Web Push</p>
  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="fm-btn fm-btn-primary self-start" disabled={a.busy || support === null} onClick={() => void a.run(async () => onAdd(await subscribePush(vapidKey)))}>
        <IconBell size={16} />
        {a.busy ? 'กำลังเปิด…' : a.done ? 'เปิดแล้ว' : 'เปิดการแจ้งเตือนบนอุปกรณ์นี้'}
      </button>
      <p className="text-xs text-muted">เบราว์เซอร์จะถามสิทธิ์การแจ้งเตือน กรุณากด “อนุญาต”</p>
      <ErrorText error={a.error} />
    </div>
  )
}

function LinkCodeForm({
  type,
  link,
  pending,
  bot,
  addFriendUrl,
  onStart,
}: {
  type: 'line' | 'telegram'
  link?: LinkState
  pending?: PublicChannel
  bot?: string | null
  addFriendUrl?: string | null
  onStart: () => Promise<void>
}) {
  const a = useAction()
  const nowMs = useNow(null, 15_000)
  // The code just handed out wins over the (possibly older) pending channel in the list.
  const code = link?.code ?? pending?.linkCode ?? null
  const expiresAt = link?.code ? (link.expiresAt ?? (pending?.linkCode === link.code ? pending.linkExpiresAt : null)) : pending?.linkExpiresAt
  const expired = !!code && linkCodeExpired(expiresAt, nowMs)
  const url =
    type === 'telegram'
      ? (link?.url ?? (bot && code ? `https://t.me/${bot.replace(/^@/, '')}?start=${code}` : null))
      : (link?.url ?? addFriendUrl ?? null)
  const startLabel = type === 'line' ? 'เชื่อมต่อ LINE' : 'เชื่อมต่อ Telegram'
  if (!code || expired) {
    return (
      <div className="flex flex-col gap-2">
        {expired && (
          <p role="status" className="text-sm text-text">
            <span className="font-medium">รหัสหมดอายุ</span> รหัสเชื่อมต่อมีอายุจำกัด กดขอรหัสใหม่ แล้วใช้รหัสใหม่แทน
          </p>
        )}
        <button type="button" className="fm-btn fm-btn-primary self-start" disabled={a.busy} onClick={() => void a.run(onStart)}>
          {a.busy ? 'กำลังสร้างรหัส…' : expired ? 'ขอรหัสใหม่' : startLabel}
        </button>
        <ErrorText error={a.error} />
      </div>
    )
  }
  const until = expiresAt ? Date.parse(expiresAt) : NaN
  return (
    <div className="flex flex-col gap-2 text-sm">
      {type === 'line' ? (
        <ol className="list-decimal space-y-1 pl-5 text-text-2">
          <li>เพิ่มเพื่อนบัญชี LINE ของระบบ</li>
          <li>ส่งรหัสนี้ในแชต</li>
        </ol>
      ) : (
        <p className="text-text-2">เปิดบอท แล้วกด “เริ่ม” (Start) ระบบจะเชื่อมต่อให้อัตโนมัติ</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-lg tracking-[0.2em]" aria-label={`รหัส ${code.split('').join(' ')}`}>
          {code}
        </span>
        <CopyButton text={code} label="คัดลอกรหัส" />
      </div>
      {Number.isFinite(until) && <p className="text-xs text-muted">รหัสใช้ได้ถึง {bkkTime(until)} น.</p>}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="fm-btn fm-btn-primary self-start">
          {type === 'line' ? 'เพิ่มเพื่อน LINE' : 'เปิด Telegram'}
        </a>
      )}
      {link?.instructions && <p className="text-xs text-muted">{link.instructions}</p>}
      <p className="text-xs text-muted" role="status">
        กำลังรอการยืนยัน… หน้านี้จะอัปเดตเองเมื่อเชื่อมต่อสำเร็จ
      </p>
    </div>
  )
}

function NtfyForm({ onAdd }: { onAdd: (topic: string) => Promise<void> }) {
  const [topic, setTopic] = useState('')
  const a = useAction()
  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(topic.trim()) || /^https:\/\/[^\s]+\/[A-Za-z0-9_-]{1,64}$/.test(topic.trim())
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void a.run(() => onAdd(topic.trim()))
      }}
    >
      <label className="text-sm text-text-2" htmlFor="ntfy-topic">
        ชื่อหัวข้อ (topic)
      </label>
      <div className="flex gap-2">
        <input id="ntfy-topic" className="fm-input min-w-0 flex-1" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="fm-xxxxxxxx" autoComplete="off" />
        <button type="button" className="fm-btn fm-btn-quiet" onClick={() => setTopic(randomTopic())}>
          สุ่มชื่อ
        </button>
      </div>
      <p className="text-xs text-muted">
        ใครรู้ชื่อหัวข้อก็อ่านข้อความได้ ควรใช้ชื่อที่เดายาก ติดตั้งแอป{' '}
        <a className="underline" href="https://ntfy.sh/" target="_blank" rel="noopener noreferrer">
          ntfy
        </a>{' '}
        แล้วกดสมัคร (Subscribe) หัวข้อเดียวกันนี้
      </p>
      {a.done && topic && (
        <a className="text-sm underline" href={`https://ntfy.sh/${encodeURIComponent(topic.trim())}`} target="_blank" rel="noopener noreferrer">
          เปิดหัวข้อนี้ใน ntfy
        </a>
      )}
      <button type="submit" className="fm-btn fm-btn-primary self-start" disabled={!valid || a.busy}>
        {a.busy ? 'กำลังบันทึก…' : 'เพิ่ม ntfy'}
      </button>
      <ErrorText error={a.error} />
    </form>
  )
}

function EmailForm({ link, onAdd }: { link?: ChannelLink; onAdd: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const a = useAction()
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void a.run(() => onAdd(email.trim()))
      }}
    >
      <label className="text-sm text-text-2" htmlFor="email-addr">
        อีเมล
      </label>
      <input id="email-addr" type="email" className="fm-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="email" />
      <button type="submit" className="fm-btn fm-btn-primary self-start" disabled={!valid || a.busy}>
        {a.busy ? 'กำลังส่ง…' : 'ส่งอีเมลยืนยัน'}
      </button>
      {a.done && (
        <p role="status" className="text-sm text-text">
          {link?.instructions ?? 'ตรวจสอบอีเมลเพื่อยืนยัน แล้วกดลิงก์ในอีเมลเพื่อเริ่มรับการแจ้งเตือน'}
        </p>
      )}
      <ErrorText error={a.error} />
    </form>
  )
}

function DiscordForm({ onAdd }: { onAdd: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState('')
  const a = useAction()
  const valid = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url.trim())
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void a.run(() => onAdd(url.trim()))
      }}
    >
      <label className="text-sm text-text-2" htmlFor="discord-url">
        Webhook URL
      </label>
      <input id="discord-url" type="url" className="fm-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" autoComplete="off" />
      <p className="text-xs text-muted">ตั้งค่าห้อง → การเชื่อมต่อ (Integrations) → Webhooks → สร้าง Webhook → คัดลอก URL</p>
      {url && !valid && <p className="text-xs text-text">รูปแบบ URL ไม่ถูกต้อง</p>}
      <button type="submit" className="fm-btn fm-btn-primary self-start" disabled={!valid || a.busy}>
        {a.busy ? 'กำลังบันทึก…' : 'เพิ่ม Discord'}
      </button>
      <ErrorText error={a.error} />
    </form>
  )
}

function ChannelRow({
  c,
  placeId,
  token,
  onChanged,
  onTest,
  testBusy,
}: {
  c: PublicChannel
  placeId: string
  token: string
  onChanged: () => void
  onTest: () => void
  testBusy: boolean
}) {
  const a = useAction()
  const nowMs = useNow(null, 15_000)
  const status = c.verified ? null : linkCodeExpired(c.linkExpiresAt, nowMs) ? 'รหัสหมดอายุ' : 'รอยืนยัน'
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{CHANNEL_LABEL_TH[c.type]}</p>
        <p className="truncate text-sm text-text-2" title={c.target}>
          {c.target || '-'}
        </p>
        <p className="text-xs text-muted">
          {c.verified ? (
            <span className="inline-flex items-center gap-1">
              <IconCheck size={12} /> พร้อมใช้งาน
            </span>
          ) : (
            status
          )}{' '}
          · เพิ่มเมื่อ {formatShortBkk(c.createdAt)}
        </p>
      </div>
      <div className="flex gap-1">
        {c.verified && (
          <button type="button" className="fm-btn fm-btn-quiet" onClick={onTest} disabled={testBusy}>
            ทดสอบ
          </button>
        )}
        <button
          type="button"
          className="fm-icon-btn"
          aria-label={`ลบช่องทาง ${CHANNEL_LABEL_TH[c.type]}`}
          title="ลบ"
          disabled={a.busy}
          onClick={() => {
            if (!window.confirm(`ลบช่องทาง ${CHANNEL_LABEL_TH[c.type]} นี้หรือไม่`)) return
            void a.run(async () => {
              await api.deleteChannel(placeId, token, c.id)
              onChanged()
            })
          }}
        >
          <IconTrash size={18} />
        </button>
      </div>
      {a.error && <p className="w-full text-sm">{a.error}</p>}
    </li>
  )
}
