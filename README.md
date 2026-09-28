# Laundry Tracking PWA

Installable mobile-first laundry tracking app with two navigation areas:

- Main Shift Tracking
- Complete Tracking

The shift sheet keeps the required primary spreadsheet columns:

- MATERIAL
- QUANTITY
- LAUNDRY PERSONNEL
- VERIFIED BY
## Database
The UI's persisted data maps to these PostgreSQL tables:

- **`records`** — laundry rows with stable text IDs, date, shift, material,
  color, quantity, personnel, verification, signature, status and timestamps
- **`locks`** — shift-level locks
- **`daily_forms`** — explicit daily forms, including empty days
- **`shift_orders`** — the shared display order for all four shifts
- **`sync_events`** — append-only sync history
- **`users`** — login accounts; password hashes are never sent to clients

Monthly tracking is calculated from records and does not need a separate table.
schema lives in `server/schema.sql` and is applied automatically on server start.

npm run prisma:deploy
npm run prisma:deploy applies only checked-in additive migrations. It does not reset
the database. The shift-order migration creates its table/index if missing and
inserts defaults only for shifts that do not already have a saved order.
### Environment variables

| Variable          | Required | Purpose                                      |
| ----------------- | -------- | -------------------------------------------- |
| `DATABASE_URL`    | yes      | PostgreSQL connection string (transaction-mode pooler) |
| `DIRECT_URL`      | no       | Session-mode PostgreSQL connection (used by `server/migrate.js`) |
| `PORT`            | no       | HTTP port (default `4173`)                   |
to `records`, `locks`, `daily_forms`, and `shift_orders`; the UI refreshes from
the API after a Realtime reconnect. To enable subscriptions, set

If `DATABASE_URL` is not set, the server falls back to the legacy JSON file
(`data/records.json`) so the app still works in development.

### Database schema

The schema is defined in `server/schema.sql` and includes:

- **`records`** — laundry tracking rows (UUID id, date, shift, material, quantity,
  laundry personnel, verified by, status, sync info, timestamps)
- **`locks`** — shift-level locks that make sheets read-only
- **`sync_events`** — append-only log of Google Sheets sync attempts

Runtime application data writes use Prisma models mapped to these existing
PostgreSQL tables. Generate and validate the Prisma client with:

This imports missing records and locks, then idempotently maps daily forms and
sync events. Existing record IDs, locks, and user accounts are preserved rather
than overwritten. The script reports counts for verification.
```powershell
npm run prisma:generate
npm run prisma:validate
```

npm run db:clear    # local development only; requires ALLOW_LOCAL_DB_CLEAR=true
npm run seed:user   # adds the universal account if missing; retains other users

The browser keeps ordered pending mutations in local storage and replays them
automatically when connectivity returns. Supabase Realtime listens for changes
to `records`, `locks`, and `daily_forms`; the UI refreshes from the API after a
Realtime reconnect. To enable subscriptions, set
`LAUNDRY_SUPABASE_URL` and `LAUNDRY_SUPABASE_ANON_KEY` in both `config.js`
copies, then run `server/realtime.sql` in the Supabase SQL editor. The anon key
is public by design; do not put a service-role key in frontend configuration.

The `users` table is intentionally excluded from Realtime because it contains
password hashes and the app has no user-profile data to synchronize. The
publication script grants read access only to the three operational tables.

### Migrating existing data

If you have legacy data in `data/records.json`, run:

```powershell
node server/migrate.js
```

This reads the JSON file and upserts all records, locks, sync events and daily
forms into PostgreSQL, then reports counts for verification.

### Daily Forms (one per calendar day)

Each calendar day is tracked as its own independent record in the
`daily_forms` table (`date`, `created_at`). Use the **"▼ New Daily Form"**
button near the top of the Daily Register to open a date picker, pick an
official date and create an empty form for that day. The system blocks
duplicate forms for the same date ("A form already exists for this date") and
the date selector next to the header lets staff jump between previous days —
editing one day never affects another. Printing prints only the currently
selected day's form.

The `records` table still stores every laundry row (material / colour / shift /
quantity / personnel / verified-by / signature). Monthly reports aggregate all
daily forms within the selected month automatically.

### Database maintenance

```powershell
npm run db:clear    # deletes all records/locks/sync_events (schema kept)
npm run seed:user   # seeds the single universal login account
```

## Login (single universal account)

The whole application shares **one** login account for all workers. There is
no registration, no password reset, no profiles and no device tracking — just
an email, a password and a Sign In button.

```powershell
npm run seed:user   # defaults below; override via UNIVERSAL_EMAIL / UNIVERSAL_PASSWORD
```

- Email: `qwerty@gmail.com`
- Password: `123456789`

The password is stored as a **scrypt hash** in the `users` table (never plain
text). The seed script deletes any other account, so the system always has
exactly one. A successful sign-in is remembered on the device (`laundry-auth-v1`
in localStorage); clearing site data shows the sign-in screen again.

## Google Sheets (optional export)

Google Sheets sync remains as an **optional** export feature.  PostgreSQL is the
primary data store; Google Sheets is no longer the source of truth.

Create a Google Cloud service account, share the target spreadsheet with the
service account email, then set:

```powershell
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_SHEETS_TAB=Records
```

The backend upserts rows by `ID`, which prevents duplicate Google Sheet rows
during retry. Credentials stay on the server and are never exposed to the PWA
frontend.

## Run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

The frontend is deployed automatically to GitHub Pages on every push to `main`:
https://qwerty9yh-gif.github.io/LS/

## Frontend ↔ backend (CORS)

The hosted PWA frontend (GitHub Pages) talks to the backend API (Render) across
origins. `config.js` defines the API base URL the frontend calls, and the
backend whitelists allowed browser origins:

```powershell
ALLOWED_ORIGINS=https://qwerty9yh-gif.github.io,http://localhost:4173
```

- `ALLOWED_ORIGINS` is a comma-separated whitelist; if unset it defaults to the
  Pages origin plus localhost. Set it to `*` to allow any origin (testing only).
- Preflight `OPTIONS` requests are answered automatically.
- The service worker never caches API calls, so offline behaviour is unchanged.
- The Render free tier sleeps when idle; the first request after a cold start
  can take up to ~1 minute. While the backend is waking up, the PWA shows its
  existing offline notice and syncs once the server responds.
