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

## Notes

- Emails are unique, never shown publicly, and only returned to the entry's owner.
- Phone numbers are only sent to the owner of an entry or to someone who entered `ACCESS_CODE`.
- The list refreshes every 15 s while the tab is visible (no realtime).
- `npm test` runs the API against an in-memory Postgres (PGlite).
