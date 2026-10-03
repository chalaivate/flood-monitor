import type { Level } from '../types'
import { LEVEL_LABEL_TH } from '../types'
import type { NotifyMessage } from './types'

// Shared Thai message formatting for every channel.

export const APP_NAME = 'Flood Monitor'

/** "[เตือนภัย]" style prefix used by plain-text channels. */
export function levelTag(level: Level): string {
  return `[${LEVEL_LABEL_TH[level]}]`
}

/** Cut a string to at most `max` characters (code points), ending with an ellipsis. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** Title line; the level tag is skipped when the title already starts with the label. */
export function titleLine(msg: NotifyMessage): string {
  const label = LEVEL_LABEL_TH[msg.level]
  if (msg.level === 'unknown' || msg.level === 'normal' || msg.title.includes(label)) return msg.title
  return `${levelTag(msg.level)} ${msg.title}`
}

/** Body plus the dashboard link (skipped when the body already contains it). */
export function bodyWithLink(msg: NotifyMessage): string {
  const body = msg.body.trim()
  if (!msg.url || body.includes(msg.url)) return body
  return `${body}\n\nดูรายละเอียด: ${msg.url}`
}

/**
 * Plain text = title + blank line + body + link, cut to `max` characters while
 * keeping the link (the most useful part when the body is long).
 */
export function plainText(msg: NotifyMessage, max = 4000): string {
  const title = titleLine(msg)
  const full = `${title}\n\n${bodyWithLink(msg)}`
  if (Array.from(full).length <= max) return full
  const link = msg.url ? `\n\nดูรายละเอียด: ${msg.url}` : ''
  const body = (msg.url ? msg.body.split(msg.url).join('') : msg.body).trim()
  const room = max - Array.from(title).length - 2 - Array.from(link).length
  return `${title}\n\n${truncate(body, Math.max(1, room))}${link}`
}

/** Cut a string so its UTF-8 encoding fits in `maxBytes` (Thai is 3 bytes per character). */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const out: string[] = []
  let used = 3 // the ellipsis
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (used + b > maxBytes) break
    out.push(ch)
    used += b
  }
  return `${out.join('')}…`
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const LEVEL_COLOR: Record<Level, string> = {
  normal: '#1b7f3b',
  watch: '#a66b00',
  warning: '#c2410c',
  critical: '#b91c1c',
  unknown: '#555555',
}

/** Minimal, inline-styled HTML e-mail body. */
export function htmlEmail(msg: NotifyMessage, footer = 'ข้อความนี้ส่งโดยอัตโนมัติจากระบบเฝ้าระวังน้ำท่วม ไม่ใช่ประกาศทางการ'): string {
  const lines = msg.body
    .trim()
    .split('\n')
    .map((l) => (l.trim() === '' ? '<br>' : `<div>${linkify(escapeHtml(l))}</div>`))
    .join('\n')
  const button = msg.url
    ? `<p style="margin:20px 0"><a href="${escapeHtml(msg.url)}" style="background:#1d4ed8;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">ดูแดชบอร์ด</a></p>`
    : ''
  return `<!doctype html>
<html lang="th"><body style="font-family:'IBM Plex Sans Thai',Tahoma,sans-serif;font-size:15px;line-height:1.6;color:#111827;background:#ffffff">
<div style="max-width:560px;margin:0 auto;padding:16px">
<div style="display:inline-block;padding:2px 10px;border-radius:999px;background:${LEVEL_COLOR[msg.level]};color:#ffffff;font-size:13px">${escapeHtml(LEVEL_LABEL_TH[msg.level])}</div>
<h2 style="font-size:18px;margin:12px 0">${escapeHtml(msg.title)}</h2>
${lines}
${button}
<p style="color:#6b7280;font-size:12px;margin-top:24px">${escapeHtml(footer)}</p>
</div></body></html>`
}

/** Turn escaped http(s) URLs into anchors. Input must already be HTML-escaped. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
}

/** Generic network error text for SendResult.error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
    return err.message
  }
  return String(err)
}

/** Timeout applied to every outbound notification request. */
export const SEND_TIMEOUT_MS = 15_000

/**
 * Read at most about `max` characters of a response body, never throwing. The body is
 * streamed and cancelled once enough bytes arrived, so a huge or endless body cannot
 * exhaust memory.
 */
export async function readErrorBody(res: Response, max = 500): Promise<string> {
  try {
    if (!res.body) return ''
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    const byteLimit = max * 4 // UTF-8: at most 4 bytes per character
    try {
      while (total < byteLimit) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return Array.from(new TextDecoder().decode(Buffer.concat(chunks))).slice(0, max).join('')
  } catch {
    return ''
  }
}
