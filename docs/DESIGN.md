# Flood Monitor — engineering design

Thai flood early-warning system. Users pick a location ("บ้าน"); the system tracks the nearest
canal / river water-level gauges (distance from water surface to the lower bank = **freeboard**,
ระยะห่างตลิ่ง), rainfall, road-flood sensors, weather and rain radar, shows a Home-Assistant-style
dashboard and pushes alerts when the situation changes.

User-facing text is Thai. Code, comments and identifiers are English.

## 1. Architecture

```
            Thailand-hosted collector (required for BMA)            Cloud / any host
 ┌─────────────────────────────────────────────┐     ┌───────────────────────────────────────┐
 │ worker/poll.ts  (Node 22, every 5–10 min)   │     │ Next.js 16 app (UI + API routes)      │
 │  sources: bma-canal, bma-rain, bma-roadflood│     │  /api/snapshot  /api/stations ...     │
 │           bma-pump (Thai IP only)           │     │  /api/cron/poll  (cloud sources:      │
 │           thaiwater-* (anywhere)            │────▶│    ThaiWater, optional)               │
 │  → Store (SQLite or Supabase)               │     │  /api/ingest    (relay push, token)   │
 │  → evaluateAlerts → notify channels         │     │  Store (SQLite or Supabase)           │
 └─────────────────────────────────────────────┘     └───────────────────────────────────────┘
```

Why a Thai collector: every `*.bangkok.go.th` endpoint sits behind Cloudflare and answers 403 /
times out for foreign and data-centre IPs (GitHub Actions, Vercel, Cloudflare Workers, Apps
Script). ThaiWater (api-v3.thaiwater.net) mirrors many BMA gauges and is reachable from the cloud,
so it is the fallback when no Thai collector runs.

Deployment modes (docs/DEPLOY.md):

1. **All-in-one (recommended)** — one Docker container on a machine in Thailand (office PC, mini PC,
   NAS, Thai VPS). `STORE=sqlite`, `EMBEDDED_WORKER=1` runs the poller inside the Next.js server
   (`src/instrumentation.ts`). Expose with Cloudflare Tunnel.
2. **Cloud UI + Thai collector** — Vercel (UI/API) + Supabase (`STORE=supabase`). A Thai machine runs
   `npm run worker` with the same Supabase credentials (fetch + store + alerts). Optional Vercel Cron
   → `/api/cron/poll` with `SOURCES=thaiwater-canal,thaiwater-wl,thaiwater-rain` as a cloud fallback.
   Only ONE place should run alerts (`RUN_ALERTS=0` on the others).
3. **Relay** — any host runs the app; a Thai device runs `npm run worker -- --relay https://host` which
   fetches Thai-only sources and POSTs them to `/api/ingest` (Bearer `INGEST_TOKEN`).

## 2. Module map and ownership

| Path | Purpose |
|---|---|
| `src/lib/types.ts` | **Shared contracts** (Station, Reading, Place, Channel, AlertEvent, DashboardSnapshot …). Change only with care. |
| `src/lib/config.ts` | Env parsing (zod). Server-only. |
| `src/lib/geo.ts`, `src/lib/time.ts` | Haversine/nearest/parseLatLng; Bangkok time parsing & Thai formatting. |
| `src/lib/engine/status.ts` | Levels from freeboard / rain / road depth, trend cm/h. |
| `src/lib/engine/snapshot.ts` | `buildSnapshot()` → `DashboardSnapshot` for a place. |
| `src/lib/engine/alerts.ts` | Pure `evaluateAlerts()` (hysteresis, cooldowns, merge to one message). |
| `src/lib/engine/format.ts` | Thai number/line formatting. |
| `src/lib/pipeline.ts` | `runIngest`, `runAlerts`, `runCycle`, `deliverEvent`, `storeSourceResult`. |
| `src/lib/sources/*` | One adapter per upstream (`SourceAdapter`), `index.ts` → `getSources(config)`. |
| `src/lib/weather/*` | `getWeather(lat, lng)` (Open-Meteo, cached). |
| `src/lib/radar.ts` | `radarImages()` list for the dashboard. |
| `src/lib/store/*` | `Store` interface, `SqliteStore`, `SupabaseStore`, `index.ts` → `getStore()`. |
| `src/lib/notify/*` | `ChannelSender` per channel + `index.ts` → `getSenders()`. |
| `src/lib/server/*` | Server helpers: auth (manage token), validation schemas, JSON responses, rate limit. |
| `src/app/api/**` | Route handlers (see §5). |
| `src/app/**/page.tsx`, `src/components/**` | UI (see §6). |
| `worker/poll.ts` | Standalone poller (`--once`, `--relay <url>`). |
| `supabase/migrations/*.sql` | Postgres schema mirroring the SQLite schema. |

## 3. Data model rules

- Station ids: `canal:<water_code>` for Bangkok canal gauges (shared by `bma-canal` and the
  `thaiwater-canal` mirror so they merge), otherwise `<source>:<nativeId>`.
- All timestamps stored as ISO-8601 UTC (`Date#toISOString()`). Display in `Asia/Bangkok`.
- `Reading.freeboard = round2(bankLevel − waterLevel)`; negative = above bank. `bankLevel` is the
  lower of left/right banks; ≤ 0 or ≥ 10 ⇒ null. Dubious banks set `Station.bankUncertain` (status
  capped at "watch").
- Never alert on stale readings (default `STALE_MINUTES=60`; rain gauges 90, road 180 recommended).
- BMA's own status (`officialStatus`) is informational only — its thresholds are unreliable.

## 4. Levels & alert rules (defaults, per place configurable)

| Level | Thai | Freeboard (m) | Rain 24 h (mm, TMD classes) | Road depth (cm) |
|---|---|---|---|---|
| normal | ปกติ | ≥ 0.60 | < 35.1 | < 5 |
| watch | เฝ้าระวัง | < 0.60 | ≥ 35.1 (ฝนหนัก) | ≥ 5 |
| warning | เตือนภัย | < 0.30 | ≥ 90.1 (ฝนหนักมาก) | ≥ 15 |
| critical | วิกฤต | < 0.10 or above bank | ≥ 150 | ≥ 30 |

Alerts (`evaluateAlerts`): escalate when a station's level rises to ≥ `place.notifyMinLevel`
(default `warning`); de-escalate ("คลี่คลาย") with 5 cm hysteresis; critical reminder every 3 h;
rapid rise ≥ `rapidRiseCm` (10) cm/h when already ≥ watch or projected to reach watch within 3 h
(cooldown 2 h); rain escalation; road flood escalation. All findings of one cycle merge into one
message per place.

`runAlerts` is single-flight across processes through a store lease (`tryLock('alerts')`, 5 min TTL;
SQLite `locks` table, Supabase `try_lock` RPC). If the lease itself errors (e.g. the locks migration
was not run) it falls back to an in-process lock and logs a warning: a broken lease may duplicate a
message across processes but never silences alerts. Each saved `AlertState` carries
`settings = alertSettingsKey(place)`; states saved under other place settings (a cycle racing a PATCH)
count as absent. When every channel of a place fails, the findings are re-raised next cycle (≤ 3 times).

## 5. HTTP API (JSON unless noted)

Public (no auth):
- `GET /api/snapshot?lat=&lng=&label=&r=&n=` or `?place=<id>` → `DashboardSnapshot`.
  `r` radius km (0.5–20, default 3), `n` max stations (1–8, default 4).
- `GET /api/stations` → `{ generatedAt, stations: MapStation[] }` where
  `MapStation = { id, kind, source, name, shortName, district, lat, lng, level, stale, observedAt, waterLevel, bankLevel, freeboard, rain24h, rain1h, roadFloodCm, officialStatus }`.
- `GET /api/history?ids=a,b&hours=48` → `{ series: Record<stationId, HistoryPoint[]> }` (≤ 8 ids, ≤ 168 h).
- `GET /api/config/public` → `{ dataMode, defaultPlace: {label,lat,lng}, pollMinutes, channels: Record<ChannelType, boolean>, telegramBot: string|null, lineAddFriendUrl: string|null, vapidPublicKey: string|null, rainviewer: boolean }`.
  A channel is `true` only when its full settings are present (`notify/index.ts` `CHANNEL_SETTINGS`: LINE token + secret +
  `LINE_ADD_FRIEND_URL`; Telegram token + webhook secret + bot username; e-mail Resend key + `EMAIL_FROM` + a valid
  `PUBLIC_BASE_URL`); `telegramBot`, `lineAddFriendUrl`, `vapidPublicKey` are null unless that channel is offered.
  Half-configured channels are logged once at server/worker start.
- `GET /api/health` → `{ ok, dataMode, lastIngestAt, lastAlertsAt, sources: SourceHealth[] }`.
- `GET /api/radar/bma/[site]` (`nongchok` | `nongkhaem`) → proxied JPEG (cached ~4 min), 502 when unreachable.

Place management (`Authorization: Bearer <manageToken>` for everything except create):
- `POST /api/places` body `PlaceInput` → `{ place: PublicPlace, manageToken }` (token shown once; we store sha256).
- `GET|PATCH|DELETE /api/places/[id]`.
- `GET|POST /api/places/[id]/channels`, `DELETE /api/places/[id]/channels/[channelId]`.
  POST body `{ type, target? }` → `{ channel: PublicChannel, link?: { code, url?, instructions } }`.
  webpush/ntfy/discord verified immediately; telegram/line need an 8-char link code (60 min) sent to the bot;
  email needs the confirmation link. E-mail limits use a normalised mailbox key (lower-case, no `+tag`,
  Gmail dots removed, googlemail → gmail): ≤ 3 e-mail channels per place, 1 confirmation mail per mailbox
  per 15 min and 3 per day, 5 per place per day, plus a server-wide cap; an already confirmed mailbox
  returns the existing channel.
- `POST /api/places/[id]/test` → sends a test message → `{ deliveries }`.
- `GET /api/places/[id]/events?limit=50` → `{ events: AlertEvent[] }`.

Webhooks / machine:
- `POST /api/line/webhook` (X-Line-Signature HMAC-SHA256 with `LINE_CHANNEL_SECRET`): follow → greeting;
  text containing an 8-char link code → verify LINE channel; "สถานะ" → reply current situation.
- `POST /api/telegram/webhook` (header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`):
  `/start <code>` links; `/status` replies.
- `GET /api/email/confirm?code=` → HTML page with a button only (mail scanners fetch links; a GET never verifies).
  `POST /api/email/confirm` (form field `code` in the body; the query string is ignored) → verifies, 303 to the
  relative `/alerts?confirmed=1|0`.
- `GET|POST /api/cron/poll` (Bearer `CRON_SECRET`) → `runCycle` (alerts only if `RUN_ALERTS` ≠ 0).
- `POST /api/ingest` (Bearer `INGEST_TOKEN`) body `{ results: SourceFetchResult[], failures?: {source, error, attemptedAt?}[] }`
  → `{ ok, inserted, sources, alerts: 'scheduled' | null }`. Alerts (when `RUN_ALERTS=1`) and pruning of readings
  older than `HISTORY_HOURS` run after the response (`after()`).

Weather (`/api/snapshot`): Open-Meteo results are cached per 0.02° (~2 km) grid cell for 10 min. Every upstream call,
saved places included, counts against a global budget (400/h; ad-hoc map lookups also against 200/h); when the
budget is spent or the provider fails, the last good value up to 60 min old is served (the UI shows its age).

`PublicPlace` = `Place` without `manageTokenHash`. `PublicChannel` = `Channel` with `target` masked
(e.g. `te***@gmail.com`, `ntfy: fm-***`, web push → device label) and without `linkCode` once verified.

## 6. UI

Dark by default (HA-like), light theme toggle (`data-theme` on `<html>`, key `fm-theme`).
Tokens in `src/app/globals.css` (`--card`, `--text`, `--lv-*` status colours, `--s1..s6` series).
Status colour is **never alone**: always `LevelDot` (shape differs by level) and/or Thai label.

Routes:
- `/` dashboard for the current place (URL `?place=` | `?lat&lng&label` | localStorage `fm-place` | default).
  Desktop 3 columns, mobile 1 column:
  - Col 1: **สถานการณ์ตอนนี้** (overall `LevelBadge` large + bullet lines + "ตรวจล่าสุด dd/MM HH:mm · อัปเดตทุก N นาที"),
    **เรดาร์ฝน** card (RainViewer animated mini-map; BMA Nong Chok / Nong Khaem image tabs when available).
  - Col 2: 2×2 **gauge cards** (freeboard of nearest stations, `Gauge` component, label = shortName,
    trend arrow + age under it), **อากาศที่บ้านตอนนี้** (condition, rain chance next 3 h, rain rate, humidity, temperature).
  - Col 3: legend card ("เข็ม = ระยะจากผิวน้ำถึงขอบตลิ่ง (เมตร) · เฝ้าระวัง < 0.60 · เตือนภัย < 0.30 · วิกฤต < 0.10 · ข้อมูล: …"),
    **ระยะห่างตลิ่ง 48 ชม. (ม.)** multi-line chart (crosshair tooltip, legend with latest values, threshold lines, table view toggle),
    **ฝนสะสม 24 ชม. รอบบ้าน** gauge (0–150 mm, TMD bands), road-flood list when any.
  - Banners: demo-data banner (`dataMode = fixture`), stale-data banner (lastIngestAt older than 3× poll),
    "set your location" prompt when using the default place.
  - Auto-refresh every 60 s; manual refresh button.
- `/map` all stations (Leaflet + OSM tiles) coloured by level, filter by kind, RainViewer overlay toggle,
  click map / "ใช้ตำแหน่งของฉัน" / paste Google Maps link to set home, radius circle, list of nearest.
- `/alerts` set up alerts: place form (label, location picker, radius, thresholds, min level),
  channel cards (Web Push on this device, LINE, Telegram, ntfy, Email, Discord) with clear Thai
  instructions, test button, alert history. Stores `{placeId, manageToken}` in localStorage `fm-place`.
- `/about` data sources & attribution, how to read freeboard, disclaimer ("ไม่ใช่ประกาศทางการ —
  ติดตามประกาศ กทม. สายด่วน 1555 / @BKK_BEST, กรมอุตุนิยมวิทยา, ปภ. 1784").

PWA: `public/manifest.webmanifest`, `public/sw.js` (push → showNotification, notificationclick → open url),
icons. iOS needs "Add to Home Screen" for Web Push (16.4+).

Charts follow the dataviz rules: 2px lines, hairline solid grid, legend for ≥ 2 series, crosshair +
tooltip, text in text tokens (never series colour), no dual axes, table view available.

## 7. Conventions

- TypeScript strict, `noUncheckedIndexedAccess`. No new dependencies without need.
- Next.js 16 App Router: read `node_modules/next/dist/docs/` before using an API (route handler
  `params` is a Promise, `proxy.ts` replaces middleware, etc.).
- Route handlers that touch the store: `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.
- Tests: Vitest in `tests/*.test.ts`, fixtures in `tests/fixtures/`. Inject `fetch`/`sleep`; never hit the network.
- `DATA_MODE=fixture` replaces live sources with the demo generator (clearly labelled in the UI).
