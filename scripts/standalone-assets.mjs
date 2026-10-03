// After `next build`: copy public/ and .next/static into .next/standalone so that
// `npm run start:standalone` serves CSS, JS and icons without manual copying.
import { cpSync, existsSync } from 'node:fs'

const target = '.next/standalone'
if (existsSync(target)) {
  if (existsSync('public')) cpSync('public', `${target}/public`, { recursive: true })
  cpSync('.next/static', `${target}/.next/static`, { recursive: true })
}
