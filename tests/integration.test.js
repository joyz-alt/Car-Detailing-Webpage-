'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database. Never point integration tests at production.');
}

let pool;
let child;
let baseUrl;
let adminKey;
let childLogs = '';

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Test server exited early. Logs:\n' + childLogs);
    }
    try {
      const response = await fetch(baseUrl + '/health');
      if (response.ok) return;
    } catch (_) {
      // The application may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Test server did not become healthy. Logs:\n' + childLogs);
}

function buildBookingForm(overrides = {}) {
  const fields = {
    service: 'Essentiel',
    date: bookingDate,
    time: '09:00',
    firstName: 'Test',
    lastName: 'Client',
    phone: '+33600000000',
    email: 'client@example.test',
    address: '1 rue de Test, Angoulême',
    legalAccepted: 'true',
    note: 'Réservation d’intégration automatisée'
  };
  Object.assign(fields, overrides);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

const bookingDate = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 40);
  return d.toISOString().slice(0, 10);
})();

let firstBookingId;

before(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
  // Integration tests must run against a dedicated disposable database.
  await pool.query('TRUNCATE email_outbox, stripe_events, booking_blocks, bookings RESTART IDENTITY CASCADE');

  const port = await getFreePort();
  baseUrl = 'http://127.0.0.1:' + port;
  adminKey = crypto.randomBytes(32).toString('hex');
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: 'test',
      TEST_BYPASS_SERVICE_AREA: 'true',
      PGSSL: 'false',
      PORT: String(port),
      ADMIN_KEY: adminKey,
      ADMIN_EMAIL: 'owner@example.test',
      PUBLIC_URL: baseUrl,
      RESEND_API_KEY: '',
      MAIL_FROM: 'Epure Auto <no-reply@example.test>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_SECURE: 'false',
      SMTP_USER: 'test',
      SMTP_PASS: 'test',
      R2_ACCOUNT_ID: '',
      R2_JURISDICTION: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { childLogs = (childLogs + chunk.toString()).slice(-5000); });
  child.stderr.on('data', chunk => { childLogs = (childLogs + chunk.toString()).slice(-5000); });
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
  }
  if (pool) await pool.end();
});

test('health endpoint connects to PostgreSQL', async () => {
  const response = await fetch(baseUrl + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('a valid customer request is stored and queues two notifications', async () => {
  const response = await fetch(baseUrl + '/api/bookings', {
    method: 'POST',
    body: buildBookingForm()
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.booking.service, 'Essentiel');
  assert.equal(payload.booking.amount, 75);
  assert.equal(payload.booking.status, 'pending');
  firstBookingId = payload.booking.id;

  const stored = await pool.query('SELECT id, status, amount_eur FROM bookings WHERE id = $1', [firstBookingId]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].status, 'pending');
  assert.equal(Number(stored.rows[0].amount_eur), 75);

  const outbox = await pool.query(
    'SELECT recipient, dedupe_key FROM email_outbox WHERE booking_id = $1 ORDER BY dedupe_key',
    [firstBookingId]
  );
  assert.equal(outbox.rowCount, 2);
  assert.ok(outbox.rows.some(row => row.recipient === 'owner@example.test'));
  assert.ok(outbox.rows.some(row => row.recipient === 'client@example.test'));
});

test('an overlapping booking request is rejected', async () => {
  const response = await fetch(baseUrl + '/api/bookings', {
    method: 'POST',
    body: buildBookingForm({ email: 'second@example.test' })
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.match(payload.error, /créneau|chevauche/i);

  const bookings = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE booking_date = $1', [bookingDate]);
  assert.equal(bookings.rows[0].count, 1);
});

test('malformed customer email is rejected without inserting a booking', async () => {
  const response = await fetch(baseUrl + '/api/bookings', {
    method: 'POST',
    body: buildBookingForm({ time: '12:00', email: 'not-an-email' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /e-mail/i);
  const bookings = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE booking_date = $1', [bookingDate]);
  assert.equal(bookings.rows[0].count, 1);
});

test('admin endpoints reject unauthenticated requests and show saved booking/outbox data', async () => {
  const denied = await fetch(baseUrl + '/api/admin/bookings');
  assert.equal(denied.status, 401);

  const headers = { 'x-admin-key': adminKey };
  const bookingsResponse = await fetch(baseUrl + '/api/admin/bookings', { headers });
  assert.equal(bookingsResponse.status, 200);
  const bookings = await bookingsResponse.json();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].id, firstBookingId);

  const outboxResponse = await fetch(baseUrl + '/api/admin/email-outbox', { headers });
  assert.equal(outboxResponse.status, 200);
  const outbox = await outboxResponse.json();
  assert.equal(outbox.configured, true);
  assert.equal(outbox.messages.length, 2);
});

test('payment cannot be initiated when Stripe and its webhook are not configured', async () => {
  const response = await fetch(baseUrl + '/api/admin/bookings/' + encodeURIComponent(firstBookingId) + '/payment', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey }
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Stripe|webhook/i);
});

test('Stripe webhook is unavailable when Stripe is not configured', async () => {
  const response = await fetch(baseUrl + '/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'evt_test_disabled', type: 'checkout.session.completed', data: { object: {} } })
  });
  assert.equal(response.status, 503);
});
