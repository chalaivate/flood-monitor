# การติดตั้งและ Deploy

ข้อจำกัดสำคัญ: endpoint ของ กทม. (`*.bangkok.go.th`) ตอบเฉพาะ IP ในประเทศไทย ส่วน ThaiWater / Open-Meteo / RainViewer ใช้ได้จากทุกที่
จึงมี 3 รูปแบบให้เลือก

| รูปแบบ | เหมาะกับ | ข้อมูล กทม. | ฐานข้อมูล | ค่าใช้จ่าย |
|---|---|---|---|---|
| A. All-in-one Docker บนเครื่องในไทย | ใช้งานจริงแบบง่ายที่สุด | ได้ครบ | SQLite (ไฟล์) | ค่าไฟ/ค่า VPS ไทย |
| B. Vercel + Supabase + เครื่องดึงข้อมูลในไทย | เว็บบนคลาวด์ รองรับผู้ใช้จำนวนมาก | ได้ครบ (จากเครื่องในไทย) | Supabase Postgres | ฟรี tier ได้ |
| C. คลาวด์อย่างเดียว (ไม่มีเครื่องในไทย) | ทดลอง/สำรอง | ใช้ข้อมูลทวนจาก ThaiWater แทน | SQLite หรือ Supabase | ฟรี tier ได้ |

ทุกแบบต้องใช้ Node.js 22.13 ขึ้นไป (ใช้ `node:sqlite` ที่มากับ Node — รุ่น 22.5–22.12 ต้องเปิด flag จึงใช้ไม่ได้)

**ต้องเปิดผ่าน HTTPS** ถ้าจะใช้ Web Push, ติดตั้งเป็นแอป (PWA), ปุ่ม "ใช้ตำแหน่งของฉัน" และ webhook ของ LINE/Telegram —
เบราว์เซอร์ปิดความสามารถเหล่านี้บน `http://` (ยกเว้น `http://localhost` สำหรับทดสอบในเครื่อง)
ใช้ Cloudflare Tunnel (ตัวอย่างใน `docker-compose.yml`) หรือ reverse proxy ที่มี TLS (Caddy/nginx) แล้วตั้ง `PUBLIC_BASE_URL=https://<โดเมน>`

---

## 0. ทดลองด้วยข้อมูลสาธิต

**GitHub Codespaces (ไม่ต้องติดตั้ง):** เปิด https://codespaces.new/chalaivate/flood-monitor/tree/claude/flood-early-warning?quickstart=1
- ครั้งแรก `.devcontainer/devcontainer.json` จะติดตั้งและ build ให้ (ราว 3–5 นาที) แล้วรัน `npm run demo` และเปิดพอร์ต 3000 ในเบราว์เซอร์
- `?quickstart=1` พากลับไป codespace เดิมของ branch นี้แทนการสร้างใหม่
- พอร์ตเป็นแบบ private (ต้องล็อกอิน GitHub บัญชีเจ้าของ) ถ้าจะให้คนอื่นดู: แท็บ PORTS → คลิกขวาพอร์ต 3000 → Port Visibility → Public
- โควตาฟรีของบัญชีส่วนตัว 120 core-hours/เดือน (เครื่อง 2 core ≈ 60 ชม.) และพื้นที่ 15 GB-month — codespace หยุดเองเมื่อไม่ได้ใช้ (ค่าเริ่มต้น 30 นาที)
  แต่ codespace ที่หยุดแล้วยังกินพื้นที่ ลบได้ที่ github.com/codespaces
- ถ้าลิงก์เปิดผิด branch: ในหน้า repo เลือก branch `claude/flood-early-warning` → Code → Codespaces → Create codespace

**ในเครื่อง (macOS / Linux / Windows):**

```bash
npm ci
npm run demo            # build เมื่อจำเป็น แล้วเปิดเซิร์ฟเวอร์ + ตัวดึงข้อมูล → http://localhost:3000
npm run demo -- --live  # ข้อมูลจริง (ใน Codespaces ใช้เฉพาะ ThaiWater เพราะ กทม. รับเฉพาะ IP ไทย)
npm run demo -- --build # บังคับ build ใหม่
```

`npm run demo` ใช้ `PORT`, `DATA_DIR`, `SOURCES`, `PUBLIC_BASE_URL` จาก environment หรือ `.env` ได้ (เช่น `PORT=3001` ในไฟล์ `.env`)
โหมดสาธิตใช้ SQLite ในเครื่องเสมอ แม้ `.env` จะตั้ง `STORE=supabase`

สำหรับพัฒนาโค้ด: `DATA_MODE=fixture EMBEDDED_WORKER=1 npm run dev` (Windows: ใส่สองค่านี้ใน `.env` แล้วรัน `npm run dev`)

โหมด `fixture` ใช้จุดวัดจริงของ กทม. (ชื่อ พิกัด ความสูงตลิ่ง) แต่ระดับน้ำ ฝน และน้ำบนถนนเป็น **ค่าจำลอง** ที่มีพายุฝนวนรอบทุก ~61 ชม.
หน้าเว็บแสดงป้าย "ข้อมูลตัวอย่าง" ตลอด และเก็บข้อมูลแยกไฟล์ (`data/flood-demo.db`) ไม่ปนกับข้อมูลจริง

ตรวจสอบ: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`

---

## A. All-in-one Docker บนเครื่องในประเทศไทย (แนะนำ)

เครื่องที่ใช้ได้: PC ที่ออฟฟิศ, mini PC, NAS ที่รัน Docker ได้, VPS ที่อยู่ในไทย — ต้องเปิดตลอดเวลา

```bash
git clone https://github.com/chalaivate/flood-monitor.git && cd flood-monitor
cp .env.example .env            # แก้ค่า PUBLIC_BASE_URL และช่องทางแจ้งเตือนที่ต้องการ
mkdir -p data && sudo chown 1000:1000 data   # container รันด้วย uid 1000
docker compose up -d --build
docker compose logs -f app      # ควรเห็น [ingest] bma-canal: ~312 stations
```

- เว็บอยู่ที่ `http://<เครื่อง>:3000` สำหรับทดสอบในวง LAN — ตัวดึงข้อมูลรันในเซิร์ฟเวอร์เดียวกัน (`EMBEDDED_WORKER=1`) ทุก `POLL_MINUTES` นาที
  (ใช้งานจริงต้องเป็น HTTPS ดูหัวข้อด้านบน)
- เปิดให้คนนอกเข้าถึงโดยไม่ต้องเปิด port: ใช้ Cloudflare Tunnel (มีตัวอย่าง service `cloudflared` ใน `docker-compose.yml`) แล้วตั้ง `PUBLIC_BASE_URL` เป็นโดเมนนั้น
  และตั้ง `TRUST_PROXY=cloudflare` เพื่อให้จำกัดคำขอต่อ IP ของผู้ใช้จริงได้ (ดู [TRUST_PROXY](#trust_proxy-ip-ของผู้ใช้สำหรับการจำกัดคำขอ))
  เมื่อใช้ tunnel ให้ผูกพอร์ตไว้ที่ `127.0.0.1:3000:3000` (หรือลบ `ports:` ออก เพราะ cloudflared เข้าถึง `http://app:3000` ผ่านเครือข่ายของ compose อยู่แล้ว)
  ไม่เช่นนั้นคนนอกจะยิงตรงเข้าพอร์ต 3000 พร้อม header ปลอมได้
- หยุด/อัปเดต: `docker compose down` / `git pull && docker compose up -d --build` — ข้อมูลอยู่ใน `./data` ไม่หายเมื่อ build ใหม่
  เมื่อสั่งหยุด เซิร์ฟเวอร์รอรอบดึงข้อมูลและงานเบื้องหลังที่ค้างอยู่ได้สูงสุด 25 วินาที (compose ตั้ง `stop_grace_period: 30s`;
  ถ้าใช้ `docker` ตรง ๆ ให้สั่ง `docker stop -t 30`) — รอบที่ถูกขัดจะข้ามการประเมินแจ้งเตือน แล้วไปประเมินในรอบแรกหลังเปิดใหม่
- สำรองข้อมูล: `sqlite3 data/flood.db ".backup backup.db"`
- ตรวจสุขภาพ: `curl http://localhost:3000/api/health`

ไม่ใช้ Docker ก็ได้:

```bash
npm ci && npm run build           # build จะคัดลอก public และ .next/static เข้า .next/standalone ให้เอง
# ใน .env: EMBEDDED_WORKER=1 และ DATA_DIR=/ที่อยู่เต็ม/ของ/flood-monitor/data (ควรเป็น path เต็ม)
npm run start:standalone          # = node --env-file-if-exists=.env .next/standalone/server.js (รันจากโฟลเดอร์โปรเจกต์)
```

ใน container (Docker, Dev Container, Codespaces) ตัวแปร `HOSTNAME` คือชื่อ container ทำให้ server ผูกกับ IP นั้นอย่างเดียว —
ให้ตั้ง `HOSTNAME=0.0.0.0` ก่อน `npm run start:standalone` (`npm run demo` และ Docker image ตั้งให้แล้ว)

การปิดเครื่องอย่างนุ่มนวลกับ `EMBEDDED_WORKER=1` ต้องมี `NEXT_MANUAL_SIG_HANDLE=true` ใน environment จริง
(systemd `Environment=` หรือ `export`) — `npm run start:standalone` อ่านจาก `.env` ได้เพราะใช้ `--env-file`
แต่ `next start` ตัดสินใจก่อนโหลด `.env` ถ้าตั้งไม่ถูกเซิร์ฟเวอร์จะเขียนคำเตือนใน log

หรือแยกเป็นสองโปรเซส: `npm start` (เว็บ) + `npm run worker` (ตัวดึงข้อมูล) ใช้ DATA_DIR เดียวกันได้ (SQLite WAL)
— `npm start` จะพิมพ์คำเตือน `"next start" does not work with "output: standalone"` ซึ่งไม่มีผลกับการทำงาน

ห้ามเก็บฐานข้อมูลไว้ใน `.next/` เพราะ `npm run build` ครั้งถัดไปจะลบทิ้ง:
ถ้า `DATA_DIR` เป็น path สัมพัทธ์และชี้เข้าไปใน `.next` (เช่นรัน `node .next/standalone/server.js` ตรง ๆ) ระบบจะใช้โฟลเดอร์ที่สั่งรันแทน หรือไม่ยอมเริ่มทำงาน

---

## B. Vercel + Supabase + เครื่องดึงข้อมูลในไทย

1. **Supabase**: สร้างโปรเจกต์ แล้วรัน **ทุกไฟล์** ใน `supabase/migrations/` ตามลำดับชื่อไฟล์
   (`supabase db push` ทำให้ครบเอง หรือวางทีละไฟล์ใน SQL Editor: `…_init.sql` แล้ว `…_locks.sql`)
   ตารางทั้งหมดเปิด RLS และไม่มี policy สำหรับ anon — เซิร์ฟเวอร์ใช้ service role key เท่านั้น
   **อัปเดตจากรุ่นก่อน:** รันไฟล์ migration ใหม่ที่ยังไม่เคยรัน (ทุกไฟล์เขียนแบบรันซ้ำได้)
   ถ้าขาด `…_locks.sql` ระบบยังแจ้งเตือนได้ แต่จะเขียน log `alerts lease unavailable` ทุกรอบ และอาจส่งข้อความซ้ำถ้ามีหลายโปรเซส
2. **Vercel**: import repo นี้ ตั้ง Environment Variables
   ```
   STORE=supabase
   SUPABASE_URL=...            SUPABASE_SERVICE_ROLE_KEY=...
   PUBLIC_BASE_URL=https://<โดเมน>
   RUN_ALERTS=0                # ให้เครื่องในไทยเป็นผู้ส่งแจ้งเตือน
   SOURCES=thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road
   CRON_SECRET=<สุ่ม>           # vercel.json เรียก /api/cron/poll ทุก 10 นาที
   # TRUST_PROXY ไม่ต้องตั้ง: บน Vercel ใช้ค่า vercel อัตโนมัติ
   + ค่าช่องทางแจ้งเตือน (VAPID_*, LINE_*, TELEGRAM_*, RESEND_API_KEY, EMAIL_FROM)
   ```
   บัญชี Vercel Hobby ตั้ง cron ได้วันละครั้ง — ให้แก้ schedule เป็นรายวัน หรือลบ `crons` แล้วใช้บริการภายนอก
   (เช่น cron-job.org) เรียก `GET https://<โดเมน>/api/cron/poll` พร้อม header `Authorization: Bearer <CRON_SECRET>` ทุก 10 นาที
3. **เครื่องในไทย** (PC/mini PC/Raspberry Pi ที่มี Node 22): ใช้ฐานข้อมูลเดียวกัน
   ```bash
   git clone ... && cd flood-monitor && npm ci
   cat > .env <<'EOF'
   STORE=supabase
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...
   RUN_ALERTS=1
   PUBLIC_BASE_URL=https://<โดเมน>
   # + ค่าช่องทางแจ้งเตือนชุดเดียวกับ Vercel
   EOF
   npm run worker          # วนทุก POLL_MINUTES (ใช้ pm2 / systemd / Task Scheduler ให้รันตลอด)
   ```
   ให้มี **ผู้ส่งแจ้งเตือนเพียงที่เดียว** (`RUN_ALERTS=1`) มิฉะนั้นผู้ใช้จะได้ข้อความซ้ำ

### ทางเลือก: โหมด relay

ถ้าเซิร์ฟเวอร์อยู่ต่างประเทศและไม่ได้ใช้ Supabase เครื่องในไทยสามารถดึงเฉพาะแหล่งข้อมูล กทม. แล้วส่งขึ้นไปให้

```bash
# เครื่องในไทย — ทั้งสองฝั่งตั้ง INGEST_TOKEN ค่าเดียวกัน
npm run worker -- --relay https://<โดเมน>
```

ฝั่งเซิร์ฟเวอร์ที่รับข้อมูลต้องตั้งค่า:

```
INGEST_TOKEN=<ค่าเดียวกับเครื่องในไทย>
SOURCES=thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road   # ห้ามมี bma-* เพราะต่างประเทศดึงไม่ได้ และจะเขียนสถานะ "ขัดข้อง" ทับข้อมูลจาก relay
EMBEDDED_WORKER=1        # หรือ cron เรียก /api/cron/poll — เพื่อดึง ThaiWater และลบข้อมูลเก่า
```

เซิร์ฟเวอร์ลบข้อมูลที่เก่ากว่า `HISTORY_HOURS` หลังรับข้อมูลจาก relay ทุกครั้งด้วย

---

## C. คลาวด์อย่างเดียว

ตั้ง `SOURCES=thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road` แล้ว deploy แบบ B (ไม่ต้องมีเครื่องในไทย, `RUN_ALERTS=1` ที่ cron)
ข้อมูลคลองของ กทม. จะมาผ่าน ThaiWater (ประมาณ 280 จุด ช้ากว่าต้นทางเล็กน้อย) — ไม่มีสถานีสูบน้ำ และภาพเรดาร์ของ กทม. จะไม่แสดง

---

## ตั้งค่าช่องทางแจ้งเตือน

| ช่องทาง | ขั้นตอน |
|---|---|
| Web Push | `npm run --silent vapid` แล้ว **แทนที่** บรรทัด `VAPID_*` ที่ว่างอยู่ใน `.env` ด้วยค่าที่ได้ (ต้องมี `--silent` ไม่เช่นนั้น npm จะพิมพ์บรรทัด `> flood-monitor…` ปนมาด้วย) — เครื่องที่มีแต่ Docker: ดูคำสั่งด้านล่าง. เปลี่ยนกุญแจแล้วผู้ใช้เดิมต้องเปิดการแจ้งเตือนใหม่ |
| LINE | ดูขั้นตอนด้านล่าง (ตั้งแต่ ก.ย. 2567 ต้องสร้าง LINE Official Account ก่อน) |
| Telegram | @BotFather → `/newbot` → ใส่ `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` → ลงทะเบียน webhook: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<โดเมน>/api/telegram/webhook&secret_token=<SECRET>"` |
| ntfy | ไม่ต้องตั้งค่า (หรือใช้เซิร์ฟเวอร์ของตัวเองด้วย `NTFY_BASE_URL`) |
| อีเมล | สมัคร Resend, ยืนยันโดเมนผู้ส่ง, ใส่ `RESEND_API_KEY` และ `EMAIL_FROM` |
| Discord | ไม่ต้องตั้งค่า |

ช่องทางที่ไม่ได้ตั้งค่า (หรือตั้งไม่ครบชุด) จะถูกซ่อนในหน้า "แจ้งเตือน" โดยอัตโนมัติ (อ่านจาก `/api/config/public`)
และ log ตอนเริ่มเซิร์ฟเวอร์จะบอกว่าขาดตัวแปรใด — LINE ต้องครบ 3 ค่า (`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_ADD_FRIEND_URL`),
Telegram ครบ 3 ค่า (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`)
อีเมลต้องตั้ง `PUBLIC_BASE_URL` ด้วย เพราะลิงก์ยืนยันในอีเมลต้องชี้ไปที่โดเมนจริง

### สร้างกุญแจ Web Push บนเครื่องที่มีแต่ Docker

```bash
docker compose run --rm --no-deps app node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey)"
```

จะใส่ `VAPID_SUBJECT=mailto:<อีเมลผู้ดูแล>` เพิ่มก็ได้ (ถ้าไม่ใส่ ระบบใช้ `PUBLIC_BASE_URL`)

### LINE

1. สร้าง LINE Official Account ที่ [manager.line.biz](https://manager.line.biz)
2. ใน LINE Official Account Manager → ตั้งค่า → Messaging API → เปิดใช้ Messaging API แล้วเลือก Provider
3. ใน [LINE Developers Console](https://developers.line.biz/console/) → channel ที่เพิ่งเกิด → แท็บ Messaging API → ออก Channel access token (long-lived) ใส่ `LINE_CHANNEL_ACCESS_TOKEN`
   และคัดลอก Channel secret จากแท็บ Basic settings ใส่ `LINE_CHANNEL_SECRET`
4. ตั้ง Webhook URL เป็น `https://<โดเมน>/api/line/webhook` กด Verify และเปิด Use webhook
5. ใน LINE Official Account Manager ปิดข้อความตอบกลับอัตโนมัติและข้อความทักทาย แล้วคัดลอกลิงก์เพิ่มเพื่อนใส่ `LINE_ADD_FRIEND_URL`

---

## TRUST_PROXY: IP ของผู้ใช้สำหรับการจำกัดคำขอ

ระบบจำกัดจำนวนคำขอต่อ IP (สร้างจุดเฝ้าระวัง 10 ครั้ง/ชม., เพิ่มช่องทางแจ้งเตือน 20 ครั้ง/ชม., `/api/snapshot` 120 ครั้ง/นาที)
และมีเพดานรวมทั้งเซิร์ฟเวอร์อีกชั้น (จุดเฝ้าระวังใหม่ 120 จุด/ชม., ช่องทางใหม่ 300 ช่องทาง/ชม.) ซึ่งทำงานแม้ไม่รู้ IP ของผู้ใช้
IP จะอ่านจาก header ของ proxy ที่ระบุใน `TRUST_PROXY` เท่านั้น — header อื่นที่ผู้ใช้ส่งมาเองจะถูกละเลย

| ค่า | ใช้เมื่อ | header ที่อ่าน |
|---|---|---|
| `cloudflare` | เข้าเว็บผ่าน Cloudflare Tunnel / Cloudflare proxy เท่านั้น | `CF-Connecting-IP` |
| `vercel` | deploy บน Vercel (เว้นว่างไว้ระบบเลือกให้อัตโนมัติเมื่อมีตัวแปร `VERCEL`) | `X-Real-IP` แล้ว `X-Forwarded-For` ตัวแรก |
| `xff` | อยู่หลัง reverse proxy ของคุณเอง (nginx/Caddy) ที่ **เขียนทับ** `X-Forwarded-For` ด้วย IP ผู้ใช้ เช่น nginx `proxy_set_header X-Forwarded-For $remote_addr;` | `X-Forwarded-For` ตัวแรก |
| `none` (ค่าเริ่มต้นนอก Vercel) | ใช้ในวง LAN หรือไม่แน่ใจ | ไม่อ่าน — ไม่จำกัดต่อ IP แต่ยังมีเพดานรวม |

ห้ามตั้ง `cloudflare` หรือ `xff` ถ้าพอร์ตของเซิร์ฟเวอร์เปิดให้อินเทอร์เน็ตเข้าถึงได้โดยตรง เพราะผู้ใช้จะปลอม header เพื่อหลบการจำกัดได้

---

## กล้อง CCTV

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `CCTV_SOURCES` | `bma-floodcam,dwr-cctv` | รายชื่อกล้องที่จะโหลด — `none` = ปิดฟีเจอร์ (โหมดสาธิตใช้กล้องจำลองเสมอ) |
| `CCTV_IMAGES` | `1` (บน Vercel `0`) | `1` = เครื่องนี้ดึงภาพนิ่งให้ผู้ใช้ (เฉพาะแหล่งที่เครื่องนี้ดึงรายชื่อเอง) · `0` = แสดงลิงก์ไปเว็บหน่วยงานอย่างเดียว |
| `CONTACT_EMAIL` | (ว่าง) | อีเมลสำหรับแจ้งเรื่องความเป็นส่วนตัว/ขอให้หยุดแสดงภาพ แสดงในหน้า "เกี่ยวกับ" |

ผลในแต่ละรูปแบบการติดตั้ง:

| รูปแบบ | ภาพกล้อง กทม. | ภาพกล้องกรมทรัพยากรน้ำ |
|---|---|---|
| A. Docker ในไทย | แสดงภาพ (เครื่องดึงเอง) | แสดงภาพ |
| B. Vercel + Supabase + เครื่องในไทย | ลิงก์ (บน Vercel ค่าเริ่มต้น `CCTV_IMAGES=0` เพราะ Vercel ดึงภาพ กทม. ไม่ได้ และแต่ละ instance ไม่ได้ใช้แคช/โควตาร่วมกัน) — เครื่องในไทยเป็นผู้ดึงรายชื่อ | ลิงก์ |
| C. คลาวด์อย่างเดียว | ไม่มีรายชื่อ (cron ไม่ดึงแหล่งที่รับเฉพาะ IP ไทย) | ลิงก์ (ถ้าเป็นเซิร์ฟเวอร์ปกติที่ไม่ใช่ serverless และตั้ง `CCTV_IMAGES=1` จะลองดึงภาพเอง) |
| relay | เครื่องในไทยส่งรายชื่อแยกหลังส่งข้อมูลระดับน้ำ (ไม่ส่งที่อยู่สตรีม) — ฝั่งเซิร์ฟเวอร์เป็นลิงก์ | เซิร์ฟเวอร์ลองดึงรายชื่อเองเพื่อแสดงภาพ |

- ภาพเป็นภาพนิ่ง อัปเดตราว 1–3 นาที ไม่ใช่วิดีโอสด และไม่ถูกใช้คำนวณสถานะหรือแจ้งเตือน
- การจำกัดคำขอภาพต่อผู้ใช้ (ภาพใหม่ 40 ภาพต่อ 10 นาที ดึงพร้อมกันไม่เกิน 2) ใช้ IP จาก `TRUST_PROXY` — ถ้า `TRUST_PROXY=none` ระบบแยกผู้ใช้ไม่ได้
  จะเหลือแค่เพดานรวมต่อชั่วโมง (ผู้ใช้คนเดียวที่ยิงถี่อาจใช้โควตาหมดได้) และ log จะขึ้น `[cctv] WARNING: camera stills are on but TRUST_PROXY=none`
  — ตั้งให้ตรงกับ proxy ที่ใช้ (เช่น `cloudflare` เมื่อเปิดผ่าน Cloudflare Tunnel) · ผู้ใช้หลายคนในเครือข่ายมือถือเดียวกันอาจใช้ IP ร่วมกัน
- ถ้าไม่ได้ตั้ง `CONTACT_EMAIL` log จะเตือน และหน้า "เกี่ยวกับ" จะบอกตรง ๆ ว่ายังไม่มีช่องทางติดต่อ
- ถ้าเครื่องถูกปฏิเสธ (network error, 403 หรือหน้า challenge) 3 ครั้งติดโดยยังไม่เคยได้ภาพ หรือหน่วยงานตอบ 429 / 403 ซ้ำ
  ระบบจะเปลี่ยนเป็นลิงก์ไปเว็บหน่วยงานชั่วคราว (30 นาที / 1–60 นาที) ดูสถานะได้ที่ `/api/health` → `cameras[].imagesReason`
- แคช โควตาต่อชั่วโมง และการดึงครั้งเดียวต่อกล้องทำงานในโปรเซสเดียว — เหมาะกับเซิร์ฟเวอร์ที่รันตลอด (Docker/VPS) ไม่ใช่ serverless
- `/api/health` มีส่วน `cameras` บอกเวลาที่ได้รายชื่อล่าสุด จำนวนกล้อง และจำนวนภาพที่ดึงในชั่วโมงที่ผ่านมา
- relay เก็บรอบเวลาดึงรายชื่อกล้องไว้ที่ `DATA_DIR/relay-camera-schedule.json`

## ก่อนเปิดให้บริการสาธารณะ

- ขออนุญาตใช้ข้อมูลจากสำนักการระบายน้ำ กทม. และ สสน. (info_thaiwater@hii.or.th) และแสดงที่มาของข้อมูล (มีในหน้า "เกี่ยวกับ")
- กล้อง CCTV: ขออนุญาตสำนักการระบายน้ำ กทม. และกรมทรัพยากรน้ำ (mekhala@dwr.mail.go.th) ก่อนแสดงภาพต่อสาธารณะ ตั้ง `CONTACT_EMAIL`
  และลองเปิดภาพจริงบนเครื่องในไทยก่อน — ถ้าเห็นใบหน้าหรือป้ายทะเบียนชัด ควรตั้ง `CCTV_IMAGES=0` จนกว่าจะมีการย่อภาพ
- RainViewer: ตั้งแต่ 1 ม.ค. 2569 API ฟรีอนุญาตเฉพาะการใช้ส่วนบุคคล/การศึกษา — ถ้าเปิดบริการสาธารณะโดยไม่มีข้อตกลง ให้ตั้ง `RAINVIEWER=0` (การ์ดเรดาร์จะแสดงภาพเรดาร์ กทม. ถ้าโหลดได้ และลิงก์ไปเรดาร์ทางการของกรมอุตุฯ แทน)
- Open-Meteo ฟรีสำหรับการใช้งานที่ไม่ใช่เชิงพาณิชย์ (CC BY 4.0) — เชิงพาณิชย์ใช้แผน API key
- ระบุชัดเจนว่าเป็นการประเมินจากข้อมูล ไม่ใช่ประกาศเตือนภัยทางการ (มีในหน้าเว็บและท้ายข้อความแจ้งเตือน)
