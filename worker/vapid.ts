// Print a fresh VAPID key pair for Web Push as .env lines:
//   npm run vapid >> .env
// Keep the private key secret. Changing keys invalidates existing browser subscriptions.

import webpush from 'web-push'

const keys = webpush.generateVAPIDKeys()
console.log('# Web Push (VAPID) — generated ' + new Date().toISOString())
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
console.log('# contact for push services: mailto:you@example.org or https://your-site')
console.log('VAPID_SUBJECT=mailto:admin@example.org')
