const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let current = 1;
let slots = [];

const serviceData = {
  Essentiel: { amount: 90, duration: '1h30 à 2h30' },
  Intégral: { amount: 130, duration: '2h30 à 3h30' }
};

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function serviceName(v) { return (v || '').split(' — ')[0]; }
function selectedService() { return serviceName($('#service')?.value); }

function goStep(n) {
  if (n < 1 || n > 3) return;
  if (n > current && !validateStep(current)) return;
  current = n;
  $$('.form-step').forEach(x => x.classList.toggle('active', Number(x.dataset.step) === n));
  $$('.progress span').forEach((x, i) => x.classList.toggle('active', i < n));
  if (n === 2) loadSlots();
  if (n === 3) renderSummary();
}

function validateStep(step) {
  if (step === 1) {
    if (!$('#service').value) return alert('Choisissez une prestation.'), false;
    return true;
  }
  if (step === 2 && !$('#time').value) return alert('Choisissez un créneau.'), false;
  if (step === 3) {
    if (!$('#legalAccepted').checked) {
      alert('Merci d’accepter les CGV et de confirmer avoir pris connaissance de la politique de confidentialité.');
      return false;
    }
    try { validatePhotoFiles($('#photos').files); }
    catch (err) { alert(err.message); $('#photos').focus(); return false; }
    const ids = ['firstName', 'lastName', 'phone', 'email', 'streetAddress', 'postcode', 'city'];
    for (const id of ids) {
      const field = $('#' + id);
      if (!field.value.trim()) {
        alert('Merci de compléter tous les champs obligatoires.');
        field.focus();
        return false;
      }
    }
  }
  return true;
}

async function loadSlots() {
  const date = $('#date').value;
  const box = $('#slots');
  if (!date) return;
  box.innerHTML = '<span class="empty-slot">Chargement…</span>';
  $('#time').value = '';

  try {
    const r = await fetch(`/api/availability?date=${encodeURIComponent(date)}&service=${encodeURIComponent(selectedService())}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur');
    slots = data.slots || [];
    box.innerHTML = '';

    if (!slots.length) {
      box.innerHTML = '<span class="empty-slot">Aucun créneau disponible pour cette date.</span>';
      return;
    }

    slots.forEach(s => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot' + (!s.available ? ' disabled' : '');
      b.textContent = s.time;
      b.title = s.available ? 'Choisir ce créneau' : 'Créneau indisponible';
      if (s.available) {
        b.onclick = () => {
          $$('.slot').forEach(x => x.classList.remove('selected'));
          b.classList.add('selected');
          $('#time').value = s.time;
        };
      } else {
        b.disabled = true;
      }
      box.appendChild(b);
    });
  } catch (err) {
    box.innerHTML = '<span class="empty-slot">Impossible de charger les disponibilités.</span>';
  }
}

function updateEarlyExecutionConsent() {
  const wrapper = $('#earlyExecutionConsentWrap');
  const checkbox = $('#earlyExecutionRequested');
  const dateField = $('#date');
  if (!wrapper || !checkbox || !dateField || !dateField.value) return;
  const today = new Date();
  const deadline = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  deadline.setDate(deadline.getDate() + 14);
  const deadlineISO = deadline.getFullYear() + '-' +
    String(deadline.getMonth() + 1).padStart(2, '0') + '-' +
    String(deadline.getDate()).padStart(2, '0');
  const required = dateField.value <= deadlineISO;
  wrapper.hidden = !required;
  checkbox.required = required;
  if (!required) checkbox.checked = false;
}

function renderSummary() {
  const s = selectedService();
  const d = $('#date').value;
  const t = $('#time').value;
  const amount = serviceData[s]?.amount ?? 0;
  const duration = serviceData[s]?.duration ?? '';

  $('#summary').textContent = `${s} · ${new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${t} · ${amount} € · durée estimée ${duration}`;
}

let selectedPhotos = [];
const photoPreviewUrls = new WeakMap();

function photoPreviewUrl(file) {
  if (!photoPreviewUrls.has(file)) photoPreviewUrls.set(file, URL.createObjectURL(file));
  return photoPreviewUrls.get(file);
}

function validatePhotoFiles(fileList) {
  const files = [...fileList];
  if (files.length > 5) throw new Error('Vous pouvez ajouter 5 photos maximum.');
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error('Utilisez uniquement des photos JPG, PNG ou WEBP.');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new Error('Chaque photo doit faire 5 Mo maximum.');
    }
  }
}

function syncPhotoInput() {
  const input = $('#photos');
  if (!input) return;
  const transfer = new DataTransfer();
  selectedPhotos.forEach(file => transfer.items.add(file));
  input.files = transfer.files;
}

function renderPhotoList() {
  const list = $('#photoList');
  const count = $('#photoCount');
  if (!list || !count) return;

  list.replaceChildren();
  selectedPhotos.forEach((file, index) => {
    const item = document.createElement('li');
    item.className = 'photo-list-item';

    item.classList.add('photo-thumbnail');

    const preview = document.createElement('img');
    preview.className = 'photo-preview';
    preview.src = photoPreviewUrl(file);
    preview.alt = `Aperçu de la photo ${index + 1}`;
    preview.loading = 'lazy';

    const name = document.createElement('span');
    name.className = 'photo-file-name';
    name.textContent = file.name;
    name.title = file.name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Supprimer la photo ${file.name}`);
    remove.title = 'Supprimer cette photo';
    remove.addEventListener('click', () => {
      selectedPhotos.splice(index, 1);
      syncPhotoInput();
      renderPhotoList();
    });

    item.append(preview, remove, name);
    list.appendChild(item);
  });

  count.textContent = selectedPhotos.length === 0
    ? 'Aucune photo sélectionnée.'
    : `${selectedPhotos.length} photo${selectedPhotos.length > 1 ? 's' : ''} sur 5 sélectionnée${selectedPhotos.length > 1 ? 's' : ''}.`;
}

function handlePhotoSelection(event) {
  const input = event.currentTarget;
  const incoming = [...input.files];
  input.value = '';

  if (!incoming.length) return;

  const combined = [...selectedPhotos];
  for (const file of incoming) {
    const duplicate = combined.some(existing =>
      existing.name === file.name &&
      existing.size === file.size &&
      existing.lastModified === file.lastModified
    );
    if (!duplicate) combined.push(file);
  }

  if (combined.length > 5) {
    syncPhotoInput();
    alert('Vous pouvez sélectionner 5 photos maximum au total. Les photos déjà sélectionnées ont été conservées.');
    return;
  }

  try {
    validatePhotoFiles(combined);
  } catch (err) {
    syncPhotoInput();
    alert(err.message);
    return;
  }

  selectedPhotos = combined;
  syncPhotoInput();
  renderPhotoList();
}

async function submitBooking(e) {
  e.preventDefault();
  if (!validateStep(3)) return;
  const btn = e.submitter || $('#bookingForm button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }

  try {
    const formData = new FormData();
    const payload = {
      service: selectedService(),
      date: $('#date').value,
      time: $('#time').value,
      firstName: $('#firstName').value.trim(),
      lastName: $('#lastName').value.trim(),
      phone: $('#phone').value.trim(),
      email: $('#email').value.trim(),
      address: [$('#streetAddress').value.trim(), $('#postcode').value.trim(), $('#city').value.trim()].join(', '),
      legalAccepted: $('#legalAccepted').checked ? 'true' : 'false',
      earlyExecutionRequested: $('#earlyExecutionRequested')?.checked ? 'true' : 'false',
      note: $('#note').value.trim()
    };
    Object.entries(payload).forEach(([key, value]) => formData.append(key, value));
    validatePhotoFiles($('#photos').files);
    [...$('#photos').files].forEach(file => formData.append('photos', file));

    const r = await fetch('/api/bookings', { method: 'POST', body: formData });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur lors de la réservation.');
    if (data.booking && data.booking.paymentUrl) { window.location.assign(data.booking.paymentUrl); return; }
    $('#bookingForm').innerHTML = '<div class="booking-success" role="status" aria-live="polite"><div class="success-mark">✓</div><small>DEMANDE ENVOYÉE</small><h3>Votre demande est enregistrée.</h3><p>Le paiement en ligne n’est pas disponible pour le moment. Nous devons vérifier votre demande manuellement avant de confirmer le rendez-vous.</p><p>Si vous ne recevez pas notre e-mail, vérifiez vos courriers indésirables (spam).</p><a class="btn btn-primary" href="#prestations">Voir les prestations</a></div>';
  } catch (err) {
    alert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmer et payer →'; }
  }
}


function updateResourceNote() {
  const water = $('#water')?.value;
  const electricity = $('#electricity')?.value;
  const note = $('#resourceNote');
  if (!note) return;
  note.hidden = !(water === 'Non' || electricity === 'Non');
}

function init() {
  const date = $('#date');
  if (date) {
    date.min = todayISO();
    date.value = todayISO();
    updateEarlyExecutionConsent();
  }

  $$('.service-cta').forEach(b => b.onclick = () => {
    const s = b.dataset.service;
    $('#service').value = `${s} — ${serviceData[s].amount}€`;
    document.querySelector('#reservation').scrollIntoView({ behavior: 'smooth' });
    current = 1;
    goStep(2);
  });

  $('#service')?.addEventListener('change', loadSlots);
  $('#date')?.addEventListener('change', () => { loadSlots(); updateEarlyExecutionConsent(); });
  $('#photos')?.addEventListener('change', handlePhotoSelection);
  renderPhotoList();
  $$('.next-btn').forEach(b => b.addEventListener('click', () => goStep(current + 1)));
  $$('.back-btn').forEach(b => b.addEventListener('click', () => goStep(current - 1)));
  $('#bookingForm')?.addEventListener('submit', submitBooking);
}

init();
