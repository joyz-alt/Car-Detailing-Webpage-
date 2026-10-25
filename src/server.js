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
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (ADMIN_KEY && ADMIN_KEY.length < 32) {
  console.error('ADMIN_KEY must be at least 32 characters long.');
  process.exit(1);
}
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACTIVE_STATUSES = ['pending', 'awaiting_payment', 'confirmed'];
const SERVICES = {
  Essentiel: { amount: 59, durationMinutes: 105, durationLabel: '1h30 à 2h' },
  Intégral: { amount: 99, durationMinutes: 180, durationLabel: '2h30 à 3h30' }
};
const SLOTS = ['09:00', '10:30', '12:00', '13:00', '14:00', '14:30', '15:30', '17:00'];
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
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function sendMail(to, subject, html) {
  const transporter = getTransporter();
  if (!to || !transporter) { console.warn('[EMAIL] SMTP non configuré.'); return false; }
  try {
    await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
    return true;
  } catch (e) { console.error('[EMAIL]', e.message); throw e; }
}
function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
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
  return {
    objectKey: key, originalName: path.basename(file.originalname || 'photo').slice(0, 120),
    contentType: detected.mime, sizeBytes: file.size
  };
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
  'b.stripe_session_id AS "stripeSessionId", b.stripe_payment_intent_id AS "stripePaymentIntentId", ' +
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

      if (booking && session.payment_status === 'paid') {
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
          if (updated.rowCount && booking.status !== 'confirmed') confirmation = booking;
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const booking = session.metadata && session.metadata.bookingId
        ? await getBooking(client, session.metadata.bookingId, true) : null;
      if (booking && booking.status === 'awaiting_payment' && booking.stripeSessionId === session.id) {
        await client.query(
          'UPDATE bookings SET status = \'pending\', stripe_session_id = NULL, payment_url = NULL WHERE id = $1',
          [booking.id]
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[STRIPE WEBHOOK]', e.message);
    return res.status(400).send('Le webhook n’a pas pu être traité.');
  } finally { client.release(); }

  if (confirmation) {
    await sendMail(confirmation.email, 'Épure Auto — rendez-vous confirmé',
      '<p>Bonjour ' + escapeHtml(confirmation.firstName) + ',</p><p>Votre rendez-vous est confirmé pour le <strong>' +
      escapeHtml(confirmation.date) + '</strong> à <strong>' + escapeHtml(confirmation.time) + '</strong>.</p><p>Prestation : ' +
      escapeHtml(confirmation.service) + ' · ' + escapeHtml(confirmation.amount) + ' €</p><p>À bientôt,<br>Épure Auto</p>')
      .catch(e => console.error('[EMAIL CONFIRMATION]', e.message));
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Explicit allow-list: do not accidentally publish server.js, environment files, or data.
const PUBLIC_FILES = new Set(['/', '/index.html', '/styles.css', '/app.js', '/admin.html', '/admin.js', '/success.html', '/reservation-annulee.html']);
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
app.get('/api/email-status', (req, res) => res.json({
  configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}));

app.get('/api/availability', asyncHandler(async (req, res) => {
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

app.post('/api/bookings', upload.array('photos', MAX_PHOTOS), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = text(body.service, 30);
  const vehicle = text(body.vehicle, 100);
  const date = text(body.date, 10);
  const time = text(body.time, 5);
  const firstName = text(body.firstName, 100);
  const lastName = text(body.lastName, 100);
  const phone = text(body.phone, 40);
  const email = text(body.email, 254).toLowerCase();
  const address = text(body.address, 300);
  const water = text(body.water, 10);
  const electricity = text(body.electricity, 10);
  const condition = text(body.condition, 100);
  const note = text(body.note, 1500);
  const files = req.files || [];

  if (!SERVICES[service] || !vehicle || !date || !time || !firstName || !lastName || !phone ||
    !email || !address || !water || !electricity || !condition) {
    return res.status(400).json({ error: 'Merci de compléter tous les champs obligatoires.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  if (!['Oui', 'Non'].includes(water) || !['Oui', 'Non'].includes(electricity)) {
    return res.status(400).json({ error: 'Veuillez préciser si l’eau et l’électricité sont disponibles.' });
  }
  if (!isValidDate(date) || date < parisToday()) return res.status(400).json({ error: 'La date de réservation est invalide.' });
  if (!SLOTS.includes(time)) return res.status(400).json({ error: 'Créneau invalide.' });
  if (date === parisToday() && slotMinutes(time) <= parisMinutesNow()) return res.status(400).json({ error: 'Ce créneau est déjà passé.' });
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
      'INSERT INTO bookings (id, service, vehicle, booking_date, booking_time, first_name, last_name, phone, email, address, water, electricity, vehicle_condition, note, amount_eur, duration_minutes, duration_label, status) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,\'pending\')',
      [id, service, vehicle, date, time, firstName, lastName, phone, email, address, water, electricity, condition, note,
        details.amount, details.durationMinutes, details.durationLabel]
    );
    for (const p of photos) {
      await client.query(
        'INSERT INTO booking_photos (booking_id, object_key, original_name, content_type, size_bytes) VALUES ($1,$2,$3,$4,$5)',
        [id, p.objectKey, p.originalName, p.contentType, p.sizeBytes]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { });
    await deleteObjects(photos);
    throw e;
  } finally { client.release(); }

  await sendMail(process.env.ADMIN_EMAIL || 'epureauto@gmail.com', 'Épure Auto — nouvelle demande ' + id,
    '<h2>Nouvelle demande de réservation</h2><p><strong>' + escapeHtml(firstName) + ' ' + escapeHtml(lastName) +
    '</strong><br>' + escapeHtml(phone) + '<br>' + escapeHtml(email) + '</p><p><strong>' + escapeHtml(service) +
    '</strong> · ' + escapeHtml(vehicle) + '<br>' + escapeHtml(date) + ' à ' + escapeHtml(time) + '<br>' +
    escapeHtml(address) + '</p><p>💧 Eau : <strong>' + escapeHtml(water) + '</strong><br>⚡ Électricité : <strong>' +
    escapeHtml(electricity) + '</strong><br>État : <strong>' + escapeHtml(condition) + '</strong></p><p>Photos : ' +
    photos.length + '</p>' + (note ? '<p>Note : ' + escapeHtml(note) + '</p>' : '') +
    '<p><a href="' + escapeHtml(publicBaseUrl()) + '/admin.html">Ouvrir l’espace pro</a></p>')
    .catch(e => console.error('[EMAIL NOUVELLE DEMANDE]', e.message));

  res.status(201).json({
    booking: {
      id, service, vehicle, date, time, firstName, lastName, amount: SERVICES[service].amount, status: 'pending',
      photos: photos.map(p => ({ name: p.originalName, type: p.contentType }))
    },
    message: 'Demande envoyée. Votre créneau sera confirmé après vérification.'
  });
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
  const booking = await getBooking(pool, req.params.id, false);
  if (!booking) return res.status(404).json({ error: 'Réservation introuvable.' });
  if (booking.status !== 'pending') return res.status(409).json({ error: 'Seule une demande en attente peut être refusée.' });
  const changed = await pool.query(
    'UPDATE bookings SET status = \'declined\' WHERE id = $1 AND status = \'pending\'',
    [req.params.id]
  );
  if (!changed.rowCount) return res.status(409).json({ error: 'Le statut a changé. Actualisez la page.' });
  await sendMail(booking.email, 'Épure Auto — demande ' + booking.id,
    '<p>Bonjour ' + escapeHtml(booking.firstName) + ',</p><p>Nous sommes désolés, le créneau demandé n’est finalement pas disponible. Nous reviendrons vers vous pour proposer un autre créneau.</p>')
    .catch(e => console.error('[EMAIL REFUS]', e.message));
  res.json({ ok: true });
}));

app.post('/api/admin/bookings/:id/payment', adminGuard, asyncHandler(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe n’est pas configuré. Ajoutez STRIPE_SECRET_KEY.' });
  const client = await pool.connect();
  let booking, session;
  try {
    await client.query('BEGIN');
    booking = await getBooking(client, req.params.id, true);
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Réservation introuvable.' }); }
    if (booking.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cette réservation ne peut pas être envoyée au paiement.' });
    }

    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: booking.email,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Épure Auto — ' + booking.service, description: booking.vehicle + ' · ' + booking.date + ' à ' + booking.time },
          unit_amount: Number(booking.amount) * 100
        },
        quantity: 1
      }],
      metadata: { bookingId: booking.id },
      success_url: publicBaseUrl() + '/success.html?booking=' + encodeURIComponent(booking.id),
      cancel_url: publicBaseUrl() + '/reservation-annulee.html?booking=' + encodeURIComponent(booking.id),
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60
    });

    await client.query(
      'UPDATE bookings SET status = \'awaiting_payment\', stripe_session_id = $2, payment_url = $3 WHERE id = $1',
      [booking.id, session.id, session.url]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { });
    throw e;
  } finally { client.release(); }

  const emailSent = await sendMail(booking.email, 'Épure Auto — votre réservation est prête à être confirmée',
    '<p>Bonjour ' + escapeHtml(booking.firstName) + ',</p><p>Votre créneau du <strong>' + escapeHtml(booking.date) +
    '</strong> à <strong>' + escapeHtml(booking.time) + '</strong> est disponible.</p><p>Montant : <strong>' +
    escapeHtml(booking.amount) + ' €</strong></p><p><a href="' + escapeHtml(session.url) +
    '">Payer et confirmer mon rendez-vous</a></p><p>Le lien expire dans 30 minutes.</p>')
    .catch(e => { console.error('[EMAIL PAIEMENT]', e.message); return false; });
  res.json({ ok: true, paymentUrl: session.url, emailSent });
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
    app.listen(PORT, '0.0.0.0', () => console.log('Épure Auto server listening on port ' + PORT));
  } catch (e) {
    console.error('Impossible de se connecter à PostgreSQL :', e.message);
    process.exit(1);
  }
}
start();

process.on('SIGTERM', async () => {
  await pool.end().catch(() => { });
  if (r2) r2.destroy();
  process.exit(0);
});
