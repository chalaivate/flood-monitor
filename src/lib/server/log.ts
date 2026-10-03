// Timestamped logging in Bangkok time ("2026-10-03 14:05:09"), shared by the API,
// the standalone worker and the embedded worker.

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function bangkokStamp(d: Date = new Date()): string {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  const hour = p.hour === '24' ? '00' : p.hour
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`
}

export type Logger = (msg: string) => void

export function log(msg: string): void {
  console.log(`[${bangkokStamp()}] ${msg}`)
}
