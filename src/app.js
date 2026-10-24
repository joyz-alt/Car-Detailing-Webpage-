const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let current = 1;
let slots = [];

const serviceData = {
  Essentiel: { amount: 59, duration: '1h30 à 2h' },
  Intégral: { amount: 99, duration: '2h30 à 3h30' }
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
    if (!$('#vehicle').value) return alert('Choisissez votre véhicule.'), false;
    return true;
  }
  if (step === 2 && !$('#time').value) return alert('Choisissez un créneau.'), false;
  if (step === 3) {
    const ids = ['firstName', 'lastName', 'phone', 'email', 'address', 'water', 'electricity', 'condition'];
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

function renderSummary() {
  const s = selectedService();
  const v = $('#vehicle').value;
  const d = $('#date').value;
  const t = $('#time').value;
  const c = $('#condition').value;
  const water = $('#water').value;
  const electricity = $('#electricity').value;
  const photos = $('#photos').files.length;
  const amount = serviceData[s]?.amount ?? 0;
  const duration = serviceData[s]?.duration ?? '';

  $('#summary').innerHTML = `<strong>${s}</strong> · ${v}<br>${new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${t}<br><strong>${amount} €</strong> · durée estimée ${duration}<br>État : ${c}<br>💧 Eau : ${water} · ⚡ Électricité : ${electricity}${photos ? `<br>${photos} photo(s) ajoutée(s)` : ''}`;
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

async function submitBooking(e) {
  e.preventDefault();
  if (!validateStep(3)) return;
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Envoi…';

  try {
    const photoFiles = $('#photos').files;
    validatePhotoFiles(photoFiles);

    const formData = new FormData();
    const payload = {
      service: selectedService(),
      vehicle: $('#vehicle').value,
      date: $('#date').value,
      time: $('#time').value,
      firstName: $('#firstName').value.trim(),
      lastName: $('#lastName').value.trim(),
      phone: $('#phone').value.trim(),
      email: $('#email').value.trim(),
      address: $('#address').value.trim(),
      water: $('#water').value,
      electricity: $('#electricity').value,
      condition: $('#condition').value,
      note: $('#note').value.trim()
    };
    Object.entries(payload).forEach(([key, value]) => formData.append(key, value));
    [...photoFiles].forEach(file => formData.append('photos', file));

    const r = await fetch('/api/bookings', {
      method: 'POST',
      body: formData
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur lors de l’envoi.');

    $('#bookingForm').innerHTML = `<div class="booking-success"><div class="success-mark">✓</div><small>DEMANDE ENVOYÉE</small><h3>Votre demande est bien reçue.</h3><p>Nous vérifions le créneau et les informations transmises. Si tout est bon, vous recevrez ensuite un e-mail avec le lien de paiement pour confirmer définitivement votre rendez-vous.</p><p class="success-note">Aucun paiement n'est demandé à cette étape.</p><a class="btn btn-primary" href="#prestations">Voir les prestations</a></div>`;
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Envoyer ma demande →';
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
  }

  $$('.service-cta').forEach(b => b.onclick = () => {
    const s = b.dataset.service;
    $('#service').value = `${s} — ${serviceData[s].amount}€`;
    document.querySelector('#reservation').scrollIntoView({ behavior: 'smooth' });
    setTimeout(loadSlots, 100);
  });

  $('#service')?.addEventListener('change', loadSlots);
  $('#date')?.addEventListener('change', loadSlots);
  $$('.next-btn').forEach(b => b.addEventListener('click', () => goStep(current + 1)));
  $$('.back-btn').forEach(b => b.addEventListener('click', () => goStep(current - 1)));
  $('#bookingForm')?.addEventListener('submit', submitBooking);
  $('#condition')?.addEventListener('change', renderSummary);
  $('#water')?.addEventListener('change', updateResourceNote);
  $('#electricity')?.addEventListener('change', updateResourceNote);
  $('#photos')?.addEventListener('change', () => {
    const n = $('#photos').files.length;
    $('#photoHint').textContent = n ? `${n} photo(s) sélectionnée(s) · facultatif` : 'Ajoutez quelques photos si vous souhaitez nous aider à évaluer l’état du véhicule.';
  });
}

init();
