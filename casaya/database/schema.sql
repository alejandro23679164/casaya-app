-- =====================================================================
-- CasaYa — esquema PostgreSQL / Supabase
-- Alternativa relacional al esquema de Firestore (ver firestore-schema.json).
-- Requiere: postgis (geolocalización), pgcrypto (hash del PIN).
-- =====================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type user_role         as enum ('client', 'technician', 'admin');
create type kyc_status        as enum ('pending_kyc', 'in_review', 'approved', 'rejected', 'suspended');
create type kyc_doc_type      as enum ('id_front', 'id_back', 'selfie_liveness', 'criminal_record', 'trade_license');
create type service_category  as enum ('plumbing', 'electrical', 'hvac', 'painting', 'cleaning', 'handyman');
create type pricing_model     as enum ('fixed', 'hourly', 'visit_fee_then_quote');
create type request_status    as enum ('pending', 'accepted', 'en_route', 'in_progress', 'completed', 'cancelled', 'disputed');
create type urgency_level     as enum ('standard', 'same_day', 'express_2h');
create type tx_status         as enum ('requires_payment', 'held', 'captured_pending_payout', 'released', 'partially_refunded', 'refunded', 'failed');
create type release_method    as enum ('client_pin', 'auto_timeout', 'admin_resolution');

-- ---------------------------------------------------------------- users
-- En Supabase, id referencia auth.users(id).
create table app_users (
  id                        uuid primary key,
  role                      user_role   not null,
  full_name                 text        not null,
  phone                     text        not null unique,     -- E.164
  phone_verified            boolean     not null default false,
  email                     text,
  photo_url                 text,
  locale                    text        not null default 'es-AR',
  disabled                  boolean     not null default false,
  address_line1             text,
  address_notes             text,
  city                      text,
  country                   char(2),
  home_location             geography(point, 4326),
  rating_avg                numeric(3,2) not null default 0 check (rating_avg between 0 and 5),
  rating_count              integer     not null default 0,
  created_at                timestamptz not null default now()
);

create table client_profiles (
  user_id                   uuid primary key references app_users(id) on delete cascade,
  payment_customer_id       text,                            -- id en el PSP, nunca datos de tarjeta
  has_verified_payment      boolean     not null default false,
  completed_requests        integer     not null default 0,
  cancelled_requests        integer     not null default 0
);

create table technician_profiles (
  user_id                   uuid primary key references app_users(id) on delete cascade,
  kyc_status                kyc_status  not null default 'pending_kyc',
  service_radius_km         numeric(5,1) not null default 10,
  is_online                 boolean     not null default false,
  jobs_completed            integer     not null default 0,
  acceptance_rate           numeric(4,3) not null default 1,
  payout_account_id         text,
  current_location          geography(point, 4326),
  location_updated_at       timestamptz
);
-- Índice espacial: es lo que hace barata la búsqueda del técnico más cercano.
create index technician_location_idx on technician_profiles using gist (current_location);
create index technician_available_idx on technician_profiles (kyc_status, is_online);

create table emergency_contacts (
  id          bigserial primary key,
  user_id     uuid not null references app_users(id) on delete cascade,
  name        text not null,
  phone       text not null,
  relation    text
);

create table kyc_documents (
  id               bigserial primary key,
  user_id          uuid not null references app_users(id) on delete cascade,
  type             kyc_doc_type not null,
  storage_path     text not null,
  document_number  text,
  status           text not null default 'uploaded' check (status in ('uploaded','verified','rejected')),
  provider         text,
  provider_ref     text,
  liveness_score   numeric(4,3),
  rejection_reason text,
  uploaded_at      timestamptz not null default now(),
  reviewed_at      timestamptz,
  expires_at       timestamptz
);

-- ------------------------------------------------------------- services
create table services (
  id                        text primary key,               -- ej: 'plumbing.drain_unclog'
  category                  service_category not null,
  name                      text not null,
  description               text not null,
  icon                      text,
  pricing_model             pricing_model not null,
  base_price_cents          integer not null check (base_price_cents >= 0),
  hourly_rate_cents         integer not null default 0,
  minimum_billable_minutes  integer not null default 60,
  visit_fee_cents           integer not null default 0,
  currency                  char(3) not null default 'ARS',
  night_surcharge_pct       numeric(4,3) not null default 0.25,
  estimated_minutes         integer not null default 60,
  materials_included        boolean not null default false,
  requires_license          boolean not null default false,
  active                    boolean not null default true
);

create table service_urgency_multipliers (
  service_id  text not null references services(id) on delete cascade,
  urgency     urgency_level not null,
  multiplier  numeric(4,2) not null,
  primary key (service_id, urgency)
);

-- Habilidades del técnico (qué servicios puede tomar).
create table technician_skills (
  user_id     uuid not null references app_users(id) on delete cascade,
  service_id  text not null references services(id) on delete cascade,
  primary key (user_id, service_id)
);

-- ------------------------------------------------------------- requests
create table requests (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references app_users(id),
  technician_id           uuid references app_users(id),
  service_id              text not null references services(id),
  category                service_category not null,
  status                  request_status not null default 'pending',
  urgency                 urgency_level not null default 'standard',
  description             text not null,

  address_line1           text not null,
  address_notes           text,
  location                geography(point, 4326) not null,   -- exacta, visible al aceptar
  coarse_location         geography(point, 4326) not null,   -- difuminada ~1 km, visible antes de aceptar

  scheduled_for           timestamptz,

  quote_currency          char(3) not null,
  quote_base_cents        integer not null,
  quote_urgency_mult      numeric(4,2) not null,
  quote_night_surcharge   integer not null default 0,
  quote_service_fee       integer not null default 0,
  quote_taxes             integer not null default 0,
  quote_total_cents       integer not null,
  quote_is_estimate       boolean not null default true,

  -- El PIN se guarda hasheado: ni un dump de la base revela el código de liberación.
  completion_pin_hash     text,
  pin_attempts            smallint not null default 0,

  created_at              timestamptz not null default now(),
  accepted_at             timestamptz,
  en_route_at             timestamptz,
  check_in_at             timestamptz,
  check_out_at            timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,

  check_in_location       geography(point, 4326),
  check_in_distance_m     numeric(8,1),
  check_out_location      geography(point, 4326),
  technician_notes        text,

  cancelled_by            text check (cancelled_by in ('client','technician','system')),
  cancellation_reason     text,
  cancellation_fee_cents  integer not null default 0,

  constraint request_needs_tech_when_active
    check (status in ('pending','cancelled') or technician_id is not null)
);
create index requests_status_idx      on requests (status, created_at desc);
create index requests_client_idx      on requests (client_id, created_at desc);
create index requests_technician_idx  on requests (technician_id, created_at desc);
create index requests_location_idx    on requests using gist (location);

create table request_media (
  id           bigserial primary key,
  request_id   uuid not null references requests(id) on delete cascade,
  storage_path text not null,
  media_type   text not null check (media_type in ('image','video')),
  stage        text not null default 'problem' check (stage in ('problem','check_in','check_out')),
  uploaded_at  timestamptz not null default now()
);

create table request_tracking (
  id          bigserial primary key,
  request_id  uuid not null references requests(id) on delete cascade,
  location    geography(point, 4326) not null,
  heading     numeric(5,2),
  speed_kmh   numeric(5,2),
  at          timestamptz not null default now()
);
create index request_tracking_idx on request_tracking (request_id, at desc);

create table request_events (      -- bitácora inmutable de auditoría
  id          bigserial primary key,
  request_id  uuid not null references requests(id) on delete cascade,
  type        text not null,
  actor_id    uuid,
  payload     jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

create table dispatch_offers (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references requests(id) on delete cascade,
  technician_id     uuid not null references app_users(id) on delete cascade,
  status            text not null default 'sent' check (status in ('sent','accepted','rejected','expired')),
  distance_km       numeric(6,2) not null,
  estimated_payout  integer not null,
  sent_at           timestamptz not null default now(),
  expires_at        timestamptz not null,
  unique (request_id, technician_id)
);

create table reviews (
  id          bigserial primary key,
  request_id  uuid not null references requests(id) on delete cascade,
  author_id   uuid not null references app_users(id),
  subject_id  uuid not null references app_users(id),
  rating      smallint not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (request_id, author_id)
);

-- --------------------------------------------------------- transactions
create table transactions (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null unique references requests(id),
  client_id           uuid not null references app_users(id),
  technician_id       uuid references app_users(id),
  currency            char(3) not null,
  amount_cents        integer not null,
  platform_fee_cents  integer not null,
  payout_cents        integer not null,
  status              tx_status not null default 'requires_payment',
  psp                 text not null,
  payment_intent_id   text,
  transfer_id         text,
  refund_id           text,
  held_at             timestamptz,
  released_at         timestamptz,
  release_method      release_method,
  auto_release_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table ledger_entries (       -- doble partida simplificada, solo append
  id              bigserial primary key,
  transaction_id  uuid not null references transactions(id) on delete cascade,
  from_account    text not null,
  to_account      text not null,
  amount_cents    integer not null,
  reason          text not null,
  at              timestamptz not null default now()
);

create table panic_alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_users(id),
  role          user_role not null,
  request_id    uuid references requests(id),
  location      geography(point, 4326) not null,
  accuracy_m    numeric(6,1),
  status        text not null default 'open' check (status in ('open','acknowledged','resolved','false_alarm')),
  triggered_at  timestamptz not null default now(),
  notes         text
);

-- ============================================================ funciones
-- Técnicos candidatos ordenados por cercanía. Filtra por KYC aprobado,
-- disponibilidad, habilidad y radio declarado por el propio técnico.
create or replace function nearby_technicians(
  p_request_id uuid,
  p_radius_km  numeric default 10,
  p_limit      integer default 10
)
returns table (technician_id uuid, distance_km numeric, rating numeric)
language sql stable as $$
  select t.user_id,
         round((st_distance(t.current_location, r.location) / 1000)::numeric, 2) as distance_km,
         u.rating_avg
  from requests r
  join technician_profiles t
    on st_dwithin(t.current_location, r.location, p_radius_km * 1000)
  join app_users u on u.id = t.user_id
  join technician_skills s on s.user_id = t.user_id and s.service_id = r.service_id
  where r.id = p_request_id
    and t.kyc_status = 'approved'
    and t.is_online
    and not u.disabled
    -- el punto debe caer también dentro del radio que el técnico aceptó cubrir
    and st_distance(t.current_location, r.location) <= t.service_radius_km * 1000
    -- no re-ofrecer a quien ya rechazó
    and not exists (
      select 1 from dispatch_offers d
      where d.request_id = r.id and d.technician_id = t.user_id
    )
  order by distance_km asc, u.rating_avg desc
  limit p_limit;
$$;

-- Verificación del PIN en una sola transacción atómica: compara el hash,
-- cuenta intentos y libera el escrow. Devuelve true solo si liberó.
create or replace function release_escrow_with_pin(
  p_request_id uuid,
  p_client_id  uuid,
  p_pin        text
)
returns boolean
language plpgsql security definer as $$
declare
  r requests%rowtype;
begin
  select * into r from requests where id = p_request_id for update;

  if r is null or r.client_id <> p_client_id then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if r.status <> 'in_progress' or r.check_out_at is null then
    raise exception 'REQUEST_NOT_READY';
  end if;
  if r.pin_attempts >= 5 then
    raise exception 'PIN_LOCKED';
  end if;

  if r.completion_pin_hash <> crypt(p_pin, r.completion_pin_hash) then
    update requests set pin_attempts = pin_attempts + 1 where id = p_request_id;
    insert into request_events (request_id, type, actor_id) values (p_request_id, 'pin_failed', p_client_id);
    return false;
  end if;

  update requests
     set status = 'completed', completed_at = now()
   where id = p_request_id;

  -- 'held' -> 'released' marca la intención; la captura real en el PSP la
  -- hace el worker que lee esta fila (ver functions/src/services/escrow.ts).
  update transactions
     set status = 'released', released_at = now(), release_method = 'client_pin', updated_at = now()
   where request_id = p_request_id and status = 'held';

  insert into request_events (request_id, type, actor_id) values (p_request_id, 'escrow_released', p_client_id);
  return true;
end;
$$;

-- ================================================================== RLS
alter table app_users            enable row level security;
alter table requests             enable row level security;
alter table transactions         enable row level security;
alter table request_tracking     enable row level security;
alter table kyc_documents        enable row level security;

create policy users_self_rw on app_users
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy users_read_counterpart on app_users
  for select using (
    exists (select 1 from requests r
            where (r.client_id = auth.uid() and r.technician_id = app_users.id)
               or (r.technician_id = auth.uid() and r.client_id = app_users.id))
  );

create policy requests_parties_read on requests
  for select using (client_id = auth.uid() or technician_id = auth.uid());

-- Nadie inserta ni cambia el estado de una solicitud desde el cliente:
-- todo pasa por funciones `security definer` llamadas desde el backend.
create policy requests_no_direct_write on requests
  for insert with check (false);

create policy tx_parties_read on transactions
  for select using (client_id = auth.uid() or technician_id = auth.uid());

create policy tracking_parties_read on request_tracking
  for select using (
    exists (select 1 from requests r where r.id = request_id
            and (r.client_id = auth.uid() or r.technician_id = auth.uid()))
  );

create policy tracking_tech_insert on request_tracking
  for insert with check (
    exists (select 1 from requests r where r.id = request_id
            and r.technician_id = auth.uid()
            and r.status in ('en_route','in_progress'))
  );

create policy kyc_owner on kyc_documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
