import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ROAD_FLOOD_CM } from '@/lib/engine/status'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'
import { LevelBadge } from '@/components/LevelBadge'

export const metadata: Metadata = {
  title: 'เกี่ยวกับระบบ',
  description: 'แหล่งข้อมูล วิธีคำนวณระยะห่างตลิ่ง เกณฑ์ระดับสถานการณ์ ข้อจำกัดความรับผิดชอบ และนโยบายความเป็นส่วนตัว',
}

const SOURCES: { name: string; url: string; data: string; cadence: string; note?: string }[] = [
  {
    name: 'สำนักการระบายน้ำ กรุงเทพมหานคร',
    url: 'https://weather.bangkok.go.th/',
    data: 'ระดับน้ำคลองและประตูระบายน้ำ ระดับตลิ่ง ฝนรายสถานี น้ำท่วมถนน สถานีสูบน้ำ ภาพเรดาร์ฝนหนองจอกและหนองแขม',
    cadence: 'ประมาณ 5–15 นาที',
    note: 'เข้าถึงได้จากเครือข่ายในประเทศไทยเท่านั้น',
  },
  {
    name: 'สถาบันสารสนเทศทรัพยากรน้ำ (สสน.) — ThaiWater',
    url: 'https://www.thaiwater.net/',
    data: 'ระดับน้ำทั่วประเทศ ฝนสะสม 24 ชม. และสำเนาข้อมูลจุดวัดของ กทม.',
    cadence: 'ประมาณ 10–60 นาที',
    note: 'ใช้เป็นแหล่งสำรองเมื่อเข้าถึงข้อมูล กทม. ไม่ได้',
  },
  {
    name: 'Open-Meteo',
    url: 'https://open-meteo.com/',
    data: 'สภาพอากาศปัจจุบัน ความชื้น อุณหภูมิ และพยากรณ์ฝนรายชั่วโมง',
    cadence: 'ทุก 15 นาที',
    note: 'เป็นค่าจากแบบจำลอง ไม่ใช่การตรวจวัดจริง',
  },
  {
    name: 'RainViewer',
    url: 'https://www.rainviewer.com/',
    data: 'ภาพเรดาร์ฝนแบบเคลื่อนไหวย้อนหลังประมาณ 2 ชม.',
    cadence: 'ทุก 10 นาที',
  },
  {
    name: 'OpenStreetMap',
    url: 'https://www.openstreetmap.org/copyright',
    data: 'แผนที่พื้นฐาน © ผู้ร่วมพัฒนา OpenStreetMap (สัญญาอนุญาต ODbL)',
    cadence: '-',
  },
]

const HOTLINES: { no: string; who: string }[] = [
  { no: '1555', who: 'ศูนย์รับแจ้งเหตุ กรุงเทพมหานคร' },
  { no: '1784', who: 'กรมป้องกันและบรรเทาสาธารณภัย (ปภ.)' },
  { no: '1182', who: 'กรมอุตุนิยมวิทยา' },
  { no: '1669', who: 'เจ็บป่วยฉุกเฉิน (สพฉ.)' },
  { no: '191', who: 'เหตุด่วนเหตุร้าย (ตำรวจ)' },
]

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card px-4 py-5 sm:px-6">
      <h2 id={id} className="text-xl font-medium">
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3 leading-relaxed text-text-2">{children}</div>
    </section>
  )
}

/** Canal cross-section explaining freeboard (ระยะห่างตลิ่ง). */
function FreeboardDiagram() {
  return (
    <figure className="rounded-xl bg-card-2 p-3">
      <svg viewBox="0 0 570 205" className="block h-auto w-full" role="img" aria-labelledby="fb-title fb-desc">
        <title id="fb-title">ภาพตัดขวางคลองแสดงระยะห่างตลิ่ง</title>
        <desc id="fb-desc">ระยะห่างตลิ่งคือระยะแนวดิ่งจากผิวน้ำขึ้นไปถึงขอบตลิ่งฝั่งที่ต่ำกว่า</desc>
        {/* ground & banks */}
        <path d="M0 70 H120 L170 190 H350 L400 90 H570 V205 H0 Z" fill="var(--grid)" />
        <path d="M0 70 H120 L170 190 H350 L400 90 H570" fill="none" stroke="var(--axis)" strokeWidth="2" />
        {/* water */}
        <path d="M139 116 H379 L350 190 H170 Z" fill="var(--s1)" opacity="0.28" />
        <line x1="139" x2="379" y1="116" y2="116" stroke="var(--s1)" strokeWidth="2" />
        {/* lower bank reference */}
        <line x1="300" x2="570" y1="90" y2="90" stroke="var(--text-2)" strokeWidth="1" strokeDasharray="4 3" />
        {/* freeboard arrow */}
        <line x1="440" x2="440" y1="94" y2="112" stroke="var(--text)" strokeWidth="1.6" />
        <path d="M440 90 l-5 7 h10 Z M440 116 l-5 -7 h10 Z" fill="var(--text)" />
        <text x="452" y="107" fontSize="13" fill="var(--text)">
          ระยะห่างตลิ่ง
        </text>
        <line x1="379" x2="440" y1="116" y2="116" stroke="var(--text-2)" strokeWidth="1" strokeDasharray="4 3" />
        {/* labels */}
        <text x="8" y="60" fontSize="12.5" fill="var(--text-2)">
          ตลิ่งฝั่งซ้าย
        </text>
        <text x="408" y="80" fontSize="12.5" fill="var(--text-2)">
          ตลิ่งฝั่งขวา (ต่ำกว่า)
        </text>
        <text x="200" y="108" fontSize="12.5" fill="var(--text-2)">
          ผิวน้ำ (ระดับน้ำ)
        </text>
        <text x="215" y="160" fontSize="12.5" fill="var(--text)">
          คลอง
        </text>
      </svg>
      <figcaption className="mt-2 text-sm text-text-2">
        ระยะห่างตลิ่ง = ระดับตลิ่งฝั่งที่ต่ำกว่า − ระดับน้ำ (ทั้งสองค่าวัดเทียบระดับอ้างอิงเดียวกัน หน่วยเมตร)
      </figcaption>
    </figure>
  )
}

export default function AboutPage() {
  const fb = DEFAULT_FREEBOARD
  const rain = DEFAULT_RAIN
  const road = ROAD_FLOOD_CM
  return (
    <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-3 pt-4 pb-16 sm:px-4">
      <header>
        <h1 className="text-2xl font-medium">เกี่ยวกับระบบเฝ้าระวังน้ำท่วม</h1>
        <p className="mt-1 text-text-2">
          ระบบนี้รวบรวมข้อมูลระดับน้ำ ฝน และน้ำท่วมถนนจากหน่วยงานที่เชื่อถือได้ แล้วสรุปสถานการณ์รอบตำแหน่งที่คุณเลือก
          พร้อมแจ้งเตือนเมื่อสถานการณ์เปลี่ยน
        </p>
      </header>

      <section
        aria-labelledby="disclaimer"
        className="card border-l-4 px-4 py-4 sm:px-6"
        style={{ borderLeftColor: 'var(--lv-watch)' }}
      >
        <h2 id="disclaimer" className="text-lg font-medium">
          ข้อจำกัดความรับผิดชอบ
        </h2>
        <p className="mt-2 leading-relaxed text-text-2">
          ข้อมูลในระบบนี้ไม่ใช่ประกาศทางการ ใช้เพื่อประกอบการเฝ้าระวังเท่านั้น ข้อมูลอาจล่าช้า ขาดหาย หรือคลาดเคลื่อนจากเครื่องมือวัด
          โปรดติดตามประกาศของกรุงเทพมหานคร (@BKK_BEST) กรมอุตุนิยมวิทยา และกรมป้องกันและบรรเทาสาธารณภัย และปฏิบัติตามคำแนะนำของเจ้าหน้าที่
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {HOTLINES.map((h) => (
            <li key={h.no}>
              <a href={`tel:${h.no}`} className="flex items-center gap-3 rounded-xl bg-card-2 px-3 py-2 hover:bg-[color-mix(in_srgb,var(--card-2)_80%,var(--text))]">
                <span className="tabular text-xl font-semibold text-text">{h.no}</span>
                <span className="text-sm text-text-2">{h.who}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <Section id="sources" title="แหล่งข้อมูล">
        <div className="overflow-x-auto rounded-xl border border-border" tabIndex={0} role="region" aria-label="ตารางแหล่งข้อมูล">
          <table className="fm-table w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr>
                <th scope="col">แหล่งข้อมูล</th>
                <th scope="col">ข้อมูลที่ใช้</th>
                <th scope="col">ความถี่โดยประมาณ</th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((s) => (
                <tr key={s.name} className="align-top">
                  <th scope="row" className="font-medium text-text">
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-border underline-offset-4 hover:decoration-current">
                      {s.name}
                    </a>
                  </th>
                  <td className="text-text-2">
                    {s.data}
                    {s.note && <span className="mt-0.5 block text-xs text-muted">{s.note}</span>}
                  </td>
                  <td className="whitespace-nowrap text-text-2">{s.cadence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm">
          ระบบดึงข้อมูลอัตโนมัติเป็นระยะ ค่าที่เก่ากว่า 60 นาทีจะแสดงเป็น “ไม่มีข้อมูลล่าสุด” และไม่ถูกนำมาใช้แจ้งเตือน
        </p>
      </Section>

      <Section id="freeboard" title="อ่านค่าระยะห่างตลิ่งอย่างไร">
        <FreeboardDiagram />
        <ul className="list-disc space-y-1 pl-5">
          <li>ตัวเลขยิ่งน้อย ผิวน้ำยิ่งใกล้ขอบตลิ่ง เข็มบนแดชบอร์ดจะเลื่อนไปทางซ้าย (สีแดง)</li>
          <li>ค่าติดลบหมายถึงน้ำสูงกว่าตลิ่งแล้ว (ล้นตลิ่ง)</li>
          <li>ใช้ตลิ่งฝั่งที่ต่ำกว่าเสมอ เพราะน้ำจะล้นฝั่งนั้นก่อน</li>
          <li>หากค่าตลิ่งของหน่วยงานดูผิดปกติ ระบบจะจำกัดระดับไว้ไม่เกิน “เฝ้าระวัง” เพื่อป้องกันการเตือนผิดพลาด</li>
          <li>สถานะที่หน่วยงานประกาศเอง (เช่น “กทม.: วิกฤต”) แสดงไว้เพื่อประกอบเท่านั้น เพราะเกณฑ์ของบางสถานีไม่สอดคล้องกับระดับตลิ่ง</li>
          <li>แนวโน้ม “ขึ้น 4 ซม./ชม.” คำนวณจากระดับน้ำที่เปลี่ยนไปในช่วงประมาณ 1 ชั่วโมงล่าสุด</li>
        </ul>
      </Section>

      <Section id="levels" title="ระดับสถานการณ์ (ค่าเริ่มต้น)">
        <div className="overflow-x-auto rounded-xl border border-border" tabIndex={0} role="region" aria-label="ตารางเกณฑ์ระดับสถานการณ์">
          <table className="fm-table w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr>
                <th scope="col">ระดับ</th>
                <th scope="col">ระยะห่างตลิ่ง</th>
                <th scope="col">ฝนสะสม 24 ชม.</th>
                <th scope="col">น้ำบนถนน</th>
              </tr>
            </thead>
            <tbody className="tabular">
              <tr>
                <th scope="row" className="font-normal">
                  <LevelBadge level="normal" className="text-text" />
                </th>
                <td>≥ {fb.watch.toFixed(2)} ม.</td>
                <td>&lt; {rain.watch} มม.</td>
                <td>&lt; {road.watch} ซม.</td>
              </tr>
              <tr>
                <th scope="row" className="font-normal">
                  <LevelBadge level="watch" className="text-text" />
                </th>
                <td>&lt; {fb.watch.toFixed(2)} ม.</td>
                <td>≥ {rain.watch} มม. (ฝนหนัก)</td>
                <td>≥ {road.watch} ซม.</td>
              </tr>
              <tr>
                <th scope="row" className="font-normal">
                  <LevelBadge level="warning" className="text-text" />
                </th>
                <td>&lt; {fb.warning.toFixed(2)} ม.</td>
                <td>≥ {rain.warning} มม. (ฝนหนักมาก)</td>
                <td>≥ {road.warning} ซม.</td>
              </tr>
              <tr>
                <th scope="row" className="font-normal">
                  <LevelBadge level="critical" className="text-text" />
                </th>
                <td>&lt; {fb.critical.toFixed(2)} ม. หรือล้นตลิ่ง</td>
                <td>≥ {rain.critical} มม.</td>
                <td>≥ {road.critical} ซม.</td>
              </tr>
              <tr>
                <th scope="row" className="font-normal">
                  <LevelBadge level="unknown" className="text-text" />
                </th>
                <td colSpan={3} className="text-text-2">
                  ไม่มีข้อมูลล่าสุด เครื่องวัดขัดข้อง หรือไม่มีข้อมูลระดับตลิ่ง
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm">
          เกณฑ์ฝนอ้างอิงการแบ่งระดับของกรมอุตุนิยมวิทยา (ฝนหนัก 35.1–90.0 มม. ฝนหนักมาก 90.1 มม. ขึ้นไป) ปรับเกณฑ์ของคุณเองได้ที่{' '}
          <Link href="/alerts" className="text-text underline underline-offset-4">
            หน้าแจ้งเตือน
          </Link>
        </p>
      </Section>

      <Section id="alerts-how" title="การแจ้งเตือนทำงานอย่างไร">
        <ul className="list-disc space-y-1 pl-5">
          <li>แจ้งเมื่อจุดวัดใกล้บ้านขึ้นถึงระดับที่คุณเลือก (ค่าเริ่มต้น “เตือนภัย”) และแจ้งอีกครั้งเมื่อสถานการณ์คลี่คลาย</li>
          <li>ระหว่างระดับวิกฤต ระบบจะเตือนซ้ำทุก 3 ชั่วโมง</li>
          <li>แจ้งทันทีเมื่อน้ำขึ้นเร็วผิดปกติ (ค่าเริ่มต้น 10 ซม. ต่อชั่วโมง)</li>
          <li>ทุกเรื่องในรอบการตรวจเดียวกันจะรวมเป็นข้อความเดียว เพื่อไม่ให้ได้รับข้อความถี่เกินไป</li>
          <li>รับได้หลายช่องทาง: แจ้งเตือนบนอุปกรณ์ (Web Push), LINE, Telegram, ntfy, อีเมล และ Discord</li>
        </ul>
      </Section>

      <Section id="privacy" title="ความเป็นส่วนตัว">
        <ul className="list-disc space-y-1 pl-5">
          <li>ตำแหน่งบ้านที่ตั้งบนแดชบอร์ดถูกเก็บในเบราว์เซอร์ของคุณเท่านั้น ไม่ถูกบันทึกบนเซิร์ฟเวอร์</li>
          <li>
            เมื่อเปิดแดชบอร์ด เบราว์เซอร์จะส่งพิกัดไปยังเซิร์ฟเวอร์เพื่อค้นหาจุดวัดใกล้เคียง โดยไม่บันทึกลงฐานข้อมูล
            และส่งเฉพาะพิกัดโดยประมาณต่อให้ Open-Meteo เพื่อขอข้อมูลอากาศ
          </li>
          <li>แผนที่และเรดาร์โหลดภาพโดยตรงจาก OpenStreetMap และ RainViewer ซึ่งจะเห็นพื้นที่แผนที่ที่คุณเปิดดู</li>
          <li>หากตั้งค่าการแจ้งเตือน ระบบจะเก็บชื่อสถานที่ พิกัด เกณฑ์ และช่องทางแจ้งเตือนไว้บนเซิร์ฟเวอร์เพื่อใช้ส่งข้อความ ลบได้ทุกเมื่อที่หน้าแจ้งเตือน</li>
          <li>ลิงก์ “คัดลอกลิงก์” บนแดชบอร์ดมีพิกัดของตำแหน่งนั้น โปรดแชร์เฉพาะกับผู้ที่ไว้ใจ</li>
          <li>ระบบไม่ใช้คุกกี้ติดตามหรือโฆษณา</li>
        </ul>
      </Section>
    </main>
  )
}
