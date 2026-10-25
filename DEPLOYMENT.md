# Épure Auto — bookings, payments, uploads and notifications

## Architecture
- Node.js 20+ and Express serve the public site and protected admin API.
- PostgreSQL stores booking requests, blocked time slots, Stripe state, photo metadata, webhook event IDs, and a transactional email outbox.
- Cloudflare R2 stores uploaded customer photos in a private bucket. Only the authenticated admin API issues short-lived signed links.
- Stripe Checkout handles payments. A verified webhook is the only path that marks a booking as paid/confirmed.
- Email notifications use the Resend HTTPS API when configured; SMTP is a fallback. Messages are queued in PostgreSQL, retried after failures, deduplicated by key, and visible in the admin dashboard.

## One-time setup
1. Create PostgreSQL and keep its connection URL private.
2. Run `database/schema.sql` against that database. The server also ensures the email-outbox table exists at startup.
3. Create a **private** Cloudflare R2 bucket; do not enable public access.
4. Create R2 API credentials scoped to this bucket with the minimum required object read/write permissions.
5. Create a Resend account, verify a domain you control, and create an API key. Do not use a fake/example sender for production. Set:
   - `RESEND_API_KEY` — secret API key stored only in host environment variables.
   - `MAIL_FROM` — verified sender, for example `Épure Auto <notifications@your-domain.fr>`.
   - `ADMIN_EMAIL` — email address where new reservation alerts should arrive.
   For local testing, Resend's permitted test sender/recipient restrictions may apply until your domain is verified.
6. Configure the hosting environment:
   - `DATABASE_URL`, `PGSSL` — database connection
   - `ADMIN_KEY` — long random secret, at least 32 characters
   - `R2_ACCOUNT_ID`, optional `R2_JURISDICTION` (set to `eu` only for an EU-jurisdiction bucket), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `PUBLIC_URL` — canonical HTTPS website URL
   - `RESEND_API_KEY`, `MAIL_FROM`, `ADMIN_EMAIL` for notifications
   SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) are an optional fallback only on hosts that allow outbound SMTP.
7. Never commit `.env`, expose secret keys in frontend code, or paste credentials into chats/issues.

## Local setup
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in your own credentials.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000/health` and verify it returns `{"ok":true}`.
5. Run `npm run check` for JavaScript syntax checks.
6. Integration tests require a **dedicated disposable test database**: set `TEST_DATABASE_URL` to that database, initialise it with `database/schema.sql`, then run `npm test`. The tests clear tables in that database; never point `TEST_DATABASE_URL` at production.
7. Check `/api/config`. The email status endpoint is admin-protected: call `/api/email-status` with the `x-admin-key` header.

## Render deployment
- Root directory: blank (the `package.json` is at repository root).
- Build command: `npm install`.
- Start command: `npm start`.
- Add secrets and configuration in Render's Environment settings.
- Render Free web services cannot send outbound SMTP over ports 25, 465, or 587. Use the Resend HTTPS API on the Free web plan, or use a host/plan that permits SMTP.
- Do not use a temporary Free PostgreSQL database for production booking records. Free Render Postgres databases expire after 30 days and do not support backups. Choose durable storage and backups before accepting real customers.
- Configure Stripe webhook URL as `https://YOUR-DOMAIN/api/stripe/webhook` and subscribe to `checkout.session.completed` and `checkout.session.expired`.
- Test the full user journey in Stripe test mode before connecting the production domain.

## Email behavior and troubleshooting
- Customer request received: an acknowledgement email is queued with the reservation.
- Business notification: the configured `ADMIN_EMAIL` receives a booking summary.
- Payment request: confirming an appointment in admin queues a Stripe Checkout link.
- Payment success: only a valid, matching Stripe webhook queues the customer confirmation email.
- Decline: the customer receives a decline message.
- Transient email errors are retried automatically with backoff. After repeated failures, the message is marked failed; the admin dashboard lists the provider error and offers a manual retry. Sent queue bodies are purged after 30 days; failed queue entries are purged after 90 days.
- The admin outbox displays delivery state; do not assume email was delivered merely because a booking was stored.

## Before real customers
- Use test Stripe keys and test webhooks first.
- Test that unauthenticated `/api/admin/*` requests return 401, that R2 objects are private, and that payment only confirms after a valid webhook.
- Test a real email to both the business inbox and a customer test address; check spam/junk and provider logs.
- Test simultaneous attempts to book the same overlapping time and confirm only one request succeeds.
- Add/verify legal notices, terms, privacy policy, retention/deletion process, and customer-photo privacy language.
- A previous JSON-based version is not automatically migrated. Back up and migrate any existing bookings/photos separately before moving production traffic.
- The Render Free Postgres database mentioned during initial setup expires on its 30-day limit. Upgrade/migrate before any real booking data is stored there.

## Cloudflare R2 budget note
The account setup screen reviewed on 25 October 2026 showed $0/month with monthly allowances of 10 GB storage, 1 million Class A operations, 10 million Class B operations and zero egress fees. The screen showed overage prices of $0.015 per GB-month, $4.50 per million Class A operations and $0.36 per million Class B operations. Pricing can change; verify the current Cloudflare billing page and monitor usage.
