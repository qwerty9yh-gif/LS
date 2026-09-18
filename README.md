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

The application uses **PostgreSQL** as its single source of truth.  The database
schema lives in `server/schema.sql` and is applied automatically on server start.

### Environment variables

| Variable          | Required | Purpose                                      |
| ----------------- | -------- | -------------------------------------------- |
| `DATABASE_URL`    | yes      | PostgreSQL connection string (transaction-mode pooler) |
| `DIRECT_URL`      | no       | Session-mode PostgreSQL connection (used by `server/migrate.js`) |
| `PORT`            | no       | HTTP port (default `4173`)                   |

If `DATABASE_URL` is not set, the server falls back to the legacy JSON file
(`data/records.json`) so the app still works in development.

### Database schema

The schema is defined in `server/schema.sql` and includes:

- **`records`** — laundry tracking rows (UUID id, date, shift, material, quantity,
  laundry personnel, verified by, status, sync info, timestamps)
- **`locks`** — shift-level locks that make sheets read-only
- **`sync_events`** — append-only log of Google Sheets sync attempts

### Migrating existing data

If you have legacy data in `data/records.json`, run:

```powershell
node server/migrate.js
```

This reads the JSON file and upserts all records, locks, and sync events into
PostgreSQL, then reports counts for verification.

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
