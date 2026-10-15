# CarTrip

Crew sign-up page for the ST/RS road trips. Static `index.html` plus three Vercel functions in `api/` backed by Neon Postgres.

## Setup

1. **Neon**: create a project at https://neon.tech and copy the connection string.
2. **Vercel**: import this repo, then add two environment variables (Settings → Environment Variables):
   - `DATABASE_URL`: the Neon connection string
   - `ACCESS_CODE`: the code that reveals phone numbers and allows admin deletes
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (and optional `MAIL_FROM`): used to email recovery codes, see below
   - optional `ROOMS_TOTAL`: number of rooms (default 14)
3. **Create the table** (once): paste `db/schema.sql` into the Neon SQL Editor, or run
   `vercel env pull .env.local && npm run db:setup`.
4. Deploy (`git push`, or `npx vercel --prod`).

## Email for recovery codes

People are remembered per device. To edit their entry from another phone or computer they tap
"recover my entry", type the email they signed up with and enter the 6-digit code we email them.
Any SMTP account works. With Gmail (free, ~500 mails/day):

1. Turn on 2-Step Verification for the Google account, then create an **App password**
   (https://myaccount.google.com/apppasswords).
2. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<the gmail address>`,
   `SMTP_PASS=<the 16-character app password>`.

Redeploy after changing environment variables.

## Notes

- Emails are unique, never shown publicly, and only returned to the entry's owner.
- Phone numbers are only sent to the owner of an entry or to someone who entered `ACCESS_CODE`.
- The list refreshes every 15 s while the tab is visible (no realtime).
- `npm test` runs the API against an in-memory Postgres (PGlite).
