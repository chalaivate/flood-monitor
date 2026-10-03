import { deliverEvent, type CycleDeps } from '../pipeline'
import type { Store } from '../store/types'
import { formatShortBkk } from '../time'
import type { AlertEvent, Channel, Place } from '../types'

// "ส่งข้อความทดสอบ" from the alerts page.

export function testEvent(place: Place, now = new Date()): AlertEvent {
  return {
    id: crypto.randomUUID(),
    placeId: place.id,
    kind: 'test',
    level: 'normal',
    title: `ทดสอบการแจ้งเตือน: ${place.label}`,
    body: [
      `นี่คือข้อความทดสอบจากระบบเฝ้าระวังน้ำท่วม สำหรับพื้นที่ "${place.label}"`,
      'หากได้รับข้อความนี้ แสดงว่าช่องทางแจ้งเตือนพร้อมใช้งาน',
      '',
      `เวลา ${formatShortBkk(now.toISOString())} น.`,
    ].join('\n'),
    stationIds: [],
    createdAt: now.toISOString(),
  }
}

/** Store view whose listChannels() only returns `channels` (delegates everything else). */
function withChannels(store: Store, channels: Channel[]): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'listChannels') return async () => channels
      const v: unknown = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

/**
 * Send a test message to every verified channel of the place, or only to
 * `channelId`. The event is recorded in the place's alert history.
 */
export async function sendTestMessage(deps: CycleDeps, place: Place, channelId?: string): Promise<AlertEvent> {
  let scoped = deps
  if (channelId) {
    const ch = (await deps.store.listChannels(place.id)).filter((c) => c.id === channelId)
    scoped = { ...deps, store: withChannels(deps.store, ch) }
  }
  const delivered = await deliverEvent(scoped, place, testEvent(place, deps.now?.()))
  await deps.store.appendAlertEvent(delivered)
  return delivered
}
