// Web Push helpers (browser side). The subscription JSON is sent to the server as the
// channel target; the service worker (public/sw.js) shows the notifications.

/** VAPID public key (base64url) → bytes for PushManager.subscribe. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export type PushSupport = 'supported' | 'ios-needs-install' | 'insecure' | 'unsupported'

/** iPhone/iPad (incl. iPadOS that reports itself as a Mac). */
export function isIos(ua: string, platform = '', maxTouchPoints = 0): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)
}

/** Thai explanation shown when the page is not a secure context (plain http:// other than localhost). */
export const NEEDS_HTTPS_TH = 'ต้องเปิดผ่าน HTTPS (ที่อยู่เว็บขึ้นต้นด้วย https://)'

/**
 * Web Push availability. Browsers hide service workers and PushManager on insecure origins,
 * so that is checked first: otherwise users would be told their browser is too old.
 */
export function classifyPushSupport(env: { secure: boolean; ios: boolean; standalone: boolean; hasApis: boolean }): PushSupport {
  if (!env.secure) return 'insecure'
  if (env.ios && !env.standalone) return 'ios-needs-install'
  return env.hasApis ? 'supported' : 'unsupported'
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  return classifyPushSupport({
    secure: window.isSecureContext !== false,
    ios: isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    standalone:
      !!window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    hasApis: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  })
}

/**
 * Register /sw.js, ask for permission and subscribe. Returns the subscription JSON
 * string to store as the channel target. Throws Error with a Thai message.
 */
export async function subscribePush(vapidPublicKey: string): Promise<string> {
  if (window.isSecureContext === false) throw new Error(`การแจ้งเตือนบนอุปกรณ์${NEEDS_HTTPS_TH}`)
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนแบบพุช')
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    throw new Error(
      perm === 'denied'
        ? 'การแจ้งเตือนถูกปิดกั้นสำหรับเว็บไซต์นี้ กรุณาเปิดสิทธิ์การแจ้งเตือนในการตั้งค่าเบราว์เซอร์แล้วลองใหม่'
        : 'ยังไม่ได้อนุญาตการแจ้งเตือน',
    )
  }
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) })
  }
  return JSON.stringify(sub.toJSON())
}

/** Random, hard-to-guess ntfy topic such as "fm-k3v9x2m7q4pa". */
export function randomTopic(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = rand(12)
  let s = ''
  for (const b of bytes) s += alphabet[b % alphabet.length]
  return `fm-${s}`
}
