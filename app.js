/* ---------- Storage helpers (all data stays in this browser, on this device) ---------- */
const STORE_KEYS = { logs: "mf_logs", weights: "mf_weights", schedule: "mf_schedule" };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function defaultSchedule() {
  // weekday: 0=Sun ... 6=Sat, matching Date.getDay()
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    enabled: true,
    startMin: 12 * 60,   // 12:00pm
    endMin: 20 * 60       // 8:00pm
  }));
}

let logs = load(STORE_KEYS.logs, []);
let weights = load(STORE_KEYS.weights, []);
let schedule = load(STORE_KEYS.schedule, defaultSchedule());
if (schedule.length !== 7) { schedule = defaultSchedule(); save(STORE_KEYS.schedule, schedule); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------- Fasting state logic ---------- */
function minutesToDate(baseDate, minutes) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function scheduleFor(date) {
  return schedule.find(s => s.weekday === date.getDay());
}

function currentFastingState(now) {
  const today = scheduleFor(now);
  if (!today || !today.enabled) return null;

  const eatingStart = minutesToDate(now, today.startMin);
  const eatingEnd = minutesToDate(now, today.endMin);

  if (now >= eatingStart && now < eatingEnd) {
    return {
      phase: "eating",
      phaseStart: eatingStart,
      windowEndsAt: eatingEnd,
      nextEatingStart: eatingStart
    };
  } else if (now < eatingStart) {
    // fasting, window opens later today; phase "started" at yesterday's eating end if available
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const ySched = scheduleFor(yesterday);
    const phaseStart = ySched ? minutesToDate(yesterday, ySched.endMin) : minutesToDate(now, 0);
    return {
      phase: "fasting",
      phaseStart,
      windowEndsAt: eatingStart,
      nextEatingStart: eatingStart
    };
  } else {
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const tSched = scheduleFor(tomorrow);
    if (!tSched || !tSched.enabled) return null;
    const nextEatingStart = minutesToDate(tomorrow, tSched.startMin);
    return {
      phase: "fasting",
      phaseStart: eatingEnd,
      windowEndsAt: nextEatingStart,
      nextEatingStart
    };
  }
}

/* ---------- Streak ---------- */
function weeklyStreak(now) {
  const day = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - day); weekStart.setHours(0,0,0,0);

  let hit = 0, total = 0;
  for (let d = new Date(weekStart); d <= now; d.setDate(d.getDate() + 1)) {
    const daySchedule = scheduleFor(d);
    if (!daySchedule || !daySchedule.enabled) continue;
    total++;

    const dayLogs = logs.filter(l => {
      const t = new Date(l.timestamp);
      return t.toDateString() === d.toDateString() && (l.type === "Meal" || l.type === "Drink");
    });
    if (dayLogs.length === 0) { total--; continue; }

    const eatingStart = minutesToDate(d, daySchedule.startMin);
    const eatingEnd = minutesToDate(d, daySchedule.endMin);
    const allWithin = dayLogs.every(l => {
      const t = new Date(l.timestamp);
      return t >= eatingStart && t <= eatingEnd;
    });
    if (allWithin) hit++;
  }
  return { hit, total };
}

/* ---------- Timer tab rendering ---------- */
const RING_CIRC = 2 * Math.PI * 88;
document.getElementById("ringProgress").style.strokeDasharray = RING_CIRC;

let lastPhase = null;

function renderTimer() {
  const now = new Date();
  const state = currentFastingState(now);
  const ring = document.getElementById("ringProgress");
  const label = document.getElementById("phaseLabel");
  const countdown = document.getElementById("countdownText");
  const sub = document.getElementById("phaseSub");
  const nextMealRow = document.getElementById("nextMealRow");
  const noSchedule = document.getElementById("noScheduleNote");

  if (!state) {
    noSchedule.hidden = false;
    label.textContent = "";
    countdown.textContent = "--:--:--";
    sub.textContent = "";
    nextMealRow.textContent = "";
    ring.style.strokeDashoffset = RING_CIRC;
    return;
  }
  noSchedule.hidden = true;

  const isFasting = state.phase === "fasting";
  label.textContent = isFasting ? "Fasting" : "Eating Window";
  label.style.color = isFasting ? "var(--chili)" : "var(--leaf)";
  ring.style.stroke = isFasting ? "var(--chili)" : "var(--leaf)";
  sub.textContent = isFasting ? "until eating window opens" : "until fasting begins";

  const remaining = Math.max(0, state.windowEndsAt - now);
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  countdown.textContent = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;

  const totalPhase = state.windowEndsAt - state.phaseStart;
  const elapsed = now - state.phaseStart;
  const frac = totalPhase > 0 ? Math.min(1, Math.max(0, elapsed / totalPhase)) : 0;
  ring.style.strokeDashoffset = RING_CIRC * (1 - frac);

  if (isFasting) {
    nextMealRow.textContent = `Next meal at ${state.nextEatingStart.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}`;
  } else {
    nextMealRow.textContent = "";
  }

  // notification on phase transition
  if (lastPhase !== null && lastPhase !== state.phase) {
    notifyPhaseChange(state.phase);
  }
  lastPhase = state.phase;

  const streak = weeklyStreak(now);
  document.getElementById("streakBadge").textContent = `${streak.hit}/${streak.total} this week`;
}

function notifyPhaseChange(phase) {
  const title = phase === "eating" ? "Eating window open" : "Fasting started";
  const body = phase === "eating" ? "Your fasting window is complete." : "Eating window closed — fast begins.";
  showToast(title);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch (e) {}
  }
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, 3000);
}

setInterval(renderTimer, 1000);
renderTimer();

if ("Notification" in window && Notification.permission === "default") {
  document.addEventListener("click", function requestOnce() {
    Notification.requestPermission();
    document.removeEventListener("click", requestOnce);
  }, { once: true });
}

/* ---------- Tab navigation ---------- */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "trends") { drawWeightChart(); drawFastChart(); }
    if (btn.dataset.tab === "schedule") { renderSchedule(); }
    if (btn.dataset.tab === "log") { renderRecent(); }
  });
});

/* ---------- Log tab ---------- */
let selectedType = "Meal";
let selectedTime = new Date();

document.getElementById("typeRow").addEventListener("click", (e) => {
  const b = e.target.closest(".type-btn");
  if (!b) return;
  document.querySelectorAll(".type-btn").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  selectedType = b.dataset.type;
});

document.getElementById("quickRow").addEventListener("click", (e) => {
  const b = e.target.closest(".quick-btn");
  if (!b) return;
  const mins = parseInt(b.dataset.min, 10);
  selectedTime = new Date(Date.now() - mins * 60000);
  document.getElementById("exactTimeToggle").checked = false;
  document.getElementById("exactTimeInput").hidden = true;
  updateSelectedTimeDisplay();
});

document.getElementById("exactTimeToggle").addEventListener("change", (e) => {
  const input = document.getElementById("exactTimeInput");
  input.hidden = !e.target.checked;
  if (e.target.checked) {
    input.value = toLocalInputValue(selectedTime);
  } else {
    updateSelectedTimeDisplay();
  }
});

document.getElementById("exactTimeInput").addEventListener("change", (e) => {
  selectedTime = new Date(e.target.value);
  updateSelectedTimeDisplay();
});

function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateSelectedTimeDisplay() {
  document.getElementById("selectedTimeDisplay").textContent =
    "Logging at " + selectedTime.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
}
updateSelectedTimeDisplay();

document.getElementById("saveLogBtn").addEventListener("click", () => {
  const note = document.getElementById("noteInput").value.trim();
  logs.unshift({ id: uid(), type: selectedType, note, timestamp: selectedTime.toISOString() });
  save(STORE_KEYS.logs, logs);
  document.getElementById("noteInput").value = "";
  selectedTime = new Date();
  document.getElementById("exactTimeToggle").checked = false;
  document.getElementById("exactTimeInput").hidden = true;
  updateSelectedTimeDisplay();
  renderRecent();
  showToast("Saved");
});

function renderRecent() {
  const list = document.getElementById("recentList");
  list.innerHTML = "";
  logs.slice(0, 10).forEach(entry => {
    const li = document.createElement("li");
    const t = new Date(entry.timestamp);
    li.innerHTML = `
      <div>
        <div class="rl-type">${entry.type}</div>
        ${entry.note ? `<div class="rl-note">${escapeHtml(entry.note)}</div>` : ""}
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <span class="rl-time">${t.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}</span>
        <button class="rl-del" data-id="${entry.id}">✕</button>
      </div>`;
    list.appendChild(li);
  });
  list.querySelectorAll(".rl-del").forEach(btn => {
    btn.addEventListener("click", () => {
      logs = logs.filter(l => l.id !== btn.dataset.id);
      save(STORE_KEYS.logs, logs);
      renderRecent();
    });
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
renderRecent();

/* ---------- Trends tab ---------- */
document.getElementById("saveWeightBtn").addEventListener("click", () => {
  const val = parseFloat(document.getElementById("weightInput").value);
  if (isNaN(val)) return;
  weights.push({ id: uid(), weightKg: val, timestamp: new Date().toISOString() });
  weights.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  save(STORE_KEYS.weights, weights);
  document.getElementById("weightInput").value = "";
  drawWeightChart();
  showToast("Weight saved");
});

function drawWeightChart() {
  const canvas = document.getElementById("weightChart");
  const empty = document.getElementById("weightEmpty");
  if (weights.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  drawLineChart(canvas, weights.map(w => ({ x: new Date(w.timestamp), y: w.weightKg })), "#D9A441");
}

function drawFastChart() {
  const canvas = document.getElementById("fastChart");
  const empty = document.getElementById("fastEmpty");
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);

  const relevant = logs.filter(l => (l.type === "Meal" || l.type === "Drink") && new Date(l.timestamp) >= cutoff);
  const byDay = {};
  relevant.forEach(l => {
    const d = new Date(l.timestamp);
    const key = d.toDateString();
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(d);
  });
  const points = Object.entries(byDay).map(([key, times]) => {
    const min = new Date(Math.min(...times));
    const max = new Date(Math.max(...times));
    const eatingHours = (max - min) / 3600000;
    return { x: new Date(key), y: Math.max(0, 24 - eatingHours) };
  }).sort((a,b) => a.x - b.x);

  if (points.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  drawBarChart(canvas, points, "#C1683F");
}

function drawLineChart(canvas, points, color) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height, pad = 24;
  ctx.clearRect(0, 0, w, h);
  if (points.length < 1) return;
  const ys = points.map(p => p.y);
  const minY = Math.min(...ys) - 1, maxY = Math.max(...ys) + 1;
  const xs = points.map(p => p.x.getTime());
  const minX = Math.min(...xs), maxX = Math.max(...xs) || minX + 1;

  const sx = x => pad + ((x - minX) / (maxX - minX || 1)) * (w - pad*2);
  const sy = y => h - pad - ((y - minY) / (maxY - minY || 1)) * (h - pad*2);

  ctx.strokeStyle = "#2C3846";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, h-pad); ctx.lineTo(w-pad, h-pad); ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = sx(p.x.getTime()), y = sy(p.y);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = color;
  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(sx(p.x.getTime()), sy(p.y), 3, 0, Math.PI*2);
    ctx.fill();
  });
}

function drawBarChart(canvas, points, color) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height, pad = 24;
  ctx.clearRect(0, 0, w, h);
  const maxY = Math.max(...points.map(p => p.y), 16);
  const barW = (w - pad*2) / points.length * 0.6;
  const step = (w - pad*2) / points.length;

  ctx.strokeStyle = "#2C3846";
  ctx.beginPath(); ctx.moveTo(pad, h-pad); ctx.lineTo(w-pad, h-pad); ctx.stroke();

  ctx.fillStyle = color;
  points.forEach((p, i) => {
    const x = pad + step * i + (step - barW)/2;
    const barH = (p.y / maxY) * (h - pad*2);
    ctx.fillRect(x, h - pad - barH, barW, barH);
  });
}

/* ---------- Schedule tab ---------- */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function minToTimeStr(min) {
  const h = Math.floor(min/60), m = min%60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function timeStrToMin(str) {
  const [h,m] = str.split(":").map(Number);
  return h*60+m;
}

function renderSchedule() {
  const container = document.getElementById("scheduleList");
  container.innerHTML = "";
  schedule.forEach(day => {
    const card = document.createElement("div");
    card.className = "day-card";
    card.innerHTML = `
      <div class="day-head">
        <span class="day-name">${DAY_NAMES[day.weekday]}</span>
        <label class="switch">
          <input type="checkbox" ${day.enabled ? "checked" : ""} data-weekday="${day.weekday}" class="day-toggle">
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="time-row" style="${day.enabled ? "" : "display:none"}">
        <div class="time-field">
          <label>Eating starts</label>
          <input type="time" value="${minToTimeStr(day.startMin)}" data-weekday="${day.weekday}" class="start-input">
        </div>
        <div class="time-field">
          <label>Eating ends</label>
          <input type="time" value="${minToTimeStr(day.endMin)}" data-weekday="${day.weekday}" class="end-input">
        </div>
      </div>`;
    container.appendChild(card);
  });

  container.querySelectorAll(".day-toggle").forEach(el => {
    el.addEventListener("change", () => {
      const d = schedule.find(s => s.weekday == el.dataset.weekday);
      d.enabled = el.checked;
      save(STORE_KEYS.schedule, schedule);
      renderSchedule();
    });
  });
  container.querySelectorAll(".start-input").forEach(el => {
    el.addEventListener("change", () => {
      const d = schedule.find(s => s.weekday == el.dataset.weekday);
      d.startMin = timeStrToMin(el.value);
      save(STORE_KEYS.schedule, schedule);
    });
  });
  container.querySelectorAll(".end-input").forEach(el => {
    el.addEventListener("change", () => {
      const d = schedule.find(s => s.weekday == el.dataset.weekday);
      d.endMin = timeStrToMin(el.value);
      save(STORE_KEYS.schedule, schedule);
    });
  });
}
renderSchedule();

/* ---------- Service worker registration ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
