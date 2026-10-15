-- Run once in the Neon console (SQL Editor) or with: npm run db:setup

create table if not exists crew_members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  car         text not null default '',
  plate       text not null,
  phone       text not null,
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
