# Laundry Tracking PWA

Installable laundry tracking app with daily, records, and monthly views. The
register keeps its material categories and table headers fixed.

## Database

PostgreSQL is the production source of truth. The UI-backed tables are:

- `records` - laundry rows, IDs, dates, shifts, material/color labels, quantities, verification, signatures, status, and timestamps
- `locks` - shift-level locks
- `daily_forms` - explicit forms, including empty days
- `shift_orders` - shared display order for the four shifts
- `material_colors` - active color labels scoped to fixed material categories
- `unit_prices` - current prices by active item/color
- `invoice_sequences` and `invoices` - stable invoice numbers and immutable billing snapshots
- `sync_events` - append-only sync history
- `users` - login accounts; password hashes are never sent to clients

Monthly revenue is calculated directly from records; invoice totals and line
items are saved as immutable snapshots so later price/catalog changes cannot
alter an issued invoice. Database additions are additive; the billing migration
retires only the eight requested catalog variants and does not modify laundry
records, users, or historical transactions.
Runtime application writes use Prisma. `server/schema.sql` is the additive
startup bootstrap; checked-in Prisma migrations are applied with
`npm run prisma:deploy`. Never use a database reset against production.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DIRECT_URL` | no | Session-mode PostgreSQL connection for migrations/setup |
| `PORT` | no | HTTP port (default `4173`) |
| `LAUNDRY_COMPANY_NAME` | no | Fixed company name printed in the invoice body, if supplied |
| `LAUNDRY_COMPANY_PO_BOX` | no | Fixed company P.O. Box, if supplied |
| `LAUNDRY_COMPANY_ADDRESS` | no | Fixed company address, if supplied |
| `LAUNDRY_COMPANY_PHONE` | no | Fixed company phone, if supplied |
| `LAUNDRY_COMPANY_EMAIL` | no | Fixed company email, if supplied |

If no database URL is configured, the app uses the legacy JSON file for local
development only.

```powershell
npm run prisma:validate
npm run prisma:generate
npm run prisma:deploy
```

### Color labels

Color labels are stored in `material_colors`, separately from laundry rows.
Renaming a label updates matching `records.color` values in one transaction;
record IDs, quantities, and timestamps are preserved. Deleting a label removes
only its catalog entry. Existing rows remain visible in the register and
reports. Add, rename, and delete operations queue locally while offline and
replay through the Prisma API when connectivity returns.

Bed Sheets (Blue, Cream, Green), Table Clothes (Blue, Cream), and Towels
(Blue, Green, Yellow) are not active selections. Their historical record rows
are retained, remain visible as read-only historical entries, and are excluded
from new revenue/invoices.

### Monthly revenue and invoices

Set current item/color prices in **Unit Price Settings**. The **Monthly Revenue**
section groups saved records by exact month and active item/color, computes
quantity × unit price, and reports a grand total. A monthly invoice asks for
Bill To details. Invoice pages use the full available page height and include
the company branding. The invoice gets a database-generated number; Customer
ID is the same number. Issued invoice
items, quantities, prices, customer/company information, and totals are saved
as a financial snapshot. Use **Open Invoice** to preview an existing snapshot,
**Download Invoice PDF** to save/share a PDF, or **Print / Save as PDF** to
print the current invoice in the installed app. Configure fixed company
information with the optional server environment variables above.

**Export PDF** downloads/shares the Monthly Revenue summary for the selected
month. The separate **Export Daily Monthly Report (PDF)** button generates a
chronological, branded A4 PDF from the selected month's records. Recorded days
start on separate pages; date and table headings repeat on continuation pages;
empty days are omitted and listed on a final page. The monthly revenue summary,
invoice calculations, and invoice numbering are unchanged. PDF exports use the
installed app's local PDF generator and the platform's file-share/download
workflow; they do not open a print website or a new browser tab.

**Daily Print** prints the currently selected register date. **Print This Day**
in the Daily Records list prints only the date on that row. Both render a
dedicated, data-backed print view in the current application before invoking
the browser/PWA print service.

### Cross-device sync

The browser keeps pending mutations in local storage and replays them in order
when connectivity returns. Supabase Realtime listens for changes to `records`,
`locks`, `daily_forms`, `shift_orders`, and `material_colors`; it refreshes from
the API after reconnect. Configure `LAUNDRY_SUPABASE_URL` and
`LAUNDRY_SUPABASE_ANON_KEY` in both `config.js` copies, then run
`server/realtime.sql` in the Supabase SQL editor. Only the public anon key may
be used in frontend configuration; never expose a service-role key.

The `users` table is excluded from Realtime because it contains password hashes.
The publication script grants read access to operational tables only.

### Migrating existing data

To import legacy `data/records.json` data, run:

```powershell
node server/migrate.js
```

The import adds missing record IDs and locks, and idempotently maps daily forms
and sync events. Existing records, locks, and user accounts are preserved rather
than overwritten. `npm run db:export` creates a read-only timestamped backup.

### Daily forms

There is one form per calendar day in `daily_forms`, including empty days. Use
the New Daily Form control to select a date; duplicate dates are blocked.
Printing prints only the selected day's form.

### Database maintenance

```powershell
npm run db:clear    # local development only; requires ALLOW_LOCAL_DB_CLEAR=true
npm run seed:user   # adds the universal account if missing; retains other users
```

`db:clear` refuses to run against production or Supabase URLs.

## Login

The application uses one shared login account. Passwords are stored as scrypt
hashes in `users`; seeding does not replace an existing account or delete other
users. A successful sign-in is remembered on the device in `laundry-auth-v1`.

## Google Sheets

Google Sheets is an optional export target. Credentials stay on the server.
Configure `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
`GOOGLE_PRIVATE_KEY`, and optionally `GOOGLE_SHEETS_TAB`.

## Run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

The frontend deploys to GitHub Pages on pushes to `main`.

## Frontend and backend

The hosted PWA calls the backend across origins. `config.js` defines the API
base URL and `ALLOWED_ORIGINS` configures the backend whitelist. The service
worker does not cache API calls. The Render free tier may sleep while idle, so
the first request after inactivity can take up to about a minute.
