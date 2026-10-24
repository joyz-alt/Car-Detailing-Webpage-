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

  if (!r.ok)
    throw new Error(d.error || 'Erreur serveur');
  return d;
}

function money(n) {
  return `${n} €`;
}

function renderBookings(rs) {
  const box = $('#bookings');
  if (!rs.length) {
    box.innerHTML = '<li class="empty">Aucune réservation.</li>';
    return;
  }

  box.innerHTML = rs.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(r => `<li class="booking-admin-item"><div><strong>
    
    ${r.date} · ${r.time}</strong> <span class="status status-${r.status}">${labelStatus(r.status)}</span><br>
    
    ${r.firstName} ${r.lastName} · ${r.service} · ${r.vehicle}<br><span class="empty">${r.phone} · ${r.email}<br>

    ${r.address}<br>💧 Eau : <strong>
    
    ${r.water || 'Non renseigné'}</strong> · ⚡ Électricité : <strong>
    ${r.electricity || 'Non renseigné'}</strong><br>État : 
    
    ${r.condition}
    ${r.note ? ' · ' + r.note : ''}</span>

    ${r.photos?.length ? `<br><span class="photo-count">📷 
      ${r.photos.length} photo(s) reçue(s)</span>` : ''}</div><div class="admin-actions">
    
    ${r.status === 'pending' ? `<button class="btn btn-primary btn-small" onclick="sendPayment('
      ${r.id}')">Confirmer & envoyer paiement</button><button class="btn btn-secondary btn-small" onclick="decline('
      ${r.id}')">Refuser</button>` : ''}

    ${r.paymentUrl ? `<a class="btn btn-secondary btn-small" href="
      ${r.paymentUrl}" target="_blank">Lien paiement</a>` : ''}</div></li>`).join('');
}
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
    $('#bookings').innerHTML = `<li class="empty">${e.message}</li>`;
  }

  try {
    const r = await api('/api/admin/blocks');
    renderBlocks(r);
  } catch (e) {
    /* handled below */
  }
}
async function renderBlocks() {
  const r = await api('/api/admin/blocks').catch(() => []);
  const box = $('#blocks');

  if (!Array.isArray(r) || !r.length) {
    box.innerHTML = '<li class="empty">Aucun créneau bloqué.</li>';
    return;
  } box.innerHTML = r.map(b => `<li><span>${b.date} · ${b.time}</span><button class="danger" onclick="removeBlock('${b.id}')">Supprimer</button></li>`).join('');
}
async function sendPayment(id) {
  try {
    const d = await api(`/api/admin/bookings/${id}/payment`, { method: 'POST' });
    alert(d.emailSent ? 'Paiement envoyé par e-mail au client.' : 'Stripe est prêt. Le lien de paiement est disponible dans la réservation.');
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
    await api(`/api/admin/blocks/${id}`, { method: 'DELETE' });
    renderBlocks();
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
    renderBlocks();
  } catch (e) {
    alert(e.message);
  }
};
$('#clearBtn').onclick = () => alert('La réinitialisation complète est volontairement désactivée en production. Supprimez les réservations individuellement ou videz les fichiers data côté serveur.');
if (!ADMIN_KEY) { 
  ADMIN_KEY = prompt('Clé administrateur (ADMIN_KEY) :') || ''; 
  
  if (ADMIN_KEY) 
    localStorage.setItem('epure_admin_key', ADMIN_KEY); 
  
}
render();
