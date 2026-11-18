const widgets = ["Kontrol cepat", "Monitor sistem", "Kalender", "Pomodoro", "Lirik", "Cuaca"];
const concepts = [
  { id: "rail", name: "Rail", initial: 0, description: "Satu widget, pemilih vertikal. Isi menempel langsung pada notch.", note: "Untuk pergantian cepat: dua tombol menetap di kiri, tanpa kartu belakang atau animasi tumpukan." },
  { id: "panorama", name: "Panorama", initial: 2, description: "Bidang mendatar dengan navigasi di bawah. Lebih luas untuk membaca.", note: "Untuk isi yang perlu ruang horizontal: kalender, metrik, dan kontrol disusun mengikuti bentuknya sendiri." },
  { id: "glance", name: "Glance", initial: 3, description: "Kalender, timer, dan cuaca terlihat bersamaan. Buka satu untuk detail.", note: "Untuk melihat sekilas: tiga ringkasan menggantikan carousel. Tombol kembali mengembalikan seluruh ringkasan." },
];
const models = new Map();
const root = document.querySelector("#concepts");
for (const concept of concepts) {
  const requested = new URLSearchParams(location.search).get("design");
  if (requested && requested !== concept.id) continue;
  const section = document.createElement("section");
  section.className = "concept"; section.id = concept.id;
  section.innerHTML = `<div class="concept-heading"><h2>${concept.name}</h2><p>${concept.description}</p></div>
    <div class="stage"><div class="notch"><div class="notch-header"><b>Nook</b><span>Preview ${concept.name}</span></div><div class="notch-content">
    <aside class="media-reference" aria-label="Referensi Media pada ${concept.name}"><div class="cover" aria-hidden="true">♫</div><div class="media-copy"><strong>Tidak ada media</strong><p>Putar musik untuk memulai</p><div class="reference-track"></div><div class="reference-transport" aria-hidden="true"><span>Ⅰ◀</span><span>▶</span><span>▶Ⅰ</span></div></div></aside>
    <div class="widget-region" role="group" aria-label="Widget ${concept.name}"></div></div></div></div>
    <div class="test-controls"><div class="field"><label for="widget-${concept.id}">Coba widget</label><select id="widget-${concept.id}">${widgets.map((name, i) => `<option value="${i}">${name}</option>`).join("")}</select></div>
    <div class="field"><label for="state-${concept.id}">Keadaan data</label><select id="state-${concept.id}"><option value="ready">Simulasi terisi</option><option value="empty">Kosong</option><option value="loading">Memuat</option><option value="error">Gagal</option></select></div></div>
    <p class="concept-note">${concept.note}</p><div class="selection"><button type="button" class="choose" aria-pressed="false">Tandai ${concept.name}</button><output aria-live="polite"></output></div>`;
  root.append(section);
  const model = { ...concept, section, active: concept.initial, state: "ready", overview: concept.id === "glance", volume: 60, brightness: 75, dnd: false, mute: false, running: false, seconds: 1500, selectedDay: 15 };
  models.set(concept.id, model);
  section.querySelector(`#widget-${concept.id}`).value = String(model.active);
  section.querySelector(`#widget-${concept.id}`).addEventListener("change", event => { model.active = Number(event.target.value); model.overview = false; render(model); });
  section.querySelector(`#state-${concept.id}`).addEventListener("change", event => { model.state = event.target.value; render(model); });
  section.querySelector(".choose").addEventListener("click", () => {
    for (const m of models.values()) { m.section.querySelector(".choose").setAttribute("aria-pressed", String(m === model)); m.section.querySelector(".selection output").textContent = m === model ? `${m.name} ditandai. Sebutkan pilihan ini di chat.` : ""; }
  });
  render(model);
}
if (new URLSearchParams(location.search).has("design")) {
  document.querySelectorAll(".jump-nav a").forEach(link => { link.href = `index.html?design=${link.hash.slice(1)}`; });
}
function clock(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2,"0")}:${(seconds % 60).toString().padStart(2,"0")}`; }
function body(m) {
  if (m.state !== "ready") {
    const name = widgets[m.active].toLowerCase();
    const text = {empty:["Belum ada data", `${name} belum tersedia.`],loading:["Memuat widget", `Menunggu data ${name}.`],error:["Widget gagal dimuat", `Data ${name} gagal dibaca.`]}[m.state];
    return `<div class="state-message" role="status"><strong>${text[0]}</strong><p>${text[1]}</p>${m.state === "error" ? '<button type="button" data-action="retry">Coba lagi</button>' : ""}</div>`;
  }
  switch (m.active) {
    case 0:return `<div class="settings-body"><h3 class="widget-title">Kontrol cepat</h3><div><label class="range-label" for="volume-${m.id}">Volume <output>${m.volume}%</output></label><input id="volume-${m.id}" type="range" min="0" max="100" value="${m.volume}" data-range="volume"></div><div><label class="range-label" for="brightness-${m.id}">Kecerahan <output>${m.brightness}%</output></label><input id="brightness-${m.id}" type="range" min="0" max="100" value="${m.brightness}" data-range="brightness"></div><div class="toggles"><button type="button" data-action="mute" aria-pressed="${m.mute}">${m.mute ? "Bisu aktif" : "Bisu"}</button><button type="button" data-action="dnd" aria-pressed="${m.dnd}">${m.dnd ? "DND aktif" : "DND"}</button></div></div>`;
    case 1:return `<div><h3 class="widget-title">Monitor sistem <span>(simulasi)</span></h3><div class="metric-list">${[["CPU",18],["RAM",42],["Disk",64]].map(([name,value])=>`<div class="metric"><span>${name}</span><div class="meter" aria-hidden="true"><i style="width:${value}%"></i></div><b>${value}%</b></div>`).join("")}</div></div>`;
    case 2:return `<div class="calendar"><div class="date-heading"><strong>${m.selectedDay}</strong><span>Nov 2026</span></div><div class="week" aria-label="Pilih tanggal simulasi">${["Jum","Sab","Min"].map((day,i)=>`<button type="button" data-day="${i+13}" aria-label="${day}, ${i+13} November" aria-pressed="${m.selectedDay===i+13}"><span>${day}</span>${i+13}</button>`).join("")}</div><p class="calendar-note">Agenda belum terhubung</p></div>`;
    case 3:return `<div class="timer"><h3 class="widget-title">Pomodoro</h3><div class="timer-digits">${clock(m.seconds)}</div><div class="timer-controls"><button type="button" class="start" data-action="timer">${m.running ? "Jeda" : "Mulai"}</button><button type="button" data-action="reset" aria-label="Reset Pomodoro">↺</button></div><p class="timer-mode">Fokus, durasi 25 menit</p></div>`;
    case 4:return `<div class="lyric"><h3 class="widget-title">Lirik, teks contoh</h3><p class="subtle">Baris sebelumnya</p><p class="current">Baris yang sedang diputar</p><p class="subtle">Baris berikutnya</p></div>`;
    case 5:return `<div class="weather"><h3 class="widget-title">Cuaca simulasi</h3><div class="weather-main"><strong>27°</strong><span>Berawan</span></div><div class="weather-hours">${[["Kini","27°"],["16.00","26°"],["17.00","25°"]].map(([time,temp])=>`<span><small>${time}</small>${temp}</span>`).join("")}</div></div>`;
  }
}
function render(m) {
  const region = m.section.querySelector(".widget-region");
  const content = `<div class="widget-content">${body(m)}</div>`;
  if (m.id === "rail") region.innerHTML = `<div class="rail-layout"><nav class="rail-nav" aria-label="Ganti widget Rail"><button type="button" data-step="-1" aria-label="Widget sebelumnya">⌃</button><span class="position">${m.active+1} / 6</span><button type="button" data-step="1" aria-label="Widget berikutnya">⌄</button></nav>${content}</div>`;
  if (m.id === "panorama") region.innerHTML = `<div class="panorama-layout">${content}<nav class="panorama-nav" aria-label="Ganti widget Panorama"><button type="button" data-step="-1" aria-label="Widget sebelumnya">‹</button><span>${widgets[m.active]}</span><button type="button" data-step="1" aria-label="Widget berikutnya">›</button></nav></div>`;
  if (m.id === "glance") region.innerHTML = m.overview && m.state === "ready" ? `<div class="glance-list">${[[2,"Kalender","15 Nov"],[3,"Fokus",clock(m.seconds)],[5,"Cuaca","27°"]].map(([i,label,value])=>`<button type="button" class="glance-row" data-open="${i}"><span class="row-label">${label}</span><span class="row-value"><strong>${value}</strong><span class="tiny-arrow" aria-hidden="true">›</span></span></button>`).join("")}</div>` : `<div class="glance-detail"><button type="button" class="back" data-action="back" aria-label="Kembali ke ringkasan">‹</button>${content}</div>`;
  m.section.querySelector(`#widget-${m.id}`).value = String(m.active);
  region.querySelectorAll("[data-step]").forEach(button => button.addEventListener("click", () => {m.active=(m.active+Number(button.dataset.step)+6)%6;render(m);region.querySelector(`[data-step="${button.dataset.step}"]`).focus();}));
  region.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click",()=>{m.active=Number(button.dataset.open);m.overview=false;render(m);region.querySelector(".back").focus();}));
  region.querySelectorAll("[data-day]").forEach(button=>button.addEventListener("click",()=>{m.selectedDay=Number(button.dataset.day);render(m);region.querySelector(`[data-day="${m.selectedDay}"]`).focus();}));
  region.querySelectorAll("[data-range]").forEach(input=>input.addEventListener("input",()=>{m[input.dataset.range]=Number(input.value);input.previousElementSibling.querySelector("output").textContent=`${input.value}%`;}));
  region.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",()=>{
    const action=button.dataset.action;
    if(action==="back"){m.overview=true;m.state="ready";m.section.querySelector(`#state-${m.id}`).value="ready";}
    if(action==="retry"){m.state="ready";m.section.querySelector(`#state-${m.id}`).value="ready";}
    if(action==="timer")m.running=!m.running;
    if(action==="reset"){m.running=false;m.seconds=1500;}
    if(action==="dnd")m.dnd=!m.dnd;
    if(action==="mute")m.mute=!m.mute;
    render(m);(region.querySelector(`[data-action="${action}"]`)||region.querySelector("button"))?.focus();
  }));
  region.onkeydown=event=>{if(event.key==="Escape"&&m.id==="glance"&&!m.overview){m.overview=true;m.state="ready";m.section.querySelector(`#state-${m.id}`).value="ready";render(m);region.querySelector("button")?.focus();}};
}
setInterval(()=>{for(const m of models.values()){if(m.running&&m.seconds>0){m.seconds--;if(m.seconds===0)m.running=false;const digits=m.section.querySelector(".timer-digits");if(digits)digits.textContent=clock(m.seconds);const overviewTimer=m.section.querySelector('[data-open="3"] strong');if(overviewTimer)overviewTimer.textContent=clock(m.seconds);}}},1000);
