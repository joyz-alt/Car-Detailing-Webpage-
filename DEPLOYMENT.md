# Épure Auto — persistent bookings and uploads

## Architecture in this branch
- Node/Express app hosted on Render (or another Node host)
- PostgreSQL stores bookings, blocked slots, Stripe payment state, and photo metadata
- Private Cloudflare R2 bucket stores customer vehicle photos
- R2 object keys are private; admin API creates short-lived signed URLs only after admin-key authentication

## One-time setup
1. Create a PostgreSQL database. Keep its connection string private.
2. In PostgreSQL, run the complete SQL file at `database/schema.sql` once.
3. Create a **private** Cloudflare R2 bucket (do not enable public bucket access).
4. Create R2 API credentials scoped only to this bucket with object read/write permissions.
5. In local `.env` and the hosting provider's environment settings, configure:
   - `DATABASE_URL` — PostgreSQL connection URL
   - `ADMIN_KEY` — long random secret, at least 32 characters
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `PUBLIC_URL` — canonical https URL, e.g. https://your-domain
   - SMTP settings if email notifications are required: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, optional `MAIL_FROM`, `ADMIN_EMAIL`
6. Never commit `.env` or paste secrets into chat/GitHub.

## Local setup
1. From the repository root run `npm install` (this regenerates package-lock.json for the added dependencies).
2. Run `npm start`.
3. Check `/health`, then test date availability, photo upload, admin login, payment link creation, and Stripe webhook in Stripe test mode.

## Render deployment
- Root directory: leave blank (package.json is at repository root)
- Build command: `npm install`
- Start command: `npm start`
- Add the environment variables above in Render's dashboard.
- Use a paid/managed PostgreSQL database and configure backups.
- Do not rely on the app filesystem for booking data or uploads; photos are in private R2 and records are in PostgreSQL.
- Configure the Stripe webhook URL as `https://YOUR-DOMAIN/api/stripe/webhook` and subscribe to `checkout.session.completed`.
- First test with the Render service URL, then connect the Cloudflare domain.

## Before using real customers
- Keep the old JSON files as a backup until you confirm they contain no required bookings. This branch does not automatically import JSON data into PostgreSQL.
- If any existing bookings exist locally, export/transfer them before switching production traffic.
- Test that unauthenticated calls to `/api/admin/*` return 401, that files cannot be accessed via guessed object keys, and that payment only changes a booking to confirmed after a verified Stripe webhook.
- Review privacy policy, legal notices, retention/deletion practices, and consent/necessity for customer vehicle photos before launch.
