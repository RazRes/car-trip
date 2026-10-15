# CarTrip

Crew sign-up page for the ST/RS road trips. Static `index.html` plus three Vercel functions in `api/` backed by Neon Postgres.

## Setup

1. **Neon**: create a project at https://neon.tech and copy the connection string.
2. **Vercel**: import this repo, then add two environment variables (Settings → Environment Variables):
   - `DATABASE_URL`: the Neon connection string
   - `ACCESS_CODE`: the code that reveals phone numbers and allows admin deletes
   - optional `ROOMS_TOTAL`: number of rooms (default 14)
3. **Create the table** (once): paste `db/schema.sql` into the Neon SQL Editor, or run
   `vercel env pull .env.local && npm run db:setup`.
4. Deploy (`git push`, or `npx vercel --prod`).

## Using the same entry on several devices

An entry is tied to the device it was created on. On another phone or computer, people tap
"M-am înscris deja" and type the email they signed up with. No password, no code.

## Live map

People with a registered entry can tap "Distribuie locația mea" on the trip day. Their position is
published every ~10 s while the page is open (it asks the phone to keep the screen on) and shown on a
map to other registered participants, or to anyone who enters `ACCESS_CODE`.

- Only the latest position per entry is stored (table `locations`). It stops showing after 10 minutes
  without an update, "Oprește" deletes it at once, sharing ends by itself after 12 hours, and rows older
  than 24 hours are deleted. Deleting an entry deletes its position.
- Run `db/schema.sql` again after updating so the `locations` table exists.
- The map is Leaflet (vendored in `vendor/leaflet`) with OpenStreetMap tiles. That is fine for a small
  group; for heavy use switch to a tile provider with a key (see the OSM tile usage policy).
- A web page cannot track location in the background, so this only works while the page is open.

## Stop check-ins

Each stop on the route has an "Am ajuns aici" button for people with a registered entry. It needs no
location: it just records which stop and when (table `checkins`), and registered participants (or the
`ACCESS_CODE` holder) see who has arrived at each stop. The owner can undo it. Run `db/schema.sql`
again so the `checkins` table exists.

## Announcements, weather, calendar

- **Announcements:** anyone with the `ACCESS_CODE` can post a short message ("Organizator? Postează un anunț"
  link in the footer). It shows at the top of the page for everyone (the last 5 are kept visible) and can be
  removed with the ✕ button. Table `announcements`, endpoint `/api/announce`.
- **Weather:** the page asks Open-Meteo (free, no key) for the trip day at the route stops. The service only
  forecasts about 15 days ahead, so before 20 Nov the card says when it will appear. It warns about snow, ice
  or freezing temperatures. The section disappears after the trip day.
- **Calendar:** `grand-finale-2026.ics` is a static file (Sat 5 Dec 2026, 09:00–18:00 Romanian time, with the
  meeting point and route in the description, plus reminders the day before and an hour before). Edit it if
  the times change.
- Run `db/schema.sql` again so the `announcements` table exists.

## Notes

- Emails are unique, never shown publicly, and only returned to the entry's owner.
- Phone numbers are only sent to the owner of an entry or to someone who entered `ACCESS_CODE`.
- The list refreshes every 15 s while the tab is visible (no realtime).
- `npm test` runs the API against an in-memory Postgres (PGlite).
