import { getConfig } from '@/lib/config'
import { escapeHtml } from '@/lib/notify/format'
import { publicOrigin, readTextCapped } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { getStore } from '@/lib/store'
import type { Channel } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// E-mail confirmation in two steps. The e-mailed link (GET) only shows a page with a
// button; the button POSTs the code and only that verifies the channel. Mail scanners
// (Safe Links and similar) fetch links in every message, so a GET that verified would
// subscribe addresses whose owners never agreed.

const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/

/** The pending e-mail channel for `code`, or null. */
async function pendingChannel(code: string): Promise<Channel | null> {
  if (!CODE_RE.test(code)) return null
  const ch = await (await getStore()).findChannelByLinkCode(code)
  return ch && ch.type === 'email' && !ch.verified ? ch : null
}

function pageHeaders(origin: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The code is in the URL: never leak it through Referer, never render in a frame.
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // form-action also covers the redirect after the POST, which goes to `origin`.
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; base-uri 'none'; frame-ancestors 'none'`,
    'X-Robots-Tag': 'noindex',
  }
}

function page(origin: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>ยืนยันการรับแจ้งเตือน · Flood Monitor</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font-family:'IBM Plex Sans Thai',Tahoma,sans-serif;font-size:16px;line-height:1.6;background:#f3f4f6;color:#111827}
main{max-width:480px;margin:48px auto;padding:24px 16px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 12px}
p{margin:0 0 16px}
button{font:inherit;font-weight:600;background:#1d4ed8;color:#fff;border:0;border-radius:8px;padding:12px 20px;cursor:pointer;width:100%}
button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
a{color:#1d4ed8}
.muted{color:#6b7280;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f9fafb}.card{background:#1f2937}.muted{color:#9ca3af}a{color:#93c5fd}}
</style></head>
<body><main><div class="card">
${body}
<p class="muted"><a href="${escapeHtml(origin)}/alerts">กลับไปหน้าตั้งค่าแจ้งเตือน</a></p>
</div></main></body></html>`
  return new Response(html, { status, headers: pageHeaders(origin) })
}

/** GET /api/email/confirm?code= → confirmation page with a button (does not verify). */
export async function GET(req: Request): Promise<Response> {
  const origin = publicOrigin(req, getConfig().PUBLIC_BASE_URL)
  const code = new URL(req.url).searchParams.get('code')?.trim() ?? ''
  let ch: Channel | null = null
  try {
    ch = await pendingChannel(code)
  } catch (err) {
    log(`[api] email confirm page failed: ${err instanceof Error ? err.message : String(err)}`)
    return page(origin, '<h1>เกิดข้อผิดพลาด</h1><p>ระบบไม่สามารถตรวจสอบลิงก์ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง</p>', 500)
  }
  if (!ch) {
    return page(
      origin,
      '<h1>ลิงก์ยืนยันไม่ถูกต้อง</h1><p>ลิงก์นี้อาจถูกใช้ไปแล้ว หรือมีการขอลิงก์ใหม่แทน กรุณาตรวจสอบอีเมลล่าสุด หรือเพิ่มอีเมลอีกครั้งที่หน้าตั้งค่าแจ้งเตือน</p>',
      404,
    )
  }
  // action="" posts back to this same URL; the code also travels in the form body.
  return page(
    origin,
    `<h1>ยืนยันการรับแจ้งเตือนทางอีเมล</h1>
<p>กดปุ่มด้านล่างเพื่อเริ่มรับการแจ้งเตือนน้ำท่วมทางอีเมลนี้ หากคุณไม่ได้ขอรับการแจ้งเตือน ให้ปิดหน้านี้ได้เลย</p>
<form method="post" action="">
<input type="hidden" name="code" value="${escapeHtml(code)}">
<button type="submit">ยืนยันการรับแจ้งเตือน</button>
</form>`,
  )
}

/** POST /api/email/confirm (form field `code`) → verifies the channel, redirects to /alerts?confirmed=1|0. */
export async function POST(req: Request): Promise<Response> {
  const origin = publicOrigin(req, getConfig().PUBLIC_BASE_URL)
  let confirmed = false
  try {
    const form = new URLSearchParams(await readTextCapped(req, 4096))
    const code = (form.get('code') ?? new URL(req.url).searchParams.get('code') ?? '').trim()
    const ch = await pendingChannel(code)
    if (ch) {
      await (await getStore()).updateChannel({ ...ch, verified: true, linkCode: null })
      confirmed = true
    }
  } catch (err) {
    log(`[api] email confirm failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}/alerts?confirmed=${confirmed ? 1 : 0}`, 'Cache-Control': 'no-store' },
  })
}
