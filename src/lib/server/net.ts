import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// SSRF guard for URLs that users supply (ntfy servers, Web Push endpoints, Discord
// webhooks). Before the server connects anywhere a user pointed it at, the host
// name is resolved and every address must be public unicast. Callers must also
// send with `redirect: 'manual'` so a public server cannot bounce the request into
// the private network.
//
// Known gap (DNS rebinding, TOCTOU): fetch resolves the name again when it
// connects, so a hostile DNS server can answer with a public address for this
// check and a private one for the connection. Closing that needs a custom
// connector that pins the checked address (an undici Agent with `connect.lookup`),
// and undici is not a dependency of this project. The check still stops literal
// private addresses, names that always resolve privately (127.0.0.1.nip.io) and
// redirects, which covers the practical attacks.

/** Resolves a host name to every address it maps to. */
export type LookupFn = (hostname: string) => Promise<string[]>

const DNS_TIMEOUT_MS = 5_000

const systemLookup: LookupFn = async (hostname) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UnsafeUrlError('dns-timeout', 'DNS lookup timed out')), DNS_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout])
    return res.map((r) => r.address)
  } finally {
    clearTimeout(timer)
  }
}

let defaultLookup: LookupFn = systemLookup

/** Replace the resolver used when no `lookup` is passed (tests); null restores the system resolver. */
export function setDefaultLookupForTests(fn: LookupFn | null): void {
  defaultLookup = fn ?? systemLookup
}

export type UnsafeUrlReason = 'invalid' | 'protocol' | 'credentials' | 'hostname' | 'private-address' | 'dns' | 'dns-timeout'

export class UnsafeUrlError extends Error {
  constructor(
    public reason: UnsafeUrlReason,
    message: string,
  ) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

// --- address classification -----------------------------------------------------------

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number)
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0
}

/** [network, prefix length] blocks that must never be reached from user-supplied URLs. */
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]
const V4_MASKS = V4_BLOCKED.map(([net, len]) => {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0
  return { net: (ipv4ToInt(net) & mask) >>> 0, mask }
})

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  return V4_MASKS.some(({ net, mask }) => ((n & mask) >>> 0) === net)
}

/** Eight 16-bit groups of a valid IPv6 address (zone id stripped, dotted IPv4 tail expanded). */
function ipv6Groups(ip: string): number[] {
  let s = ip.split('%')[0]!.toLowerCase()
  const dotted = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const n = ipv4ToInt(dotted[1]!)
    s = `${s.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = s.includes('::') ? (s.split('::') as [string, string]) : [s, undefined]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : new Array<string>(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16))
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`
}

function isPrivateV6(ip: string): boolean {
  const g = ipv6Groups(ip)
  if (g.length !== 8) return true
  const [a, b] = g as [number, number]
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0)
  // ::, ::1, IPv4-compatible ::a.b.c.d and IPv4-mapped ::ffff:a.b.c.d are all refused:
  // public services publish real AAAA records, never these forms.
  if (firstFiveZero && (g[5] === 0 || g[5] === 0xffff)) return true
  // NAT64 64:ff9b::/96 reaches the embedded IPv4 address.
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4(g[6]!, g[7]!))
  // 6to4 2002::/16 embeds an IPv4 address in groups 1–2.
  if (a === 0x2002) return isPrivateV4(embeddedV4(g[1]!, g[2]!))
  if (a === 0x2001 && b === 0) return true // Teredo
  if (a === 0x2001 && b === 0xdb8) return true // documentation
  if ((a & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true // multicast
  return false
}

/**
 * True for addresses a user-supplied URL must not reach: loopback, RFC 1918, link-local,
 * CGNAT, 0.0.0.0/8, multicast/reserved, IPv6 ::1, fc00::/7, fe80::/10, IPv4-mapped and
 * IPv4-compatible forms. Anything that is not a valid IP literal also counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, '')
  const v = isIP(s.split('%')[0]!)
  if (v === 4) return isPrivateV4(s)
  if (v === 6) return isPrivateV6(s)
  return true
}

// --- URL checks -----------------------------------------------------------------------------

/**
 * Cheap syntactic check (no DNS): a dotted name that is not a literal IP and not a
 * localhost / LAN-style suffix. Used before the DNS check and for error messages.
 */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h.includes('.')) return false
  if (isIP(h) !== 0 || h.includes(':')) return false
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|localdomain)$/.test(h)
}

export interface PublicUrlOptions {
  lookup?: LookupFn
  /** Allowed protocols (default https only). */
  protocols?: string[]
}

/**
 * Parse `raw` and make sure it may be fetched on a user's behalf: https, no
 * credentials, a public host name, and every resolved address public.
 * Throws UnsafeUrlError otherwise. See the DNS-rebinding note at the top of this file.
 */
export async function assertPublicUrl(raw: string | URL, opts: PublicUrlOptions = {}): Promise<URL> {
  let u: URL
  try {
    u = new URL(String(raw))
  } catch {
    throw new UnsafeUrlError('invalid', 'invalid URL')
  }
  if (!(opts.protocols ?? ['https:']).includes(u.protocol)) throw new UnsafeUrlError('protocol', `protocol ${u.protocol} not allowed`)
  if (u.username || u.password) throw new UnsafeUrlError('credentials', 'credentials in URL not allowed')
  if (!isPublicHostname(u.hostname)) throw new UnsafeUrlError('hostname', 'host name not allowed')
  let addresses: string[]
  try {
    addresses = await (opts.lookup ?? defaultLookup)(u.hostname.replace(/\.$/, ''))
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err
    throw new UnsafeUrlError('dns', 'host name does not resolve')
  }
  if (addresses.length === 0) throw new UnsafeUrlError('dns', 'host name does not resolve')
  // Every address must be public: fetch may connect to any of them.
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError('private-address', 'host resolves to a private address')
  return u
}

/** fetch() result that is a redirect (3xx, or an opaque redirect from `redirect: 'manual'`). */
export function isRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)
}
