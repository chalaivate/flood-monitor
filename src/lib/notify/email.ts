import type { AppConfig } from '../config'
import type { Channel } from '../types'
import { APP_NAME, SEND_TIMEOUT_MS, bodyWithLink, errorMessage, htmlEmail, readErrorBody, titleLine, truncate, escapeHtml } from './format'
import { discardBody, logHttpFailure } from './http'
import type { ChannelSender, NotifyMessage, SendResult } from './types'

// E-mail through Resend's HTTP API (no SMTP needed, works from serverless hosts).

export const RESEND_API = 'https://api.resend.com/emails'

export interface EmailContent {
  to: string
  subject: string
  text: string
  html: string
}

export async function sendEmail(fetchImpl: typeof fetch, config: AppConfig, mail: EmailContent): Promise<SendResult> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM) return { ok: false, error: 'email not configured' }
  try {
    const res = await fetchImpl(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (res.ok) {
      await discardBody(res)
      return { ok: true }
    }
    const body = await readErrorBody(res, 300)
    let detail = body
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? body
    } catch {
      // raw body
    }
    // The detail stays in the server log; deliveries only get the status.
    return { ok: false, error: logHttpFailure('Resend', res.status, detail) }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/**
 * The confirmation e-mail sent when someone adds an e-mail channel. Anyone can request
 * it for any address, so it carries no user-supplied text (not even the place label):
 * only fixed wording and our own confirmation link. The link opens a page with a
 * confirm button; merely fetching the link (mail scanners) does not subscribe anyone.
 */
export function confirmationEmail(to: string, confirmUrl: string): EmailContent {
  const text = [
    `มีการขอรับการแจ้งเตือนน้ำท่วมจากระบบ ${APP_NAME} ทางอีเมลนี้`,
    '',
    'หากต้องการรับการแจ้งเตือน กรุณาเปิดลิงก์ด้านล่าง แล้วกดปุ่ม "ยืนยันการรับแจ้งเตือน":',
    confirmUrl,
    '',
    'หากคุณไม่ได้ขอรับการแจ้งเตือนนี้ ไม่ต้องดำเนินการใด ๆ ระบบจะไม่ส่งการแจ้งเตือนถึงคุณ',
  ].join('\n')
  const html = `<!doctype html>
<html lang="th"><body style="font-family:'IBM Plex Sans Thai',Tahoma,sans-serif;font-size:15px;line-height:1.6;color:#111827">
<div style="max-width:560px;margin:0 auto;padding:16px">
<h2 style="font-size:18px">ยืนยันการรับการแจ้งเตือนน้ำท่วม</h2>
<p>มีการขอรับการแจ้งเตือนน้ำท่วมจากระบบ ${escapeHtml(APP_NAME)} ทางอีเมลนี้</p>
<p style="margin:20px 0"><a href="${escapeHtml(confirmUrl)}" style="background:#1d4ed8;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">ไปหน้ายืนยันอีเมล</a></p>
<p style="color:#6b7280;font-size:13px">หากปุ่มไม่ทำงาน ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์: ${escapeHtml(confirmUrl)}</p>
<p style="color:#6b7280;font-size:13px">หากคุณไม่ได้ขอรับการแจ้งเตือนนี้ ไม่ต้องดำเนินการใด ๆ ระบบจะไม่ส่งการแจ้งเตือนถึงคุณ</p>
</div></body></html>`
  return { to, subject: `${APP_NAME}: ยืนยันการรับการแจ้งเตือนน้ำท่วม`, text, html }
}

export const emailSender: ChannelSender = {
  type: 'email',
  isConfigured: (config) => !!(config.RESEND_API_KEY && config.EMAIL_FROM),

  async send(channel: Channel, msg: NotifyMessage, ctx): Promise<SendResult> {
    if (!channel.target) return { ok: false, error: 'email address missing' }
    return sendEmail(ctx.fetch, ctx.config, {
      to: channel.target,
      subject: truncate(`${titleLine(msg)} · ${APP_NAME}`, 200),
      text: `${titleLine(msg)}\n\n${bodyWithLink(msg)}\n\n-- \nข้อความนี้ส่งโดยอัตโนมัติจากระบบเฝ้าระวังน้ำท่วม ไม่ใช่ประกาศทางการ`,
      html: htmlEmail(msg),
    })
  },
}
