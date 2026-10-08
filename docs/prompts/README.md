# Prompt สำหรับสร้างแอปเฝ้าระวังน้ำท่วมใหม่ด้วย Claude Code

โฟลเดอร์นี้มี prompt 2 แบบ สำหรับวางใน Claude Code เพื่อสร้างแอปนี้ขึ้นใหม่ตั้งแต่ศูนย์
เนื้อหาสรุปจากโปรเจกต์นี้ (branch `claude/flood-early-warning` ถึง commit `b043467` ตรวจเมื่อ 2026-10-08)
ทั้งการออกแบบ, ค่าคงที่, endpoint ที่ตรวจแล้ว และบทเรียนจากการสร้างจริง

| ไฟล์ | ใช้เมื่อ |
|---|---|
| [`build-flood-monitor.md`](build-flood-monitor.md) | ต้องการแอปหลัก: ระดับน้ำ ฝน น้ำบนถนน อากาศ เรดาร์ แผนที่ และการแจ้งเตือน **ไม่มีกล้อง CCTV** |
| [`build-flood-monitor-cctv.md`](build-flood-monitor-cctv.md) | ต้องการแอปหลัก**และ**ภาพนิ่งจากกล้อง CCTV ของหน่วยงานรัฐ เนื้อหาคือ prompt แรกทั้งหมด (ส่วนที่ 1) ตามด้วยส่วนที่ 2: กล้อง CCTV |

## ควรเลือกแบบไหน

- **เริ่มจากแบบไม่มีกล้อง** ถ้ายังไม่แน่ใจ เพราะงานน้อยกว่า ความเสี่ยงด้านกฎหมายและความเป็นส่วนตัวน้อยกว่า และเพิ่มกล้องภายหลังได้
- **เลือกแบบมีกล้อง** เมื่อมีครบทุกข้อนี้:
  - มีเครื่องในไทยที่รันตลอด เช่น Docker (ภาพของ กทม. ดึงได้จาก IP ไทยเท่านั้น และแคชของภาพต้องอยู่ในโปรเซสที่รันตลอด)
  - พร้อมขออนุญาตหน่วยงานเจ้าของภาพก่อนเปิดสาธารณะ
  - มีช่องทางให้ผู้คนขอให้หยุดแสดงภาพได้ (`CONTACT_EMAIL`)
- ถ้าจะ deploy บน Vercel อย่างเดียว จะไม่มีรายชื่อกล้องเฝ้าระวังน้ำท่วม กทม. (`bma-floodcam` ต้องใช้เครื่องในไทย) เหลือเพียงลิงก์ของกล้อง DDS 6 ตัวและกล้องกรมทรัพยากรน้ำ การเลือกแบบมีกล้องจึงได้ประโยชน์น้อย
- prompt แบบมีกล้องตั้ง `CCTV_IMAGES=0` (ลิงก์อย่างเดียว) เป็นค่าเริ่มต้นทุกเครื่องในโหมด live คุณต้องเปิดภาพเองหลังได้รับอนุญาต

## วิธีใช้ใน Claude Code

### กรณีที่ 1: เริ่มจาก repo ว่าง

1. สร้างโฟลเดอร์ใหม่และ `git init` แล้วเปิด Claude Code ในโฟลเดอร์นั้น
2. **เปิด plan mode ก่อนวาง prompt** เพื่อให้ Claude อ่านและวางแผนโดยยังไม่แก้ไฟล์
   (ใน terminal กด Shift+Tab จนขึ้น plan mode หรือพิมพ์ขอให้วางแผนก่อนก็ได้)
3. วางเนื้อหาไฟล์ prompt **ทั้งไฟล์** ครั้งเดียว
4. Claude จะตอบกลับด้วยสรุป คำถาม (หัวข้อ 13 และถ้าใช้แบบมีกล้อง C14) และแผนตาม phase
   - ตอบคำถามให้ครบ โดยเฉพาะเรื่องรูปแบบ deploy, นโยบาย header ของ กทม. และการขออนุญาตหน่วยงาน
   - แล้วจึงอนุมัติแผน
5. **ให้ทำทีละ phase** (ตรวจแหล่งข้อมูล → ออกแบบ → สร้าง → ทดสอบ → review → รันจริงและดู)
   - จบแต่ละ phase Claude ต้องรัน gate แล้ว commit และรายงานว่าอะไรทดสอบแล้วหรือยังไม่ได้ทดสอบ
   - อ่านรายงานก่อนพิมพ์ให้ทำ phase ถัดไป
6. **ใช้ session เดิมตลอดทุก phase** เพื่อให้ Claude จำการตัดสินใจก่อนหน้าได้
   - prompt สั่งให้ commit ตัว prompt เป็น `docs/BUILD-SPEC.md` (ส่วนที่ 2 เป็น `docs/BUILD-SPEC-CCTV.md`) และเขียน `CLAUDE.md` ใน commit แรก พร้อมเก็บแผนและ contracts เป็นไฟล์ใน repo
   - ถ้า context ถูกย่อหรือ session หยุด ให้เปิด session ใหม่ในโฟลเดอร์เดิม แล้วสั่งว่า "อ่าน `docs/BUILD-SPEC*.md` แผน และ docs ใน repo แล้วทำต่อจาก phase ที่ค้าง"
7. Claude จะถามก่อนทำทุกอย่างที่ออกนอกเครื่อง (push, deploy, สร้าง resource บน cloud, ส่งการแจ้งเตือนจริง) ให้ตอบเองทุกครั้ง

**Gate** ที่ทุก commit ต้องผ่าน:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

### กรณีที่ 2: เพิ่มกล้องให้แอปที่สร้างจาก prompt แรกแล้ว

1. เปิด `build-flood-monitor-cctv.md` แล้วคัดลอก**เฉพาะส่วนที่ 2**
   - ตั้งแต่บรรทัด `<!-- CCTV-ADDON:START -->` (หรือป้าย **[เริ่มส่วนที่ 2: กล้อง CCTV]**)
   - ถึงบรรทัด `<!-- CCTV-ADDON:END -->` (หรือป้าย **[จบส่วนที่ 2: กล้อง CCTV]**)
2. เปิด Claude Code ใน repo ของแอปเดิม เปิด plan mode แล้ววางส่วนนั้น
3. ส่วนที่ 2 เขียนให้ใช้แยกได้:
   - หัวข้อ C1 สั่งให้อ่าน docs, contracts และ Store interface ของแอปเดิมก่อน
   - แล้วสรุปจุดเชื่อม (Store `meta`, ขั้นตอนท้าย poll cycle, payload ของ `/api/ingest`, `TRUST_PROXY`, rate limiter, โหมดสาธิต)
   - ถ้าแอปเดิมไม่มีจุดไหน Claude จะถามก่อน
4. ทำตามลำดับ rollout ในหัวข้อ C11
   - ขั้นแรก Claude จะเขียนเครื่องมือ probe ตามหัวข้อ C10 (`npm run cctv:probe` ยังไม่มีในแอปที่สร้างจาก prompt แรก) แล้วคุณรันจากเครื่องในไทยและส่งผลกลับ
   - ให้ส่งมอบแบบลิงก์ก่อน แล้วค่อยเปิดภาพ

## สิ่งที่ต้องเตรียม

- **Node.js 22.13 ขึ้นไป** (แอปใช้ `node:sqlite`)
- **เครื่องที่ใช้ IP ในไทย** สำหรับข้อมูลของ กทม. (`*.bangkok.go.th`)
  - session ของ Claude Code บน cloud และ CI เรียก endpoint เหล่านี้ไม่ได้
  - Claude จะเขียน probe script ให้คุณรันบนเครื่องในไทย probe จะเขียน response ลง `tests/fixtures/` บน clone ของคุณ แล้วคุณ commit หรือคัดลอกไฟล์กลับมา (ไม่ต้องวาง JSON ยาวในแชต)
  - ระหว่างรอผล Claude ทำแหล่ง cloud และโหมดสาธิตไปก่อนได้
- **โดเมนที่มี HTTPS** ถ้าจะใช้ Web Push, PWA, ปุ่มตำแหน่งปัจจุบัน หรือ webhook ของ LINE/Telegram
- **key ของช่องทางแจ้งเตือนที่ต้องการ**
  - VAPID: หลัง Claude สร้าง script แล้ว ให้รัน `npm run --silent vapid >> .env` เอง อย่าให้ Claude รัน เพราะ private key จะไปอยู่ในแชต
  - LINE Official Account + Messaging API
  - Telegram bot
  - Resend
  - ใส่ใน `.env` เอง ห้ามวางในแชต
- **การอนุญาตจากหน่วยงาน** ก่อนเปิดสาธารณะ
  - ข้อมูล: สำนักการระบายน้ำ กทม. และ สสน.
  - ภาพกล้อง: สำนักการระบายน้ำ กทม. และกรมทรัพยากรน้ำ
  - ช่องทางติดต่ออยู่ใน `docs/DATA-SOURCES.md` และ `docs/DEPLOY.md` ของ repo นี้

## ต้องตรวจซ้ำก่อนเชื่อ

prompt ระบุวันที่กำกับข้อมูลที่เปลี่ยนได้ และสั่งให้ Claude ตรวจทุก endpoint ซ้ำในขั้นแรก รายการที่ควรดูเป็นพิเศษ (วันที่เป็นเวลาไทย):

| เรื่อง | สถานะที่บันทึกไว้ | วันที่ |
|---|---|---|
| endpoint ของ กทม. (`weather.bangkok.go.th`, `dds.bangkok.go.th`, `floodbangkok.bangkok.go.th`) | เป็น API ภายในของหน้าเว็บ ไม่ใช่ API ทางการ ตอบเฉพาะ IP ไทย · ต้นแบบยังไม่เคยเรียก `weather.bangkok.go.th` เองจาก IP ไทย | ต.ค. 2026 |
| อัตรา 403 ของ `weather.bangkok.go.th` | มีบันทึกว่าตอบ 403 ราว 9–12% แม้จาก IP ไทย (ไม่มีแหล่งหรือผลวัด) | ไม่ระบุแหล่ง (บันทึก 2026-10-03) |
| `thaiwater-canal` (สำเนาคลอง กทม. บน ThaiWater) | บุคคลที่สาม (ไฟล์สถานะบอท GitHub Actions) รายงานว่าข้อมูลค้างตั้งแต่ 2026-09-28 13:30 ถ้ายังค้าง แบบ cloud อย่างเดียวจะไม่มีข้อมูลคลอง กทม. ที่สด | รายงานบุคคลที่สาม 2026-10-03 (ยังไม่ยืนยัน) |
| ThaiWater `/public/canal_waterlevel`, `/public/flood_road` | fixture ของต้นแบบสร้างจากชื่อฟิลด์ ไม่ใช่ response จริง (ThaiWater relaunch เมื่อ 2026-07-17) | 2026-09-28 |
| RainViewer | ตั้งแต่ 2026-01-01 ฟรีเฉพาะส่วนบุคคลหรือการศึกษา, zoom ≤ 7 และไม่มี nowcast · ถ้าเปิดสาธารณะให้ตั้ง `RAINVIEWER=0` | 2026-01-01 |
| ภาพนิ่ง `bma-floodcam` | proxy ของ floodbangkok ตอบ HTTP 500 ทั้ง 2 กล้องที่ทดสอบ (รายชื่อ 876 กล้องยังอ่านได้) | 2026-10-06 |
| ภาพนิ่ง `bma-ddscam` | `cctv1`/`cctv2` ตอบ JPEG แต่บุคคลที่สามรายงานว่าภาพใหม่สุดลงวันที่ 28 ส.ค. (ยังไม่ยืนยัน) · กล้อง 3–6 ยังไม่ทดสอบ · ตำแหน่งยังไม่ยืนยัน | 2026-10-06 / 2026-09-28 |
| ภาพนิ่ง `dwr-cctv` | ได้ภาพจาก IP ไทย · จาก cloud ยังไม่ยืนยัน | 2026-10-06 |
| LINE Notify | ปิดแล้ว ต้องใช้ LINE OA + Messaging API | 2025-03-31 |
| Next.js | ต้นแบบใช้ 16.3.8 · prompt สั่งให้ scaffold ด้วยรุ่นนี้ ถามก่อนใช้ major ที่ใหม่กว่า และอ่าน `node_modules/next/dist/docs/` ก่อนเขียนโค้ด เพราะ API ต่างจากรุ่นเก่า | 2026-10 |

สิ่งที่ต้นแบบ**ยังไม่เคยทดสอบจริง** (Claude ควรรายงานเรื่องเดียวกันในแอปใหม่):
- ดึงข้อมูล กทม. จาก IP ไทยภายใน session
- ส่ง LINE, Telegram และ e-mail จริง
- build Docker image จริง

## ที่มาของเนื้อหาใน prompt

ค่าใน prompt มาจากไฟล์ใน repo นี้ (commit `b043467`) ยกเว้นข้อที่มีป้าย **ข้อกำหนดใหม่** ซึ่งเพิ่มจากการตรวจทาน prompt (2026-10-08) และยังไม่มีในต้นแบบ:
นโยบาย header ที่บอกตัวตน, การปิด endpoint ที่ตรวจไม่ผ่าน, ป้ายข้อมูลสำรองของแบบ C และ `CCTV_IMAGES=0` เป็นค่าเริ่มต้น
ถ้าแก้โค้ดแล้วค่าเปลี่ยน ให้แก้ prompt ตาม

| หัวข้อใน prompt | ที่มาหลัก |
|---|---|
| กฎที่ห้ามละเมิด | `CLAUDE.md`, `AGENTS.md`, `docs/DESIGN.md:24-27`, `src/lib/store/index.ts:23-37` |
| แหล่งข้อมูล และการแปลงข้อมูล | `docs/DATA-SOURCES.md:9-68`, `docs/SOURCES-CATALOG.md:1-24`, `src/lib/sources/bma-canal.ts`, `src/lib/sources/bma-misc.ts`, `src/lib/sources/thaiwater.ts`, `src/lib/sources/http.ts`, `src/lib/pipeline.ts:78-153` |
| ฟิลด์ของ กทม. (หัวข้อ 3.5) | `tests/fixtures/bma-*.json`, `tests/sources-bma-canal.test.ts:6`, `tests/sources-bma-misc.test.ts:5-6`, `src/lib/sources/bma-canal.ts:73-127`, `src/lib/sources/bma-misc.ts` |
| โหมดสาธิต | `src/lib/sources/demo.ts:7-50`, `src/lib/config.ts:124-125,163-167`, `docs/DEPLOY.md:57` |
| อากาศและเรดาร์ | `src/lib/weather/openmeteo.ts`, `src/lib/server/weather-cache.ts`, `src/lib/server/radar-proxy.ts`, `src/lib/ui/rainviewer.ts`, `src/components/dashboard/RadarCard.tsx:11-14`, `docs/SOURCES-CATALOG.md:248` |
| สถาปัตยกรรม และ config | `package.json`, `src/lib/config.ts`, `src/lib/store/*`, `supabase/migrations/*`, `src/lib/server/poller.ts`, `worker/poll.ts`, `docs/DESIGN.md:187-247` |
| สถานะ | `src/lib/types.ts:26-148`, `src/lib/engine/status.ts`, `src/lib/engine/snapshot.ts`, `src/lib/server/validation.ts:8-88` |
| การแจ้งเตือน | `src/lib/engine/alerts.ts`, `src/lib/pipeline.ts:239-389`, `src/lib/notify/*`, `src/lib/server/channels.ts`, `docs/ALERTS.md` |
| หน้าจอ | `docs/DESIGN.md:248-302`, `src/app/globals.css`, `src/components/**`, `tests/ui-round3.test.ts` |
| deploy | `docs/DEPLOY.md:1-208`, `Dockerfile`, `docker-compose.yml`, `vercel.json`, `scripts/demo.mjs`, `.devcontainer/devcontainer.json` |
| ความปลอดภัย | `src/lib/server/rate-limit.ts`, `src/lib/server/http.ts:120-183`, `src/lib/server/net.ts`, `src/lib/server/auth.ts`, `docs/DEPLOY.md:209-225` |
| ส่วนที่ 2: กล้อง CCTV | `docs/DESIGN.md:67-153,201-212,269-280`, `docs/DATA-SOURCES.md:70-121`, `docs/DEPLOY.md:226-284`, `src/lib/server/cctv-proxy.ts`, `src/lib/cameras/catalog.ts`, `src/lib/sources/cameras/*` (ตาราง DDS: `dds.ts:51-75`), `src/lib/ui/cctv.ts`, `tests/ui-cctv.test.ts:92-93`, `worker/cctv-probe.ts` |
| บทเรียน | ข้อความ commit `2cfa6f8`, `5c0e7e3`, `b335404`, `d1be577`, `98161c2`, `4f6d0a4`, `b8fdf93`, `550a117`, `9f3e6e2`, `e094775`, `93785e3`, `b043467` · บทเรียน `npm audit` ยังไม่มีหลักฐานใน repo (prompt บอกให้ตรวจซ้ำ) |

## การดูแล prompt

- `build-flood-monitor-cctv.md` = `build-flood-monitor.md` + ส่วนที่ 2 ถ้าแก้ส่วนที่ 1 ต้องแก้ทั้งสองไฟล์ให้ตรงกัน
- ส่วนที่ 1 ของสองไฟล์ต่างกันแค่ 5 จุด:
  - ชื่อเรื่อง และกล่องคำอธิบายด้านบน
  - ข้อ "ขอบเขต" ในหัวข้อ 0
  - การอ้างถึง C11/C14 ในข้อ plan mode
  - ตำแหน่งการ์ดกล้องในลำดับของ dashboard (หัวข้อ 7)
  - ข้อ "ไม่ต้องทำ" ในหัวข้อ 12
- ห้ามใส่ e-mail, token, key หรือที่อยู่สตรีมกล้องลงใน prompt
- ห้ามใส่ชื่อรุ่นของโมเดลลงใน prompt
- ข้อที่ไม่มีในต้นแบบต้องมีป้าย **ข้อกำหนดใหม่** ข้อเท็จจริงจากบุคคลที่สามหรือที่ยังไม่ได้ตรวจเองต้องบอกไว้พร้อมวันที่
- เมื่อมีผล probe ใหม่ หรือแหล่งข้อมูลเปลี่ยน ให้แก้ตาราง "ต้องตรวจซ้ำก่อนเชื่อ" และวันที่ใน prompt ไปพร้อมกัน
