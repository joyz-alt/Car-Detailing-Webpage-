const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let current = 1;
let slots = [];

const serviceData = {
  Essentielle: { amount: 79, duration: '2h30 (marge comprise)' },
  Premium: { amount: 129, duration: '4h30 (marge comprise)' }
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

let availabilityWeekOffset = 0;

async function loadSlots(preserveScroll = false) {
  const scrollTop = preserveScroll ? window.scrollY : null;
  const restoreScroll = () => {
    if (scrollTop === null) return;
    requestAnimationFrame(() => window.scrollTo({ top: scrollTop, left: 0, behavior: 'instant' }));
  };
  const box = $('#slots');
  const prev = $('#weekPrev');
  const next = $('#weekNext');
  const label = $('#weekLabel');
  box.innerHTML = '<span class="empty-slot">Recherche des disponibilités…</span>';
  restoreScroll();
  $('#date').value = '';
  $('#time').value = '';

  try {
    const r = await fetch(`/api/next-availability?service=${encodeURIComponent(selectedService())}&week=${availabilityWeekOffset}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur');

    label.textContent = data.weekLabel || '';
    prev.disabled = availabilityWeekOffset === 0;
    next.disabled = !data.hasNextWeek;
    box.innerHTML = '';

    const days = data.days || [];
    if (!days.some(day => day.slots.length)) {
      box.innerHTML = '<span class="empty-slot">Aucun créneau disponible cette semaine. Passez à la semaine suivante pour consulter les prochaines disponibilités.</span>';
      restoreScroll();
      return;
    }

    days.forEach(day => {
      const card = document.createElement('section');
      card.className = 'availability-day' + (day.slots.length ? '' : ' is-full');
      const dateLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('fr-FR', {
        weekday: 'short', day: 'numeric', month: 'short'
      });
      const heading = document.createElement('h4');
      heading.textContent = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
      card.appendChild(heading);

      if (!day.slots.length) {
        const full = document.createElement('span');
        full.className = 'availability-full';
        full.textContent = 'Complet';
        card.appendChild(full);
      } else {
        const times = document.createElement('div');
        times.className = 'availability-times';
        day.slots.forEach(slot => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'availability-time-button';
          button.textContent = slot.time;
          button.setAttribute('aria-label', `${dateLabel} à ${slot.time}`);
          button.onclick = () => {
            $$('.availability-time-button').forEach(item => {
              item.classList.remove('selected');
              item.setAttribute('aria-pressed', 'false');
            });
            button.classList.add('selected');
            button.setAttribute('aria-pressed', 'true');
            $('#date').value = slot.date;
            $('#time').value = slot.time;
            updateEarlyExecutionConsent();
          };
          button.setAttribute('aria-pressed', 'false');
          times.appendChild(button);
        });
        card.appendChild(times);
      }
      box.appendChild(card);
    });
    restoreScroll();
  } catch (err) {
    box.innerHTML = '<span class="empty-slot">Impossible de charger les disponibilités. Veuillez réessayer.</span>';
    restoreScroll();
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

  $('#summary').textContent = `${s} · ${new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${t} · prix de base ${amount} € · durée estimée ${duration} · paiement après la prestation`;
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
    $('#bookingForm').innerHTML = '<div class="booking-success" role="status" aria-live="polite"><div class="success-mark">✓</div><small>DEMANDE ENVOYÉE</small><h3>Votre demande est enregistrée.</h3><p>Nous vous contacterons pour confirmer les détails de votre rendez-vous. Aucun paiement n’est demandé sur le site : vous réglerez après le nettoyage, une fois le montant final convenu.</p><p>Si vous ne recevez pas notre e-mail, vérifiez vos courriers indésirables (spam).</p><a class="btn btn-primary" href="#prestations">Voir les prestations</a></div>';
  } catch (err) {
    alert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Envoyer ma demande →'; }
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

  $('#service')?.addEventListener('change', () => { availabilityWeekOffset = 0; loadSlots(); });
  $('#weekPrev')?.addEventListener('click', () => { if (availabilityWeekOffset > 0) { availabilityWeekOffset--; loadSlots(true); } });
  $('#weekNext')?.addEventListener('click', () => { availabilityWeekOffset++; loadSlots(true); });
    $('#photos')?.addEventListener('change', handlePhotoSelection);
  renderPhotoList();
  $$('.next-btn').forEach(b => b.addEventListener('click', () => goStep(current + 1)));
  $$('.back-btn').forEach(b => b.addEventListener('click', () => goStep(current - 1)));
  $('#bookingForm')?.addEventListener('submit', submitBooking);
}

init();


// Swipe, mouse-drag and arrow controls for the before/after portfolio.
(() => {
  const track = document.getElementById('portfolioTrack');
  if (!track) return;
  const cards = [...track.querySelectorAll('.portfolio-pair')];
  const dots = [...document.querySelectorAll('.portfolio-dot')];
  const prev = document.getElementById('portfolioPrev');
  const next = document.getElementById('portfolioNext');
  let activeIndex = 0;
  let pointerStart = null;
  let scrollStart = 0;
  let dragged = false;

  const cardStep = () => cards[0] ? cards[0].getBoundingClientRect().width + 16 : 0;
  const goTo = index => {
    activeIndex = Math.max(0, Math.min(cards.length - 1, index));
    track.scrollTo({ left: activeIndex * cardStep(), behavior: 'smooth' });
    updateDots();
  };
  const updateDots = () => {
    const step = cardStep() || 1;
    const index = Math.max(0, Math.min(cards.length - 1, Math.round(track.scrollLeft / step)));
    activeIndex = index;
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === index);
      if (i === index) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === cards.length - 1;
  };
  prev?.addEventListener('click', () => goTo(activeIndex - 1));
  next?.addEventListener('click', () => goTo(activeIndex + 1));
  dots.forEach((dot, i) => dot.addEventListener('click', () => goTo(i)));
  track.addEventListener('scroll', updateDots, { passive: true });
  track.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') goTo(activeIndex + 1);
    if (event.key === 'ArrowLeft') goTo(activeIndex - 1);
  });
  track.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    pointerStart = event.clientX;
    scrollStart = track.scrollLeft;
    dragged = false;
    track.classList.add('is-dragging');
    track.setPointerCapture(event.pointerId);
  });
  track.addEventListener('pointermove', event => {
    if (pointerStart === null) return;
    const delta = event.clientX - pointerStart;
    if (Math.abs(delta) > 4) dragged = true;
    if (dragged) track.scrollLeft = scrollStart - delta;
  });
  const stopDrag = () => {
    if (pointerStart === null) return;
    pointerStart = null;
    track.classList.remove('is-dragging');
    if (dragged) {
      const index = Math.round(track.scrollLeft / (cardStep() || 1));
      goTo(index);
    }
  };
  track.addEventListener('pointerup', stopDrag);
  track.addEventListener('pointercancel', stopDrag);
  track.addEventListener('lostpointercapture', stopDrag);
  updateDots();
  window.addEventListener('resize', updateDots);
})();
