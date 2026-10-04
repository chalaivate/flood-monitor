import type { Metadata } from 'next'
import Link from 'next/link'
import { connection } from 'next/server'
import type { ReactNode } from 'react'
import { getConfig } from '@/lib/config'
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

/** Coordinates of one layout of the freeboard diagram (user units of its viewBox). */
interface DiagramLayout {
  id: string
  width: number
  height: number
  /** Ground outline: left bank top, channel bottom, right (lower) bank top. */
  ground: string
  water: { path: string; y: number; x1: number; x2: number }
  /** Dashed line at the lower bank's height. */
  bank: { y: number; x1: number; x2: number }
  /** Freeboard arrow (x, from bank height down to the water surface). */
  arrowX: number
  /** Optional dashed extension of the water level to the arrow. */
  waterExt?: { x1: number; x2: number }
  font: number
  labels: { x: number; y: number; text: string; anchor?: 'start' | 'end'; strong?: boolean }[]
  className: string
}

// The wide layout is unreadable when scaled to a phone (labels ~7px), so phones get a
// narrower drawing with the same labels; both keep labels >= 12 CSS px at their smallest
// size (wide: 536px at the sm breakpoint; narrow: 280px on a 360px screen).
const DIAGRAMS: DiagramLayout[] = [
  {
    id: 'fb-narrow',
    width: 320,
    height: 228,
    ground: 'M0 64 H56 L96 200 H226 L262 92 H320',
    water: { path: 'M73.6 124 H251.3 L226 200 H96 Z', y: 124, x1: 73.6, x2: 251.3 },
    bank: { y: 92, x1: 188, x2: 320 },
    arrowX: 200,
    font: 14,
    labels: [
      { x: 4, y: 52, text: 'ตลิ่งฝั่งซ้าย' },
      { x: 316, y: 62, text: 'ตลิ่งฝั่งขวา', anchor: 'end' },
      { x: 316, y: 82, text: '(ต่ำกว่า)', anchor: 'end' },
      { x: 192, y: 113, text: 'ระยะห่างตลิ่ง', anchor: 'end', strong: true },
      { x: 104, y: 148, text: 'ผิวน้ำ (ระดับน้ำ)', strong: true },
      { x: 146, y: 184, text: 'คลอง', strong: true },
    ],
    className: 'mx-auto block h-auto w-full max-w-[400px] sm:hidden',
  },
  {
    id: 'fb-wide',
    width: 570,
    height: 205,
    ground: 'M0 70 H120 L170 190 H350 L400 90 H570',
    water: { path: 'M139 116 H387 L350 190 H170 Z', y: 116, x1: 139, x2: 387 },
    bank: { y: 90, x1: 300, x2: 570 },
    arrowX: 440,
    waterExt: { x1: 387, x2: 440 },
    font: 14,
    labels: [
      { x: 8, y: 58, text: 'ตลิ่งฝั่งซ้าย' },
      { x: 408, y: 78, text: 'ตลิ่งฝั่งขวา (ต่ำกว่า)' },
      { x: 452, y: 108, text: 'ระยะห่างตลิ่ง', strong: true },
      { x: 196, y: 106, text: 'ผิวน้ำ (ระดับน้ำ)' },
      { x: 215, y: 160, text: 'คลอง', strong: true },
    ],
    className: 'hidden h-auto w-full sm:block',
  },
]

function DiagramSvg({ d }: { d: DiagramLayout }) {
  const { arrowX: x, bank, water } = d
  return (
    <svg viewBox={`0 0 ${d.width} ${d.height}`} className={d.className} role="img" aria-labelledby={`${d.id}-title ${d.id}-desc`}>
      <title id={`${d.id}-title`}>ภาพตัดขวางคลองแสดงระยะห่างตลิ่ง</title>
      <desc id={`${d.id}-desc`}>ระยะห่างตลิ่งคือระยะแนวดิ่งจากผิวน้ำขึ้นไปถึงขอบตลิ่งฝั่งที่ต่ำกว่า</desc>
      {/* ground & banks */}
      <path d={`${d.ground} V${d.height} H0 Z`} fill="var(--grid)" />
      <path d={d.ground} fill="none" stroke="var(--axis)" strokeWidth="2" />
      {/* water */}
      <path d={water.path} fill="var(--s1)" opacity="0.28" />
      <line x1={water.x1} x2={water.x2} y1={water.y} y2={water.y} stroke="var(--s1)" strokeWidth="2" />
      {/* lower bank reference */}
      <line x1={bank.x1} x2={bank.x2} y1={bank.y} y2={bank.y} stroke="var(--text-2)" strokeWidth="1" strokeDasharray="4 3" />
      {/* freeboard arrow */}
      <line x1={x} x2={x} y1={bank.y + 4} y2={water.y - 4} stroke="var(--text)" strokeWidth="1.6" />
      <path d={`M${x} ${bank.y} l-5 7 h10 Z M${x} ${water.y} l-5 -7 h10 Z`} fill="var(--text)" />
      {d.waterExt && (
        <line x1={d.waterExt.x1} x2={d.waterExt.x2} y1={water.y} y2={water.y} stroke="var(--text-2)" strokeWidth="1" strokeDasharray="4 3" />
      )}
      {d.labels.map((l) => (
        <text key={l.text} x={l.x} y={l.y} fontSize={d.font} textAnchor={l.anchor ?? 'start'} fill={l.strong ? 'var(--text)' : 'var(--text-2)'}>
          {l.text}
        </text>
      ))}
    </svg>
  )
}

/** Canal cross-section explaining freeboard (ระยะห่างตลิ่ง). */
function FreeboardDiagram() {
  return (
    <figure className="rounded-xl bg-card-2 p-3">
      {DIAGRAMS.map((d) => (
        <DiagramSvg key={d.id} d={d} />
      ))}
      <figcaption className="mt-2 text-sm text-text-2">
        ระยะห่างตลิ่ง = ระดับตลิ่งฝั่งที่ต่ำกว่า − ระดับน้ำ (ทั้งสองค่าวัดเทียบระดับอ้างอิงเดียวกัน หน่วยเมตร)
      </figcaption>
    </figure>
  )
}

const CAMERA_SOURCES: { name: string; owner: string; url: string; host: string }[] = [
  {
    name: 'กล้องเฝ้าระวังน้ำท่วม',
    owner: 'ระบบตรวจวัดน้ำท่วมถนน สำนักการระบายน้ำ กรุงเทพมหานคร',
    url: 'https://floodbangkok.bangkok.go.th/',
    host: 'floodbangkok.bangkok.go.th',
  },
  { name: 'กล้องสถานีโทรมาตรแม่น้ำ', owner: 'กรมทรัพยากรน้ำ', url: 'https://telemetry.dwr.go.th/reportCctv', host: 'telemetry.dwr.go.th' },
]

const CAMERA_LINKS: { name: string; url: string; host: string }[] = [
  { name: 'กล้องระดับน้ำ สำนักการระบายน้ำ', url: 'https://dds.bangkok.go.th/cctv.php', host: 'dds.bangkok.go.th/cctv.php' },
  { name: 'กล้องจราจร กทม.', url: 'http://www.bmatraffic.com/', host: 'bmatraffic.com' },
  { name: 'CCTV ลุ่มน้ำเจ้าพระยา กรมชลประทาน', url: 'https://wmsc.rid.go.th/cctv2/', host: 'wmsc.rid.go.th/cctv2' },
  { name: 'กล้องทางหลวง กรมทางหลวง', url: 'https://www.highwaytraffic.go.th/', host: 'highwaytraffic.go.th' },
]

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-text underline decoration-border underline-offset-4 hover:decoration-current">
      {children}
    </a>
  )
}

/** "ภาพจากกล้อง CCTV": sources, display conditions, privacy and the takedown contact. */
function CameraSection({ demo, contactEmail }: { demo: boolean; contactEmail: string | null }) {
  return (
    <Section id="cctv" title="ภาพจากกล้อง CCTV">
      <p>แอปนี้แสดงภาพนิ่งจากกล้องของหน่วยงานรัฐ เพื่อช่วยดูสภาพน้ำบนถนนและในแม่น้ำใกล้บ้าน ประกอบกับข้อมูลระดับน้ำ</p>
      {demo && (
        <p className="rounded-xl border border-border bg-card-2 px-3 py-2 text-sm text-text">
          โหมดสาธิต: ภาพกล้องทั้งหมดเป็นภาพจำลองที่ระบบสร้างขึ้น ไม่ใช่ภาพจากกล้องจริง
        </p>
      )}
      <ul className="list-disc space-y-1 pl-5">
        {CAMERA_SOURCES.map((c) => (
          <li key={c.host}>
            <span className="font-medium text-text">{c.name}:</span> {c.owner} (<ExtLink href={c.url}>{c.host}</ExtLink>)
          </li>
        ))}
        <li>
          <span className="font-medium text-text">ลิงก์ไปยังเว็บของหน่วยงาน:</span>{' '}
          {CAMERA_LINKS.map((l, i) => (
            <span key={l.host}>
              {i > 0 && ' · '}
              {l.name} (<ExtLink href={l.url}>{l.host}</ExtLink>)
            </span>
          ))}
        </li>
      </ul>
      <h3 className="mt-1 font-medium text-text">เงื่อนไขการแสดงภาพ</h3>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          ภาพเป็นลิขสิทธิ์และอยู่ในความรับผิดชอบของหน่วยงานเจ้าของกล้อง หน่วยงานเหล่านี้ไม่ได้รับรองหรือเกี่ยวข้องกับโครงการนี้
          (สถานะ: หน่วยงานยังไม่ได้เผยแพร่เงื่อนไขการใช้ภาพ)
        </li>
        <li>
          ภาพเป็นภาพนิ่งที่ดึงเป็นระยะ ไม่ใช่ภาพสด เวลาที่แสดงคือเวลาที่ระบบได้รับภาพ เว้นแต่ระบุว่า “ถ่าย”
          ซึ่งเป็นเวลาที่หน่วยงานบันทึก
        </li>
        <li>
          ระบบเก็บภาพล่าสุดของแต่ละกล้องไว้ในหน่วยความจำชั่วคราวไม่เกิน 15 นาที (กล้องกรมทรัพยากรน้ำไม่เกิน 1 ชั่วโมง) เพื่อลดภาระเซิร์ฟเวอร์ของหน่วยงาน
          ไม่บันทึกลงดิสก์หรือฐานข้อมูล ไม่มีภาพย้อนหลัง ไม่ขยายภาพ และไม่ใช้ระบบจดจำใบหน้าหรือป้ายทะเบียนรถ
        </li>
        <li>ระบบไม่บันทึกว่าผู้ใช้คนใดเปิดดูกล้องใด</li>
        <li>ภาพใช้ประกอบการดูสถานการณ์เท่านั้น สถานะและการแจ้งเตือนคำนวณจากระยะห่างตลิ่งของสถานีวัดระดับน้ำ ไม่ได้มาจากภาพกล้อง</li>
        <li>
          กล้องที่ติดต่อไม่ได้ ภาพค้าง หรือภาพเก่า <strong className="font-medium text-text">ไม่ได้แปลว่าไม่มีน้ำท่วม</strong>
        </li>
        <li>บางเซิร์ฟเวอร์แสดงได้เฉพาะลิงก์ไปยังเว็บของหน่วยงาน เพราะกล้องบางแหล่งเปิดให้เข้าถึงจากเครือข่ายในประเทศไทยเท่านั้น</li>
        <li>
          หากพบภาพที่กระทบความเป็นส่วนตัว หรือหน่วยงานเจ้าของกล้องต้องการให้หยุดแสดงภาพ ติดต่อ{' '}
          {contactEmail ? (
            <a href={`mailto:${contactEmail}`} className="text-text underline underline-offset-4">
              {contactEmail}
            </a>
          ) : (
            'ผู้ดูแลเว็บไซต์นี้'
          )}{' '}
          — เราจะปิดการแสดงภาพจากแหล่งนั้นทันที
        </li>
      </ul>
      <p className="text-sm">
        ระบบนี้ไม่ใช่ประกาศเตือนภัยทางการ — ติดตามประกาศ กทม. สายด่วน{' '}
        <a href="tel:1555" className="text-text underline underline-offset-4">
          1555
        </a>{' '}
        และ ปภ.{' '}
        <a href="tel:1784" className="text-text underline underline-offset-4">
          1784
        </a>
      </p>
    </Section>
  )
}

/** Plain address only (it is rendered into a mailto: link). */
function contactEmailOf(v: string | undefined): string | null {
  const s = v?.trim()
  return s && /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/.test(s) ? s : null
}

export default async function AboutPage() {
  // Rendered per request: the camera section and the contact address come from the server's
  // runtime settings, not from the build.
  await connection()
  const cfg = getConfig()
  const cameraSources = cfg.enabledCameraSources
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

      {cameraSources.length > 0 && <CameraSection demo={cameraSources.includes('demo-cam')} contactEmail={contactEmailOf(cfg.CONTACT_EMAIL)} />}

      <Section id="privacy" title="ความเป็นส่วนตัว">
        <ul className="list-disc space-y-1 pl-5">
          <li>ตำแหน่งบ้านที่ตั้งบนแดชบอร์ดถูกเก็บในเบราว์เซอร์ของคุณเท่านั้น ไม่ถูกบันทึกบนเซิร์ฟเวอร์</li>
          <li>
            เมื่อเปิดแดชบอร์ด เบราว์เซอร์จะส่งพิกัดไปยังเซิร์ฟเวอร์เพื่อค้นหาจุดวัดใกล้เคียง โดยไม่บันทึกลงฐานข้อมูล
            และส่งเฉพาะพิกัดโดยประมาณต่อให้ Open-Meteo เพื่อขอข้อมูลอากาศ
          </li>
          <li>แผนที่และเรดาร์โหลดภาพโดยตรงจาก OpenStreetMap และ RainViewer ซึ่งจะเห็นพื้นที่แผนที่ที่คุณเปิดดู</li>
          {cameraSources.length > 0 && (
            <li>ภาพกล้องที่แสดงในแอปโหลดผ่านเซิร์ฟเวอร์นี้ หน่วยงานเจ้าของกล้องจึงไม่เห็นตำแหน่งหรือที่อยู่ IP ของคุณ ส่วนลิงก์ “เปิดเว็บทางการ” จะเปิดเว็บของหน่วยงานโดยตรง แต่ไม่ส่งที่อยู่หน้านี้ (ซึ่งอาจมีพิกัดบ้าน) ไปด้วย</li>
          )}
          <li>หากตั้งค่าการแจ้งเตือน ระบบจะเก็บชื่อสถานที่ พิกัด เกณฑ์ และช่องทางแจ้งเตือนไว้บนเซิร์ฟเวอร์เพื่อใช้ส่งข้อความ ลบได้ทุกเมื่อที่หน้าแจ้งเตือน</li>
          <li>ลิงก์ “คัดลอกลิงก์” บนแดชบอร์ดมีพิกัดของตำแหน่งนั้น โปรดแชร์เฉพาะกับผู้ที่ไว้ใจ</li>
          <li>ระบบไม่ใช้คุกกี้ติดตามหรือโฆษณา</li>
        </ul>
      </Section>
    </main>
  )
}
