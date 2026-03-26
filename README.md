# Prasthanam-Backend

This contains the required backend.

## Content persistence

Set `MONGO_URI` in `backend/.env` if you want admin content edits to persist in MongoDB.

If `MONGO_URI` is missing or MongoDB is temporarily unavailable, the backend now falls back to a local `siteContent.fallback.json` file so content edits can still survive local restarts. This fallback is useful for development, but a real database is still recommended for deployed environments.

## Ticket bookings -> Google Sheets

The public ticket form now posts to `POST /api/tickets/book`, and the backend appends each booking as a new row in Google Sheets.

Required `backend/.env` values:

```env
GOOGLE_SHEETS_SPREADSHEET_ID=1orVQ0AxpButerxWqD_vwcWtaIBPTQ_EoTWUGM5e85EA
GOOGLE_SHEETS_TAB_NAME=
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Notes:

- `GOOGLE_SHEETS_SPREADSHEET_ID` already defaults to the Prasthanam ticket sheet above.
- If `GOOGLE_SHEETS_TAB_NAME` is blank, the backend uses the first tab in the spreadsheet.
- Share the sheet with the service-account email as an editor, or appends will fail.
