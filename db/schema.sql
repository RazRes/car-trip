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
  code_hash       text,
  code_expires_at timestamptz,
  code_attempts   integer not null default 0,
  code_sent_at    timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists crew_members_created_at_idx on crew_members (created_at desc);

-- Upgrade for tables created before email recovery existed (safe to re-run)
alter table crew_members add column if not exists email text;
alter table crew_members add column if not exists code_hash text;
alter table crew_members add column if not exists code_expires_at timestamptz;
alter table crew_members add column if not exists code_attempts integer not null default 0;
alter table crew_members add column if not exists code_sent_at timestamptz;

create unique index if not exists crew_members_email_idx on crew_members (lower(email));
