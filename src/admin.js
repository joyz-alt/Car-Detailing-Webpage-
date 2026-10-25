const $ = s => document.querySelector(s);
let ADMIN_KEY = localStorage.getItem('epure_admin_key') || '';
function headers(json = false) {
  const h = {};

  if (json)
    h['Content-Type'] = 'application/json';

  if (ADMIN_KEY)
    h['x-admin-key'] = ADMIN_KEY;
  return h;
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...headers(!!opts.body), ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    if (r.status === 401) {
      localStorage.removeItem('epure_admin_key');
      ADMIN_KEY = '';
    }
    throw new Error(d.error || 'Erreur serveur');
  }
  return d;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function renderBookings(rs) {
  const box = $('#bookings');
  if (!rs.length) {
    box.innerHTML = '<li class="empty">Aucune réservation.</li>';
    return;
  }

  box.innerHTML = rs.map(r => {
    const photos = (r.photos || []).filter(p => p && p.url).map(p =>
      '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener noreferrer" title="Ouvrir la photo">' +
      '<img src="' + escapeHtml(p.url) + '" alt="Photo du véhicule" loading="lazy" ' +
      'style="width:94px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--border)"></a>'
    ).join('');
    const canCreatePayment = ['pending', 'expired'].includes(r.status);
    const serviceOptions = ['Essentiel', 'Intégral'].map(service =>
      '<option value="' + service + '"' + (r.service === service ? ' selected' : '') + '>' +
      service + ' — ' + (service === 'Essentiel' ? '90' : '130') + ' €</option>'
    ).join('');
    const savedAddons = Array.isArray(r.paymentItems)
      ? r.paymentItems.slice(1).map(item => item.name + ' | ' + item.amount).join('\n')
      : '';
    const paymentForm = canCreatePayment
      ? '<div class="payment-config" style="display:grid;gap:8px;min-width:min(100%,280px);margin-top:12px">' +
        '<label>Formule finale<select data-field="service">' + serviceOptions + '</select></label>' +
        '<label>Suppléments (une ligne par extra : intitulé | prix en €)' +
        '<textarea data-field="addons" rows="3" placeholder="Poils d’animaux | 20&#10;Traitement des taches | 15">' +
        escapeHtml(savedAddons) + '</textarea></label>' +
        '<small class="empty">À utiliser après le nettoyage, lorsque le montant final a été convenu avec le client.</small>' +
        '<button class="btn btn-primary btn-small" data-action="payment" data-id="' + escapeHtml(r.id) + '">' +
        (r.status === 'expired' ? 'Renvoyer le lien de paiement' : 'Créer et envoyer le lien après nettoyage') + '</button>' +
        (r.status === 'pending' ? '<button class="btn btn-secondary btn-small" data-action="decline" data-id="' + escapeHtml(r.id) + '">Refuser la demande</button>' : '') +
        '</div>'
      : '';
    const paymentLink = r.paymentUrl && r.status === 'awaiting_payment'
      ? '<a class="btn btn-secondary btn-small" href="' + escapeHtml(r.paymentUrl) + '" target="_blank" rel="noopener noreferrer">Ouvrir le lien de paiement</a>'
      : '';

    return '<li class="booking-admin-item"><div><strong>' + escapeHtml(r.date) + ' · ' + escapeHtml(r.time) +
      '</strong> <span class="status status-' + escapeHtml(r.status) + '">' + escapeHtml(labelStatus(r.status)) +
      '</span><br>' + escapeHtml(r.firstName) + ' ' + escapeHtml(r.lastName) + ' · ' + escapeHtml(r.service) +
      ' · ' + escapeHtml(r.vehicle) + '<br><strong>Montant enregistré : ' + escapeHtml(r.amount) + ' €</strong>' +
      '<br><span class="empty">' + escapeHtml(r.phone) + ' · ' + escapeHtml(r.email) +
      '<br>' + escapeHtml(r.address) + '<br>Eau : <strong>' + escapeHtml(r.water || 'Non renseigné') +
      '</strong> · Électricité : <strong>' + escapeHtml(r.electricity || 'Non renseigné') +
      '</strong><br>État : ' + escapeHtml(r.condition || '') + (r.note ? ' · ' + escapeHtml(r.note) : '') +
      '</span>' + (photos ? '<div class="admin-photo-grid" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">' + photos + '</div>' :
      ((r.photos || []).length ? '<br><span class="photo-count">Photos enregistrées, mais leur stockage n’est pas disponible.</span>' : '')) +
      (paymentForm ? paymentForm : '') + '</div><div class="admin-actions">' + paymentLink + '</div></li>';
  }).join('');
}
$('#bookings').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === 'payment') await sendPayment(id, button);
  if (button.dataset.action === 'decline') await decline(id);
});

function labelStatus(s) {
  return {
    pending: 'Réservation reçue', awaiting_payment: 'Paiement en attente', confirmed: 'Payé', declined: 'Refusé', expired: 'Lien expiré'
  }[s] || s;
}

async function render() {
  try {
    const data = await api('/api/admin/bookings');
    renderBookings(data);
  } catch (e) {
    $('#bookings').innerHTML = `<li class="empty">${escapeHtml(e.message)}</li>`;
  }

  try {
    renderBlocks(await api('/api/admin/blocks'));
  } catch (e) {
    $('#blocks').innerHTML = `<li class="empty">${escapeHtml(e.message)}</li>`;
  }

  await renderNotifications();
}

function renderBlocks(rows) {
  const box = $('#blocks');
  if (!Array.isArray(rows) || !rows.length) {
    box.innerHTML = '<li class="empty">Aucun créneau bloqué.</li>';
    return;
  }
  box.innerHTML = rows.map(b =>
    '<li><span>' + escapeHtml(b.date) + ' · ' + escapeHtml(b.time) +
    '</span><button class="danger" data-action="remove-block" data-id="' + escapeHtml(b.id) +
    '">Supprimer</button></li>'
  ).join('');
}

const emailStatusLabel = {
  pending: 'En attente', sending: 'En cours d’envoi', sent: 'Envoyé', failed: 'Échec'
};
async function renderNotifications() {
  const provider = $('#emailProvider');
  const box = $('#emailOutbox');
  if (!provider || !box) return;
  try {
    const data = await api('/api/admin/email-outbox');
    provider.textContent = data.configured
      ? 'Fournisseur : ' + data.provider + ' · File de notifications'
      : 'Aucun fournisseur e-mail valide. Configurez Resend (recommandé) ou SMTP avant de recevoir des réservations.';
    if (!data.messages.length) {
      box.innerHTML = '<li class="empty">Aucune notification en file.</li>';
      return;
    }
    box.innerHTML = data.messages.map(m =>
      '<li class="booking-admin-item"><div><strong>' + escapeHtml(m.subject) + '</strong><br>' +
      '<span class="empty">' + escapeHtml(m.recipient) + ' · ' +
      escapeHtml(emailStatusLabel[m.status] || m.status) + ' · tentatives : ' +
      escapeHtml(m.attempts) + '</span>' +
      (m.lastError ? '<br><span class="photo-count">' + escapeHtml(m.lastError) + '</span>' : '') +
      (m.sentAt ? '<br><span class="empty">Envoyé le ' + escapeHtml(new Date(m.sentAt).toLocaleString('fr-FR')) + '</span>' : '') +
      '</div><div class="admin-actions">' +
      (m.status === 'failed'
        ? '<button class="btn btn-secondary btn-small" data-action="retry-email" data-id="' + escapeHtml(m.id) + '">Réessayer</button>'
        : '') +
      '</div></li>'
    ).join('');
  } catch (e) {
    provider.textContent = 'Impossible de lire la file e-mail : ' + e.message;
    box.innerHTML = '';
  }
}

$('#emailOutbox').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action="retry-email"]');
  if (!button) return;
  button.disabled = true;
  try {
    await api('/api/admin/email-outbox/' + encodeURIComponent(button.dataset.id) + '/retry', { method: 'POST' });
    await renderNotifications();
  } catch (e) {
    alert(e.message);
    button.disabled = false;
  }
});

$('#blocks').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action="remove-block"]');
  if (!button) return;
  await removeBlock(button.dataset.id);
});

async function sendPayment(id, button) {
  const card = button.closest('.booking-admin-item');
  const service = card?.querySelector('[data-field="service"]')?.value;
  const addonText = card?.querySelector('[data-field="addons"]')?.value || '';
  const addons = [];
  for (const line of addonText.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const separator = line.lastIndexOf('|');
    if (separator < 1) return alert('Format de supplément invalide. Utilisez une ligne par extra : intitulé | prix en euros.');
    const name = line.slice(0, separator).trim();
    const amountText = line.slice(separator + 1).trim();
    if (!name || !/^\d+$/.test(amountText)) return alert('Chaque supplément doit avoir un intitulé et un prix entier en euros. Exemple : Poils d’animaux | 20');
    addons.push({ name, amount: Number(amountText) });
  }
  if (!confirm('Confirmez-vous que le nettoyage est terminé et que le client a accepté le montant final ? Un lien Stripe sera créé et envoyé par e-mail.')) return;
  button.disabled = true;
  try {
    const d = await api(`/api/admin/bookings/${id}/payment`, {
      method: 'POST',
      body: JSON.stringify({ service, addons })
    });
    if (d.emailSent) {
      alert('Le lien de paiement de ' + d.totalAmount + ' € a été envoyé au client par e-mail.');
    } else if (d.emailStatus === 'failed') {
      alert('Le lien Stripe de ' + d.totalAmount + ' € a été créé, mais l’e-mail a échoué. Consultez « Notifications e-mail ».');
    } else {
      alert('Le lien de paiement de ' + d.totalAmount + ' € est créé. L’e-mail est en cours de traitement ; vérifiez « Notifications e-mail ».');
    }
    render();
  } catch (e) {
    alert(e.message);
    button.disabled = false;
  }
}
async function decline(id) {
  if (!confirm('Refuser cette demande ?'))
    return;
  try {
    await api(`/api/admin/bookings/${id}/decline`, { method: 'POST' });
    render();
  } catch (e) {
    alert(e.message);
  }
}
async function removeBlock(id) {
  try {
    await api('/api/admin/blocks/' + encodeURIComponent(id), { method: 'DELETE' });
    renderBlocks(await api('/api/admin/blocks'));
  } catch (e) {
    alert(e.message);
  }
}

$('#blockDate').min = new Date().toISOString().slice(0, 10);
$('#blockBtn').onclick = async () => {
  const date = $('#blockDate').value, time = $('#blockTime').value;
  if (!date)
    return alert('Choisissez une date.');
  try {
    await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify({ date, time }) });
    renderBlocks(await api('/api/admin/blocks'));
  } catch (e) {
    alert(e.message);
  }
};
$('#clearBtn').onclick = () => render();
$('#refreshEmails').onclick = () => renderNotifications();
if (!ADMIN_KEY) { 
  ADMIN_KEY = prompt('Clé administrateur (ADMIN_KEY) :') || ''; 
  
  if (ADMIN_KEY) 
    localStorage.setItem('epure_admin_key', ADMIN_KEY); 
  
}
render();
