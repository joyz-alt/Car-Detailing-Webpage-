require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Pool } = require('pg');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim();
if (ADMIN_KEY && ADMIN_KEY.length < 32) {
  console.error('ADMIN_KEY must be at least 32 characters long.');
  process.exit(1);
}
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACTIVE_STATUSES = ['pending', 'awaiting_payment', 'confirmed'];
const SERVICES = {
  Essentiel: { amount: 90, durationMinutes: 120, durationLabel: '1h30 à 2h30' },
  Intégral: { amount: 130, durationMinutes: 180, durationLabel: '2h30 à 3h30' }
};
const SLOTS = ['09:00', '10:30', '12:00', '13:00', '14:00', '14:30', '15:30', '17:00'];
const SERVICE_AREA_CENTER = { lat: 45.64889, lon: 0.17426 }; // Marché Victor Hugo, Angoulême
const SERVICE_AREA_RADIUS_KM = 25;
function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat), dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat), lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
async function validateServiceAddress(address) {
  if (!address || address.length < 5) return { valid: false, reason: 'Veuillez saisir une adresse complète.' };
  if (process.env.NODE_ENV === 'test' && process.env.TEST_BYPASS_SERVICE_AREA === 'true') return { valid: true, distanceKm: 0 };
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'fr');
  url.searchParams.set('q', address + ', France');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'EpureAutoBooking/1.0 (https://epure-auto.com)', 'Referer': 'https://epure-auto.com/' },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Le service de vérification d’adresse est temporairement indisponible. Réessayez dans un instant.');
  const results = await response.json();
  if (!Array.isArray(results) || !results.length) return { valid: false, reason: 'Adresse introuvable. Vérifiez l’adresse saisie.' };
  const first = results[0], point = { lat: Number(first.lat), lon: Number(first.lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return { valid: false, reason: 'Cette adresse n’a pas pu être vérifiée.' };
  const distanceKm = haversineKm(SERVICE_AREA_CENTER, point);
  return distanceKm <= SERVICE_AREA_RADIUS_KM
    ? { valid: true, distanceKm: Math.round(distanceKm * 10) / 10 }
    : { valid: false, reason: 'Cette adresse se trouve en dehors de notre zone de déplacement de 25 km autour du Marché Victor Hugo à Angoulême.' };
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Configure PostgreSQL before starting.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  ...(process.env.PGSSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {})
});
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const r2Configured = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
const r2Endpoint = 'https://' + process.env.R2_ACCOUNT_ID +
  (process.env.R2_JURISDICTION ? '.' + process.env.R2_JURISDICTION : '') + '.r2.cloudflarestorage.com';
const r2 = r2Configured ? new S3Client({
  region: 'auto',
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
}) : null;
const R2_BUCKET = process.env.R2_BUCKET || '';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_PHOTOS, fileSize: MAX_PHOTO_BYTES, fields: 20, fieldSize: 20000, parts: 30 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(new Error('Format photo non accepté. Utilisez JPG, PNG ou WEBP.'));
    cb(null, true);
  }
});

function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function makeId(prefix) { return (prefix || 'E') + crypto.randomBytes(6).toString('hex'); }
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 500); }
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function parisToday() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
function slotMinutes(time) {
  const parts = String(time).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}
function parisMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8'), right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
function adminGuard(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'L’espace administrateur n’est pas configuré.' });
  if (!constantTimeEquals(req.headers['x-admin-key'], ADMIN_KEY)) return res.status(401).json({ error: 'Clé administrateur incorrecte ou absente.' });
  next();
}
function publicBaseUrl() { return String(process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''); }

function getEmailProvider() {
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}
function emailSetupReady() {
  return Boolean(ADMIN_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL) && getEmailProvider());
}
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

async function deliverEmail(message) {
  const provider = getEmailProvider();
  if (!provider) throw new Error('Email provider is not configured. Set RESEND_API_KEY and MAIL_FROM, or SMTP settings.');
  if (provider === 'resend') {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'epure-email-' + message.id
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [message.recipient],
        subject: message.subject,
        html: message.htmlBody
      }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result && result.message ? String(result.message).slice(0, 300) : 'HTTP ' + response.status;
      throw new Error('Resend email request failed: ' + detail);
    }
    return;
  }

  const transporter = getTransporter();
  if (!transporter) throw new Error('SMTP settings are incomplete.');
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: message.recipient,
    subject: message.subject,
    html: message.htmlBody
  });
}

async function enqueueEmail(db, message) {
  await db.query(
    'INSERT INTO email_outbox (dedupe_key, booking_id, recipient, subject, html_body) ' +
    'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING',
    [message.dedupeKey, message.bookingId || null, message.recipient, message.subject, message.htmlBody]
  );
}

let emailWorkerRunning = false;
let lastEmailOutboxCleanupAt = 0;
async function processEmailQueue() {
  if (emailWorkerRunning) return;
  emailWorkerRunning = true;
  try {
    if (Date.now() - lastEmailOutboxCleanupAt >= 24 * 60 * 60 * 1000) {
      await pool.query(
        "DELETE FROM email_outbox WHERE (status = 'sent' AND sent_at < NOW() - INTERVAL '30 days') " +
        "OR (status = 'failed' AND created_at < NOW() - INTERVAL '90 days')"
      );
      lastEmailOutboxCleanupAt = Date.now();
    }
    const client = await pool.connect();
    let jobs = [];
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE email_outbox SET status = 'pending', locked_at = NULL, next_attempt_at = NOW() " +
        "WHERE status = 'sending' AND locked_at < NOW() - INTERVAL '10 minutes'"
      );
      const selected = await client.query(
        "SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= NOW() " +
        'ORDER BY created_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED'
      );
      const ids = selected.rows.map(row => row.id);
      if (ids.length) {
        const claimed = await client.query(
          "UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, locked_at = NOW() " +
          'WHERE id = ANY($1::bigint[]) RETURNING id, recipient, subject, html_body AS "htmlBody", attempts',
          [ids]
        );
        jobs = claimed.rows;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    for (const job of jobs) {
      try {
        await deliverEmail(job);
        await pool.query(
          "UPDATE email_outbox SET status = 'sent', sent_at = NOW(), locked_at = NULL, last_error = NULL WHERE id = $1",
          [job.id]
        );
      } catch (e) {
        const status = job.attempts >= 8 ? 'failed' : 'pending';
        const retryMinutes = Math.min(60, Math.pow(2, Math.max(0, job.attempts - 1)));
        await pool.query(
          'UPDATE email_outbox SET status = $2, next_attempt_at = NOW() + ($3 * INTERVAL \'1 minute\'), ' +
          'locked_at = NULL, last_error = $4 WHERE id = $1',
          [job.id, status, retryMinutes, String(e.message || e).slice(0, 500)]
        );
        console.error('[EMAIL OUTBOX] Message ' + job.id + ' attempt ' + job.attempts + ' failed: ' + String(e.message || e));
      }
    }
  } catch (e) {
    console.error('[EMAIL WORKER]', e.message || e);
  } finally {
    emailWorkerRunning = false;
  }
}

async function ensureEmailOutboxSchema() {
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_attempt INTEGER NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_items JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_version TEXT');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS privacy_version TEXT');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS early_execution_requested BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS early_execution_requested_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check');
  await pool.query("ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'awaiting_payment', 'confirmed', 'declined', 'expired'))");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS email_outbox (" +
    "id BIGSERIAL PRIMARY KEY, " +
    "dedupe_key TEXT NOT NULL UNIQUE, " +
    "booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL, " +
    "recipient TEXT NOT NULL, subject TEXT NOT NULL, html_body TEXT NOT NULL, " +
    "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')), " +
    "attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), " +
    "next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), locked_at TIMESTAMPTZ, " +
    "last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ)"
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS email_outbox_pending_idx ON email_outbox (status, next_attempt_at, created_at)'
  );
}

function createRateLimiter(windowMs, maxRequests) {
  const entries = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    if (entries.size > 5000) {
      for (const [ip, item] of entries) if (item.resetAt <= now) entries.delete(ip);
    }
    if (entry.count > maxRequests) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Trop de demandes. Réessayez un peu plus tard.' });
    }
    next();
  };
}
const bookingRateLimit = createRateLimiter(60 * 60 * 1000, 8);
const availabilityRateLimit = createRateLimiter(60 * 1000, 90);
function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ) {
    return { mime: 'image/png' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp' };
  }
  return null;
}

async function uploadPhoto(bookingId, file, detected) {
  if (!r2) throw new Error('Le stockage photo R2 n’est pas configuré.');
  const key = 'booking-photos/' + bookingId + '/' + crypto.randomUUID() + '.' + EXTENSIONS[detected.mime];
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: file.buffer, ContentType: detected.mime,
    CacheControl: 'private, max-age=0, no-store', Metadata: { 'booking-id': bookingId }
  }));
  return { objectKey: key, originalName: path.basename(file.originalname || 'photo').slice(0, 120),
    contentType: detected.mime, sizeBytes: file.size };
}
async function deleteObjects(objects) {
  if (!r2) return;
  await Promise.allSettled(objects.map(o => r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: o.objectKey }))));
}
async function signPhoto(key) {
  if (!r2) return null;
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 600 });
}

const BOOKING_SELECT =
  'SELECT b.id, b.created_at AS "createdAt", b.service, b.vehicle, b.booking_date::text AS date, ' +
  'to_char(b.booking_time, \'HH24:MI\') AS time, b.first_name AS "firstName", b.last_name AS "lastName", ' +
  'b.phone, b.email, b.address, b.water, b.electricity, b.vehicle_condition AS condition, b.note, ' +
  'b.amount_eur AS amount, b.duration_minutes AS "durationMinutes", b.duration_label AS duration, b.status, ' +
  'b.payment_items AS "paymentItems", b.stripe_session_id AS "stripeSessionId", b.stripe_payment_intent_id AS "stripePaymentIntentId", ' +
  'b.payment_url AS "paymentUrl", b.paid_at AS "paidAt" FROM bookings b ';

async function getBooking(client, id, lock) {
  const result = await client.query(BOOKING_SELECT + 'WHERE b.id = $1' + (lock ? ' FOR UPDATE' : ''), [id]);
  return result.rows[0] || null;
}
async function photoList(bookingId) {
  const result = await pool.query(
    'SELECT id, object_key AS "objectKey", original_name AS name, content_type AS type FROM booking_photos WHERE booking_id = $1 ORDER BY id',
    [bookingId]
  );
  return Promise.all(result.rows.map(async p => ({ id: p.id, name: p.name, type: p.type, url: await signPhoto(p.objectKey) })));
}
async function isAvailableInTransaction(client, date, time, service) {
  const duration = SERVICES[service].durationMinutes;
  // Lock each day's schedule so simultaneous requests cannot both reserve the same slot.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [date]);
  const booked = await client.query(
    'SELECT 1 FROM bookings WHERE booking_date = $1 AND status = ANY($2::text[]) ' +
    'AND booking_time < ($3::time + ($4 * interval \'1 minute\')) ' +
    'AND booking_time + duration_minutes * interval \'1 minute\' > $3::time LIMIT 1',
    [date, ACTIVE_STATUSES, time, duration]
  );
  if (booked.rowCount) return false;
  const blocked = await client.query(
    'SELECT 1 FROM booking_blocks WHERE block_date = $1 ' +
    'AND block_time < ($2::time + ($3 * interval \'1 minute\')) ' +
    'AND block_time + interval \'1 hour\' > $2::time LIMIT 1',
    [date, time, duration]
  );
  return blocked.rowCount === 0;
}

// Stripe signature validation requires the raw request body. Register this before JSON middleware.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook non configuré.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send('Signature webhook invalide.'); }

  const client = await pool.connect();
  let confirmation = null;
  try {
    await client.query('BEGIN');
    const recorded = await client.query(
      'INSERT INTO stripe_events (id, event_type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id',
      [event.id, event.type]
    );
    if (!recorded.rowCount) {
      await client.query('COMMIT');
      return res.json({ received: true, duplicate: true });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const booking = session.metadata && session.metadata.bookingId
        ? await getBooking(client, session.metadata.bookingId, true) : null;

      if (booking && session.payment_status === 'paid' && booking.stripeSessionId === session.id) {
        if (session.currency !== 'eur' || Number(session.amount_total) !== Number(booking.amount) * 100) {
          throw new Error('Le montant ou la devise Stripe ne correspond pas à la réservation.');
        }
        if (booking.status === 'awaiting_payment' || booking.status === 'confirmed') {
          const updated = await client.query(
            'UPDATE bookings SET status = \'confirmed\', paid_at = COALESCE(paid_at, NOW()), ' +
            'stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id) ' +
            'WHERE id = $1 AND status <> \'declined\' RETURNING id',
            [booking.id, typeof session.payment_intent === 'string' ? session.payment_intent : null]
          );
          if (updated.rowCount && booking.status !== 'confirmed') {
            confirmation = booking;
            await enqueueEmail(client, {
              dedupeKey: 'booking:' + booking.id + ':confirmed',
              bookingId: booking.id,
              recipient: booking.email,
              subject: 'Épure Auto — paiement reçu, merci !',
              htmlBody: '<p>Bonjour ' + escapeHtml(booking.firstName) + ',</p><p>Nous confirmons la réception de votre paiement de <strong>' +
                escapeHtml(booking.amount) + ' €</strong> pour la prestation <strong>' + escapeHtml(booking.service) +
                '</strong>.</p><p>Merci pour votre confiance !</p><p>À bientôt,<br>Épure Auto</p>'
            });
          }
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const booking = session.metadata && session.metadata.bookingId
        ? await getBooking(client, session.metadata.bookingId, true) : null;
      if (booking && booking.status === 'awaiting_payment' && booking.stripeSessionId === session.id) {
        await client.query(
          'UPDATE bookings SET status = \'expired\', stripe_session_id = NULL, payment_url = NULL WHERE id = $1',
          [booking.id]
        );
        await enqueueEmail(client, { dedupeKey: 'booking:' + booking.id + ':payment-expired', bookingId: booking.id,
          recipient: booking.email, subject: 'Épure Auto — lien de paiement expiré',
          htmlBody: '<p>Bonjour ' + escapeHtml(booking.firstName) + ',</p><p>Le lien de règlement de votre prestation a expiré. Contactez-nous et nous vous transmettrons un nouveau lien de paiement.</p><p>À bientôt,<br>Épure Auto</p>' });
        confirmation = { expired: true };
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[STRIPE WEBHOOK]', e.message);
    return res.status(400).send('Le webhook n’a pas pu être traité.');
  } finally { client.release(); }

  if (confirmation) void processEmailQueue().catch(e => console.error('[EMAIL CONFIRMATION QUEUE]', e.message));
  res.json({ received: true });
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Explicit allow-list: do not accidentally publish server.js, environment files, or data.
const PUBLIC_FILES = new Set(['/', '/index.html', '/styles.css', '/app.js', '/admin.html', '/admin.js', '/success.html', '/reservation-annulee.html', '/mentions-legales.html', '/politique-confidentialite.html', '/cgv.html', '/formulaire-retractation.html']);
app.get([...PUBLIC_FILES], (req, res, next) => {
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  res.sendFile(path.join(__dirname, file), e => { if (e) next(e); });
});

app.get('/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));
app.get('/api/config', (req, res) => res.json({
  stripeEnabled: Boolean(stripe), services: SERVICES, slots: SLOTS,
  maxPhotos: MAX_PHOTOS, maxPhotoBytes: MAX_PHOTO_BYTES
}));
app.get('/api/email-status', adminGuard, asyncHandler(async (req, res) => {
  const counts = await pool.query(
    'SELECT status, COUNT(*)::int AS count FROM email_outbox GROUP BY status'
  );
  res.json({
    configured: emailSetupReady(),
    provider: getEmailProvider() || 'none',
    queue: Object.fromEntries(counts.rows.map(row => [row.status, row.count]))
  });
}));

app.get('/api/availability', availabilityRateLimit, asyncHandler(async (req, res) => {
  const date = text(req.query.date, 10);
  const service = text(req.query.service || 'Essentiel', 30);
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date invalide.' });
  if (date < parisToday()) return res.status(400).json({ error: 'La date doit être aujourd’hui ou dans le futur.' });
  if (!SERVICES[service]) return res.status(400).json({ error: 'Prestation invalide.' });

  const client = await pool.connect();
  try {
    const slots = [];
    for (const time of SLOTS) {
      const duration = SERVICES[service].durationMinutes;
      const booked = await client.query(
        'SELECT 1 FROM bookings WHERE booking_date = $1 AND status = ANY($2::text[]) ' +
        'AND booking_time < ($3::time + ($4 * interval \'1 minute\')) ' +
        'AND booking_time + duration_minutes * interval \'1 minute\' > $3::time LIMIT 1',
        [date, ACTIVE_STATUSES, time, duration]
      );
      const blocked = await client.query(
        'SELECT 1 FROM booking_blocks WHERE block_date = $1 ' +
        'AND block_time < ($2::time + ($3 * interval \'1 minute\')) ' +
        'AND block_time + interval \'1 hour\' > $2::time LIMIT 1',
        [date, time, duration]
      );
      const isPast = date === parisToday() && slotMinutes(time) <= parisMinutesNow();
      slots.push({ time, available: !isPast && booked.rowCount === 0 && blocked.rowCount === 0 });
    }
    res.json({ slots });
  } finally { client.release(); }
}));

app.post('/api/bookings', bookingRateLimit, (req, res, next) => {
  if (!emailSetupReady()) {
    return res.status(503).json({
      error: 'La réservation en ligne est temporairement indisponible. Le service e-mail doit être configuré avant de recevoir les demandes.'
    });
  }
  next();
}, upload.array('photos', MAX_PHOTOS), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = text(body.service, 30);
  const vehicle = text(body.vehicle, 100) || 'Non renseigné';
  const date = text(body.date, 10);
  const time = text(body.time, 5);
  const firstName = text(body.firstName, 100);
  const lastName = text(body.lastName, 100);
  const phone = text(body.phone, 40);
  const email = text(body.email, 254).toLowerCase();
  const address = text(body.address, 300);
  const water = text(body.water, 10) || 'Non renseigné';
  const electricity = text(body.electricity, 10) || 'Non renseigné';
  const condition = text(body.condition, 100) || 'Non renseigné';
  const note = text(body.note, 1500);
  const legalAccepted = text(body.legalAccepted, 10);
  const earlyExecutionRequested = text(body.earlyExecutionRequested, 10) === 'true';
  const files = req.files || [];

  if (!SERVICES[service] || !date || !time || !firstName || !lastName || !phone || !email || !address || legalAccepted !== 'true') {
    return res.status(400).json({ error: 'Merci de compléter tous les champs obligatoires.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  if (!isValidDate(date) || date < parisToday()) return res.status(400).json({ error: 'La date de réservation est invalide.' });
  if (!SLOTS.includes(time)) return res.status(400).json({ error: 'Créneau invalide.' });
  if (date === parisToday() && slotMinutes(time) <= parisMinutesNow()) return res.status(400).json({ error: 'Ce créneau est déjà passé.' });
  const withdrawalDeadline = new Date(parisToday() + 'T00:00:00Z');
  withdrawalDeadline.setUTCDate(withdrawalDeadline.getUTCDate() + 14);
  const withinWithdrawalWindow = date <= withdrawalDeadline.toISOString().slice(0, 10);
  if (withinWithdrawalWindow && !earlyExecutionRequested) {
    return res.status(400).json({ error: 'Pour un rendez-vous dans les 14 prochains jours, veuillez confirmer votre demande expresse de commencement anticipé de la prestation.' });
  }
  let serviceAddress;
  try { serviceAddress = await validateServiceAddress(address); }
  catch (e) { return res.status(503).json({ error: e.message || 'Vérification d’adresse indisponible. Réessayez.' }); }
  if (!serviceAddress.valid) return res.status(400).json({ error: serviceAddress.reason });
  if (files.length && !r2) return res.status(503).json({ error: 'Le stockage des photos n’est pas configuré. Configurez R2 avant d’envoyer des photos.' });

  const checkedFiles = [];
  for (const file of files) {
    const detected = detectImageType(file.buffer);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      return res.status(400).json({ error: 'Une photo n’est pas un fichier JPG, PNG ou WEBP valide.' });
    }
    checkedFiles.push({ file, detected });
  }

  const id = makeId();
  const photos = [];
  const client = await pool.connect();
  try {
    for (const item of checkedFiles) photos.push(await uploadPhoto(id, item.file, item.detected));

    await client.query('BEGIN');
    const available = await isAvailableInTransaction(client, date, time, service);
    if (!available) {
      await client.query('ROLLBACK');
      await deleteObjects(photos);
      return res.status(409).json({ error: 'Ce créneau vient d’être pris ou chevauche une autre prestation.' });
    }

    const details = SERVICES[service];
    await client.query(
      'INSERT INTO bookings (id, service, vehicle, booking_date, booking_time, first_name, last_name, phone, email, address, water, electricity, vehicle_condition, note, amount_eur, duration_minutes, duration_label, status, terms_accepted_at, terms_version, privacy_version, early_execution_requested, early_execution_requested_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,\'pending\',NOW(),\'2026-10-25\',\'2026-10-25\',$18,CASE WHEN $18 THEN NOW() ELSE NULL END)',
      [id, service, vehicle, date, time, firstName, lastName, phone, email, address, water, electricity, condition, note,
       details.amount, details.durationMinutes, details.durationLabel, earlyExecutionRequested]
    );
    for (const p of photos) {
      await client.query(
        'INSERT INTO booking_photos (booking_id, object_key, original_name, content_type, size_bytes) VALUES ($1,$2,$3,$4,$5)',
        [id, p.objectKey, p.originalName, p.contentType, p.sizeBytes]
      );
    }

    await enqueueEmail(client, {
      dedupeKey: 'booking:' + id + ':new-request-owner',
      bookingId: id,
      recipient: ADMIN_EMAIL,
      subject: 'Épure Auto — nouvelle demande ' + id,
      htmlBody: '<h2>Nouvelle demande de réservation</h2><p><strong>' + escapeHtml(firstName) + ' ' + escapeHtml(lastName) +
        '</strong><br>' + escapeHtml(phone) + '<br>' + escapeHtml(email) + '</p><p><strong>' + escapeHtml(service) +
        '</strong> · ' + escapeHtml(vehicle) + '<br>' + escapeHtml(date) + ' à ' + escapeHtml(time) + '<br>' +
        escapeHtml(address) + '</p><p>Eau : <strong>' + escapeHtml(water) + '</strong><br>Électricité : <strong>' +
        escapeHtml(electricity) + '</strong><br>État : <strong>' + escapeHtml(condition) + '</strong></p><p>Photos : ' +
        photos.length + '</p>' + (note ? '<p>Note : ' + escapeHtml(note) + '</p>' : '') +
        '<p><a href="' + escapeHtml(publicBaseUrl()) + '/admin.html">Ouvrir l’espace pro</a></p>'
    });
    await enqueueEmail(client, {
      dedupeKey: 'booking:' + id + ':request-received-customer',
      bookingId: id,
      recipient: email,
      subject: 'Épure Auto — demande de réservation reçue',
      htmlBody: '<p>Bonjour ' + escapeHtml(firstName) + ',</p><p>Nous avons bien reçu votre demande pour la prestation <strong>' + escapeHtml(service) + '</strong> le <strong>' + escapeHtml(date) + '</strong> à <strong>' + escapeHtml(time) + '</strong>.</p><p>Nous vous recontacterons pour confirmer les détails du rendez-vous. Aucun paiement n’est demandé sur le site : le règlement aura lieu après le nettoyage, une fois le montant final convenu.</p><p>Si vous ne voyez pas cet e-mail dans votre boîte de réception, vérifiez vos courriers indésirables (spam).</p><p>À bientôt,<br>Épure Auto</p>'
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await deleteObjects(photos);
    throw e;
  } finally { client.release(); }

  void processEmailQueue().catch(e => console.error('[EMAIL BOOKING QUEUE]', e.message));



  res.status(201).json({
    booking: { id, service, vehicle, date, time, firstName, lastName, amount: SERVICES[service].amount, status: 'pending', paymentUrl: null,
      photos: photos.map(p => ({ name: p.originalName, type: p.contentType })) },
    message: 'Demande enregistrée. Aucun paiement n’est demandé en ligne ; le règlement aura lieu après la prestation.'
  });
}));

app.get('/api/admin/email-outbox', adminGuard, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, booking_id AS "bookingId", recipient, subject, status, attempts, next_attempt_at AS "nextAttemptAt", ' +
    'last_error AS "lastError", created_at AS "createdAt", sent_at AS "sentAt" ' +
    'FROM email_outbox ORDER BY created_at DESC LIMIT 30'
  );
  res.json({ configured: emailSetupReady(), provider: getEmailProvider() || 'none', messages: result.rows });
}));

app.post('/api/admin/email-outbox/:id/retry', adminGuard, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "UPDATE email_outbox SET status = 'pending', attempts = 0, next_attempt_at = NOW(), " +
    "locked_at = NULL, last_error = NULL WHERE id = $1 AND status = 'failed' RETURNING id",
    [req.params.id]
  );
  if (!result.rowCount) {
    return res.status(409).json({ error: 'Ce message n’est pas en échec ou n’existe plus.' });
  }
  void processEmailQueue().catch(e => console.error('[EMAIL MANUAL RETRY]', e.message));
  res.status(202).json({ ok: true, message: 'Le message a été remis en file d’attente.' });
}));

app.get('/api/admin/bookings', adminGuard, asyncHandler(async (req, res) => {
  const result = await pool.query(BOOKING_SELECT + 'ORDER BY b.booking_date, b.booking_time, b.created_at DESC');
  res.json(await Promise.all(result.rows.map(async b => ({ ...b, photos: await photoList(b.id) }))));
}));
app.get('/api/admin/blocks', adminGuard, asyncHandler(async (req, res) => {
  const r = await pool.query('SELECT id, block_date::text AS date, to_char(block_time, \'HH24:MI\') AS time FROM booking_blocks ORDER BY block_date, block_time');
  res.json(r.rows);
}));
app.post('/api/admin/blocks', adminGuard, asyncHandler(async (req, res) => {
  const date = text(req.body && req.body.date, 10), time = text(req.body && req.body.time, 5);
  if (!isValidDate(date) || date < parisToday() || !SLOTS.includes(time)) return res.status(400).json({ error: 'Date ou heure invalide.' });
  await pool.query(
    'INSERT INTO booking_blocks (id, block_date, block_time) VALUES ($1,$2,$3) ON CONFLICT (block_date, block_time) DO NOTHING',
    [makeId('B'), date, time]
  );
  res.json({ ok: true });
}));
app.delete('/api/admin/blocks/:id', adminGuard, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM booking_blocks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/admin/bookings/:id/decline', adminGuard, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    booking = await getBooking(client, req.params.id, true);
    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Réservation introuvable.' });
    }
    if (booking.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Seule une demande en attente peut être refusée.' });
    }
    const changed = await client.query(
      "UPDATE bookings SET status = 'declined' WHERE id = $1 AND status = 'pending' RETURNING id",
      [req.params.id]
    );
    if (!changed.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Le statut a changé. Actualisez la page.' });
    }
    await enqueueEmail(client, {
      dedupeKey: 'booking:' + booking.id + ':declined',
      bookingId: booking.id,
      recipient: booking.email,
      subject: 'Épure Auto — demande ' + booking.id,
      htmlBody: '<p>Bonjour ' + escapeHtml(booking.firstName) + ',</p><p>Nous sommes désolés, le créneau demandé n’est finalement pas disponible. Nous reviendrons vers vous pour proposer un autre créneau.</p>'
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  void processEmailQueue().catch(e => console.error('[EMAIL REFUS QUEUE]', e.message));
  res.json({ ok: true });
}));

app.post('/api/admin/bookings/:id/payment', adminGuard, asyncHandler(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe ou son webhook n’est pas configuré. Aucun lien de paiement n’a été créé.' });
  }
  const requestedService = text(req.body && req.body.service, 30);
  const rawAddons = req.body && Array.isArray(req.body.addons) ? req.body.addons : [];
  if (!SERVICES[requestedService]) {
    return res.status(400).json({ error: 'Choisissez une formule valide.' });
  }
  if (rawAddons.length > 10) {
    return res.status(400).json({ error: 'Vous pouvez ajouter 10 suppléments maximum.' });
  }
  const addons = [];
  for (const item of rawAddons) {
    const name = text(item && item.name, 100);
    const amount = Number(item && item.amount);
    if (!name || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000) {
      return res.status(400).json({ error: 'Chaque supplément doit avoir un intitulé et un prix entier compris entre 1 et 1 000 €.' });
    }
    addons.push({ name, amount });
  }
  const packageDetails = SERVICES[requestedService];
  const paymentItems = [
    { name: 'Épure Auto — formule ' + requestedService, amount: packageDetails.amount },
    ...addons
  ];
  const totalAmount = paymentItems.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(totalAmount) || totalAmount > 10000) {
    return res.status(400).json({ error: 'Le montant total est invalide.' });
  }

  const client = await pool.connect();
  let booking, session;
  try {
    await client.query('BEGIN');
    booking = await getBooking(client, req.params.id, true);
    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Réservation introuvable.' });
    }
    if (!['pending', 'expired'].includes(booking.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Seules les demandes en attente ou les liens expirés peuvent recevoir un nouveau lien de paiement.' });
    }

    if (packageDetails.durationMinutes > Number(booking.durationMinutes)) {
      const overlap = await client.query(
        'SELECT 1 FROM bookings WHERE id <> $1 AND booking_date = $2 AND status = ANY($3::text[]) ' +
        'AND booking_time < ($4::time + ($5 * interval \'1 minute\')) ' +
        'AND booking_time + duration_minutes * interval \'1 minute\' > $4::time LIMIT 1',
        [booking.id, booking.date, ACTIVE_STATUSES, booking.time, packageDetails.durationMinutes]
      );
      const blocked = await client.query(
        'SELECT 1 FROM booking_blocks WHERE block_date = $1 ' +
        'AND block_time < ($2::time + ($3 * interval \'1 minute\')) ' +
        'AND block_time + interval \'1 hour\' > $2::time LIMIT 1',
        [booking.date, booking.time, packageDetails.durationMinutes]
      );
      if (overlap.rowCount || blocked.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Cette formule est plus longue et chevaucherait un autre rendez-vous ou un créneau bloqué. Choisissez une formule plus courte ou modifiez le planning.' });
      }
    }

    const attemptResult = await client.query(
      'UPDATE bookings SET payment_attempt = payment_attempt + 1 WHERE id = $1 RETURNING payment_attempt',
      [booking.id]
    );
    const paymentAttempt = attemptResult.rows[0].payment_attempt;
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: booking.email,
      payment_method_types: ['card'],
      line_items: paymentItems.map(item => ({
        price_data: {
          currency: 'eur',
          product_data: { name: item.name, description: booking.vehicle + ' · ' + booking.date + ' à ' + booking.time },
          unit_amount: item.amount * 100
        },
        quantity: 1
      })),
      metadata: { bookingId: booking.id, finalService: requestedService, finalAmount: String(totalAmount) },
      success_url: publicBaseUrl() + '/success.html?booking=' + encodeURIComponent(booking.id),
      cancel_url: publicBaseUrl() + '/reservation-annulee.html?booking=' + encodeURIComponent(booking.id),
      expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60
    }, {
      idempotencyKey: 'epure-booking-' + booking.id + '-payment-' + paymentAttempt
    });

    if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
    await client.query(
      'UPDATE bookings SET service = $2, amount_eur = $3, duration_minutes = $4, duration_label = $5, ' +
      'payment_items = $6::jsonb, status = \'awaiting_payment\', stripe_session_id = $7, payment_url = $8 WHERE id = $1',
      [booking.id, requestedService, totalAmount, packageDetails.durationMinutes, packageDetails.durationLabel,
        JSON.stringify(paymentItems), session.id, session.url]
    );

    const itemSummary = paymentItems.map(item =>
      '<li>' + escapeHtml(item.name) + ' : <strong>' + escapeHtml(item.amount) + ' €</strong></li>'
    ).join('');
    await enqueueEmail(client, {
      dedupeKey: 'booking:' + booking.id + ':payment:' + session.id,
      bookingId: booking.id,
      recipient: booking.email,
      subject: 'Épure Auto — règlement de votre prestation',
      htmlBody: '<p>Bonjour ' + escapeHtml(booking.firstName) + ',</p><p>Merci de nous avoir confié votre véhicule. Voici le détail du montant convenu après la prestation :</p><ul>' +
        itemSummary + '</ul><p><strong>Total à régler : ' + escapeHtml(totalAmount) + ' €</strong></p><p><a href="' + escapeHtml(session.url) +
        '">Régler ma prestation</a></p><p>Ce lien de paiement sécurisé est valable pendant 24 heures. Si vous avez une question, contactez-nous.</p><p>À bientôt,<br>Épure Auto</p>'
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }

  void processEmailQueue().catch(e => console.error('[EMAIL PAYMENT QUEUE]', e.message));
  const emailResult = await pool.query(
    'SELECT status FROM email_outbox WHERE dedupe_key = $1',
    ['booking:' + booking.id + ':payment:' + session.id]
  );
  const emailStatus = emailResult.rows[0] ? emailResult.rows[0].status : 'pending';
  res.json({ ok: true, paymentUrl: session.url, totalAmount, emailSent: emailStatus === 'sent', emailStatus });
}));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Chaque photo doit faire 5 Mo maximum.' :
      error.code === 'LIMIT_FILE_COUNT' ? 'Vous pouvez envoyer 5 photos maximum.' : 'Fichiers envoyés invalides.';
    return res.status(400).json({ error: message });
  }
  if (error.message && error.message.includes('Format photo non accepté')) return res.status(400).json({ error: error.message });
  console.error('[SERVER ERROR]', error.stack || error.message);
  res.status(500).json({ error: 'Une erreur serveur est survenue. Réessayez plus tard.' });
});

async function start() {
  try {
    await pool.query('SELECT 1');
    await ensureEmailOutboxSchema();
    app.listen(PORT, '0.0.0.0', () => {
      console.log('Épure Auto server listening on port ' + PORT);
      void processEmailQueue().catch(e => console.error('[EMAIL WORKER START]', e.message));
    });
    const emailWorkerTimer = setInterval(() => {
      void processEmailQueue().catch(e => console.error('[EMAIL WORKER TIMER]', e.message));
    }, 30000);
    emailWorkerTimer.unref();
  } catch (e) {
    console.error('Impossible de préparer PostgreSQL :', e.message);
    process.exit(1);
  }
}
start();

process.on('SIGTERM', async () => {
  await pool.end().catch(() => {});
  if (r2) r2.destroy();
  process.exit(0);
});
