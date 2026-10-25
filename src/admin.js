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
    const actions = r.status === 'pending'
      ? '<button class="btn btn-primary btn-small" data-action="payment" data-id="' + escapeHtml(r.id) + '">Confirmer & envoyer paiement</button>' +
        '<button class="btn btn-secondary btn-small" data-action="decline" data-id="' + escapeHtml(r.id) + '">Refuser</button>'
      : '';
    const paymentLink = r.paymentUrl
      ? '<a class="btn btn-secondary btn-small" href="' + escapeHtml(r.paymentUrl) + '" target="_blank" rel="noopener noreferrer">Lien paiement</a>'
      : '';

    return '<li class="booking-admin-item"><div><strong>' + escapeHtml(r.date) + ' · ' + escapeHtml(r.time) +
      '</strong> <span class="status status-' + escapeHtml(r.status) + '">' + escapeHtml(labelStatus(r.status)) +
      '</span><br>' + escapeHtml(r.firstName) + ' ' + escapeHtml(r.lastName) + ' · ' + escapeHtml(r.service) +
      ' · ' + escapeHtml(r.vehicle) + '<br><span class="empty">' + escapeHtml(r.phone) + ' · ' + escapeHtml(r.email) +
      '<br>' + escapeHtml(r.address) + '<br>💧 Eau : <strong>' + escapeHtml(r.water || 'Non renseigné') +
      '</strong> · ⚡ Électricité : <strong>' + escapeHtml(r.electricity || 'Non renseigné') +
      '</strong><br>État : ' + escapeHtml(r.condition || '') + (r.note ? ' · ' + escapeHtml(r.note) : '') +
      '</span>' + (photos ? '<div class="admin-photo-grid" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">' + photos + '</div>' :
      ((r.photos || []).length ? '<br><span class="photo-count">Photos enregistrées, mais leur stockage n’est pas disponible.</span>' : '')) +
      '</div><div class="admin-actions">' + actions + paymentLink + '</div></li>';
  }).join('');
}
$('#bookings').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === 'payment') await sendPayment(id);
  if (button.dataset.action === 'decline') await decline(id);
});

function labelStatus(s) {
  return {
    pending: 'À vérifier', awaiting_payment: 'Paiement en attente', confirmed: 'Confirmé', declined: 'Refusé'
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

async function sendPayment(id) {
  try {
    const d = await api(`/api/admin/bookings/${id}/payment`, { method: 'POST' });
    if (d.emailSent) {
      alert('Le lien de paiement a été envoyé au client par e-mail.');
    } else if (d.emailStatus === 'failed') {
      alert('Le lien Stripe a été créé, mais l’e-mail a échoué. Consultez « Notifications e-mail » puis réessayez.');
    } else {
      alert('Le lien de paiement est créé. L’e-mail est en cours de traitement ou en attente ; son statut apparaît dans « Notifications e-mail ».');
    }
    render();
  } catch (e) {
    alert(e.message);
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
