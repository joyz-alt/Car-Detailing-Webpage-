const $ = s => document.querySelector(s);
let ADMIN_KEY = localStorage.getItem('epure_admin_key') || '';
let ALL_BOOKINGS = [];
let CURRENT_PAGE = 1;
const PAGE_SIZE = 25;
const SERVICE_PRICES = { Essentielle: 79, Premium: 129 };
let dialogResolver = null;
function showToast(message, type = 'success') {
  const host = $('#adminToast');
  if (!host) return;
  host.textContent = message;
  host.className = 'admin-toast is-visible ' + (type === 'error' ? 'is-error' : 'is-success');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => host.classList.remove('is-visible'), 4200);
}
function showDialog({ title = 'Épure Auto', message = '', confirmLabel = 'OK', cancelLabel = '', input = false, password = false, placeholder = '' } = {}) {
  const overlay = $('#adminDialog'), field = $('#adminDialogInput');
  $('#adminDialogTitle').textContent = title; $('#adminDialogMessage').textContent = message;
  $('#adminDialogConfirm').textContent = confirmLabel; $('#adminDialogCancel').hidden = !cancelLabel;
  $('#adminDialogCancel').textContent = cancelLabel || 'Annuler';
  field.hidden = !input; field.type = password ? 'password' : 'text'; field.placeholder = placeholder; field.value = '';
  overlay.hidden = false; document.body.classList.add('dialog-open');
  if (input) field.focus(); else $('#adminDialogConfirm').focus();
  return new Promise(resolve => { dialogResolver = resolve; });
}
function closeDialog(value) {
  const overlay = $('#adminDialog'); if (overlay.hidden) return;
  overlay.hidden = true; document.body.classList.remove('dialog-open');
  const resolve = dialogResolver; dialogResolver = null; if (resolve) resolve(value);
}
function showConfirm(message, title = 'Confirmer cette action') {
  return showDialog({ title, message, confirmLabel: 'Confirmer', cancelLabel: 'Annuler' });
}
$('#adminDialogForm').addEventListener('submit', event => {
  event.preventDefault(); closeDialog($('#adminDialogInput').hidden ? true : $('#adminDialogInput').value);
});
$('#adminDialogCancel').addEventListener('click', () => closeDialog(false));
$('#adminDialog').addEventListener('click', event => { if (event.target === $('#adminDialog')) closeDialog(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#adminDialog').hidden) closeDialog(false); });

function headers(json = false) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (ADMIN_KEY) h['x-admin-key'] = ADMIN_KEY;
  return h;
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...headers(!!opts.body), ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) { localStorage.removeItem('epure_admin_key'); ADMIN_KEY = ''; }
    throw new Error(d.error || 'Erreur serveur');
  }
  return d;
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function labelStatus(s) {
  return { pending: 'En attente', confirmed: 'Payé', declined: 'Refusé' }[s] || s;
}
function formatBookingDate(value) {
  const date = new Date(value + 'T12:00:00');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('fr-FR');
}
function serviceOptions(selected, disabled = false) {
  const options = Object.keys(SERVICE_PRICES).map(name =>
    '<option value="' + name + '"' + (selected === name ? ' selected' : '') + '>' + name + ' — ' + SERVICE_PRICES[name] + ' €</option>'
  );
  if (!SERVICE_PRICES[selected]) options.unshift('<option selected value="' + escapeHtml(selected) + '">' + escapeHtml(selected) + ' (ancienne formule)</option>');
  return '<select data-field="service"' + (disabled ? ' disabled' : '') + '>' + options.join('') + '</select>';
}
function renderEditForm(r) {
  return '<form class="booking-edit-form" data-edit-form="' + escapeHtml(r.id) + '">' +
    '<div class="edit-grid">' +
    '<label>Formule' + serviceOptions(r.service, r.status === 'confirmed') + '</label>' +
    '<label>Date<input data-field="date" type="date" value="' + escapeHtml(r.date) + '" required></label>' +
    '<label>Heure<input data-field="time" type="time" value="' + escapeHtml(r.time) + '" required></label>' +
    '<label>Prénom<input data-field="firstName" value="' + escapeHtml(r.firstName) + '" maxlength="100" required></label>' +
    '<label>Nom<input data-field="lastName" value="' + escapeHtml(r.lastName) + '" maxlength="100" required></label>' +
    '<label>Téléphone<input data-field="phone" value="' + escapeHtml(r.phone) + '" maxlength="40" required></label>' +
    '<label>E-mail<input data-field="email" type="email" value="' + escapeHtml(r.email) + '" maxlength="254" required></label>' +
    '<label>Adresse<input data-field="address" value="' + escapeHtml(r.address) + '" maxlength="300" required></label>' +
    '<label>Véhicule<input data-field="vehicle" value="' + escapeHtml(r.vehicle || '') + '" maxlength="100"></label>' +
    '<label>Eau<select data-field="water"><option value="Non renseigné">Non renseigné</option><option value="Oui">Oui</option><option value="Non">Non</option></select></label>' +
    '<label>Électricité<select data-field="electricity"><option value="Non renseigné">Non renseigné</option><option value="Oui">Oui</option><option value="Non">Non</option></select></label>' +
    '<label>État du véhicule<input data-field="condition" value="' + escapeHtml(r.condition || '') + '" maxlength="100"></label>' +
    '<label class="edit-note">Précisions<textarea data-field="note" rows="3" maxlength="1500">' + escapeHtml(r.note || '') + '</textarea></label>' +
    '</div><div class="admin-actions"><button class="btn btn-primary btn-small" type="submit">Enregistrer les modifications</button>' +
    '<button class="btn btn-secondary btn-small" type="button" data-action="cancel-edit">Annuler</button></div>' +
    '<p class="empty edit-warning">' + (r.status === 'confirmed' ? 'La formule est verrouillée pour préserver la cohérence du reçu déjà émis.' : 'La modification de la date et de l’heure est vérifiée contre les autres réservations et les créneaux bloqués.') + '</p>' +
    '</form>';
}
function renderBookingDetails(r) {
  const photos = (r.photos || []).filter(p => p && p.url).map(p =>
    '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener noreferrer"><img src="' + escapeHtml(p.url) +
    '" alt="Photo du véhicule" loading="lazy"></a>').join('');
  const paymentItems = Array.isArray(r.paymentItems) ? r.paymentItems : [];
  const receipt = r.status === 'confirmed'
    ? '<div class="payment-receipt"><strong>Règlement enregistré : ' + escapeHtml(r.amount) + ' €</strong><br>Mode : ' +
      escapeHtml(r.paymentMethod === 'card' ? 'Carte bancaire' : r.paymentMethod === 'cash' ? 'Espèces' : 'Non renseigné') +
      (paymentItems.length ? '<ul>' + paymentItems.map(item => '<li>' + escapeHtml(item.name) + ' : ' + escapeHtml(item.amount) + ' €</li>').join('') + '</ul>' : '') + '</div>' : '';
  const paymentForm = r.status === 'pending'
    ? '<div class="payment-config"><h4>Enregistrer le paiement après la prestation</h4>' +
      '<label>Formule finale' + serviceOptions(r.service) + '</label>' +
      '<label>Suppléments (une ligne par extra : intitulé | prix en €)<textarea data-field="addons" rows="3" placeholder="Poils d’animaux | 20&#10;Traitement des taches | 15"></textarea></label>' +
      '<label>Mode de règlement<select data-field="paymentMethod"><option value="card">Carte bancaire</option><option value="cash">Espèces</option></select></label>' +
      '<small class="empty">Enregistrez uniquement après avoir réellement reçu le règlement et obtenu l’accord du client sur la formule et les suppléments.</small>' +
      '<button class="btn btn-primary btn-small" data-action="payment" data-id="' + escapeHtml(r.id) + '">Enregistrer le paiement et envoyer le reçu</button>' +
      '<button class="btn btn-secondary btn-small" data-action="decline" data-id="' + escapeHtml(r.id) + '">Refuser la demande</button></div>' : '';
  return '<div class="booking-detail-layout"><div class="booking-detail-info">' +
    '<p><strong>Contact :</strong> ' + escapeHtml(r.phone) + ' · ' + escapeHtml(r.email) + '</p>' +
    '<p><strong>Adresse :</strong> ' + escapeHtml(r.address) + '</p>' +
    '<p><strong>Véhicule :</strong> ' + escapeHtml(r.vehicle || 'Non renseigné') + '</p>' +
    '<p><strong>Eau :</strong> ' + escapeHtml(r.water || 'Non renseigné') + ' · <strong>Électricité :</strong> ' + escapeHtml(r.electricity || 'Non renseigné') + '</p>' +
    '<p><strong>État :</strong> ' + escapeHtml(r.condition || 'Non renseigné') + '</p>' +
    '<p><strong>Précisions :</strong> ' + escapeHtml(r.note || 'Aucune') + '</p>' +
    (photos ? '<div class="admin-photo-grid">' + photos + '</div>' : ((r.photos || []).length ? '<p class="empty">Photos enregistrées, stockage actuellement indisponible.</p>' : '')) +
    receipt + paymentForm + '</div><div class="booking-detail-edit">' + renderEditForm(r) + '</div></div>';
}
function renderBookings(rows) {
  ALL_BOOKINGS = rows;
  applyBookingFilters();
}
function applyBookingFilters() {
  const query = ($('#bookingSearch')?.value || '').trim().toLocaleLowerCase('fr');
  const status = $('#bookingStatus')?.value || 'all';
  const filtered = ALL_BOOKINGS.filter(r => {
    const haystack = [r.id, r.firstName, r.lastName, r.email, r.phone, r.vehicle, r.address, r.service].join(' ').toLocaleLowerCase('fr');
    return (status === 'all' || r.status === status) && (!query || haystack.includes(query));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);
  $('#bookingCount').textContent = filtered.length + ' réservation(s) affichée(s) sur ' + ALL_BOOKINGS.length;
  $('#bookingPageLabel').textContent = filtered.length ? 'Page ' + CURRENT_PAGE + ' / ' + totalPages : 'Page 0 / 0';
  $('#bookingPrev').disabled = CURRENT_PAGE <= 1 || !filtered.length;
  $('#bookingNext').disabled = CURRENT_PAGE >= totalPages || !filtered.length;
  const box = $('#bookings');
  if (!filtered.length) {
    box.innerHTML = '<tr><td colspan="6" class="empty">Aucune réservation ne correspond à votre recherche.</td></tr>';
    return;
  }
  box.innerHTML = pageRows.map(r =>
    '<tr class="booking-table-row">' +
    '<td><strong>' + escapeHtml(formatBookingDate(r.date)) + '</strong><br>' + escapeHtml(r.time) + '</td>' +
    '<td><strong>' + escapeHtml(r.firstName) + ' ' + escapeHtml(r.lastName) + '</strong><br><span class="table-subtext">' + escapeHtml(r.phone) + '</span></td>' +
    '<td>' + escapeHtml(r.service) + '</td><td><strong>' + escapeHtml(r.amount) + ' €</strong></td>' +
    '<td><span class="status status-' + escapeHtml(r.status) + '">' + escapeHtml(labelStatus(r.status)) + '</span></td>' +
    '<td><div class="table-actions"><button class="btn btn-secondary btn-small" data-action="toggle-details" data-id="' + escapeHtml(r.id) + '">Détails / modifier</button>' +
    '<button class="btn btn-danger btn-small" data-action="delete-booking" data-id="' + escapeHtml(r.id) + '">Supprimer</button></div></td></tr>' +
    '<tr class="booking-detail-row" id="details-' + escapeHtml(r.id) + '" hidden><td colspan="6">' + renderBookingDetails(r) + '</td></tr>'
  ).join('');
  for (const r of pageRows) {
    const detail = $('#details-' + CSS.escape(r.id));
    const form = detail?.querySelector('[data-edit-form]');
    if (form) {
      const water = form.querySelector('[data-field="water"]');
      const electricity = form.querySelector('[data-field="electricity"]');
      if (water) water.value = r.water || 'Non renseigné';
      if (electricity) electricity.value = r.electricity || 'Non renseigné';
    }
  }
}
async function render() {
  try {
    renderBookings(await api('/api/admin/bookings'));
  } catch (e) {
    $('#bookings').innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(e.message) + '</td></tr>';
  }
  try { renderBlocks(await api('/api/admin/blocks')); }
  catch (e) { $('#blocks').innerHTML = '<li class="empty">' + escapeHtml(e.message) + '</li>'; }
  await renderNotifications();
}
function renderBlocks(rows) {
  const box = $('#blocks');
  if (!Array.isArray(rows) || !rows.length) { box.innerHTML = '<li class="empty">Aucun créneau bloqué.</li>'; return; }
  box.innerHTML = rows.map(b => '<li><span>' + escapeHtml(b.date) + ' · ' + escapeHtml(b.time) +
    '</span><button class="danger" data-action="remove-block" data-id="' + escapeHtml(b.id) + '">Supprimer</button></li>').join('');
}
const emailStatusLabel = { pending: 'En attente', sending: 'En cours d’envoi', sent: 'Envoyé', failed: 'Échec' };
async function renderNotifications() {
  const provider = $('#emailProvider'), box = $('#emailOutbox');
  try {
    const data = await api('/api/admin/email-outbox');
    const counts = data.counts || {};
    provider.textContent = data.configured
      ? 'Fournisseur : ' + data.provider + ' · Historique des envois conservé automatiquement.'
      : 'Aucun fournisseur e-mail valide. Configurez Resend ou SMTP avant de recevoir des réservations.';
    $('#emailSentCount').textContent = Number(counts.sent || 0);
    $('#emailPendingCount').textContent = Number(counts.pending || 0) + Number(counts.sending || 0);
    $('#emailFailedCount').textContent = Number(counts.failed || 0);
    if (!data.messages.length) {
      box.innerHTML = '<li class="empty email-all-clear">Aucune notification ne nécessite votre attention.</li>';
      return;
    }
    box.innerHTML = data.messages.map(m => '<li class="booking-admin-item"><div><strong>' + escapeHtml(m.subject) + '</strong><br>' +
      '<span class="empty">' + escapeHtml(m.recipient) + ' · ' + escapeHtml(emailStatusLabel[m.status] || m.status) +
      ' · tentatives : ' + escapeHtml(m.attempts) + '</span>' +
      (m.lastError ? '<br><span class="photo-count">' + escapeHtml(m.lastError) + '</span>' : '') +
      '</div><div class="admin-actions">' + (m.status === 'failed' ? '<button class="btn btn-secondary btn-small" data-action="retry-email" data-id="' + escapeHtml(m.id) + '">Réessayer</button>' : '') +
      '</div></li>').join('');
  } catch (e) { provider.textContent = 'Impossible de lire la file e-mail : ' + e.message; box.innerHTML = ''; }
}
async function sendPayment(id, button) {
  const detail = button.closest('.booking-detail-row');
  const service = detail?.querySelector('[data-field="service"]')?.value;
  const addonText = detail?.querySelector('[data-field="addons"]')?.value || '';
  const paymentMethod = detail?.querySelector('[data-field="paymentMethod"]')?.value;
  const addons = [];
  for (const line of addonText.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const separator = line.lastIndexOf('|');
    if (separator < 1) return showToast('Format invalide. Utilisez : intitulé | prix en euros.', 'error');
    const name = line.slice(0, separator).trim(), amountText = line.slice(separator + 1).trim();
    if (!name || !/^\d+$/.test(amountText)) return showToast('Chaque supplément doit avoir un intitulé et un prix entier en euros.', 'error');
    addons.push({ name, amount: Number(amountText) });
  }
  const methodLabel = paymentMethod === 'card' ? 'carte bancaire' : 'espèces';
  if (!await showConfirm('Confirmez-vous que le nettoyage est terminé, que le client a accepté la formule et les suppléments, et que le règlement par ' + methodLabel + ' a réellement été reçu ?')) return;
  button.disabled = true;
  try {
    const d = await api('/api/admin/bookings/' + encodeURIComponent(id) + '/payment', {
      method: 'POST', body: JSON.stringify({ service, addons, paymentMethod, customerAgreed: true })
    });
    if (d.emailSent) showToast('Paiement de ' + d.totalAmount + ' € enregistré. Le reçu a été envoyé.');
    else showToast('Paiement enregistré. Vérifiez la file des notifications e-mail.');
    await render();
  } catch (e) { showToast(e.message, 'error'); button.disabled = false; }
}
async function saveBooking(form) {
  const id = form.dataset.editForm;
  const values = {};
  form.querySelectorAll('[data-field]').forEach(input => { values[input.dataset.field] = input.value; });
  try {
    await api('/api/admin/bookings/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(values) });
    showToast('Réservation mise à jour.');
    await render();
    const row = $('#details-' + CSS.escape(id));
    if (row) row.hidden = false;
  } catch (e) { showToast(e.message, 'error'); }
}
async function deleteBooking(id) {
  const booking = ALL_BOOKINGS.find(item => item.id === id);
  if (!booking) return;
  const identity = booking.firstName + ' ' + booking.lastName + ' · ' + booking.date;
  if (!await showConfirm('Supprimer définitivement la réservation de ' + identity + ' ?\n\nCette action supprime la réservation et ses photos associées. Elle est irréversible.')) return;
  try {
    await api('/api/admin/bookings/' + encodeURIComponent(id), { method: 'DELETE' });
    ALL_BOOKINGS = ALL_BOOKINGS.filter(item => item.id !== id);
    applyBookingFilters();
    showToast('Réservation supprimée.');
  } catch (e) { showToast(e.message, 'error'); }
}
$('#bookings').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'toggle-details') {
    const row = $('#details-' + CSS.escape(id));
    row.hidden = !row.hidden;
    button.textContent = row.hidden ? 'Détails / modifier' : 'Masquer les détails';
  }
  if (action === 'delete-booking') await deleteBooking(id);
  if (action === 'payment') await sendPayment(id, button);
  if (action === 'decline') {
    if (!await showConfirm('Refuser cette demande ?')) return;
    try { await api('/api/admin/bookings/' + encodeURIComponent(id) + '/decline', { method: 'POST' }); await render(); }
    catch (e) { showToast(e.message, 'error'); }
  }
  if (action === 'cancel-edit') {
    const row = button.closest('.booking-detail-row');
    const form = row?.querySelector('[data-edit-form]');
    if (form) form.reset();
  }
  if (action === 'remove-block') {
    try { await api('/api/admin/blocks/' + encodeURIComponent(id), { method: 'DELETE' }); await renderBlocks(await api('/api/admin/blocks')); }
    catch (e) { showToast(e.message, 'error'); }
  }
  if (action === 'retry-email') {
    button.disabled = true;
    try { await api('/api/admin/email-outbox/' + encodeURIComponent(id) + '/retry', { method: 'POST' }); await renderNotifications(); }
    catch (e) { showToast(e.message, 'error'); button.disabled = false; }
  }
});
$('#bookings').addEventListener('submit', event => {
  const form = event.target.closest('[data-edit-form]');
  if (!form) return;
  event.preventDefault();
  saveBooking(form);
});
$('#emailOutbox').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action="retry-email"]');
  if (!button) return;
  button.disabled = true;
  try {
    await api('/api/admin/email-outbox/' + encodeURIComponent(button.dataset.id) + '/retry', { method: 'POST' });
    await renderNotifications();
  } catch (e) {
    showToast(e.message, 'error');
    button.disabled = false;
  }
});
$('#blocks').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action="remove-block"]');
  if (!button) return;
  try { await api('/api/admin/blocks/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' }); await renderBlocks(await api('/api/admin/blocks')); }
  catch (e) { showToast(e.message, 'error'); }
});
$('#blockDate').min = new Date().toISOString().slice(0, 10);
$('#blockBtn').onclick = async () => {
  const date = $('#blockDate').value, time = $('#blockTime').value;
  if (!date) return showToast('Choisissez une date.', 'error');
  try { await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify({ date, time }) }); await renderBlocks(await api('/api/admin/blocks')); }
  catch (e) { showToast(e.message, 'error'); }
};
$('#clearBtn').onclick = () => render();
$('#refreshEmails').onclick = () => renderNotifications();
$('#bookingSearch').addEventListener('input', () => { CURRENT_PAGE = 1; applyBookingFilters(); });
$('#bookingStatus').addEventListener('change', () => { CURRENT_PAGE = 1; applyBookingFilters(); });
$('#bookingPrev').addEventListener('click', () => { CURRENT_PAGE = Math.max(1, CURRENT_PAGE - 1); applyBookingFilters(); });
$('#bookingNext').addEventListener('click', () => { CURRENT_PAGE += 1; applyBookingFilters(); });
if (!ADMIN_KEY) {
  ADMIN_KEY = '';
}
async function startAdmin() {
  if (!ADMIN_KEY) {
    const entered = await showDialog({ title: 'Accès professionnel', message: 'Saisissez votre clé administrateur pour accéder à votre espace pro.', confirmLabel: 'Se connecter', cancelLabel: 'Annuler', input: true, password: true, placeholder: 'Clé administrateur' });
    ADMIN_KEY = typeof entered === 'string' ? entered.trim() : '';
    if (ADMIN_KEY) localStorage.setItem('epure_admin_key', ADMIN_KEY);
  }
  render();
}
startAdmin();