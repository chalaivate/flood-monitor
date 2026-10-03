/* Flood Monitor service worker: shows Web Push alerts and opens the dashboard on click.
   Payload (src/lib/notify/webpush.ts): { title, body, url?, tag?, level? } as JSON. */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'เฝ้าระวังน้ำท่วม'
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'flood-monitor'
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag,
    // Replace the previous alert for the same place but still buzz the phone.
    renotify: true,
    lang: 'th',
    dir: 'ltr',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    data: { url: typeof data.url === 'string' && data.url ? data.url : '/' },
    // Critical alerts stay on screen until the user acts on them.
    requireInteraction: data.level === 'critical',
    timestamp: Date.now(),
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = (event.notification.data && event.notification.data.url) || '/'
  let target
  try {
    target = new URL(raw, self.location.origin)
  } catch {
    target = new URL('/', self.location.origin)
  }
  // Never navigate to another origin from a notification.
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin)
  const url = target.href

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of windows) {
        if (c.url === url && 'focus' in c) return c.focus()
      }
      for (const c of windows) {
        if (new URL(c.url).origin === self.location.origin && 'navigate' in c) {
          await c.focus()
          return c.navigate(url)
        }
      }
      return self.clients.openWindow(url)
    })(),
  )
})
