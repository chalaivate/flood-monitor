-- Flood Monitor — initial schema (mirrors src/lib/store/sqlite.ts).
--
-- Access model: the server (Next.js API routes, worker) connects with the
-- service-role key, which bypasses RLS. Every table has RLS enabled and NO
-- policies, and anon/authenticated roles are revoked, so the public anon key
-- cannot read or write anything (place manage-token hashes, channel targets
-- such as e-mail addresses and LINE user ids live here).

-- ---------------------------------------------------------------------------
-- Stations & readings
-- ---------------------------------------------------------------------------
create table if not exists public.stations (
  id          text primary key,
  source      text not null,
  kind        text not null,
  lat         double precision not null,
  lng         double precision not null,
  data        jsonb not null,               -- full Station object (src/lib/types.ts)
  updated_at  timestamptz not null default now()
);
create index if not exists stations_source_idx on public.stations (source);
create index if not exists stations_kind_idx on public.stations (kind);

create table if not exists public.readings (
  station_id       text not null,
  observed_at      timestamptz not null,
  water_level      double precision,         -- metres, same datum as bank level
  freeboard        double precision,         -- bank − water (m); negative = above bank
  rain_1h          double precision,         -- mm
  rain_24h         double precision,         -- mm
  road_flood_cm    double precision,         -- cm of water on the road
  pumps_running    integer,
  pumps_total      integer,
  official_status  text,
  primary key (station_id, observed_at)
);
create index if not exists readings_observed_at_idx on public.readings (observed_at);

-- Latest reading per station. Equivalent to
--   select distinct on (station_id) * from readings order by station_id, observed_at desc
-- but written as a LATERAL top-1 per station so Postgres does one primary-key
-- index probe per station instead of scanning the whole history window.
create or replace view public.latest_readings
with (security_invoker = true) as
select r.*
from public.stations s
cross join lateral (
  select rr.*
  from public.readings rr
  where rr.station_id = s.id
  order by rr.observed_at desc
  limit 1
) r;

-- ---------------------------------------------------------------------------
-- Ingest bookkeeping
-- ---------------------------------------------------------------------------
create table if not exists public.source_health (
  source      text primary key,
  data        jsonb not null,               -- SourceHealth
  updated_at  timestamptz not null default now()
);

create table if not exists public.meta (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Places, channels, alerting
-- ---------------------------------------------------------------------------
create table if not exists public.places (
  id          text primary key,
  data        jsonb not null,               -- Place (includes manageTokenHash = sha256 hex)
  created_at  timestamptz not null default now()
);
create index if not exists places_created_at_idx on public.places (created_at);

create table if not exists public.channels (
  id          text primary key,
  place_id    text not null references public.places (id) on delete cascade,
  type        text not null check (type in ('webpush', 'line', 'telegram', 'ntfy', 'email', 'discord')),
  link_code   text,                         -- one-time code while unverified, else null
  data        jsonb not null                -- Channel
);
create index if not exists channels_place_idx on public.channels (place_id);
create unique index if not exists channels_link_code_key on public.channels (link_code) where link_code is not null;

create table if not exists public.alert_states (
  place_id    text not null references public.places (id) on delete cascade,
  key         text not null,
  data        jsonb not null,               -- AlertState
  primary key (place_id, key)
);

create table if not exists public.alert_events (
  id          text primary key,
  place_id    text not null references public.places (id) on delete cascade,
  created_at  timestamptz not null,
  data        jsonb not null                -- AlertEvent (with deliveries)
);
create index if not exists alert_events_place_idx on public.alert_events (place_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled everywhere, no policies (service role only).
-- ---------------------------------------------------------------------------
alter table public.stations      enable row level security;
alter table public.readings      enable row level security;
alter table public.source_health enable row level security;
alter table public.meta          enable row level security;
alter table public.places        enable row level security;
alter table public.channels      enable row level security;
alter table public.alert_states  enable row level security;
alter table public.alert_events  enable row level security;

revoke all on table
  public.stations, public.readings, public.source_health, public.meta,
  public.places, public.channels, public.alert_states, public.alert_events,
  public.latest_readings
from anon, authenticated;

grant select, insert, update, delete on table
  public.stations, public.readings, public.source_health, public.meta,
  public.places, public.channels, public.alert_states, public.alert_events
to service_role;
grant select on table public.latest_readings to service_role;
