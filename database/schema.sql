-- Run once against the PostgreSQL database before deploying.
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  service TEXT NOT NULL CHECK (service IN ('Essentiel', 'Intégral')),
  vehicle TEXT NOT NULL,
  booking_date DATE NOT NULL,
  booking_time TIME NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  water TEXT NOT NULL,
  electricity TEXT NOT NULL,
  vehicle_condition TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  amount_eur INTEGER NOT NULL CHECK (amount_eur >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  duration_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_payment', 'confirmed', 'declined')),
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  payment_url TEXT,
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bookings_date_status_idx
  ON bookings (booking_date, status);

CREATE TABLE IF NOT EXISTS booking_blocks (
  id TEXT PRIMARY KEY,
  block_date DATE NOT NULL,
  block_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (block_date, block_time)
);
CREATE INDEX IF NOT EXISTS booking_blocks_date_idx ON booking_blocks (block_date);

CREATE TABLE IF NOT EXISTS booking_photos (
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS booking_photos_booking_idx ON booking_photos (booking_id);

-- Provides idempotency for Stripe webhook deliveries.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transactional outbox for reliable, deduplicated email delivery.
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_outbox_pending_idx
  ON email_outbox (status, next_attempt_at, created_at);
