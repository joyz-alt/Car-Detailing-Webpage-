const SK = "noirea_bookings_v1", BK = "noirea_blocks_v1";
const $ = s => document.querySelector(s);
const read = k => JSON.parse(localStorage.getItem(k) || "[]");
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));


function render() {
    const bs = read(BK), rs = read(SK);
    $("#blocks").innerHTML = bs.length ? bs.map((b, i) =>
        `<li><span>${b.date} · ${b.time}</span><button class="danger" onclick="removeBlock(${i})">Supprimer</button></li>`).join("") : `
        <li class="empty">Aucun créneau bloqué.</li>`;

    $("#bookings").innerHTML = rs.length ? rs.sort((a, b) =>
        (a.date + a.time).localeCompare(b.date + b.time)).map((r, i) =>
            `<li><div><strong>${r.date} · ${r.time}</strong><br>${r.firstName} ${r.lastName} · ${r.service} · ${r.vehicle}
            <br><span class="empty">${r.phone} · ${r.email}${r.note ? " · " + r.note : ""}</span></div>
            <button class="danger" onclick="removeBooking(${i})">Annuler</button></li>`).join("") : `<li class="empty">Aucune réservation.</li>`;
}

function removeBlock(i) {
    const a = read(BK);
    a.splice(i, 1);
    write(BK, a);
    render()
}

function removeBooking(i) {
    const a = read(SK);
    a.splice(i, 1);
    write(SK, a);
    render()
}

$("#blockDate").min = new Date().toISOString().slice(0, 10);

$("#blockBtn").onclick = () => {
    const date = $("#blockDate").value, time = $("#blockTime").value;
    if (!date)
        return alert("Choisissez une date.");
    const a = read(BK);

    if (!a.some(x => x.date === date && x.time === time)) {
        a.push({ date, time });
        write(BK, a)
    }
    render()
};

$("#clearBtn").onclick = () => {
    if (confirm("Effacer toutes les données de démonstration ?")) {
        localStorage.removeItem(SK);
        localStorage.removeItem(BK); render()
    }
};

render();