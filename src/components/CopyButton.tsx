'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { IconCheck, IconCopy } from './icons'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for http:// or blocked clipboard permission.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

/** Button that copies `text` (or the result of `getText`) and confirms with "คัดลอกแล้ว". */
export function CopyButton({
  text,
  getText,
  label = 'คัดลอกลิงก์',
  className = 'fm-btn fm-btn-quiet',
  icon,
}: {
  text?: string
  getText?: () => string
  label?: ReactNode
  className?: string
  icon?: ReactNode
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 2200)
    return () => clearTimeout(id)
  }, [state])
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const value = text ?? getText?.() ?? ''
        setState((await copyText(value)) ? 'ok' : 'fail')
      }}
    >
      {state === 'ok' ? <IconCheck size={18} /> : (icon ?? <IconCopy size={18} />)}
      <span aria-live="polite">{state === 'ok' ? 'คัดลอกแล้ว' : state === 'fail' ? 'คัดลอกไม่สำเร็จ' : label}</span>
    </button>
  )
}
