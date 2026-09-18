# Laundry Tracking PWA

Installable mobile-first laundry tracking app with two navigation areas:

- Main Shift Tracking
- Complete Tracking

The shift sheet keeps the required primary spreadsheet columns:

- MATERIAL
- QUANTITY
- LAUNDRY PERSONNEL
- VERIFIED BY

## Run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

The frontend is deployed automatically to GitHub Pages on every push to `main`:
https://qwerty9yh-gif.github.io/LS/

## Google Sheets

Create a Google Cloud service account, share the target spreadsheet with the service account email, then set:

```powershell
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_SHEETS_TAB=Records
```

The backend upserts rows by `ID`, which prevents duplicate Google Sheet rows during retry. Credentials stay on the server and are never exposed to the PWA frontend.
