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
| `src/lib/sources/cameras/*` | CCTV camera catalogue adapters (`CameraCatalogAdapter`): `bma-floodcam`, `dwr-cctv`, `demo-cam`. |
| `src/lib/cameras/*` | Camera catalogues in Store meta (public list + server-only refs), refresh scheduling, station join. |
| `src/lib/server/cctv-proxy.ts`, `image-cache.ts`, `cctv-demo-image.ts` | On-demand camera stills: allowlist, shared cache, budgets; demo SVG. |
| `src/lib/store/*` | `Store` interface, `SqliteStore`, `SupabaseStore`, `index.ts` → `getStore()`. |
| `src/lib/notify/*` | `ChannelSender` per channel + `index.ts` → `getSenders()`. |
| `src/lib/server/*` | Server helpers: auth (manage token), validation schemas, JSON responses, rate limit. |
| `src/app/api/**` | Route handlers (see §5). |
| `src/app/**/page.tsx`, `src/components/**` | UI (see §6). |
| `worker/poll.ts` | Standalone poller (`--once`, `--relay <url>`). |
| `supabase/migrations/*.sql` | Postgres schema mirroring the SQLite schema. |

## 2a. CCTV cameras

Cameras are **not** Stations: no readings, no status, no alerts. Images are stills fetched on
demand and never influence status.

- **Catalogues** (`src/lib/sources/cameras/*` → `src/lib/cameras/catalog.ts`):
  `bma-floodcam` (DDS flood-watch cameras, `floodbangkok…/items/camera_profile`, Thai IP only,
  daily, drifting to 03:00), `dwr-cctv` (DWR river telemetry cameras, central plains, weekly),
  `demo-cam` (fixture mode). The poll cycle refreshes due catalogues after ingest → alerts → prune
  (embedded worker and `worker/poll.ts` refresh every enabled source; `/api/cron/poll` only sources
  that are not Thai-IP-only). A failure never affects the cycle and keeps the last good list; a
  shutdown abort is not a failure; the 120 s deadline is. Failures of Thai-IP-only sources are
  tracked per host (`cctv:status` `hosts`), so a cloud host can never block the Thai worker.
  BMA refresh drifts to the 03:xx Bangkok hour once the list is ≥ 1 h old. A DWR station lookup that
  fails keeps the camera's last known position; the refresh fails if more than max(2, 10%) lookups
  fail with no known position.
- **Storage** (Store meta, per source): `cctv:catalog:<src>` public list, `cctv:refs:<src>`
  server-only upstream references (BMA stream address, DWR snapshot id — never in an API
  response, log or relay), `cctv:index:<src>` (commit point), `cctv:status:<src>` (refresh
  bookkeeping). A list under 50% of the previous size is refused until it repeats in ≥ 3 distinct
  fetches over ≥ 24 h (relayed lists too). `nearStationIds` (road ≤ 50 m, canal/river ≤ 150 m) is
  computed at save time.
- **Relay**: readings are POSTed first; camera lists follow in their own POST to `/api/ingest`
  (`results: []`, `cameraCatalogs` with public fields only, zod-validated, ≤ 5 lists / 5000 cameras).
  Each `cameras[i]` answer carries `saved`, `count`, `warning` and on refusal `reason`/`retry`; the
  relay resends an unconfirmed list up to 6 times, then refetches with backoff. A relayed list drops
  this host's refs, so that source is link-only here, and a relayed Thai-only list is only ever
  refreshed by the relay.
- **Images** (`/api/cctv/image/[source]/[nativeId].jpg`): served only when `CCTV_IMAGES=1` and
  this host holds the source's refs (it fetched the list itself). Checks before any upstream call:
  source enabled, camera in catalogue, per-IP limit. Upstream hosts are fixed per source and URLs
  are built server-side; within one server process one request per camera is shared by all viewers
  (limits and caches are per process — per warm instance on serverless, which is why Vercel
  defaults to `CCTV_IMAGES=0`).

  | | `bma-floodcam` | `dwr-cctv` |
  |---|---|---|
  | Fresh / fail / stale max | 60 s / 60 s / 15 min | 5 min / 60 s / 60 min |
  | Timeout | 25 s | 20 s for both steps together |
  | In flight (source queue) | 3 (20) | 2 (10) |
  | Hourly upstream budget (per process) | 600 | 240 |

  Queue wait is 15 s in total (client line + source queue); the server's worst case is 40 s, below
  the client's 50 s watchdog. **Per client** (only with a trusted client IP, see `TRUST_PROXY`):
  cache hits are free; a request that goes upstream takes one of 40 misses per 10 min per IP
  (IPv6 grouped by /64), at most 2 running or queued at once plus 6 waiting; beyond that 429
  `limited` (a still-valid older frame is served instead when there is one). Abandoned requests
  leave the queue at once (`req.signal`).
  Accepts JPEG (magic check, trim after the last `FF D9`), PNG (≥ 64×48, smaller = placeholder) and WebP;
  same-origin redirects only (≤ 2); browser-style User-Agent with a `flood-monitor/0.1 (+…/about)` suffix;
  2 MB cap, frozen-frame hash (`X-Cctv-Changed-At`). Health shows `lastFailure: { reason, at }` per
  source (no camera ids); the log prints each failure reason once per 30 min. `npm run cctv:probe`
  diagnoses the BMA frame proxy from the server's own network.
  Frames live in memory only (LRU ≈ 300) and are swept by age (never older than the stale max:
  15 min BMA, 60 min DWR); frame hashes (no image data) are forgotten after 2 h without a view.
  **Fallbacks:** a host that never got a frame for a source and is turned away 3 times in a row
  (network error, 403 or an HTML/challenge page — not timeouts or 5xx) shows agency links for 30 min;
  an agency 429, or 403/503 with Retry-After, or three 403s in a row pauses the source for
  1–60 min. During either, the camera list marks the source `media: 'link'` and the image route
  answers 503 `unavailable`. Startup logs `[cctv] WARNING` when stills are on with
  `TRUST_PROXY=none` or without `CONTACT_EMAIL`. Demo mode returns a generated SVG labelled
  "ภาพจำลอง".

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
- `GET /api/health` → `{ ok, dataMode, lastIngestAt, lastAlertsAt, sources: SourceHealth[], cameras: [{ source, ok, catalogAt, count, lastError, images, imagesReason: 'disabled'|'link-only'|'host-unreachable'|'agency-backoff'|null, imagesUntil, frames1h: { ok, fail, refused, budget: 'ok'|'low'|'spent' } | null, lastFrame }] }` (cameras never change `ok`).
- `GET /api/cctv/cameras?lat&lng&r&n` → `CamerasResponse`: every camera of the nearest `n` sites
  (default 4, ≤ 24) within `r` km (default 3, 0.5–20), with `distanceKm`, `media: 'image' | 'link'`,
  `imageUrl`, `refreshSec`; `nearestOutsideKm`; `links[]` (agency camera pages we only link to);
  `catalogAt`. Without lat/lng: every camera (map layer).
- `GET /api/cctv/image/[source]/[file]` (`<nativeId>.jpg`, `.svg` in demo) → still with
  `X-Cctv-Fetched-At`, `X-Cctv-Captured-At` (DWR), `X-Cctv-Changed-At`, `X-Cctv-Stale`,
  `Cache-Control`, `CSP default-src 'none'`, `nosniff`, `CORP same-origin`. Errors are JSON
  `{ error, reason }`: 404 `not-found`; 429 `limited` + Retry-After (per-IP request or miss limits);
  502 `unreachable` | `no-image`; 503 `busy` | `budget` + Retry-After; 503 `unavailable` + Retry-After
  (images off, link-only list, host fallback or agency backoff — no upstream call). The UI treats
  404 and `unavailable` as link-only (stops automatic requests ≥ 5 min, reloads the camera list at most
  every 20 s) and honours Retry-After (429: every camera; 503: that source).
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
`--muted` stays ≥ 4.5:1 on every surface (a test computes the ratios from globals.css); filled buttons use
`--accent-fill` with white text; accent-coloured text uses `--accent-text`; `--accent` is only for lines,
borders and focus rings (≥ 3:1).
Status colour is **never alone**: always `LevelDot` (shape differs by level) and/or Thai label.

Routes:
- `/` dashboard for the current place (URL `?place=` | `?lat&lng&label` | localStorage `fm-place` | default).
  Cards are in the DOM in phone priority order — **สถานการณ์ตอนนี้**, 2×2 **gauge cards** (freeboard, trend, age),
  **ระยะห่างตลิ่ง 48 ชม. (ม.)** chart (crosshair tooltip, threshold lines, table view), **ฝนสะสม 24 ชม. รอบบ้าน**
  (0–150 mm, TMD bands), road-flood list (when any), **อากาศที่บ้านตอนนี้**, **เรดาร์ฝน** (RainViewer + BMA
  Nong Chok / Nong Khaem / forecast image tabs; ARIA tablist, forecast images never labelled "ตอนนี้"), legend.
  Wider screens place them with `.fm-dash` grid-template-areas (never `order` / `display: contents`), so focus
  order follows reading order. Desktop: top row situation · gauges · history; weather under the gauges; rain and
  road flood under the situation; radar under the history; legend full width. Tablet reads row by row in DOM order.
  - Out of coverage (`snapshot.coverage.nearestWaterKm` beyond the radius): "สถานีวัดน้ำที่ใกล้ที่สุดอยู่ห่าง X กม. —
    อยู่นอกพื้นที่ครอบคลุม" with "เลือกตำแหน่งอื่น"; within reach: "ขยายรัศมีเป็น N กม."; no recent data anywhere: says so.
  - Banners: demo-data banner (`dataMode = fixture`), stale-data banner (lastIngestAt older than 3× poll),
  - **กล้อง CCTV ใกล้บ้าน** (`src/components/cctv/CameraCard.tsx`, area `cam`): full-width row above the
    legend (after radar in the DOM). One `/api/cctv/cameras` request per place (r = max(radius, 10), n = 12),
    2×2 tiles (4 across from 48rem), one per site with an "N มุม" badge, distance, credit, time badge and
    the joined sensor's own level; sites whose sensor is ≥ watch first; "นอกรัศมี" fill up to 10 km.
    Tiles refresh every 180 s only when on screen, tab visible, not paused (`localStorage['fm-cctv-paused']`),
    not Save-Data and while the viewer is closed. Viewer (`CameraViewer.tsx`, dialog/sheet; opening adds a
    history entry so Back closes it; state is dropped on navigation): every 60 s, 50 s watchdog, auto-pause after 5 min,
    angle and site switching, rights line, "เปิดเว็บทางการ" (`noopener noreferrer`). Stills are fetched →
    blob → object URL (swap after decode, revoke). States and Thai copy in `src/lib/ui/cctv.ts`
    (BMA stale after 5 min; DWR by capture time: stale 45 min, old 24 h; frozen = same picture ≥ 15 min or
    3 upload intervals; dates shown when a still is not from today). Never "สด"/"LIVE"; never implies
    dry/normal from an image.
    "set your location" prompt when using the default place.
  - Auto-refresh every 60 s; manual refresh button.
- `/map` all stations (Leaflet + OSM tiles) coloured by level, filter by kind, RainViewer overlay toggle,
  "กล้อง CCTV" layer (off by default; `?cams=1`; neutral camera markers, popup ดูภาพ / เปิดเว็บทางการ —
  opening a marker moves focus into its popup, Escape returns to the marker; station popups get
  "ดูกล้องที่จุดนี้ (N มุม)"),
  click map / "ใช้ตำแหน่งของฉัน" / paste Google Maps link to set home, radius circle, list of nearest.
- `/alerts` set up alerts: place form (label, location picker, radius, thresholds, min level),
  channel cards (Web Push on this device, LINE, Telegram, ntfy, Email, Discord) with clear Thai
  instructions, test button, alert history. Stores `{placeId, manageToken}` in localStorage `fm-place`.
  LINE/Telegram link codes show "รหัสใช้ได้ถึง HH:mm น." and, once expired, "รหัสหมดอายุ" + "ขอรหัสใหม่".
  On a non-secure origin (`!isSecureContext`) Web Push and "ใช้ตำแหน่งปัจจุบัน" explain that HTTPS is required.
  Channels the server does not offer are hidden (e-mail) or greyed out.
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
