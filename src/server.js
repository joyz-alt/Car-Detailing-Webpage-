require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4242;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const BLOCKS_FILE = path.join(DATA_DIR, 'blocks.json');
if (!fs.existsSync(BOOKINGS_FILE)) fs.writeFileSync(BOOKINGS_FILE, '[]');
if (!fs.existsSync(BLOCKS_FILE)) fs.writeFileSync(BLOCKS_FILE, '[]');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const SERVICES = {
  Essentiel: { amount: 59, durationMinutes: 105, durationLabel: '1h30 à 2h' },
  Intégral: { amount: 99, durationMinutes: 180, durationLabel: '2h30 à 3h30' }
};

// The start times are deliberately simple for the launch version.
// Availability is checked against the duration of the selected service.
const SLOTS = ['09:00', '10:30', '12:00', '13:00', '14:00', '14:30', '15:30', '17:00'];

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function publicBooking(b) {
  const copy = { ...b };
  delete copy.customerToken;
  return copy;
}
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function sendMail(to, subject, html) {
  if (!to) return false;
  const transporter = getTransporter();
  if (!transporter || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[EMAIL NON CONFIGURÉ] Ajoutez SMTP_USER et SMTP_PASS dans .env pour recevoir les notifications.');
    return false;
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  try {
    await transporter.sendMail({ from, to, subject, html });
    console.log(`[EMAIL ENVOYÉ] ${to} — ${subject}`);
    return true;
  } catch (err) {
    console.error(`[EMAIL ÉCHEC] ${to} — ${err.message}`);
    throw err;
  }
}
function makeId(prefix = 'E') { return prefix + crypto.randomBytes(6).toString('hex'); }
function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function toMinutes(time) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
function overlaps(startA, durationA, startB, durationB) {
  return startA < startB + durationB && startB < startA + durationA;
}
function activeStatus(status) { return ['pending', 'awaiting_payment', 'confirmed'].includes(status); }
function bookingIsAvailable(date, time, service) {
  const requested = SERVICES[service];
  const start = toMinutes(time);
  const bookings = read(BOOKINGS_FILE);
  const blocks = read(BLOCKS_FILE);
  const conflictsBookings = bookings.some(b => b.date === date && activeStatus(b.status) && overlaps(start, requested.durationMinutes, toMinutes(b.time), SERVICES[b.service]?.durationMinutes || 0));
  const conflictsBlocks = blocks.some(b => b.date === date && overlaps(start, requested.durationMinutes, toMinutes(b.time), 60));
  return !conflictsBookings && !conflictsBlocks;
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhook non configuré');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookings = read(BOOKINGS_FILE);
    const b = bookings.find(x => x.id === session.metadata?.bookingId);
    if (b) {
      b.status = 'confirmed';
      b.paidAt = new Date().toISOString();
      b.stripePaymentIntentId = session.payment_intent;
      write(BOOKINGS_FILE, bookings);
      await sendMail(b.email, `Épure Auto — rendez-vous confirmé`, `<p>Bonjour ${b.firstName},</p><p>Votre rendez-vous est confirmé pour le <strong>${b.date}</strong> à <strong>${b.time}</strong>.</p><p>Prestation : ${b.service} · ${b.amount} €</p><p>À bientôt,<br>Épure Auto</p>`).catch(console.error);
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/config', (req, res) => res.json({ stripeEnabled: Boolean(stripe), services: SERVICES, slots: SLOTS }));

app.get('/api/email-status', (req, res) => {
  const configured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  res.json({ configured, recipient: process.env.ADMIN_EMAIL || 'epureauto@gmail.com' });
});

app.get('/api/availability', (req, res) => {
  const { date, service = 'Essentiel' } = req.query;
  if (!date) return res.status(400).json({ error: 'Date manquante.' });
  if (!SERVICES[service]) return res.status(400).json({ error: 'Prestation invalide.' });
  res.json({ slots: SLOTS.map(time => ({ time, available: bookingIsAvailable(date, time, service) })) });
});

app.post('/api/bookings', async (req, res) => {
  const { service, vehicle, date, time, firstName, lastName, phone, email, address, water, electricity, condition, note, photos = [] } = req.body;
  if (!SERVICES[service] || !vehicle || !date || !time || !firstName || !lastName || !phone || !email || !address || !water || !electricity || !condition) {
    return res.status(400).json({ error: 'Merci de compléter tous les champs obligatoires.' });
  }
  if (!SLOTS.includes(time)) return res.status(400).json({ error: 'Créneau invalide.' });
  if (!bookingIsAvailable(date, time, service)) return res.status(409).json({ error: 'Ce créneau vient d’être pris ou chevauche une autre prestation.' });

  const safePhotos = Array.isArray(photos) ? photos.slice(0, 5).map(p => ({
    name: String(p.name || '').slice(0, 120),
    type: String(p.type || '').slice(0, 80),
    data: String(p.data || '').slice(0, 2_000_000)
  })) : [];

  const booking = {
    id: makeId(),
    createdAt: new Date().toISOString(),
    service,
    vehicle,
    date,
    time,
    firstName,
    lastName,
    phone,
    email,
    address,
    water,
    electricity,
    condition,
    note: note || '',
    photos: safePhotos,
    amount: SERVICES[service].amount,
    duration: SERVICES[service].durationLabel,
    status: 'pending',
    customerToken: makeToken()
  };

  const bookings = read(BOOKINGS_FILE);
  bookings.push(booking);
  write(BOOKINGS_FILE, bookings);

  await sendMail(process.env.ADMIN_EMAIL || 'epureauto@gmail.com', `Épure Auto — nouvelle demande ${booking.id}`, `<h2>Nouvelle demande de réservation</h2><p><strong>${firstName} ${lastName}</strong><br>${phone}<br>${email}</p><p><strong>${service}</strong> · ${vehicle}<br>${date} à ${time}<br>${address}</p><p>💧 Eau sur place : <strong>${water}</strong><br>⚡ Électricité sur place : <strong>${electricity}</strong><br>État : <strong>${condition}</strong></p><p>Photos : ${safePhotos.length}</p>${note ? `<p>Note : ${note}</p>` : ''}<p><a href="${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/admin.html">Ouvrir l'espace pro</a></p>`).catch(console.error);
  res.status(201).json({ booking: publicBooking(booking), message: 'Demande envoyée. Votre créneau sera confirmé après vérification.' });
});

function adminGuard(req, res, next) {
  if (process.env.ADMIN_KEY && req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

app.get('/api/admin/bookings', adminGuard, (req, res) => res.json(read(BOOKINGS_FILE).map(publicBooking)));
app.get('/api/admin/blocks', adminGuard, (req, res) => res.json(read(BLOCKS_FILE)));

app.post('/api/admin/blocks', adminGuard, (req, res) => {
  const { date, time } = req.body;
  if (!date || !time) return res.status(400).json({ error: 'Date et heure requises.' });
  const blocks = read(BLOCKS_FILE);
  if (!blocks.some(b => b.date === date && b.time === time)) blocks.push({ id: makeId('B'), date, time });
  write(BLOCKS_FILE, blocks);
  res.json({ ok: true });
});

app.delete('/api/admin/blocks/:id', adminGuard, (req, res) => {
  write(BLOCKS_FILE, read(BLOCKS_FILE).filter(b => b.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/decline', adminGuard, async (req, res) => {
  const bookings = read(BOOKINGS_FILE);
  const b = bookings.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Réservation introuvable.' });
  b.status = 'declined';
  write(BOOKINGS_FILE, bookings);
  await sendMail(b.email, `Épure Auto — demande ${b.id}`, `<p>Bonjour ${b.firstName},</p><p>Nous sommes désolés, le créneau demandé n'est finalement pas disponible. Nous allons revenir vers vous pour vous proposer un autre créneau.</p>`).catch(console.error);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/payment', adminGuard, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe n’est pas configuré. Ajoutez STRIPE_SECRET_KEY.' });
  const bookings = read(BOOKINGS_FILE);
  const b = bookings.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Réservation introuvable.' });
  if (b.status !== 'pending') return res.status(400).json({ error: 'Cette réservation ne peut pas être envoyée au paiement.' });
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: b.email,
    line_items: [{ price_data: { currency: 'eur', product_data: { name: `Épure Auto — ${b.service}`, description: `${b.vehicle} · ${b.date} à ${b.time}` }, unit_amount: b.amount * 100 }, quantity: 1 }],
    metadata: { bookingId: b.id },
    success_url: `${base}/success.html?booking=${encodeURIComponent(b.id)}`,
    cancel_url: `${base}/reservation-annulee.html?booking=${encodeURIComponent(b.id)}`,
    expires_at: Math.floor(Date.now() / 1000) + 1800
  });

  b.status = 'awaiting_payment';
  b.stripeSessionId = session.id;
  b.paymentUrl = session.url;
  write(BOOKINGS_FILE, bookings);

  const sent = await sendMail(b.email, `Épure Auto — votre réservation est prête à être confirmée`, `<p>Bonjour ${b.firstName},</p><p>Votre créneau du <strong>${b.date}</strong> à <strong>${b.time}</strong> est disponible.</p><p>Montant : <strong>${b.amount} €</strong></p><p><a href="${session.url}">Payer et confirmer mon rendez-vous</a></p><p>Le lien expire dans 30 minutes.</p>`).catch(err => { console.error(err); return false; });
  res.json({ ok: true, paymentUrl: session.url, emailSent: sent });
});

app.listen(PORT, () => console.log(`Épure Auto server running on http://localhost:${PORT}`));
