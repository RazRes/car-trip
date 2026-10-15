-- Run once in the Neon console (SQL Editor) or with: npm run db:setup

create table if not exists crew_members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  car         text not null default '',
  plate       text not null,
  phone       text not null,
  email       text,
  rsvp_status text not null default 'confirmed'
              check (rsvp_status in ('confirmed', 'maybe', 'cant_come')),
  room_people integer check (room_people is null or room_people between 1 and 20),
  notes       text,
  photo       text,
  owner_token text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists crew_members_created_at_idx on crew_members (created_at desc);

-- Upgrade for tables created by earlier versions of this file (safe to re-run)
alter table crew_members add column if not exists email text;
alter table crew_members drop column if exists code_hash;
alter table crew_members drop column if exists code_expires_at;
alter table crew_members drop column if exists code_attempts;
alter table crew_members drop column if exists code_sent_at;

create unique index if not exists crew_members_email_idx on crew_members (lower(email));

-- Live map: one latest position per entry, removed with the entry
create table if not exists locations (
  entry_id   uuid primary key references crew_members(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  accuracy   real,
  heading    real,
  speed      real,
  updated_at timestamptz not null default now()
);

-- Check-ins: which stop of the route an entry says it has reached (no location is stored)
create table if not exists checkins (
  entry_id   uuid not null references crew_members(id) on delete cascade,
  stop       text not null,
  created_at timestamptz not null default now(),
  primary key (entry_id, stop)
);

-- Announcements posted by the organizers (shown at the top of the page)
create table if not exists announcements (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity,
  body       text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
