'use client'

import { useId, useState } from 'react'
import type { Place } from '@/lib/types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'
import { api, type PublicPlace } from '@/lib/ui/api'
import { levelLabel } from '@/lib/ui/levels'
import { thresholdForm as toForm, validateThresholds, type ThresholdForm as Form } from '@/lib/ui/thresholds'
import { LevelDot } from '../LevelBadge'

type MinLevel = Place['notifyMinLevel']

const LEVEL_HELP: Record<MinLevel, string> = {
  watch: 'แจ้งเร็วที่สุด เมื่อน้ำเริ่มใกล้ตลิ่งหรือฝนเริ่มหนัก อาจได้รับข้อความบ่อยในฤดูฝน',
  warning: 'แนะนำ แจ้งเมื่อน้ำใกล้ล้นตลิ่ง ฝนหนักมาก หรือน้ำท่วมถนนลึก',
  critical: 'แจ้งเฉพาะเมื่อน้ำเกือบล้นหรือล้นตลิ่งแล้ว เหมาะกับผู้ที่ต้องการข้อความน้อยที่สุด',
}

/** Step 2: minimum level to notify + thresholds (PATCH /api/places/[id]). */
export function ThresholdStep({ server, token, onChanged }: { server: PublicPlace; token: string; onChanged: () => void }) {
  const uid = useId()
  const [form, setForm] = useState<Form>(() => toForm(server))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setMsg(null)
  }
  const invalid = validateThresholds(form)
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(server))

  const save = async () => {
    if (invalid) return
    setBusy(true)
    try {
      await api.updatePlace(server.id, token, {
        notifyMinLevel: form.notifyMinLevel,
        freeboard: { watch: Number(form.watch), warning: Number(form.warning), critical: Number(form.critical) },
        rain: { watch: Number(form.rainWatch), warning: Number(form.rainWarning), critical: Number(form.rainCritical) },
        rapidRiseCm: Number(form.rapidRiseCm),
      })
      setMsg({ ok: true, text: 'บันทึกเกณฑ์แล้ว' })
      onChanged()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    set({
      watch: String(DEFAULT_FREEBOARD.watch),
      warning: String(DEFAULT_FREEBOARD.warning),
      critical: String(DEFAULT_FREEBOARD.critical),
      rapidRiseCm: '10',
      rainWatch: String(DEFAULT_RAIN.watch),
      rainWarning: String(DEFAULT_RAIN.warning),
      rainCritical: String(DEFAULT_RAIN.critical),
    })
  }

  const num = (key: keyof Form, label: string, unit: string, step: string) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-text-2">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={form[key]}
          onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)}
          className="fm-input tabular w-full min-w-0"
        />
        <span className="shrink-0 text-muted">{unit}</span>
      </span>
    </label>
  )

  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 font-medium">แจ้งเตือนเมื่อสถานการณ์ถึงระดับ</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup">
          {(['watch', 'warning', 'critical'] as const).map((l) => (
            <label
              key={l}
              className={`flex cursor-pointer flex-col gap-1 rounded-xl border px-3 py-3 ${form.notifyMinLevel === l ? 'border-accent bg-card-2' : 'border-border'}`}
            >
              <span className="flex items-center gap-2">
                <input type="radio" name={`${uid}-lvl`} checked={form.notifyMinLevel === l} onChange={() => set({ notifyMinLevel: l })} className="accent-[var(--accent)]" />
                <LevelDot level={l} size={12} decorative />
                <span className="font-medium">{levelLabel(l)}ขึ้นไป</span>
              </span>
              <span className="text-xs text-text-2">{LEVEL_HELP[l]}</span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          ระบบจะแจ้งอีกครั้งเมื่อสถานการณ์คลี่คลาย แจ้งซ้ำทุก 3 ชม. ระหว่างวิกฤต และแจ้งทันทีเมื่อน้ำขึ้นเร็วผิดปกติ
        </p>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-medium">ระยะห่างตลิ่ง (ระยะจากผิวน้ำถึงขอบตลิ่ง)</legend>
        <p className="mb-2 text-xs text-text-2">ยิ่งตัวเลขน้อย ผิวน้ำยิ่งใกล้ขอบตลิ่ง ค่าติดลบหมายถึงน้ำล้นตลิ่งแล้ว</p>
        <div className="grid grid-cols-3 gap-2">
          {num('watch', 'เฝ้าระวัง น้อยกว่า', 'ม.', '0.05')}
          {num('warning', 'เตือนภัย น้อยกว่า', 'ม.', '0.05')}
          {num('critical', 'วิกฤต น้อยกว่า', 'ม.', '0.05')}
        </div>
        <div className="mt-3 max-w-[16rem]">{num('rapidRiseCm', 'แจ้งเมื่อน้ำขึ้นเร็วตั้งแต่', 'ซม./ชม.', '1')}</div>
      </fieldset>

      <details className="rounded-xl border border-border px-4 py-3">
        <summary className="cursor-pointer font-medium">เกณฑ์ฝนสะสม 24 ชม. (ขั้นสูง)</summary>
        <p className="mt-1 mb-2 text-xs text-text-2">ค่าเริ่มต้นตามเกณฑ์กรมอุตุนิยมวิทยา: ฝนหนัก 35.1 มม. ฝนหนักมาก 90.1 มม.</p>
        <div className="grid grid-cols-3 gap-2">
          {num('rainWatch', 'เฝ้าระวัง ตั้งแต่', 'มม.', '0.1')}
          {num('rainWarning', 'เตือนภัย ตั้งแต่', 'มม.', '0.1')}
          {num('rainCritical', 'วิกฤต ตั้งแต่', 'มม.', '1')}
        </div>
      </details>

      {(invalid || msg) && (
        <p role={invalid || !msg?.ok ? 'alert' : 'status'} className="text-sm text-text">
          {invalid ?? msg?.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="fm-btn fm-btn-primary" disabled={!!invalid || !dirty || busy} onClick={() => void save()}>
          {busy ? 'กำลังบันทึก…' : 'บันทึกเกณฑ์'}
        </button>
        <button type="button" className="fm-btn fm-btn-quiet" onClick={reset}>
          คืนค่าเริ่มต้น
        </button>
      </div>
    </div>
  )
}
