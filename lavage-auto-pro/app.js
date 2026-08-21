const STORAGE_KEY = "noirea_bookings_v1", BLOCK_KEY = "noirea_blocks_v1";
const slotsByService = { Essentiel: ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"], Intégral: ["09:00", "12:00", "14:30"], Signature: ["08:30", "13:00"] };
const priceByService = { Essentiel: 49, Intégral: 89, Signature: 149 };
const durationByService = { Essentiel: "1h30", Intégral: "2h30", Signature: "4h" };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function read(k) {
  try {
    return JSON.parse(localStorage.getItem(k) || "[]")
  }
  catch {
    return []
  }
}

function write(k, v) {
  localStorage.setItem(k, JSON.stringify(v))
}

function normalizeService(v) {
  return v.split(" — ")[0]
}

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}


function init() {
  const date = $("#date");

  if (date) {
    date.min = todayISO();
    date.value = todayISO();
    renderSlots()
  }

  $$(".service-cta").forEach(b => b.addEventListener("click", () => {
    const s = b.dataset.service;
    $("#service").value = s + " — " + priceByService[s] + "€";
    document.querySelector("#reservation").scrollIntoView({ behavior: "smooth" }); renderSlots()
  }));

  $("#service")?.addEventListener("change", renderSlots);
  $("#date")?.addEventListener("change", renderSlots);
  $$(".next-btn").forEach(b => b.addEventListener("click", () => goStep(currentStep() + 1)));
  $$(".back-btn").forEach(b => b.addEventListener("click", () => goStep(currentStep() - 1)));
  $("#bookingForm")?.addEventListener("submit", submitBooking);
}

function currentStep() {
  return Number($(".form-step.active")?.dataset.step || 1)
}

function goStep(n) {
  if (n < 1 || n > 3) return;
  const current = currentStep();
  if (n > current && !validateStep(current)) return;

  $$(".form-step").forEach(x => x.classList.toggle("active", Number(x.dataset.step) === n));
  $$(".progress span").forEach((x, i) => x.classList.toggle("active", i < n));

  if (n === 3) renderSummary();
}

function validateStep(step) {
  if (step === 1 && !$("#service").value) {
    alert("Choisissez une prestation.");
    return false
  }

  if (step === 1 && !$("#vehicle").value) {
    alert("Choisissez votre véhicule.");
    return false
  }

  if (step === 2 && !$("#time").value) {
    alert("Choisissez un créneau.");
    return false
  }

  return true
}
function renderSlots() {
  const box = $("#slots"), service = normalizeService($("#service")?.value || "Essentiel"), date = $("#date")?.value;

  if (!box || !date) return;
  const bookings = read(STORAGE_KEY), blocks = read(BLOCK_KEY);
  const unavailable = [...bookings.filter(b => b.date === date).map(b => b.time), ...blocks.filter(b => b.date === date).map(b => b.time)];
  box.innerHTML = "";

  (slotsByService[service] || slotsByService.Essentiel).forEach(time => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot" + (unavailable.includes(time) ? " disabled" : "");
    btn.textContent = time;

    if (!unavailable.includes(time)) btn.onclick = () => {
      $$(".slot").forEach(x => x.classList.remove("selected"));
      btn.classList.add("selected"); $("#time").value = time
    };

    box.appendChild(btn);
  });

  $("#time").value = "";
}

function renderSummary() {
  const service = normalizeService($("#service").value), date = $("#date").value, time = $("#time").value, vehicle = $("#vehicle").value;
  $("#summary").innerHTML = `<strong>${service}</strong> · ${vehicle}<br>${new Date(date + "T12:00:00").toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long"
  })} à ${time}<br><strong>${priceByService[service]} €</strong> · durée estimée ${durationByService[service]}`;
}

function submitBooking(e) {
  e.preventDefault();
  const service = normalizeService($("#service").value), date = $("#date").value, time = $("#time").value;
  const bookings = read(STORAGE_KEY), blocks = read(BLOCK_KEY);
  if (bookings.some(b => b.date === date && b.time === time) || blocks.some(b => b.date === date && b.time === time)) {
    alert("Ce créneau vient d'être pris. Choisissez-en un autre.");
    goStep(2);
    renderSlots();
    return
  }

  const booking = {
    id: "N" + Date.now(), createdAt: new Date().toISOString(),
    service, vehicle: $("#vehicle").value, date, time, firstName: $("#firstName").value, lastName: $("#lastName").value,
    phone: $("#phone").value, email: $("#email").value, note: $("#note").value, status: "pending_payment", amount: priceByService[service]
  };

  bookings.push(booking); write(STORAGE_KEY, bookings);
  alert("Réservation enregistrée en mode démo. En production, cette étape ouvrira Stripe Checkout puis confirmera automatiquement le rendez-vous après paiement.");
  window.location.href = "admin.html";
}

init();