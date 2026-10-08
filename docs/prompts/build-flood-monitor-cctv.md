# Prompt: สร้างเว็บแอปเฝ้าระวังน้ำท่วม (Flood Monitor) แบบมีกล้อง CCTV

> วางข้อความทั้งหมดนี้ใน Claude Code session ใหม่ใน repo ว่าง
> ข้อเท็จจริงมาจากโปรเจกต์ต้นแบบที่สร้างและทดสอบช่วง 2026-10-03 ถึง 2026-10-06 (เวลาไทย) · ตรวจทาน prompt 2026-10-08
> ข้อที่มีป้าย **ข้อกำหนดใหม่** ไม่มีในต้นแบบ ต้องสร้างเพิ่ม
> ค่าที่มีวันที่กำกับต้องตรวจซ้ำก่อนเชื่อ · วันที่เป็น ค.ศ. เวลาไทย (พ.ศ. 2569 = 2026)
>
> prompt นี้มี 2 ส่วน:
> - **ส่วนที่ 1** (หัวข้อ 0–13) คือแอปหลัก เนื้อหาเหมือน prompt แบบไม่มีกล้อง ต่างกันแค่เรื่องขอบเขต
> - **ส่วนที่ 2** (หัวข้อ C1–C14) คือกล้อง CCTV อยู่ระหว่างเครื่องหมาย `CCTV-ADDON:START` และ `CCTV-ADDON:END`

> **ส่วนที่ 1: แอปหลัก**

## 0. วิธีทำงาน

- **ขอบเขต**: ทำส่วนที่ 1 (แอปหลัก) ให้ผ่านเกณฑ์ส่งมอบในหัวข้อ 11 ก่อน แล้วจึงทำส่วนที่ 2 (กล้อง CCTV) ใน session เดียวกัน
  ให้ส่วนที่ 1 มีจุดเชื่อมที่ส่วนที่ 2 ใช้: Store มี key-value `meta`, poll cycle ต่อขั้นตอนท้ายรอบได้, payload ของ `/api/ingest` เพิ่มฟิลด์ได้
- **เริ่มใน plan mode** ตอบกลับด้วยสรุปสิ่งที่จะสร้าง คำถามจากหัวข้อ 13 และ C14 และแผนตามหัวข้อ 10 และ C11 แล้วรออนุมัติก่อนเขียนโค้ด
- **ทำทีละ phase** จบด้วย gate → commit → รายงานว่าทำอะไร ทดสอบอะไร และ**อะไรที่ยังไม่ได้ทดสอบ**
- **เก็บ spec, แผน และ contracts เป็นไฟล์ใน repo** เพื่อทำต่อได้ถ้า context ถูกย่อหรือเปิด session ใหม่
  - commit แรก: บันทึก prompt นี้ทั้งฉบับแบบไม่แก้เป็น `docs/BUILD-SPEC.md` (ถ้ามีส่วนที่ 2 ให้แยกส่วนที่ 2 เป็น `docs/BUILD-SPEC-CCTV.md`)
  - เขียน `CLAUDE.md` ที่มีกฎหัวข้อ 2 และ gate ของหัวข้อ 10 · เริ่ม session ใหม่ทุกครั้งให้อ่าน `docs/BUILD-SPEC*.md` ก่อน
- **ถ้าผลตรวจจริงขัดกับ prompt** ให้เชื่อผลจริง บันทึกพร้อมวันที่ใน `docs/DATA-SOURCES.md` แล้วแจ้งเจ้าของ ห้ามเดา endpoint หรือชื่อฟิลด์

## 1. เป้าหมายและผู้ใช้

- เว็บแอปภาษาไทยเตือนภัยน้ำท่วมล่วงหน้า
  - ผู้ใช้เลือกตำแหน่ง ("บ้าน")
  - แอปติดตามจุดวัดที่ใกล้ที่สุด บอกสถานะเป็นภาษาคน และแจ้งเตือนเมื่อสถานการณ์เปลี่ยน
- **ข้อมูลเชื่อถือได้**: มาจากหน่วยงานรัฐโดยตรง ทุกค่ามีที่มาและอายุข้อมูล ข้อมูลที่ขาดต้องแสดงว่าขาด
- **พื้นที่**: เริ่มที่กรุงเทพฯ (ข้อมูลสำนักการระบายน้ำ กทม. ละเอียดสุด) แล้วขยายทั่วประเทศผ่าน ThaiWater ของ สสน.
- **การแจ้งเตือน**: Web Push, LINE, Telegram, ntfy, e-mail, Discord โดยไม่ต้องมีบัญชี
- **หน้าตา**: dashboard แบบ Home Assistant (การ์ด, gauge ครึ่งวงกลม, ธีมมืด) ออกแบบสำหรับมือถือก่อน และเป็น PWA
- **ไม่ใช่ประกาศทางการ**: บอกทุกหน้าและทุกข้อความ พร้อมสายด่วน กทม. 1555, ปภ. 1784

## 2. ข้อกำหนดที่ห้ามละเมิด

1. **สถานะมาจาก freeboard** = ตลิ่งฝั่งที่ต่ำกว่า − ระดับน้ำ (เมตร ติดลบ = ล้นตลิ่ง)
   - เกณฑ์ warning/critical, `txtStatus` ของ กทม. และ `situation_level` ของ ThaiWater เป็นข้อมูลประกอบในวงเล็บเท่านั้น
   - 2026-09-28 กทม. ติด "วิกฤต" 97 จาก 312 จุด เพราะหลายจุดเป็นระดับควบคุมการระบายน้ำ
2. **`*.bangkok.go.th` ตอบเฉพาะ IP ไทย** ห้ามสมมติว่าเรียกได้จาก CI, Vercel, cloud หรือ sandbox นี้ ต้องมีเครื่องดึงข้อมูลในไทยหรือ relay ตั้งแต่วันแรก
3. **โหมดสาธิต `DATA_MODE=fixture`** (ข้อมูลจำลอง)
   - มีป้าย "ข้อมูลตัวอย่าง" ทุกหน้าและทุกป้ายที่มา
   - ใช้ไฟล์ SQLite แยก `flood-demo.db` และปฏิเสธเมื่อใช้คู่กับ `STORE=supabase`
   - ห้ามให้เครดิตข้อมูลจำลองแก่หน่วยงานจริง
   - ตัวสร้างข้อมูลจำลอง: ใช้ metadata ของสถานีจริงเท่านั้น (ชื่อ พิกัด ตลิ่ง) ค่าทั้งหมดจำลอง · พายุวนรอบแบบ deterministic ที่ผ่านทุกระดับ · place เริ่มต้นของโหมดนี้อยู่กลางชุดข้อมูล
   - ต้นแบบ: จุดวัดคลอง กทม. 17 จุดรอบประเวศ (metadata 2026-09-28), พายุทุก ~61 ชม., place เริ่มต้น `13.7208, 100.683` "บ้าน (ตัวอย่าง) ประเวศ"
4. **Tests ห้ามแตะเครือข่าย**
   - inject `fetch`, `sleep`, `now`, DNS lookup
   - ใช้ response จริงใน `tests/fixtures/` ส่วน fixture ที่สังเคราะห์ต้องมี `_fixture_note`
   - route test ให้ stub fetch ที่ throw เมื่อเจอ URL ที่ไม่รู้จัก
5. **ภาษา**: ข้อความที่ผู้ใช้เห็น (UI, การแจ้งเตือน, bot, error, docs) เป็นภาษาไทย โค้ดและคอมเมนต์เป็นภาษาอังกฤษ
6. **Next.js รุ่นนี้ต่างจากที่คุณรู้**
   - repo ว่างยังไม่มี `node_modules` ให้ scaffold ด้วยรุ่นที่ต้นแบบทดสอบ (2026-10): `next@^16.3.8`, `react@^19.3`, `eslint-config-next@^16.3.8` · ถามเจ้าของก่อนใช้ major ที่ใหม่กว่า
   - หลังติดตั้งให้อ่าน `node_modules/next/dist/docs/` ก่อนใช้ API ของ Next · ถ้า docs ที่ติดตั้งขัดกับ prompt ให้เชื่อ docs
   - คำแนะนำ ณ Next 16.3.8 (2026-10): `params` เป็น Promise, ใช้ `proxy.ts` แทน middleware, ใช้ ESLint CLI แทน `next lint`
   - เก็บบล็อก `AGENTS.md` ที่ `next dev` เขียนไว้
7. **ความลับและลิขสิทธิ์**
   - ห้าม commit secret, `.env` หรือข้อมูลส่วนบุคคล
   - ห้ามใช้ token ที่ฝังในโค้ดหรือหน้าเว็บของโครงการอื่น และห้ามคัดลอกโค้ดจาก repo ที่ไม่มี LICENSE
   - ห้ามปิด TLS verification (ถ้า chain ไม่ครบให้ใช้ `NODE_EXTRA_CA_CERTS`)
8. **ถามก่อนทำสิ่งที่ออกนอกเครื่อง**: push, deploy, แก้ resource บน cloud, ส่งการแจ้งเตือนจริง, ติดต่อหน่วยงาน

## 3. แหล่งข้อมูล

**ตรวจทุก endpoint ซ้ำก่อนเชื่อ** ที่มาของข้อมูลด้านล่าง:
- endpoint ของ `weather.bangkok.go.th` รู้จากโค้ด/capture ของโครงการอื่น (~2026-09-28) ต้นแบบ**ยังไม่เคยเรียกเองจาก IP ไทย**
- ThaiWater `canal_waterlevel` และ `flood_road`: fixture ของต้นแบบสร้างจากชื่อฟิลด์ ไม่ใช่ response จริง

วิธีตรวจ:
- เรียกจริงจากเครื่องที่เรียกได้ แล้วบันทึก response ลง `tests/fixtures/` และบันทึกผลพร้อมวันที่
- ถ้าเครื่องคุณไม่ใช่ IP ไทย ให้เขียน probe script (ปิดบัง cookie/token) ให้เจ้าของรันจากเครื่องในไทย
  - probe เขียน body ดิบของแต่ละ endpoint ลง `tests/fixtures/<source>.json` บน clone ของเจ้าของ (ตัดเหลือ N แถว ไม่มี cookie/token)
  - เจ้าของ commit หรือคัดลอกไฟล์เหล่านั้นกลับมา ไม่ต้องวาง JSON ยาวในแชต
- **ระหว่างรอผล probe ไม่ต้องหยุด**: ทำแหล่ง cloud (ThaiWater, Open-Meteo) และโหมดสาธิตก่อน · เขียน adapter ของ กทม. กับ fixture ที่สังเคราะห์จากหัวข้อ 3.5 (มี `_fixture_note`) แล้วแทนด้วย body จริงเมื่อได้ผล
- **endpoint ที่ตรวจไม่ผ่าน** (ตอบผิดรูป ค้าง หรือถูกปฏิเสธ) **ข้อกำหนดใหม่**:
  - ปิดเป็นค่าเริ่มต้น ไม่อยู่ใน `SOURCES` ค่าเริ่มต้นและไม่นับในเกณฑ์ส่งมอบ แต่เก็บ adapter ไว้เปิดผ่าน config ได้
  - บันทึกพร้อมวันที่ใน `docs/DATA-SOURCES.md` และ docs ของรูปแบบ B/relay/C ต้องบอกว่าข้อมูลส่วนไหนจะขาด
  - ถามเจ้าของก่อนลบ adapter

### 3.1 จุดวัด

- `StationKind` = `canal | river | pump | roadflood | rain`
- ThaiWater base `https://api-v3.thaiwater.net/api/v1/thaiwater30` (ไม่ต้องใช้ key)

| Source id | Endpoint | ได้อะไร | จาก cloud |
|---|---|---|---|
| `bma-canal` | `POST https://weather.bangkok.go.th/water/PageMap/GoogleMap` · `Content-Type: application/x-www-form-urlencoded; charset=UTF-8` · body ตรงตัว `payload=` · ได้ JSON array (ตัด BOM ก่อน parse) | ระดับน้ำคลอง/ประตูระบายน้ำ ~312 จุด ทุก 5 นาที | ไม่ได้ |
| `bma-rain` | `POST …/rain/PageMap/GetDataForUpdate` | ฝน ~122 สถานี | ไม่ได้ |
| `bma-roadflood` | `GET …/Flood/PageMap/GetData?id=0` → `{dtTbl}` | น้ำบนถนน/อุโมงค์ ~251 จุด | ไม่ได้ |
| `bma-pump` | `GET …/Station/Map/GetData?id=0` → `{waterTbl, LastPump}` | สถานีสูบ | ไม่ได้ |
| `thaiwater-canal` | `/public/canal_waterlevel` | สำเนาคลอง กทม. ~282 จุด · **บุคคลที่สาม (ไฟล์สถานะบอท GitHub Actions) รายงานเมื่อ 2026-10-03 ว่าค้างตั้งแต่ 2026-09-28 13:30 — ต้นแบบยังไม่ได้ตรวจเอง** | ได้ |
| `thaiwater-wl` | `/provinces/waterlevel?province_code=XX` หรือ `/public/waterlevel_load` | ระดับน้ำ ม.รทก. | ได้ |
| `thaiwater-rain` | `/provinces/rain24?include_zero=1&province_code=XX` หรือ `/public/rain_24h` | ฝน 24 ชม. และ 1 ชม. | ได้ |
| `thaiwater-road` | `/public/flood_road` | สำเนาน้ำบนถนน ~262 จุด | ได้ |

- `THAIWATER_PROVINCES` ค่าเริ่มต้น `10,11,12,13` (กรุงเทพฯ สมุทรปราการ นนทบุรี ปทุมธานี) ถ้าเป็น `all` ใช้ feed ทั้งประเทศ (2–5 MB)
- fixture ของ `thaiwater-canal` และ `thaiwater-road` ในต้นแบบสร้างจากชื่อฟิลด์ ต้องจับ response จริงก่อน

### 3.2 การเรียก HTTP

- **นโยบาย header ของหน่วยงาน** ใช้นโยบายเดียวกับทุกคำขอไป `*.bangkok.go.th` (ข้อมูล เรดาร์) และไปแหล่งภาพกล้อง · ThaiWater มีกติกาของตัวเองด้านล่าง · ยืนยันกับเจ้าของในหัวข้อ 13
  - **ค่าเริ่มต้น (ข้อกำหนดใหม่)**: UA ที่บอกตัวตน `flood-monitor/0.1 (+<PUBLIC_BASE_URL หรือ repo url>)`, `Accept: application/json`, `Accept-Language: th-TH` · ไม่ปลอม Origin, Referer หรือ `X-Requested-With` · ไม่อุ่น cookie ของ WAF
  - **403 หรือหน้า challenge = หยุดและรายงานเจ้าของ** (health บอกเหตุผล) ห้ามหาทางเลี่ยง
  - **แบบเลียนเบราว์เซอร์ (ต้นแบบใช้แบบนี้)** ใช้ได้เมื่อเจ้าของเลือกเองเท่านั้น บันทึกใน `docs/DATA-SOURCES.md` และควรได้อนุญาตจากหน่วยงานก่อน:
    - UA แบบเบราว์เซอร์ลงท้าย `flood-monitor/0.1`, `Accept: application/json, text/javascript, */*; q=0.01`
    - Referer = หน้าเว็บของข้อมูล (`/water`, `/rain`, `/flood/`, `/station`), `Origin: https://weather.bangkok.go.th`, `X-Requested-With: XMLHttpRequest`
    - เจอ 403 ครั้งแรกให้ GET หน้าเว็บนั้นหนึ่งครั้งเพื่อเก็บ cookie แล้ว retry
- **retry ของ กทม.**
  - retry หลัง 5 และ 15 วินาที เมื่อเจอ network error หรือ 5xx (retry 403 เฉพาะแบบเลียนเบราว์เซอร์ที่เจ้าของเลือก)
  - ห้าม retry 429
  - มีรายงาน (ต้นแบบยังไม่ได้วัดเอง) ว่า `weather.bangkok.go.th` ตอบ 403 เป็นครั้งคราว (~9–12%) แม้จาก IP ไทย
  - IP ต่างประเทศหรือ data centre ได้ 403 (Cloudflare) หรือ timeout (ผลทดสอบของโครงการอื่น)
- **ThaiWater**
  - UA `flood-monitor/0.1 (+<repo url>)`, `Referer: https://www.thaiwater.net/` (Referer เว็บอื่นหรือยิงถี่จะได้ 429)
  - timeout: ทั้งประเทศ 120 วินาที รายจังหวัด 30 วินาที · retry: ทั้งประเทศหลัง 3 และ 10 วินาที รายจังหวัดหลัง 3 วินาที
  - ดึงพร้อมกันไม่เกิน 2 จังหวัด จังหวัดที่ล้มเป็นแค่ warning
  - ตอบ 200 พร้อม error ได้ เช่น `{result:'OK', data:'422: No station id'}` จึงต้องปฏิเสธเมื่อ `data` ไม่ใช่ array
- **ตัวจัดรอบ**
  - `POLL_MINUTES` 10 (2–120 เตือนเมื่อต่ำกว่า 5) · 1 request ต่อ endpoint ต่อรอบ
  - host เดียวกันดึงทีละตัว ต่าง host ดึงพร้อมกัน
  - หลังได้ 403/429 ให้ข้าม source ที่เหลือของ host นั้นในรอบนั้น · หลังได้ 429 ให้พัก host 30 นาที
  - deadline ของรอบ = max(30 วินาที, min(0.8 × รอบ, 240 วินาที))
- source ที่ `thaiIpOnly` แล้วล้มเพราะ timeout/reset/403 ให้ health ต่อท้ายว่า "(แหล่งข้อมูลนี้รับเฉพาะ IP ในประเทศไทย)"

### 3.3 การแปลงข้อมูล

- **คลอง กทม.**
  - ใช้ `wl_in` (ระดับด้านในคลอง ประตูระบายน้ำและสถานีสูบใช้ค่านี้อย่างเดียว), `left_bank`, `right_bank`, `warning`, `critical`, `txtStatus`
  - `site_timestamp` อยู่ในรูป `/Date(ms)/` เป็น UTC จริง
- **ตลิ่ง**
  - bank = min(left, right) หลังตัดค่า ≤ 0 หรือ ≥ 10
  - ถ้าตลิ่ง < 0.3 ม. หรือสองฝั่งต่างกัน > 1 ม. ให้ตั้ง `bankUncertain` (สถานะขึ้นได้ไม่เกิน watch)
  - freeboard ปัดเป็นซม.
- **ค่าที่ถือว่าไม่มีค่า**
  - ≤ −90, ≥ 9999, −2.00 ตรงตัวจาก กทม.
  - |ค่า| ≥ 10 ม. เฉพาะของ กทม. (ThaiWater ต่างจังหวัดเกิน 100 ม. ได้)
  - ระดับติดลบเป็นค่าปกติ (คลองที่สูบน้ำออก)
- **เกณฑ์หลอกของ กทม.** (−0.2/0, 0/0.1, −0.2/−0.1, 0/0 หรือหน่วยซม. เช่น 320/450) ให้ทิ้ง
- **เวลา**
  - ล่วงหน้าเกิน 15 นาทีให้ทิ้ง ล่วงหน้าน้อยกว่านั้นให้ปัดเป็นเวลาปัจจุบัน
  - เวลาไม่มี timezone (ThaiWater, Open-Meteo) = +07:00 · รองรับปี พ.ศ.
  - ThaiWater ที่เก่ากว่า 72 ชม. ให้ทิ้ง
  - feed รายชั่วโมง (ระดับน้ำที่ไม่ใช่ของ HII และ `rain_24h`) ให้ `staleMinutes: 180`
- **ThaiWater ระดับน้ำ**
  - bank = `min_bank` ถ้าไม่เป็น 0 และสูงกว่า `ground_level` ไม่อย่างนั้นใช้ตลิ่งฝั่งต่ำที่ไม่เป็น 0 · ค่า 0 = ไม่ทราบ
  - `situation_level` 1 = **น้ำน้อยวิกฤต** ไม่ใช่ปกติ
- **ฝน**
  - แถว กทม. ที่ `status ≠ 1` มีค่า 0 ปลอม ให้ทิ้งค่า
  - ThaiWater ที่ไม่มี key `rain_1h` = ไม่ทราบ ไม่ใช่ 0
  - ยอด 24 ชม. เป็นยอดเลื่อน ไม่ใช่รอบ 07:00 ของกรมอุตุฯ
- **ถนน**
  - `chkStatustxt` `'น้ำท่วม'` → `flood` ซม. (0–500), `'ปกติ'` → 0, อื่น ๆ = ขัดข้อง
  - อุโมงค์ (`TN.*`) หลายทิศทางให้รวมเป็นสถานีเดียว เก็บค่าที่ลึกกว่าและยังสด
- **สถานีสูบ**: `pump_status1..6` (1 = เดิน) · `rtu_status: false` = ข้ามค่า
- **รวมสถานีซ้ำ**
  - id ร่วม `canal:WL.*`, `rain:RF.*`, `road:FL.*`/`TN.*`
  - metadata ของ กทม. (priority 3) ชนะ ThaiWater (2) · เก็บค่าจากทั้งสองแหล่ง · ตัดซ้ำด้วย (station, observedAt)
- **พิกัด** นอกกรอบไทย (lat 5.5–20.6, lng 97.2–105.8) ให้ทิ้ง
- **health**: เก็บ `latestObservationAt` (ค่าใหม่สุด ไม่ใช่เวลาที่ HTTP สำเร็จ) และเตือนเมื่อเก่ากว่า 180 นาที

### 3.4 อากาศและเรดาร์

- **Open-Meteo**
  - `GET https://api.open-meteo.com/v1/forecast?latitude&longitude&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,is_day&hourly=precipitation_probability,precipitation&forecast_hours=25&timezone=Asia/Bangkok`
  - `current.precipitation` เป็นมม. ต่อ `current.interval` ให้แปลงเป็นมม./ชม.
  - ค่ารายชั่วโมงที่เวลา T คือช่วง (T−1ชม., T] ให้แสดงตามชั่วโมงเริ่มต้น
  - ช่วงที่มี null ให้ผลรวมเป็น null
  - แคชต่อช่อง 0.02° (~2 กม.) 10 นาที · ล้มให้ลองใหม่หลัง 2 นาที · ใช้ค่าเก่าได้ถึง 60 นาที · งบ upstream 400 ครั้ง/ชม. ทั้งเซิร์ฟเวอร์
- **เรดาร์ กทม.** (HTTP ธรรมดา IP ไทยเท่านั้น)
  - `http://weather.bangkok.go.th/FTPCustomer/radar/pics/radarh.jpg` (หนองจอก), `nkradarh.jpg` (หนองแขม)
  - ส่งต่อผ่าน `GET /api/radar/bma/{nongchok|nongkhaem}`: ภาพที่ได้แคช 4 นาที · ล้มแล้วลองใหม่ได้หลัง 60 วินาที · timeout 15 วินาที · ใช้ภาพเก่าได้ถึง 30 นาที · ≤ 8 MB · ตรวจ JPEG magic bytes (หน้า challenge มาเป็น HTML)
- **คาดการณ์ฝน 3 ชม.** `https://dds.bangkok.go.th/Line_data/picture/radar_rain.gif`
  - ให้เบราว์เซอร์ผู้ใช้โหลดเอง (เห็นเฉพาะผู้ใช้ในไทย)
  - เครดิต "สำนักการระบายน้ำ กทม. / Weathernews" และห้ามเรียกว่า "ตอนนี้"
- **RainViewer** `https://api.rainviewer.com/public/weather-maps.json`
  - ตรวจ host (https) และ path (`^/[\w/.-]+$`) ก่อนสร้าง tile URL · ใช้เฉพาะภาพย้อนหลัง · zoom ≤ 7
  - **ตั้งแต่ 2026-01-01** ฟรีเฉพาะส่วนบุคคลหรือการศึกษา
  - `RAINVIEWER=0` ซ่อน RainViewer แล้วลิงก์ไป `https://weather.tmd.go.th/composite/index_composite.html` และ `https://weather.bangkok.go.th/radar/RadarAnimation.aspx`
- **เงื่อนไข**
  - endpoint ของ กทม. เป็น API ภายในที่ไม่เป็นทางการ ต้องขออนุญาต กทม. และ สสน. ก่อนเปิดสาธารณะ
  - แสดงที่มา: กทม., ThaiWater/สสน. + หน่วยงานเจ้าของสถานี, Open-Meteo (CC BY 4.0 ไม่ใช่เชิงพาณิชย์), RainViewer, OpenStreetMap

### 3.5 ฟิลด์ที่ต้นแบบอ่านจาก กทม.

ใช้สังเคราะห์ fixture ระหว่างรอผล probe แล้วยืนยันกับ body จริงอีกครั้ง
- ที่มา: fixture ของต้นแบบ · คลองและสถานีสูบเป็น body ดิบ (2026-09-28)
- ฝนและถนนเป็นค่าจริงจาก relay ในไทย (2026-09-28 ถึง 2026-10-02) ที่แปลงกลับเป็นชื่อฟิลด์ของ กทม. ชื่อฟิลด์จึงยังต้องยืนยัน

| Source | รูป response | ฟิลด์ที่อ่าน |
|---|---|---|
| `bma-canal` | JSON array | `water_code`, `water_name`, `water_shortname`, `river_name` (ขึ้นต้น "แม่น้ำ" = river), `district_name`, `latitude`, `longitude`, `wl_in`, `left_bank`, `right_bank`, `warning`, `critical`, `txtStatus`, `site_timestamp` (`/Date(ms)/`), `site_timestampEN` (สำรอง) |
| `bma-rain` | JSON array | `rain_code`, `rain_name`, `rain_shortname`, `district_name`, `latitude`, `longitude`, `status`, `site_timestamp`, `rf24hr`, `rf1hr` |
| `bma-roadflood` | `{dtTbl: [...]}` | `flood_code` (`FL.*`/`TN.*`), `flood_name`, `flood_shortname`, `typesite` (2 = อุโมงค์), `road_name`, `districtName`, `latitude`, `longitude`, `chkStatustxt`, `flood`, `site_timestamp` |
| `bma-pump` | `{waterTbl: [...], LastPump: [...]}` จับคู่ด้วย `pumpStation_id` | `pumpStation_code`, `pumpStation_name`, `pump_shortname`, `latitude`, `longitude`, `district_name`, `rtu_status`, `site_timestamp_last` (สำรอง `site_timestamp_station`), `water_level`, `pump_status1..6` |

## 4. สถาปัตยกรรม

- **Stack**
  - Next.js 16 App Router, React 19, TypeScript strict (+ `noUncheckedIndexedAccess`), zod 4, Tailwind 4
  - leaflet/react-leaflet, web-push, `@supabase/supabase-js`, ฟอนต์ IBM Plex Sans Thai, Vitest, ESLint flat config
  - Node ≥ 22.13 (`node:sqlite`) · `output: 'standalone'` · กราฟเป็น SVG เขียนเอง
- **contracts**
  - ที่ใช้ร่วมกัน: `src/lib/types.ts`
  - type ของ API: `src/lib/server/public.ts` (type-only ปลอดภัยสำหรับ client)
  - config: `src/lib/config.ts` (zod)
  - engine: pure function ไม่มี I/O
- **Adapter**: `{ id, label (ชื่อหน่วยงานไทย), thaiIpOnly, fetch(ctx) }`
  - ctx ให้ `fetch`, `now`, `timeoutMs`, `signal`, `sleep`
  - คืนค่า `{ source, stations, readings, fetchedAt, warnings }`
- **Store** (interface เดียว สอง backend)
  - **SQLite** (`node:sqlite`): WAL + `busy_timeout` ให้ server กับ worker ใช้ไฟล์เดียวกัน · `BEGIN IMMEDIATE` · readings PK (station_id, observed_at)
  - **Supabase** (service-role): upsert แบ่งชุด 500 และตัดแถวซ้ำก่อน · pageSize ≤ `max-rows` (1000)
  - migration รันซ้ำได้ · มี locks + RPC `try_lock` · RLS ไม่มี policy และ grant ให้ `service_role` เท่านั้น
  - โหลด backend แบบ lazy ตาม `STORE` · ห้าม cache การ init ที่ล้ม
  - มี lease (`tryLock`) และ key-value `meta`
- **Poll cycle**: ingest → ตรวจ abort → alerts (`RUN_ALERTS=1`) → prune เกิน `HISTORY_HOURS` (72) → ขั้นตอนเสริม
  - รอบไม่ซ้อนกัน · ถ้ากำลังปิดระบบหลัง ingest ให้ข้าม alerts
- **รูปแบบการรัน** (codebase เดียว)
  - embedded: `EMBEDDED_WORKER=1` ผ่าน `instrumentation.ts` เฉพาะ runtime nodejs
  - worker แยก: `npm run worker` (`--once`)
  - relay: `--relay https://host` ดึงเฉพาะ `thaiIpOnly` แล้ว POST `/api/ingest` ด้วย Bearer `INGEST_TOKEN` · retry เฉพาะ network/429/5xx
- **API**
  - อ่าน: `GET /api/snapshot?lat&lng&r&n` หรือ `?place=` (ตำแหน่งต้องอยู่ในไทย, r 0.5–20, n 1–8, cache 30 วินาที), `/api/stations`, `/api/history` (≤ 8 id, ≤ 168 ชม.), `/api/config/public`
  - `/api/health`: `{ok, dataMode, store, lastIngestAt, lastAlertsAt, ingestStale, sources}` ตอบ 503 เฉพาะเมื่อใช้ store ไม่ได้
  - place: `POST /api/places` (ไม่ต้องมี token — คืน manage token ครั้งเดียว) · ที่เหลือต้องมี Bearer manage token: `GET/PATCH/DELETE /api/places/[id]`, `…/channels`, `…/test`, `…/events`
  - `POST /api/ingest`: ไม่ได้ตั้ง token = 503, token ผิด = 401 · body ≤ 25 MB ตรวจด้วย zod · ตอบทันทีแล้วรัน alerts + prune ใน `after()`
  - `GET/POST /api/cron/poll`: Bearer `CRON_SECRET` · เรียกซ้อนได้ 409
  - webhook ของ LINE/Telegram, `/api/email/confirm`, `/api/radar/bma/[site]`
  - route ที่แตะ store: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `await ctx.params` · error เป็น `{error}` ภาษาไทย · `no-store` เป็นค่าเริ่มต้น
- **Config**
  - ค่าว่าง = ค่าเริ่มต้น · ตัวเลขนอกช่วงให้ clamp แล้วเตือน · `SOURCES` ที่ไม่รู้จักให้เตือนแล้วข้าม · `DATA_DIR` แบบ relative ที่ชี้เข้าไปใน `.next` ให้ resolve ใหม่หรือปฏิเสธ
  - ตัวแปรหลัก: `DATA_MODE`, `STORE`, `DATA_DIR`, `POLL_MINUTES`, `STALE_MINUTES` 60, `HISTORY_HOURS` 72 (48–2160), `FETCH_TIMEOUT_MS` 30000 (1000–120000), `SOURCES`, `THAIWATER_PROVINCES`, `RUN_ALERTS` 1, `EMBEDDED_WORKER`, `INGEST_ON_REQUEST`, `CRON_SECRET`, `INGEST_TOKEN`, `PUBLIC_BASE_URL`, `TRUST_PROXY`, `RAINVIEWER`, `DEFAULT_LAT/LNG/LABEL` (13.7563, 100.5018, กรุงเทพมหานคร · โหมดสาธิตใช้ place เริ่มต้นของชุดข้อมูลจำลอง)
  - Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` · Web Push: `VAPID_SUBJECT` (ว่าง = ใช้ `PUBLIC_BASE_URL` ที่เป็น https) · ตัวแปรของช่องทางแจ้งเตือนอยู่ในหัวข้อ 6
  - บน Vercel (`VERCEL` ถูกตั้ง): `TRUST_PROXY=vercel` และถ้าใช้ SQLite จะได้ `DATA_DIR=/tmp/…` + `INGEST_ON_REQUEST=1`
  - `.env.example` ภาษาไทย ครบทุกตัวแปร

## 5. กฎการคำนวณสถานะ

ระดับ: `unknown < normal < watch < warning < critical` = ไม่มีข้อมูล / ปกติ / เฝ้าระวัง / เตือนภัย / วิกฤต

| | watch | warning | critical | เทียบ |
|---|---|---|---|---|
| freeboard (ม.) ปรับต่อ place ได้ | 0.6 | 0.3 | 0.1 | `<` |
| ฝน 24 ชม. (มม.) ปรับต่อ place ได้ | 35.1 (ฝนหนัก) | 90.1 (ฝนหนักมาก) | 150 | `>=` |
| น้ำบนถนน (ซม.) ค่าคงที่ | 5 | 15 | 30 | `>=` |

- **ที่มาของเกณฑ์**
  - 35.1/90.1 มม. คือเกณฑ์ฝนหนัก/หนักมาก 24 ชม. ของกรมอุตุฯ
  - freeboard 0.6/0.3/0.1 ม., ฝนวิกฤต 150 มม. และถนน 5/15/30 ซม. **เป็นค่าที่ต้นแบบเลือกเอง ไม่ใช่เกณฑ์ของหน่วยงาน** (ยืนยันกับเจ้าของในหัวข้อ 13)
- **ค่าที่ใช้ไม่ได้และข้อจำกัด**
  - null → unknown · สถานีสูบ → unknown เสมอ
  - `bankUncertain` ขึ้นได้ไม่เกิน watch
- **ข้อความฝน** (กรมอุตุฯ): < 0.1 ไม่มีฝน, ≤ 10 เล็กน้อย, ≤ 35 ปานกลาง, ≤ 90 หนัก, > 90 หนักมาก
- **ข้อมูลค้าง**
  - คลอง 60 นาที, ฝน 90, ถนน 180 หรือ `staleMinutes` ของสถานีถ้ามากกว่า
  - ค่าที่ค้าง = unknown และแสดงสีเทา "ไม่มีข้อมูลล่าสุด"
  - สถานีที่ไม่มีค่าใน 24 ชม. ห้ามนับเป็นสถานีที่ติดตาม
- **แนวโน้ม** (ซม./ชม.)
  - median ของ 15 นาทีล่าสุด เทียบ median ของ 45–75 นาทีก่อน (สำรอง 40–100) โดยช่วงต้องห่างกัน ≥ 0.5 ชม.
  - คิดเฉพาะ canal/river ที่ไม่ค้าง (เทียบทีละจุดจะถูก spike หลอก)
- **snapshot**
  - น้ำ: canal/river ใกล้สุดใน `radiusKm` ไม่เกิน `maxStations`
  - ฝน: 3 สถานีใกล้สุดใน max(radiusKm, 15 กม.) แล้วใช้ค่าสูงสุดที่ไม่ค้าง
  - ถนน: ≤ 5 เซนเซอร์
  - ระดับรวม = max ของทั้งหมด
- **place**
  - `radiusKm` 3 (0.5–20) · `maxStations` 4 (1–8) · `rapidRiseCm` 10 (3–50) · `notifyMinLevel` warning (watch|warning|critical)
  - เกณฑ์ต้องเรียงถูกลำดับ (freeboard: watch > warning > critical, ฝน: กลับกัน)
  - label ≤ 60 ตัวอักษร · ตำแหน่งในไทย

## 6. การแจ้งเตือน

- **Engine**: `evaluateAlerts` เป็น pure function
  - รับ place, ค่าน้ำ/ถนน/ฝน, state เดิม, `now`
  - คืน finding, state ใหม่ และข้อความรวมไม่เกิน 1 ข้อความ
- **hysteresis**: ขาขึ้นใช้ทันที ขาลงลดทีละขั้นเมื่อพ้นเส้นเกิน margin (freeboard 0.05 ม., ฝน 5 มม., ถนน 3 ซม.)
- **น้ำ**
  - ครั้งแรก/ยกระดับ: แจ้งเมื่อ ≥ `notifyMinLevel`
  - "คลี่คลาย": แจ้งเฉพาะเมื่อระดับเดิม ≥ min
  - วิกฤต: ย้ำทุก 180 นาที
  - บันทึก state เสมอแม้ไม่ได้แจ้ง
- **ข้อมูลค้าง/unknown**: ข้าม ไม่มี finding และไม่แตะ state เดิม
- **น้ำขึ้นเร็ว**: trend ≥ `rapidRiseCm` และ (≥ watch หรือคาดว่าถึง watch ใน 3 ชม.) · cooldown 120 นาที
- **ฝน**: แจ้งเฉพาะขายกระดับ และห้ามลดระดับถ้ามีสถานีในกลุ่มที่ค้าง (กันการแจ้งซ้ำเมื่อสถานีกลับมา)
- **ถนน**: ยกระดับและคลี่คลายตามกติกาเดียวกับน้ำ ไม่มีย้ำเตือน
- **รวมข้อความ**
  - 1 ข้อความต่อ place ต่อรอบ รายการรุนแรงสุดก่อน หัวเรื่องลงท้าย "(+อีก N รายการ)"
  - soft cap 1500 ตัวอักษร ถ้าเกินให้ตัดทั้งบรรทัด แต่**ส่วนท้ายต้องครบ** (พื้นที่, เวลาไทย, ลิงก์, disclaimer)
  - freeboard ติดลบเขียน "ล้นตลิ่ง X ม."
- **disclaimer ทุกข้อความ**: `ประเมินอัตโนมัติจากข้อมูลหน่วยงาน ไม่ใช่ประกาศทางการ · กทม. 1555 · ปภ. 1784`
- **runAlerts**
  - **บันทึก state หลังส่ง**
  - single-flight ด้วย lease 5 นาที ถ้า lease ล้มให้ใช้ lock ในโปรเซสแทน (**ห้ามทำให้การแจ้งเตือนเงียบ**)
  - state มี fingerprint ของการตั้งค่า และ PATCH ที่เปลี่ยนค่าใดนอกจาก label ให้ล้าง state
  - ทุกช่องทางล้ม = แจ้งซ้ำรอบถัดไปได้สูงสุด 3 ครั้ง
  - มีผู้ส่ง (`RUN_ALERTS=1`) **โปรเซสเดียวต่อฐานข้อมูล**
  - ลิงก์สร้างจาก `PUBLIC_BASE_URL` เท่านั้น

**ช่องทาง** (เปิดเฉพาะเมื่อตั้งค่าครบ และ log ช่องทางที่ตั้งไม่ครบตอนเริ่ม)

| ช่องทาง | ต้องตั้ง | ข้อจำกัด | ลบเมื่อ |
|---|---|---|---|
| Web Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (เจ้าของรัน `npm run --silent vapid >> .env` เอง ห้ามพิมพ์ private key ในแชต) | payload ≤ 3800 B, TTL 6 ชม. | 404/410 |
| LINE Messaging API | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_ADD_FRIEND_URL` | ≤ 5000, push นับโควตา OA | ผู้รับบล็อก/เลิกเป็นเพื่อน |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | ข้อความธรรมดา ≤ 4096 | 403/chat not found |
| ntfy | (`NTFY_BASE_URL` = `https://ntfy.sh`) | ≤ 3900 B | – |
| e-mail (Resend) | `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_BASE_URL` | subject ≤ 200 | – |
| Discord | – | webhook ของ discord.com เท่านั้น, ≤ 2000, `allowed_mentions: {parse: []}` | 404 |

- **sender**: timeout 15 วินาที · ไม่ตาม redirect · error ที่ผู้ใช้เห็นเป็นแค่ `HTTP <status>`/`timeout` (body ลง log)
- **ไม่มีบัญชี**
  - `POST /api/places` คืน manage token สุ่ม 32 bytes ครั้งเดียว และเก็บแค่ sha256 · ตรวจด้วย Bearer แบบ constant-time
  - ลิงก์จัดการ `/alerts?place=<id>#token=…` (token อยู่ใน fragment)
- **LINE/Telegram**
  - รหัสเชื่อม 8 ตัว (ไม่มี I, O, 0, 1) อายุ 60 นาที
  - ข้อความหนึ่ง = เดาได้หนึ่งครั้ง · จำกัดต่อแชตและต่อแพลตฟอร์ม
  - LINE ตรวจ `X-Line-Signature` ก่อน parse
  - Telegram ตรวจ secret header (ผิด = 401) แล้ว**ตอบ 200 แม้การประมวลผลล้ม** (Telegram retry คำตอบที่ไม่ใช่ 2xx ไม่สิ้นสุด) ยกเว้น body เกินขนาด (413) หรือ JSON เสีย (400)
  - bot ตอบ "สถานะ" ได้
- **e-mail**
  - GET ลิงก์ยืนยันแสดงแค่ปุ่ม และ POST เป็นตัวยืนยัน (mail scanner เปิดลิงก์เอง)
  - จำกัดต่อ mailbox ที่ normalise แล้ว (ตัด `+tag` และจุดของ Gmail) ต่อ place และทั้งระบบ
  - ในอีเมลไม่มีข้อความที่ผู้ใช้พิมพ์
- LINE Notify ปิดตั้งแต่ 2025-03-31 ให้ใช้ LINE OA
- เปลี่ยน VAPID keys แล้วผู้ใช้ต้องเปิด push ใหม่

## 7. หน้าจอ

- **ทั้งแอป**
  - `lang="th"`, IBM Plex Sans Thai, ธีมมืดเป็นค่าเริ่มต้น สลับได้ (ตั้งด้วย inline script ก่อน paint)
  - สีเป็น token: แยก `--accent` / `--accent-fill` (ตัวอักษรขาว ≥ 4.5:1) / `--accent-text` และมี **unit test คำนวณ contrast จาก CSS จริง**
- **ห้ามบอกสถานะด้วยสีอย่างเดียว**: ● ปกติ ▲ เฝ้าระวัง ◆ เตือนภัย ■ วิกฤต ○ ไม่มีข้อมูล คู่กับชื่อไทยเสมอ
- **Top bar**: sticky อยู่เหนือ Leaflet · แท็บ บ้าน/แผนที่/แจ้งเตือน/เกี่ยวกับ · chip ของ place · ปุ่มรีเฟรช · ธีม · skip link
- **Dashboard (`/`)**
  - **ลำดับใน DOM** (ตามความสำคัญบนมือถือ): สถานการณ์ → gauge → ประวัติ 48 ชม. → ฝน → น้ำท่วมถนน (ถ้ามี) → อากาศ → เรดาร์ → (การ์ดกล้องจากส่วนที่ 2) → คำอธิบาย
  - layout ด้วย `grid-template-areas` (1/2/3 คอลัมน์ที่ 48rem/64rem) **ห้ามใช้ CSS `order`** และมี test ตรวจลำดับ
  - **banner**: สาธิต · อันตรายเมื่อ ≥ warning (มี `tel:1555`, `tel:1784`) · ingest ค้าง > 3 รอบ · feed ค้าง > 180 นาที · "ตั้งตำแหน่งบ้านของคุณ"
  - **gauge** ครึ่งวงกลม SVG (`role=meter`) ฝั่งอันตรายอยู่ซ้าย สีเทาเมื่อค้าง · แสดงแนวโน้ม ระยะ อายุข้อมูล
  - **กราฟ freeboard 48 ชม.**: เส้นเกณฑ์แบบเส้นประ, ตัดเส้นเมื่อช่องว่าง > 90 นาที, tooltip, อ่านด้วยคีย์บอร์ดได้, มีมุมมองตาราง
  - **อากาศ**: ฝน 12 ชม. · **เรดาร์**: ARIA tabs และซ่อนแท็บที่โหลดไม่ได้ · `prefers-reduced-motion` ให้เริ่มแบบหยุด
  - **ไม่มีข้อมูล**: เกิน 20 กม. ให้ "เลือกตำแหน่งอื่น" · ใกล้กว่านั้นให้ "ขยายรัศมีเป็น N กม."
  - **โหลดข้อมูล**: snapshot ทุก 60 วินาที, history ทุก 5 นาที · error ให้คงข้อมูลเดิมพร้อม "เชื่อมต่อไม่ได้ · แสดงข้อมูลเมื่อ …"
- **แผนที่ (`/map`)**
  - Leaflet + OSM (โหลดผ่าน `next/dynamic({ssr:false})`) · marker เป็นรูปทรงตามระดับ · หมุดบ้าน + รัศมี
  - ตัวกรองชนิดสถานี (สถานีสูบปิดเป็นค่าเริ่มต้น) · บนมือถือเป็น bottom sheet · attribution มองเห็นเสมอ
  - popup ใช้คีย์บอร์ดได้ และแสดง "สถานะตามหน่วยงาน" เป็นข้อมูลประกอบ
- **เลือกตำแหน่ง** (`<dialog>`)
  - แตะแผนที่, ตำแหน่งปัจจุบัน (ตรวจ `isSecureContext` ก่อน), วางพิกัดหรือลิงก์ Google Maps/OSM (ลิงก์ย่อให้ปฏิเสธ)
  - รัศมี 0.5–20 กม. · จำนวนสถานี 1–8
  - ลำดับหา place: `?place=` → `?lat&lng` → localStorage `fm-place` → ค่าเริ่มต้น · ลิงก์แชร์ใส่แค่พิกัด
- **แจ้งเตือน (`/alerts`)**
  - 3 ขั้นตอน (ตำแหน่ง → เกณฑ์ → ช่องทาง) + ประวัติ + ลบ · กล่องเตือนให้เก็บลิงก์จัดการ
  - ช่องทางที่ปิดเป็นสีเทา "ผู้ดูแลระบบยังไม่ได้เปิดใช้"
  - Web Push: อธิบายเรื่อง HTTPS และ Add to Home Screen บน iOS 16.4+ · register service worker เมื่อผู้ใช้เปิด push เท่านั้น
- **เกี่ยวกับ (`/about`)**: disclaimer + `tel:` 1555, 1784, 1182, 1669, 191 · ตารางที่มา · แผนภาพ freeboard ที่อ่านได้ที่ 360 px · ความเป็นส่วนตัว
- **PWA**: manifest ภาษาไทย · service worker รับ push และเปิดเฉพาะ URL same-origin
- **มือถือ**: ไม่มี horizontal scroll ที่ 360 px · input 16px · เป้ากด ≥ 36–40 px
- **ทดสอบ UI**: logic อยู่ใน `src/lib/ui/*.ts` ที่ test ได้ · มี `/dev/preview` (เฉพาะ dev) แบบ normal/critical/empty/stale

## 8. การ deploy

ต้องใช้ **HTTPS** สำหรับ Web Push, PWA, ตำแหน่งปัจจุบัน และ webhook (ใช้ Cloudflare Tunnel หรือ reverse proxy แล้วตั้ง `PUBLIC_BASE_URL`)

| รูปแบบ | ใช้เมื่อ | ข้อมูล กทม. |
|---|---|---|
| 0. สาธิต: `npm run demo`, Codespaces, Vercel แบบ fixture | ให้คนลองหน้าจอ | จำลอง |
| A. Docker บนเครื่องในไทย (SQLite) | ใช้จริงแบบง่ายสุด (แนะนำ) | ครบ |
| B. Vercel + Supabase + worker ในไทย | เว็บบน cloud ผู้ใช้มาก | ครบ |
| Relay | เซิร์ฟเวอร์นอกไทย + เครื่องในไทย | ครบ |
| C. cloud อย่างเดียว | ทดลอง/สำรอง | สำเนา ThaiWater (~280 จุด ไม่มีสถานีสูบและเรดาร์ กทม.) |

- **`npm run demo`**
  - ใช้ได้ทุก OS · ค่าเริ่มต้น fixture (`--live` ใช้ข้อมูลจริง)
  - ตั้ง `HOSTNAME=0.0.0.0` · build เมื่อจำเป็น · คัดลอก standalone assets ทุกครั้ง · ตรวจว่าพอร์ตเป็นของเราผ่าน `/api/health`
  - มี devcontainer ที่ build แล้วรัน demo
- **Vercel สาธิต**
  - ตั้ง `DATA_MODE=fixture`, `PUBLIC_BASE_URL`, `CRON_SECRET`, `RAINVIEWER=0`
  - ระบบใช้ SQLite ใน `/tmp` ต่อ instance + ingest เมื่อมีคำขอ (single-flight) และ `/api/config/public` ตอบ `ephemeral: true` เพื่อให้ UI เตือนว่าไม่เก็บถาวร
  - **ตั้ง env ก่อน deploy production ครั้งแรก และดูว่า branch ไหนเป็น Production Branch** (ถ้าไม่ตั้ง `CRON_SECRET` cron ใน `vercel.json` จะตอบ 503 ทุกรอบ)
- **Docker**
  - `node:22-bookworm-slim`, uid 1000, volume `/app/data`, HEALTHCHECK `/api/health`
  - `EMBEDDED_WORKER=1` · `NEXT_MANUAL_SIG_HANDLE=true` ต้องเป็น env จริง (ใน `.env` ไม่ทัน) · รองานค้าง ≤ 25 วินาที แต่ compose `stop_grace_period: 30s`
  - โค้ด production ห้าม import จาก `tests/`
- **B**
  - Vercel ตั้ง `STORE=supabase`, `RUN_ALERTS=0`, `SOURCES=thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road`
  - เครื่องในไทยรัน `npm run worker` ด้วย `RUN_ALERTS=1`
  - รัน migration ทุกไฟล์ตามลำดับ
  - Vercel Hobby ตั้ง cron ได้วันละครั้ง ให้ใช้ cron ภายนอกที่ส่ง Bearer
- **Relay**: ฝั่งรับต้องตั้ง `SOURCES` เฉพาะ `thaiwater-*` (ถ้ามี `bma-*` จะเขียน health "ขัดข้อง" ทับข้อมูลที่ relay ส่งมา)
- **C** (**ข้อกำหนดใหม่** ต้นแบบยังไม่มี): UI ต้องบอกว่าใช้ข้อมูลสำรอง
  - ตรวจจาก health: ไม่มีแหล่ง `bma-*` ที่สด (ไม่ได้ดึงเองและไม่ได้รับผ่าน relay) แล้วส่งผลผ่าน `/api/config/public`

## 9. ความปลอดภัย

- **Rate limit**
  - token bucket ในหน่วยความจำต่อโปรเซส (เป็นเบรกกันการใช้ผิด) · IPv6 จัดกลุ่ม /64
  - ถ้า IP เป็น `unknown` (`TRUST_PROXY=none`) ให้ข้าม bucket ต่อ IP จึงเหลือแค่ bucket รวม (ถ้ามี)
  - ต่อ IP + รวมทั้งเซิร์ฟเวอร์: สร้าง place 10/ชม./IP + 120/ชม. · สร้างช่องทาง 20/ชม./IP + 300/ชม. · อีเมลยืนยันรวม 100/ชม. (และต่อ mailbox ต่อ place)
  - ต่อ IP อย่างเดียว (แบบต้นแบบ): snapshot 120/นาที/IP จึงไม่จำกัดเมื่อ `TRUST_PROXY=none` · ถ้าเพิ่มเพดานรวม ต้องตั้งสูงพอไม่ให้ผู้ใช้ที่มาทาง tunnel เดียวกันโดนจำกัดทั้งหมด
- **`TRUST_PROXY`** = `none` | `cloudflare` (`CF-Connecting-IP`) | `vercel` (`X-Real-IP`) | `xff`
  - ห้ามตั้ง cloudflare/xff ถ้าพอร์ตแอปเปิดให้เข้าตรงได้ (เมื่อใช้ tunnel ให้ bind `127.0.0.1`)
- **Token**: `CRON_SECRET`, `INGEST_TOKEN` ตรวจแบบ constant-time ถ้าไม่ได้ตั้ง = ปิด · สร้างด้วย `openssl rand -base64 32`
- **SSRF** (URL ที่ผู้ใช้ส่ง: ntfy, push, Discord)
  - https เท่านั้น ไม่มี credential และทุก address ที่ resolve ได้ต้องเป็น public
  - ตรวจตอนเพิ่มและทุกครั้งที่ส่ง · บันทึกใน docs ว่า DNS rebinding ยังเป็นช่องโหว่
- **Input**: นับไบต์ของ body จริง (เกินตอบ 413) · ตรวจทุก payload ด้วย zod · place id เป็น UUID
- **ลิงก์ออกนอกเว็บ** สร้างจาก `PUBLIC_BASE_URL` เท่านั้น เพราะ `req.url` ของ Next 16 มี bind address และ Host ปลอมได้

## 10. ลำดับการทำงานและ gate

**Gate ก่อนทุก commit**: `npm run typecheck && npm run lint && npm test && npm run build`
- ทุก commit ต้องผ่าน (ก่อน scaffold เสร็จให้รันเฉพาะขั้นของ gate ที่มีแล้ว) · stage ไฟล์แบบระบุชื่อ (ห้าม `git add -A` ขณะ subagent ยังแก้อยู่) · commit ตาม phase

| Phase | งาน |
|---|---|
| 0. วางแผน | plan mode → รออนุมัติ |
| 1. ตั้งต้นและตรวจแหล่งข้อมูล | commit `docs/BUILD-SPEC*.md` + `CLAUDE.md` · scaffold ตามข้อ 6 ของหัวข้อ 2 แล้วอ่าน docs ของ Next · probe script (ปิดบังความลับ, ทีละคำขอ, พิมพ์เวอร์ชัน) · จับ fixture · `docs/DATA-SOURCES.md` พร้อมวันที่ · ใช้ subagent ตรวจหลายแหล่งพร้อมกันได้ · ไม่มีเครื่องในไทยให้ทำตามหัวข้อ 3 |
| 2. ออกแบบ | `docs/DESIGN.md` · **commit contracts ก่อน** (`types.ts`, `public.ts`, `config.ts`, Store interface) |
| 3. สร้าง | sources/store/pipeline → engine/alerts → API → notify → UI → ไฟล์ deploy · subagent แต่ละตัวถือไฟล์ไม่ซ้ำกัน |
| 4. ทดสอบ | test ไปพร้อมโค้ด (ดูหัวข้อ 11) |
| 5. Review | adversarial review หลายมิติ (correctness, security, UI/a11y, ops/privacy) ด้วย subagent หรือ workflow · finding ต้องผ่านการโต้แย้ง และ finding ที่ยืนยันต้องได้ regression test |
| 6. รันจริงและดู | production build บนพอร์ตและ `DATA_DIR` ชั่วคราว (kill ด้วย PID ที่เก็บในไฟล์ ห้าม `pkill -f`) · Playwright ถ่ายภาพ 1440/390 px ทั้งสองธีม ตรวจ error และ overflow · ทดสอบ SIGTERM · จำลอง `VERCEL=1` · fresh clone แล้ว `npm ci && npm run demo` |

## 11. เกณฑ์ส่งมอบ

- [ ] gate ผ่าน · `npm test` ไม่เรียกเครือข่าย
- [ ] adapter ทุกตัวที่ตรวจผ่านมี test จาก fixture จริง · ตัวที่ตรวจไม่ผ่านปิดเป็นค่าเริ่มต้นตามหัวข้อ 3 · fixture สังเคราะห์มี `_fixture_note` · `docs/DATA-SOURCES.md` มีวันที่และผลตรวจทุก endpoint
- [ ] test ยืนยันว่า status ไม่ตามเกณฑ์ของหน่วยงาน (เช่น `WL.PWT.03`: warning = critical = 0.2, "วิกฤต" แต่ freeboard 0.32 ม.)
- [ ] test ของ alerts ครอบคลุม:
  - ครั้งแรก, hysteresis, ข้อมูลค้าง, น้ำขึ้นเร็ว + cooldown
  - รวมข้อความ + ส่วนท้ายครบ, ฝนกับสถานีค้าง
  - single-flight, lease เสีย, ส่งซ้ำเมื่อทุกช่องทางล้ม, fingerprint
  - ย้ำเตือนวิกฤต, น้ำท่วมถนน, cap ของ bankUncertain
- [ ] โหมดสาธิตมีป้ายทุกหน้า (รวม `/map` และ popup) และไม่มีที่ใดให้เครดิตแก่ กทม.
- [ ] fresh clone + `npm run demo` ใช้ได้ และ `/api/health` ตอบ 200
- [ ] ไม่มี horizontal scroll ที่ 360 px · contrast test ผ่าน · ลำดับการ์ดถูกต้อง
- [ ] ช่องทางที่ตั้งไม่ครบไม่ปรากฏใน `/api/config/public`
- [ ] ingest/cron ตอบ 503 เมื่อไม่ได้ตั้ง secret และ 401 เมื่อ token ผิด
- [ ] `.env.example` ครบ · ไม่มี secret ใน repo · docs ภาษาไทยตรงกับโค้ด
- [ ] รายงานสุดท้ายแยก "ทดสอบแล้ว" กับ "ยังไม่ได้ทดสอบ" (เช่น IP ไทยจริง, ส่ง LINE/e-mail จริง, Docker build)

## 12. สิ่งที่ไม่ต้องทำ และบทเรียน

- **ไม่ต้องทำ**: กล้อง CCTV ในส่วนที่ 1 (ทำในส่วนที่ 2), บัญชีผู้ใช้, chart library, offline cache
- **แหล่งที่สำรวจแล้วแต่ยังไม่ทำ** (2026-10-03, เก็บเป็นงานอนาคต): TMD CAP, HII FEWS, ThaiWater `analyst/dam`, RID SWOC, ONWR WAM, เรดาร์ composite ของกรมอุตุฯ
- **บทเรียน**
  - status code เชื่อไม่ได้ (challenge page มาเป็น 200 HTML ได้) ต้องตรวจเนื้อหาเสมอ
  - HTTP สำเร็จไม่ได้แปลว่าข้อมูลสด
  - ค่าที่หายคือ "ไม่ทราบ" ไม่ใช่ "ไม่มีฝน"
  - อ่านนิยาม scale ของหน่วยงานก่อนใช้
  - ใน container ต้องตั้ง `HOSTNAME=0.0.0.0` · `postbuild` ถูกข้ามเมื่อใช้ `--ignore-scripts` (ไม่มี CSS/JS)
  - อย่าใช้ `npm audit fix --force` กับ Next 16 โดยไม่ตรวจ diff ของ `package.json` (ต้นแบบเคยพบว่าลดรุ่น `eslint-config-next` — ยังไม่มีบันทึกใน repo ให้ตรวจซ้ำ)
  - คำสั่งที่ให้ผู้ใช้รันต้องรันซ้ำได้ (cd แบบ absolute, `git pull`) และ script ต้องพิมพ์เวอร์ชันของตัวเอง

## 13. คำถามที่ต้องถามเจ้าของ

ข้อที่เจ้าของไม่ตอบ ให้ใช้ค่าตามหัวข้อ 3–6 เป็นค่าเริ่มต้น

1. ต้องการรูปแบบ deploy ไหนบ้าง (A + สาธิตพอไหม หรือต้องมี B และ relay)
2. นโยบาย header ของหน่วยงาน (ข้อมูล เรดาร์ กล้อง): ใช้ค่าเริ่มต้นที่บอกตัวตน หรือเลือกแบบเลียนเบราว์เซอร์ของต้นแบบ (UA เบราว์เซอร์, Referer/Origin/`X-Requested-With`, อุ่น cookie หลัง 403) · ถ้าเลือกแบบหลัง ได้อนุญาตจากหน่วยงานแล้วหรือยัง
3. สถานีฝน: ใช้ค่าเริ่มต้น max(รัศมี, 15 กม.) หรือ 15 กม. ตายตัว
4. ฝนและถนน: ใช้ค่าเริ่มต้นตามหัวข้อ 6 (ฝนแจ้งเฉพาะขายกระดับ ถนนไม่มีย้ำเตือน) หรือต้องมีย้ำเตือน/คลี่คลาย · ต้องแจ้งเมื่อเซนเซอร์ขัดข้อง หรือเมื่อกลับเป็นปกติไหม
5. snapshot ของ place เปิดได้ด้วย id อย่างเดียว (ไม่ต้องใช้ token) รับได้ไหม · ต้องมี security headers ทั้งเว็บไหม
6. ได้รับอนุญาตจาก กทม./สสน. แล้วหรือยัง · มีข้อตกลงกับ RainViewer ไหม
7. ต้องการ CI ที่รันเฉพาะ fixture ไหม · Vercel แผนอะไร และ deploy จาก branch ไหน
8. ยืนยันเกณฑ์ที่ต้นแบบเลือกเอง (ใช้ในการแจ้งเตือนสาธารณะ): freeboard 0.6/0.3/0.1 ม., ฝนวิกฤต 150 มม., ถนน 5/15/30 ซม.

<!-- CCTV-ADDON:START -->

---

> **[เริ่มส่วนที่ 2: กล้อง CCTV]** ถ้าจะใช้เป็น add-on ให้คัดลอกตั้งแต่บรรทัดนี้ถึง "[จบส่วนที่ 2]"

## ส่วนที่ 2: กล้อง CCTV

ข้อเท็จจริงมาจากโปรเจกต์ต้นแบบ วันที่เป็น ค.ศ. เวลาไทย ผล probe อาจเปลี่ยนแล้ว ต้องตรวจซ้ำก่อนเชื่อ

### C1. วิธีใช้ส่วนนี้

- **ใน prompt เต็ม**: ทำหลังส่วนที่ 1 ผ่านเกณฑ์ส่งมอบ ใน session เดียวกัน
- **วางแยกเป็น add-on** ในแอปที่สร้างจาก prompt แบบไม่มีกล้อง
  1. อ่าน `docs/BUILD-SPEC.md` (ถ้ามี), `docs/DESIGN.md`, `docs/DATA-SOURCES.md`, `src/lib/types.ts`, `src/lib/config.ts` และ Store interface
  2. ใน plan mode สรุปจุดเชื่อม:
     - Store `meta`
     - ขั้นตอนท้าย poll cycle
     - payload ของ `/api/ingest`
     - `TRUST_PROXY` และ rate limiter
     - `DATA_MODE=fixture`
     - dashboard, แผนที่, `/about`
  3. ถ้าไม่มีจุดใด ให้ถามก่อน
  4. commit แรกของงานกล้อง: บันทึกส่วนนี้ทั้งฉบับแบบไม่แก้เป็น `docs/BUILD-SPEC-CCTV.md`
- **กฎของแอปหลักยังใช้**
  - plan mode ก่อน และทำทีละ phase
  - gate `npm run typecheck && npm run lint && npm test && npm run build`
  - tests ไม่แตะเครือข่าย
  - `*.bangkok.go.th` รับเฉพาะ IP ไทย
  - ข้อความผู้ใช้เป็นภาษาไทย โค้ดเป็นภาษาอังกฤษ
  - อ่าน `node_modules/next/dist/docs/` ก่อนใช้ Next
  - ห้าม commit secret
  - ถามก่อนทำสิ่งที่ออกนอกเครื่อง
  - นโยบาย header ของหน่วยงาน (หัวข้อ 3.2 ของส่วนที่ 1 หรือของ prompt แบบไม่มีกล้อง: ค่าเริ่มต้นบอกตัวตน แบบเลียนเบราว์เซอร์เมื่อเจ้าของเลือกเท่านั้น) ถ้าแอปเดิมไม่มี ให้ถามเจ้าของ

### C2. หลักการ

- **Camera ไม่ใช่ Station**: ไม่มีค่าวัด ไม่มี status ไม่มี alerts และภาพ**ไม่มีผล**ต่อสถานะ, banner, การแจ้งเตือน หรือ `ok` ของ `/api/health`
- **ภาพนิ่งเท่านั้น**: ดึงเมื่อมีคนดูผ่าน proxy ของเรา ไม่เก็บถาวร
- **แหล่งภาพ**: ใช้เฉพาะหน่วยงานรัฐโดยตรง ห้ามใช้ relay ของบุคคลที่สาม
- **link-only** (แสดงลิงก์ไปเว็บหน่วยงาน) เป็นสถานะที่ออกแบบไว้ ไม่ใช่ error
- **ปิดได้** ทั้งฟีเจอร์และทีละแหล่ง

### C3. แหล่งภาพ

| Source id | รายชื่อกล้อง | ภาพนิ่ง | สถานะล่าสุด |
|---|---|---|---|
| `bma-floodcam` (สำนักการระบายน้ำ กทม.) | `GET https://floodbangkok.bangkok.go.th/bkk/dds/services/api/floods/v1/items/camera_profile?limit=-1&fields=id,CameraName,LiveStream,Lat,Long,camera_description` · IP ไทย · ทุก 24 ชม. | `GET https://floodbangkok.bangkok.go.th/api/proxy?rtcUrl=<encodeURIComponent(LiveStream)>&timestamp=<ms>` (แบบเดียวกับหน้าเว็บ กทม.) · ต้นแบบยังไม่เคยได้ภาพจริง · ~9 วินาทีต่อภาพเป็นค่าจากแหล่งอื่น ยังไม่ยืนยัน | **2026-10-06** (IP ไทย): รายชื่อได้ 876 กล้อง แต่ proxy ตอบ **HTTP 500** ทั้ง 2 กล้องที่ทดสอบ (โฮสต์สตรีมเดียวกัน โฮสต์อื่นยังไม่ทดสอบ) · โฮสต์สตรีมไม่อยู่ใน DNS สาธารณะ |
| `bma-ddscam` (กทม. กล้องดูระดับน้ำ 6 ตัวของ `dds.bangkok.go.th/cctv.php`) | หน้าไม่มีรายชื่อที่โปรแกรมอ่านได้ จึงเป็น**ตารางคงที่ในโค้ด** (`staticList`, ไม่ใช้เครือข่าย, ไม่ relay) | `GET https://dds.bangkok.go.th<imagePath>?t=<ms>` path คงที่ต่อแถว: กล้อง 3 = `/cctv/cctv3.jpg`, กล้องอื่น = `/cctv-image/cctv<n>.jpg` · เวลาถ่าย = `Last-Modified` | **2026-10-06**: `cctv1`, `cctv2` ตอบ 200 `image/jpeg` (อ่านแค่ 7,877 ไบต์แรก ยังไม่รู้ความสด) · กล้อง 3–6 ยังไม่ทดสอบ · บุคคลที่สามรายงาน **2026-09-28** (ยังไม่ยืนยัน) ว่าภาพใหม่สุดลงวันที่ 28 ส.ค. คือ feed อาจหยุดแล้ว |
| `dwr-cctv` (กรมทรัพยากรน้ำ) | `POST https://telemetry.dwr.go.th/api/public/reportCctv/listPaginate` body `{paginate:{page,pageSize:200,orders:[]},search:{}}` (ไม่มี `orders` ได้ 400) · พิกัดจาก `GET /api/public/station/getByCode/{code}` · ทุก 168 ชม. | `GET /api/public/reportCctv/snapshot/{id}` ได้ `{"value":"/TA…/2026/10/4/10_15.jpg"}` (ตรวจ path ด้วย regex เข้ม `^/[A-Za-z0-9_-]{1,32}(/[A-Za-z0-9_.-]{1,64}){1,8}$` และห้ามมี `..` · ไม่ตรงให้ถือว่าล้ม) แล้ว `POST /api/file/image/cctv {path}` · เวลาถ่ายจาก path (UTC+7) · ภาพใหม่ราว 15 นาที | **2026-10-06**: ได้ภาพจาก IP ไทย · จาก cloud ยังไม่ยืนยัน |
| `demo-cam` | กล้องจำลองข้างสถานีจำลอง | SVG จากค่าจำลอง ลายน้ำ "ภาพจำลอง — ไม่ใช่ภาพจากกล้องจริง" | – |

- **การ parse**
  - อ่านเฉพาะฟิลด์ที่อนุญาต ห้าม spread แถว
  - BMA: `LiveStream` ต้องเป็น rtsp/rtmp/http/https ≤ 512 ตัวอักษร และตัดแถวนอกกรอบ กทม. (13.5–14.1 N, 100.2–100.95 E)
  - DWR: แถวในรายชื่อมีฟิลด์ลิงก์ที่ฝัง `user:pass@` (เช่น `cctvSnapshotLink`, `cctvVideoLink`) — เก็บแถวไว้ แต่ห้ามอ่าน เก็บ หรือ log ฟิลด์เหล่านั้น · อ่านเฉพาะ `entity.id`, `entity.stationCode`, ชื่อสถานี (`stnNameTh`/`stnNameEn`) และจังหวัด (`provinceNameTh`)
  - DWR: จำกัด 16 จังหวัดภาคกลาง และถ้าค้นพิกัดไม่สำเร็จให้ใช้พิกัดเดิม
- **ตำแหน่งกล้อง DDS ยังไม่ยืนยัน**
  - หมุดบนหน้า DDS (บันทึกโดยโครงการภายนอกเมื่อ 2026-09-28) ผิด 4 ใน 6 ตัว และหน้า `cctv.php` เปิดได้เฉพาะ IP ไทย
  - จึงวางกล้องที่สถานี กทม. ที่ชื่อตรงกันและปักสถานีนั้นไว้ (`pinnedStationIds` ใช้ id สถานีตามรูปแบบของแอป `canal:<water_code>`)
  - ใส่ตารางนี้ในโค้ดตามที่เขียน (ตารางของต้นแบบ ณ 2026-10-06) ห้ามสร้าง path ภาพด้วย template

| n | ชื่อ | lat, lng | สถานีที่ปัก | ที่อยู่ภาพ | ความมั่นใจ |
|---|---|---|---|---|---|
| 1 | บางเขนใหม่ | 13.81722, 100.51066 | `canal:WL.BKA.01` | `/cctv-image/cctv1.jpg` | ปานกลาง |
| 2 | สะพานพระปิ่นเกล้า | 13.76381, 100.48802 (หมุดของ DDS) | – (แม่น้ำเจ้าพระยา ไม่มีสถานี กทม.) | `/cctv-image/cctv2.jpg` | ปานกลาง |
| 3 | บางนา | 13.67482, 100.58775 | `canal:WL.BNA.01` | `/cctv/cctv3.jpg` | ปานกลาง |
| 4 | คลองสวนแดน 1 | 13.79063, 100.46199 | `canal:WL.SDN.01` | `/cctv-image/cctv4.jpg` | ต่ำ |
| 5 | คลองชักพระ | 13.7789, 100.46431 | `canal:WL.CPA.01` | `/cctv-image/cctv5.jpg` | ต่ำ |
| 6 | คลองทวีวัฒนา | 13.80042, 100.32977 | `canal:WL.TWW.01` | `/cctv-image/cctv6.jpg` | ต่ำ |

- **เครือข่าย**: `dds.bangkok.go.th` ไม่ได้อยู่หลัง Cloudflare (ต.ค. 2026) จากต่างประเทศจึงอาจได้ timeout หรือ reset แทน 403 (ยังไม่ได้ทดสอบจาก cloud)
- **ลิงก์อย่างเดียว** (ไม่ดึงภาพ): กล้องจราจร กทม. (bmatraffic.com), กรมชลประทาน (`wmsc.rid.go.th/cctv2`), กรมทางหลวง (highwaytraffic.go.th)

### C4. Contracts (commit ก่อนเขียน logic)

- `CameraSourceId` = `bma-floodcam | bma-ddscam | dwr-cctv | demo-cam`
- **`Camera`**
  - `id` = `${source}:${nativeId}` (nativeId `^[A-Za-z0-9_-]{1,64}$` ไม่อย่างนั้นใช้ sha1 16 hex)
  - `siteId` = `${source}:${lat.toFixed(5)},${lng.toFixed(5)}` ใช้รวมหลายมุม
  - ฟิลด์อื่น: `source`, `nativeId`, `name`, `code` (รหัสหน่วยงาน/รหัสสถานี DWR ใช้จับคู่พิกัดเดิม), `angle`, `owner`, `lat`, `lng`, `facing`, `nearStationIds`, `officialUrl`, `cadenceMin`
- **`CameraRef {cameraId, ref}`** (ที่อยู่สตรีม, เลขภาพ, snapshot id) เป็น server-only ห้ามอยู่ใน API, log, health หรือ relay
- **`CameraCatalogAdapter`** `{id, label, thaiIpOnly, refreshHours, staticList?, fetchCatalog(ctx + รายชื่อเดิม), pinnedStationIds?}`
- **`PublicCamera`** = ฟิลด์สาธารณะ + `distanceKm`, `media: 'image'|'link'`, `imageUrl`, `refreshSec`

### C5. รายชื่อกล้อง

- **ที่เก็บ**: Store `meta` ต่อแหล่ง
  - `cctv:catalog:<src>` (สาธารณะ), `cctv:refs:<src>` (server-only), `cctv:status:<src>`
  - `cctv:index:<src>` เขียนท้ายสุดเพื่อเป็น commit point
- **ปฏิเสธรายชื่อ** ที่ว่าง, ลงเวลาอนาคต, เก่ากว่าที่มี หรือหดเหลือ < 50%
  - รายชื่อที่หดยอมรับเมื่อซ้ำ ≥ 3 ครั้งในช่วง ≥ 24 ชม.
  - `staticList` ไม่ต้องผ่านเกณฑ์นี้
- **refresh**
  - ทำหลัง ingest → alerts → prune · deadline 120 วินาที
  - ล้มให้ backoff 1, 2, 4… ชม. และเก็บรายชื่อดีล่าสุด
  - `/api/cron/poll` ข้ามแหล่งที่ `thaiIpOnly`
  - นับความล้มเหลวต่อ host เพื่อไม่ให้ host บน cloud บล็อก worker ในไทย
- **ผูกกล้องกับสถานี** ตอนบันทึก: ถนน ≤ 50 ม., คลอง/แม่น้ำ ≤ 150 ม., ไม่เกิน 6 สถานี + สถานีที่ปักไว้
- **`officialUrl`** ต้องเป็น https บนโดเมนของหน่วยงาน
- **relay**
  - ส่งรายชื่อเป็น POST แยกหลังค่าวัด (ฟิลด์สาธารณะเท่านั้น, ตรวจด้วย zod, เฉพาะ `bma-floodcam` และ `dwr-cctv`)
  - รายชื่อที่รับผ่าน relay ไม่มี ref จึงเป็น link-only บนฝั่งรับ (ในทางปฏิบัติคือ `bma-floodcam` · `dwr-cctv` ฝั่งรับดึงเองได้ ดู C9)

### C6. Proxy ภาพ

- **Routes**
  - `GET /api/cctv/cameras?lat&lng&r&n`: r ค่าเริ่มต้น 3 กม. (0.5–20) · n จุด ค่าเริ่มต้น 4 (≤ 24) · ไม่มี lat/lng = ทุกกล้อง (สำหรับแผนที่) · 30 ครั้ง/นาที/IP
    - response: กล้องทุกมุมของ n จุดพร้อม `distanceKm`, `media`, `imageUrl`, `refreshSec` · `nearestOutsideKm` · `links[]` (หน้ากล้องที่ลิงก์อย่างเดียว) · `catalogAt`
  - `GET /api/cctv/image/[source]/[file]` (file = `<nativeId>.jpg` หรือ `.svg` ในโหมดสาธิต · ตรวจด้วย regex ใน handler)
- **client ไม่เคยส่ง URL**: เซิร์ฟเวอร์สร้าง URL จาก host คงที่ของแหล่ง + ref
- **ตรวจก่อนเรียก upstream**: แหล่งเปิดอยู่, ชื่อไฟล์ตรง regex, กล้องอยู่ในรายชื่อ, ภาพใช้ได้ (`CCTV_IMAGES=1`, ไม่อยู่ใน fallback, เครื่องนี้มี ref), ไม่เกิน 60 ครั้ง/นาที/IP

| | `bma-floodcam` | `bma-ddscam` | `dwr-cctv` |
|---|---|---|---|
| สด / จำความล้มเหลว / เก่าสุดที่ใช้ได้ | 60 วิ / 60 วิ / 15 นาที | 60 วิ / 60 วิ / 15 นาที | 5 นาที / 60 วิ / 60 นาที |
| timeout | 25 วิ | 15 วิ | 20 วิ (สองขั้นรวมกัน) |
| ดึงพร้อมกัน (คิว) | 3 (20) | 2 (10) | 2 (10) |
| งบต่อชั่วโมงต่อโปรเซส | 600 | 360 | 240 |

- **ขนาดและเวลา**: ภาพ ≤ 2 MB · รอคิวรวม 15 วิ · **invariant: กรณีแย่สุดของเซิร์ฟเวอร์ 40 วิ < watchdog ของ client 50 วิ** (มี test)
- **ต่อผู้ใช้** (เมื่อ `TRUST_PROXY` ให้ IP ที่เชื่อได้)
  - cache hit ฟรี · miss ได้ 40 ครั้ง/10 นาที/IP
  - ดึงพร้อมกัน 2 + รอ 6 เกินตอบ 429
  - คำขอที่ยกเลิกให้ออกจากคิวทันที
- **cache**
  - LRU ในหน่วยความจำ ≈ 300 ภาพ, single-flight ต่อกล้อง
  - กวาดทุก 60 วิด้วย timer (ภาพต้องไม่อยู่เกินอายุแม้ไม่มีคำขอ)
  - เก็บ hash ของภาพไว้ตรวจภาพค้าง
- **ตรวจภาพ**: JPEG magic `FF D8 FF` · PNG ≥ 64×48 (เล็กกว่าคือ placeholder) · WebP · HTML = ปฏิเสธ
- **คำขอไป upstream** (นโยบาย header เดียวกับแหล่งข้อมูล ดู C1)
  - ตาม redirect เฉพาะ same-origin ≤ 2 ครั้ง
  - **ไม่ส่ง Referer/Origin**
  - UA ค่าเริ่มต้นบอกตัวตน `flood-monitor/0.1 (+<PUBLIC_BASE_URL>/about)` · UA แบบเบราว์เซอร์ที่มี suffix นี้ใช้เมื่อเจ้าของเลือกเท่านั้น (ต้นแบบใช้แบบเบราว์เซอร์เพราะเชื่อว่า WAF ปฏิเสธ UA ของเครื่องมือ — ยังไม่ยืนยัน ดู C12)
- **fallback**
  - host ที่ไม่เคยได้ภาพแล้วถูกปฏิเสธหรือเข้าไม่ถึง 3 ครั้งติด → ลิงก์ 30 นาที
  - 429, 403/503 ที่มี Retry-After หรือ 403 สามครั้งติด → พักแหล่ง 1–60 นาที
  - ไม่เคยได้ภาพ + 5xx 8 ครั้งติด → พัก 15 นาที
  - timeout หรือ 403 ครั้งเดียว**ไม่นับ**ว่าถูกบล็อก
  - ระหว่าง fallback รายชื่อตอบ `media: 'link'` และ route ภาพตอบ 503 `unavailable` โดยไม่เรียก upstream
- **error**: JSON ภาษาไทย `{error, reason}`
  - 404 `not-found`
  - 429 `limited`
  - 502 `unreachable`/`no-image`
  - 503 `busy`/`budget`/`unavailable` พร้อม Retry-After
- **header ของภาพ**
  - `nosniff`, CSP `default-src 'none'`, CORP `same-origin`
  - `X-Cctv-Fetched-At`, `X-Cctv-Captured-At`, `X-Cctv-Changed-At`, `X-Cctv-Stale`
- **health**: `/api/health` มีส่วน `cameras` (เหตุผลที่ไม่มีภาพ, งบ, `lastFailure` ไม่มี id กล้อง) และไม่เปลี่ยน `ok`

### C7. ความเป็นส่วนตัวและกฎหมาย

- **สิ่งที่เก็บ**
  - ภาพนิ่งเท่านั้น ไม่มีวิดีโอ ไม่มีซูม ไม่มีประวัติ
  - เก็บในหน่วยความจำเท่านั้น (กทม. ≤ 15 นาที, DWR ≤ 1 ชม.) ไม่ลงดิสก์หรือฐานข้อมูล
  - ไม่จดจำใบหน้าหรือป้ายทะเบียน และไม่บันทึกว่าใครดูกล้องไหน
- **เครดิต** "ภาพ: <หน่วยงาน>" ทุกภาพ และบอกว่าหน่วยงานไม่ได้รับรองแอปนี้
- **`/about#cctv`** บอกว่า:
  - ภาพไม่ใช่ภาพสด และเก็บนานเท่าไร
  - ภาพไม่ได้กำหนดสถานะ และภาพเสียไม่ได้แปลว่าไม่มีน้ำท่วม
  - ภาพนิ่งที่แสดงในแอปขอผ่านเซิร์ฟเวอร์ของเรา หน่วยงานจึงไม่เห็น IP ของผู้ดูภาพนิ่ง (ลิงก์ไปเว็บหน่วยงานเปิดตรงจากเบราว์เซอร์ · ต้นแบบเขียนข้อนี้ในหัวข้อความเป็นส่วนตัวของ `/about`)
  - ช่องทางขอให้หยุดแสดงภาพจาก `CONTACT_EMAIL` (ถ้าไม่ได้ตั้ง ให้บอกตรง ๆ ว่ายังไม่มี **ห้ามแต่งที่อยู่** และให้สายด่วน 1555)
- **การอนุญาต**: ไม่มีหน่วยงานใดเผยแพร่เงื่อนไขการใช้ภาพ จึง**ต้องขออนุญาตสำนักการระบายน้ำ กทม. และกรมทรัพยากรน้ำก่อนเปิดสาธารณะ** (เจ้าของเป็นผู้ติดต่อ)
- **ก่อนเปิดภาพ**: ดูภาพจริงบนเครื่องในไทย ถ้าเห็นใบหน้าหรือป้ายทะเบียนชัด ให้ตั้ง `CCTV_IMAGES=0` จนกว่าจะมีการย่อภาพ
- **repo**: ห้าม commit ภาพจริงหรือที่อยู่สตรีมจริง · fixture ใช้ค่าปลอม (`example.invalid`)

### C8. หน้าจอ

- **คำที่ใช้**
  - ห้ามเรียกภาพว่า "สด" หรือ "LIVE" และห้ามมีสถานะที่สื่อว่าแห้งหรือปกติ
  - test จับ สด เป็นคำเดี่ยว, "ภาพสด" และ "ถ่ายทอดสด" เท่านั้น เพราะ "แสดง" มี สด อยู่ข้างใน · ข้อความปฏิเสธ "ไม่ใช่ภาพสด" ใน `/about` ได้รับยกเว้น
  - ทุกที่บอก "สถานะมาจากเซ็นเซอร์วัดน้ำ ไม่ได้มาจากภาพ"
  - ข้อความเมื่อล้มต่อท้าย "ไม่ได้แปลว่าไม่มีน้ำท่วม"
  - alt text บอกกล้อง หน่วยงาน และเวลา ไม่บรรยายภาพ
- **ห้ามให้ภาพเก่าดูเหมือนภาพปัจจุบัน**
  - แสดงเวลาถ่ายของหน่วยงานถ้ารู้ ไม่อย่างนั้นใช้เวลาที่ดึง ("ภาพนิ่ง · 10:42 น.")
  - **stale**: ดึงมาเกิน 5 นาที หรือถ่ายเกิน 45 นาที → หรี่
  - **old**: เกิน 24 ชม. → "ภาพเก่ากว่า 1 วัน" ขาวดำ + วันที่
  - **frozen**: ภาพเดิม ≥ max(15 นาที, 3 × รอบถ่าย) → บอกว่าค้าง
  - ภาพที่ไม่ใช่ของวันนี้มีวันที่เสมอ
- **การ์ด "กล้อง CCTV ใกล้บ้าน"** (แถวเต็มความกว้างเหนือการ์ดคำอธิบาย แสดงเมื่อมีรายชื่อ)
  - เรียก `/api/cctv/cameras` ครั้งเดียวต่อ place ด้วย `r` = max(รัศมี, 10) และ `n` = 12
  - 4 จุด เรียงตามระยะ จุดที่เซ็นเซอร์ที่ผูก ≥ watch ขึ้นก่อน แล้วเติมด้วยจุด "นอกรัศมี" ไม่เกิน 10 กม.
  - แต่ละ tile: ภาพ 4:3, badge เวลา, "N มุม", ระยะ, ค่าของเซ็นเซอร์ที่ผูก, เครดิต
- **รีเฟรช tile** ทุก 180 วิ เฉพาะเมื่อ:
  - tile อยู่บนจอและแท็บมองเห็นได้
  - ผู้ใช้ไม่ได้กดหยุด
  - ไม่ได้เปิด Save-Data (ถ้าเปิด ให้แตะเพื่อโหลด)
  - **viewer ปิดอยู่** (IntersectionObserver มองไม่เห็น modal)
- **โหลดภาพ**
  - ทีละคำขอ: blob → object URL → decode → สลับ → revoke ของเก่า
  - เคารพ Retry-After: 429 หยุดทุกกล้อง, 503 หยุดแหล่งนั้น
  - 404 หรือ `unavailable` → link-only แล้วลองใหม่หลัง ≥ 300 วิ
- **viewer**: `<dialog>`
  - ปุ่ม Back ปิดได้ (push history entry)
  - เลือกมุมได้ และเลื่อนก่อน/ถัดไปได้
  - รีเฟรช 60 วิ และหยุดเองหลัง 5 นาที
  - "เปิดเว็บทางการ" ใช้ `noopener noreferrer` + `referrerPolicy=no-referrer` (URL อาจมีพิกัดบ้าน)
  - focus ไม่หลุดไป `<body>` (ใช้ `aria-disabled`)
- **แผนที่**
  - ชั้นกล้องปิดเป็นค่าเริ่มต้น (`?cams=1`) และไม่โหลดอะไรจนกว่าจะเปิด
  - marker สีกลาง ไม่ใช่รูปทรงระดับ
  - popup มีคำว่า "ภาพนิ่ง ไม่ใช่วิดีโอ"

### C9. Config และ deploy

- **ตัวแปร**
  - `CCTV_SOURCES` ค่าเริ่มต้น `bma-floodcam,bma-ddscam,dwr-cctv` · `none` = ปิดกล้องจริงทั้งหมด (โหมดสาธิตใช้ `demo-cam` เสมอ — ถ้าต้องการปิดในโหมดสาธิตด้วยให้ระบุเป็นข้อกำหนดใหม่)
  - `CCTV_IMAGES` **ค่าเริ่มต้น 0 ในโหมด live ทุกเครื่อง** (**ข้อกำหนดใหม่** — ต้นแบบใช้ 1 ยกเว้น Vercel) เจ้าของตั้ง 1 เองหลังผ่านขั้น 8 ของ C11 · โหมดสาธิตแสดงภาพจำลองได้
  - `CONTACT_EMAIL`
- **คำเตือนตอนเริ่ม**: log `[cctv] WARNING` เมื่อเปิดภาพแต่ `TRUST_PROXY=none` หรือไม่มี `CONTACT_EMAIL`
- **ผลตามรูปแบบ deploy** (เมื่อเจ้าของตั้ง `CCTV_IMAGES=1`)
  - Docker ในไทย: แสดงภาพได้
  - Vercel: คง `CCTV_IMAGES=0` เป็นลิงก์ (ดึงภาพ กทม. ไม่ได้ และ instance ไม่แชร์แคช)
  - cloud อย่างเดียว: ไม่มีรายชื่อ `bma-floodcam` (cron ไม่ดึงแหล่ง `thaiIpOnly`) และภาพ DDS ต้องใช้ IP ไทย
  - เซิร์ฟเวอร์นอกไทยที่ไม่ใช่ Vercel: ถ้าภาพ DDS ได้แค่ timeout จะไม่นับเข้า fallback จึงขึ้น "ติดต่อกล้องไม่ได้" ทุกครั้ง ให้เอา `bma-ddscam` ออกจาก `CCTV_SOURCES` หรือตั้ง `CCTV_IMAGES=0`
  - relay:
    - `bma-floodcam` ฝั่งรับเป็นลิงก์ (รายชื่อมาจาก relay ไม่มี ref)
    - `dwr-cctv` ฝั่งรับดึงรายชื่อเอง (ไม่ใช่ `thaiIpOnly`) และไม่รับรายชื่อจาก relay ขณะรายชื่อของตัวเองยังสด จึงแสดงภาพได้
    - `bma-ddscam` ไม่ผ่าน relay ทุกเครื่องสร้างตารางเองและจะพยายามดึงภาพ (ดูข้อเซิร์ฟเวอร์นอกไทยด้านบน)
- แคชและงบอยู่ต่อโปรเซส จึงเหมาะกับเซิร์ฟเวอร์ที่รันตลอด ไม่ใช่ serverless

### C10. เครื่องมือวินิจฉัย (`npm run cctv:probe`)

- **เขียนสองขั้น** (แอปที่สร้างจาก prompt แรกยังไม่มี script นี้)
  - ขั้นแรก (C11 ข้อ 1): ตรวจเฉพาะ upstream ไม่ต้องมีโค้ดกล้องของแอป
  - หลัง C11 ข้อ 5: เพิ่มการตรวจผ่าน proxy ของแอป
- **วิธีรัน**: บนเครื่องเดียวกับเซิร์ฟเวอร์ (ในไทย) ทีละคำขอ มีขอบเขต พิมพ์ `[probe vN]`
- **สิ่งที่ตรวจ**
  - รายชื่อ BMA
  - proxy ของ กทม. (และ proxy ของแอปในขั้นที่สอง) โฮสต์สตรีมละ 1 กล้อง (≤ 10 โฮสต์)
  - DWR 2 สถานี
  - DDS: `cctv1..8.jpg` ใต้ `/cctv-image/` และ `/cctv/` (สถานะ ขนาด `Last-Modified`) แล้วอ่านซ้ำหลัง 65 วิว่าภาพเปลี่ยนไหม (`--quick` ข้าม)
  - โครงสร้างของ `now.bangkok.go.th/cctv-flood-data.json`
- **ห้ามพิมพ์** cookie, credential, ที่อยู่สตรีม, host ที่เป็น IP, ค่าใน query และ token (รวมใน error body)
- **ผล**: ให้เจ้าของรันแล้วส่งผลกลับ จากนั้นบันทึกพร้อมวันที่และ timezone ใน `docs/DATA-SOURCES.md`

### C11. ลำดับ rollout

1. เขียน probe ขั้นแรกตาม C10 (upstream อย่างเดียว) แล้วให้เจ้าของรันจากเครื่องในไทยและส่งผลกลับ บันทึกว่าแหล่งไหนได้ภาพจริง
2. commit contracts
3. adapter รายชื่อ + test
4. ที่เก็บ, การผูกสถานี, relay
5. proxy ภาพ + health · เพิ่มการตรวจผ่าน proxy ของแอปใน probe
6. UI แบบ link-only ก่อน แล้วจึงเปิดภาพ
7. adversarial review (security, correctness, UI/a11y, privacy) และ regression test ทุก finding
8. เปิดภาพ (`CCTV_IMAGES=1`) บน Docker ในไทย เมื่อได้รับอนุญาตแล้ว, ตั้ง `CONTACT_EMAIL` แล้ว, ตรวจใบหน้า/ป้ายทะเบียนแล้ว และ `TRUST_PROXY` ถูกต้อง

แหล่งที่ probe ล่าสุดยังไม่ให้ภาพ (เช่น `bma-floodcam` เมื่อ 2026-10-06) ให้ส่งมอบเป็นลิงก์ก่อน

### C12. บทเรียน

- **UA**: proxy ภาพเคยส่ง UA ของเครื่องมือ (ต่างจากคำขอรายชื่อที่ใช้ UA เบราว์เซอร์) จึงแก้ให้ใช้ UA แบบเดียวกันทุกคำขอ (2026-10-04) แต่ภาพ กทม. ก็ยังล้ม เพราะ proxy ของ กทม. ตอบ HTTP 500 กับทุกกล้องและทุก UA (probe 2026-10-05 และ 2026-10-06 เวลาไทย) — UA ไม่ใช่สาเหตุ ใช้ UA เดียวกันทุกคำขอเพื่อความสม่ำเสมอเท่านั้น
- **อย่าเดาสาเหตุ**: เสียหลายรอบกับการเดาว่ารูปแบบคำขอผิด ทั้งที่ proxy ของ กทม. ตอบ 500 เอง ให้ทำ probe ก่อนแก้โค้ด
- **หมุดของหน่วยงานผิดได้**: บันทึกหลักฐานและความมั่นใจต่อแถว และห้ามสร้าง path ภาพด้วย template
- **timeout**: ถ้า client timeout สั้นกว่าเซิร์ฟเวอร์ ภาพที่ช้าแต่สำเร็จจะกลายเป็นล้ม
- **timezone**: วันที่ของหลักฐานเป็นเวลาไทย แต่ commit เป็น UTC ให้ระบุ timezone ทุกครั้ง

### C13. เกณฑ์ส่งมอบ (กล้อง)

- [ ] gate ผ่าน และ test ของกล้องไม่แตะเครือข่าย
- [ ] ไม่มีที่อยู่สตรีม, ref หรือ credential ใน response, log, health หรือ relay (มี test)
- [ ] กล้องไม่เปลี่ยน status, alerts, banner หรือ `ok`
- [ ] `CCTV_SOURCES=none` ปิดกล้องจริงทั้งหมด (โหมดสาธิตใช้ `demo-cam` เสมอ) · `CCTV_IMAGES=0` (ค่าเริ่มต้นโหมด live) เหลือแต่ลิงก์ · ปิดทีละแหล่งได้
- [ ] สถานะ stale/old/frozen/link-only ถูกต้อง และไม่มีที่ใดเรียกภาพว่าสด
- [ ] `/about#cctv` ครบ และไม่แต่งช่องทางติดต่อ
- [ ] `docs/DATA-SOURCES.md` มีผล probe พร้อมวันที่ และบอกสิ่งที่ยังไม่ได้ทดสอบ

### C14. คำถามที่ต้องถามเจ้าของ

1. เปิดแหล่งไหนเป็นค่าเริ่มต้น · จะเปิดภาพ (`CCTV_IMAGES=1`) บนเครื่องไหน และเมื่อไร
2. ได้รับอนุญาตจาก กทม. และกรมทรัพยากรน้ำแล้วหรือยัง · ต้องย่อภาพหรือเบลอใบหน้าและป้ายทะเบียนไหม
3. ข้อความแจ้งเตือนควรมีลิงก์ไปกล้องที่ใกล้ที่สุดไหม (กล้องยังต้องไม่มีผลต่อสถานะ)
4. `now.bangkok.go.th/cctv-flood-data.json` เป็นแหล่งทางการที่เสถียรกว่าไหม (ต้นแบบมีขั้นตอน probe ที่พิมพ์โครงสร้าง แต่ยังไม่มีผลบันทึก — รู้จักจาก repo บุคคลที่สาม 2026-09-29/10-02 เท่านั้น)

> **[จบส่วนที่ 2: กล้อง CCTV]**

<!-- CCTV-ADDON:END -->
