// Print a fresh VAPID key pair for Web Push as .env lines (stdout carries nothing else):
//   npm run --silent vapid
// Then put the two VAPID_* lines into .env, replacing the empty VAPID_PUBLIC_KEY= and
// VAPID_PRIVATE_KEY= lines (or append them: `npm run --silent vapid >> .env`; later lines
// win). Without --silent npm prints its own "> flood-monitor@… vapid" banner to stdout,
// which is not a valid .env line (docker compose refuses such a file).
//
// Docker-only hosts (no Node.js / npm on the host) can use the image, which ships web-push:
//   docker compose run --rm --no-deps app node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey)"
//
// Keep the private key secret. Changing keys invalidates existing browser subscriptions.

import webpush from 'web-push'

const keys = webpush.generateVAPIDKeys()
process.stdout.write(
  [
    `# Web Push (VAPID) keys, generated ${new Date().toISOString()}`,
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    '',
  ].join('\n'),
)
