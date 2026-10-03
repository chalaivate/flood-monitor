# การติดตั้งและ Deploy

ข้อจำกัดสำคัญ: endpoint ของ กทม. (`*.bangkok.go.th`) ตอบเฉพาะ IP ในประเทศไทย ส่วน ThaiWater / Open-Meteo / RainViewer ใช้ได้จากทุกที่
จึงมี 3 รูปแบบให้เลือก

| รูปแบบ | เหมาะกับ | ข้อมูล กทม. | ฐานข้อมูล | ค่าใช้จ่าย |
|---|---|---|---|---|
| A. All-in-one Docker บนเครื่องในไทย | ใช้งานจริงแบบง่ายที่สุด | ได้ครบ | SQLite (ไฟล์) | ค่าไฟ/ค่า VPS ไทย |
| B. Vercel + Supabase + เครื่องดึงข้อมูลในไทย | เว็บบนคลาวด์ รองรับผู้ใช้จำนวนมาก | ได้ครบ (จากเครื่องในไทย) | Supabase Postgres | ฟรี tier ได้ |
| C. คลาวด์อย่างเดียว (ไม่มีเครื่องในไทย) | ทดลอง/สำรอง | ใช้ข้อมูลทวนจาก ThaiWater แทน | SQLite หรือ Supabase | ฟรี tier ได้ |

ทุกแบบต้องใช้ Node.js 22.13 ขึ้นไป (ใช้ `node:sqlite` ที่มากับ Node)

---

## 0. ทดลองในเครื่องด้วยข้อมูลสาธิต

```bash
npm ci
DATA_MODE=fixture EMBEDDED_WORKER=1 npm run dev
# เปิด http://localhost:3000
```

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

- เว็บอยู่ที่ `http://<เครื่อง>:3000` — ตัวดึงข้อมูลรันในเซิร์ฟเวอร์เดียวกัน (`EMBEDDED_WORKER=1`) ทุก `POLL_MINUTES` นาที
- เปิดให้คนนอกเข้าถึงโดยไม่ต้องเปิด port: ใช้ Cloudflare Tunnel (มีตัวอย่าง service `cloudflared` ใน `docker-compose.yml`) แล้วตั้ง `PUBLIC_BASE_URL` เป็นโดเมนนั้น
  และตั้ง `TRUST_PROXY=cloudflare` เพื่อให้จำกัดคำขอต่อ IP ของผู้ใช้จริงได้ (ดู [TRUST_PROXY](#trust_proxy-ip-ของผู้ใช้สำหรับการจำกัดคำขอ))
- สำรองข้อมูล: `sqlite3 data/flood.db ".backup backup.db"`
- ตรวจสุขภาพ: `curl http://localhost:3000/api/health`

ไม่ใช้ Docker ก็ได้:

```bash
npm ci && npm run build
EMBEDDED_WORKER=1 node .next/standalone/server.js   # คัดลอก .next/static และ public ไปไว้ข้าง ๆ ตามคู่มือ Next.js standalone
# หรือแยกเป็นสองโปรเซส: `npm start` (เว็บ) + `npm run worker` (ตัวดึงข้อมูล) ใช้ DATA_DIR เดียวกันได้ (SQLite WAL)
```

---

## B. Vercel + Supabase + เครื่องดึงข้อมูลในไทย

1. **Supabase**: สร้างโปรเจกต์ แล้วรัน `supabase/migrations/20261003000000_init.sql` (SQL Editor หรือ `supabase db push`)
   ตารางทั้งหมดเปิด RLS และไม่มี policy สำหรับ anon — เซิร์ฟเวอร์ใช้ service role key เท่านั้น
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
# ทั้งสองฝั่งตั้ง INGEST_TOKEN ค่าเดียวกัน
npm run worker -- --relay https://<โดเมน>
```

---

## C. คลาวด์อย่างเดียว

ตั้ง `SOURCES=thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road` แล้ว deploy แบบ B (ไม่ต้องมีเครื่องในไทย, `RUN_ALERTS=1` ที่ cron)
ข้อมูลคลองของ กทม. จะมาผ่าน ThaiWater (ประมาณ 280 จุด ช้ากว่าต้นทางเล็กน้อย) — ไม่มีสถานีสูบน้ำ และภาพเรดาร์ของ กทม. จะไม่แสดง

---

## ตั้งค่าช่องทางแจ้งเตือน

| ช่องทาง | ขั้นตอน |
|---|---|
| Web Push | `npm run vapid` แล้วคัดลอก 3 บรรทัดที่ได้ลง `.env` (เปลี่ยนกุญแจแล้วผู้ใช้เดิมต้องเปิดการแจ้งเตือนใหม่) |
| LINE | LINE Developers Console → สร้าง Provider + Messaging API channel → ออก Channel access token (long-lived) → ใส่ `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_ADD_FRIEND_URL` → ตั้ง Webhook URL `https://<โดเมน>/api/line/webhook` และเปิด Use webhook, ปิด Auto-reply ใน LINE Official Account Manager |
| Telegram | @BotFather → `/newbot` → ใส่ `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` → ลงทะเบียน webhook: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<โดเมน>/api/telegram/webhook&secret_token=<SECRET>"` |
| ntfy | ไม่ต้องตั้งค่า (หรือใช้เซิร์ฟเวอร์ของตัวเองด้วย `NTFY_BASE_URL`) |
| อีเมล | สมัคร Resend, ยืนยันโดเมนผู้ส่ง, ใส่ `RESEND_API_KEY` และ `EMAIL_FROM` |
| Discord | ไม่ต้องตั้งค่า |

ช่องทางที่ไม่ได้ตั้งค่าจะถูกซ่อนในหน้า "แจ้งเตือน" โดยอัตโนมัติ (อ่านจาก `/api/config/public`)

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

## ก่อนเปิดให้บริการสาธารณะ

- ขออนุญาตใช้ข้อมูลจากสำนักการระบายน้ำ กทม. และ สสน. (info_thaiwater@hii.or.th) และแสดงที่มาของข้อมูล (มีในหน้า "เกี่ยวกับ")
- RainViewer: ตั้งแต่ 1 ม.ค. 2569 API ฟรีอนุญาตเฉพาะการใช้ส่วนบุคคล/การศึกษา — ถ้าเปิดบริการสาธารณะโดยไม่มีข้อตกลง ให้ตั้ง `RAINVIEWER=0` (การ์ดเรดาร์จะแสดงภาพเรดาร์ กทม. ถ้าโหลดได้ และลิงก์ไปเรดาร์ทางการของกรมอุตุฯ แทน)
- Open-Meteo ฟรีสำหรับการใช้งานที่ไม่ใช่เชิงพาณิชย์ (CC BY 4.0) — เชิงพาณิชย์ใช้แผน API key
- ระบุชัดเจนว่าเป็นการประเมินจากข้อมูล ไม่ใช่ประกาศเตือนภัยทางการ (มีในหน้าเว็บและท้ายข้อความแจ้งเตือน)
