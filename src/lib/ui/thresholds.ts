import type { Place } from '../types'

// Threshold form model for /alerts step 2 (strings while the user types).

export interface ThresholdForm {
  notifyMinLevel: Place['notifyMinLevel']
  watch: string
  warning: string
  critical: string
  rapidRiseCm: string
  rainWatch: string
  rainWarning: string
  rainCritical: string
}

export function thresholdForm(p: Pick<Place, 'notifyMinLevel' | 'freeboard' | 'rain' | 'rapidRiseCm'>): ThresholdForm {
  return {
    notifyMinLevel: p.notifyMinLevel,
    watch: String(p.freeboard.watch),
    warning: String(p.freeboard.warning),
    critical: String(p.freeboard.critical),
    rapidRiseCm: String(p.rapidRiseCm),
    rainWatch: String(p.rain.watch),
    rainWarning: String(p.rain.warning),
    rainCritical: String(p.rain.critical),
  }
}

/** Client-side check mirroring the server rules (src/lib/server/validation.ts re-validates). Thai error or null. */
export function validateThresholds(f: ThresholdForm): string | null {
  const fields = [f.watch, f.warning, f.critical, f.rapidRiseCm, f.rainWatch, f.rainWarning, f.rainCritical]
  if (fields.some((v) => v.trim() === '' || !Number.isFinite(Number(v)))) return 'กรุณากรอกตัวเลขให้ครบทุกช่อง'
  const n = (v: string) => Number(v)
  if (!(n(f.watch) > n(f.warning) && n(f.warning) > n(f.critical))) return 'ระยะห่างตลิ่งต้องเรียงจากมากไปน้อย: เฝ้าระวัง > เตือนภัย > วิกฤต'
  if (n(f.watch) > 10) return 'ค่าเฝ้าระวังต้องไม่เกิน 10 เมตร'
  if (n(f.critical) < -1) return 'ค่าวิกฤตต้องไม่ต่ำกว่า -1 เมตร'
  if (n(f.rapidRiseCm) < 3 || n(f.rapidRiseCm) > 50) return 'เกณฑ์น้ำขึ้นเร็วต้องอยู่ระหว่าง 3–50 ซม./ชม.'
  if (!(n(f.rainWatch) > 0 && n(f.rainWatch) < n(f.rainWarning) && n(f.rainWarning) < n(f.rainCritical))) {
    return 'ปริมาณฝนต้องเรียงจากน้อยไปมาก: เฝ้าระวัง < เตือนภัย < วิกฤต'
  }
  if (n(f.rainCritical) > 1000) return 'ค่าปริมาณฝนต้องไม่เกิน 1000 มม.'
  return null
}
