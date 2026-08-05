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
    targetHours: 16   // targeted fasting window, in hours
  }));
}

function clampHours(h) {
  if (typeof h !== "number" || isNaN(h)) return 16;
  return Math.min(23, Math.max(8, Math.round(h)));
}

// Convert any older start/end-time schedule to the new fasting-hours model.
function migrateSchedule(saved) {
  if (!Array.isArray(saved) || saved.length !== 7) return defaultSchedule();
  return saved.map((d, i) => {
    const weekday = typeof d.weekday === "number" ? d.weekday : i;
    if (typeof d.targetHours === "number") {
      return { weekday, targetHours: clampHours(d.targetHours) };
    }
    // old format: derive fasting hours from the eating window (24 - window length)
    if (typeof d.startMin === "number" && typeof d.endMin === "number") {
      return { weekday, targetHours: clampHours(24 - (d.endMin - d.startMin) / 60) };
    }
    return { weekday, targetHours: 16 };
  });
}

let logs = load(STORE_KEYS.logs, []);
let weights = load(STORE_KEYS.weights, []);
let schedule = migrateSchedule(load(STORE_KEYS.schedule, defaultSchedule()));
save(STORE_KEYS.schedule, schedule);

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------- Fasting state logic ---------- */
function targetHoursFor(date) {
  const s = schedule.find(x => x.weekday === date.getDay());
  return s ? s.targetHours : 16;
}

// Most recent fast-breaking log entry (Meal or Drink) at or before `now`.
// Water and Electrolyte do not break a fast.
function lastEatEntryBefore(now) {
  let latest = null, latestT = null;
  for (const l of logs) {
    if (l.type !== "Meal" && l.type !== "Drink") continue;
    const t = new Date(l.timestamp);
    if (t <= now && (!latestT || t > latestT)) { latest = l; latestT = t; }
  }
  return latest;
}

// If you tap "Started eating" but never tap "Ended eating", we don't want the
// eating window to run forever. After this grace period with no end, assume a
// normal short meal and close it with a fixed window (also catches the case
// where the app was shut during those hours).
const EAT_AUTOCLOSE_MS = 2 * 3600000;   // 2 hours with no "Ended eating"
const EAT_ASSUMED_MS   = 30 * 60000;    // ...then treat the meal as 30 minutes

// Writes an automatic "Ended eating" entry (30 min after the start) if a lone
// "Started eating" marker has been open longer than the grace period.
// Returns true if it added one. Idempotent — once closed it won't re-trigger.
function autoCloseStaleEating() {
  const nowMs = new Date().getTime();
  const last = lastEatEntryBefore(new Date(nowMs));
  if (!last || last.marker !== "start") return false;
  const startMs = new Date(last.timestamp).getTime();
  if (nowMs - startMs <= EAT_AUTOCLOSE_MS) return false;

  const endT = new Date(startMs + EAT_ASSUMED_MS);
  logs.unshift({ id: uid(), type: "Meal", marker: "end", note: "Ended eating (auto · 30m)", timestamp: endT.toISOString() });
  save(STORE_KEYS.logs, logs);
  return true;
}

// The fast rolls from your last meal. A "Started eating" marker with nothing
// logged after it means you're actively in your eating window; anything else
// (an "Ended eating" marker, a plain meal or drink) starts the fast clock.
//   phases: none | eating | fasting | goal
function rollingFastState(now) {
  const last = lastEatEntryBefore(now);
  if (!last) return { phase: "none" };
  const lastTime = new Date(last.timestamp);

  if (last.marker === "start") {
    return { phase: "eating", eatingSince: lastTime };
  }

  const target = targetHoursFor(lastTime);
  const goalAt = new Date(lastTime.getTime() + target * 3600000);
  return {
    phase: now < goalAt ? "fasting" : "goal",
    fastStart: lastTime,
    goalAt,
    target
  };
}

/* ---------- Streak ---------- */
function weeklyStreak(now) {
  const day = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - day); weekStart.setHours(0,0,0,0);

  let hit = 0, total = 0;
  for (let d = new Date(weekStart); d <= now; d.setDate(d.getDate() + 1)) {
    const target = targetHoursFor(d);
    const times = logs
      .filter(l => (l.type === "Meal" || l.type === "Drink") &&
                   new Date(l.timestamp).toDateString() === d.toDateString())
      .map(l => new Date(l.timestamp).getTime());
    if (times.length === 0) continue;   // nothing eaten that day — don't count it

    total++;
    const eatingSpanHours = (Math.max(...times) - Math.min(...times)) / 3600000;
    const fastingHours = 24 - eatingSpanHours;   // consistent with the Trends fasting chart
    if (fastingHours >= target) hit++;
  }
  return { hit, total };
}

/* ---------- Timer tab rendering ---------- */
const RING_CIRC = 2 * Math.PI * 88;
document.getElementById("ringProgress").style.strokeDasharray = RING_CIRC;

let lastPhase = null;

function formatHMS(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function updateStreakBadge(now) {
  const streak = weeklyStreak(now);
  document.getElementById("streakBadge").textContent = `${streak.hit}/${streak.total} this week`;
}

function renderTimer() {
  if (autoCloseStaleEating()) renderRecent();
  const now = new Date();
  const state = rollingFastState(now);
  const ring = document.getElementById("ringProgress");
  const label = document.getElementById("phaseLabel");
  const countdown = document.getElementById("countdownText");
  const sub = document.getElementById("phaseSub");
  const nextMealRow = document.getElementById("nextMealRow");
  const noSchedule = document.getElementById("noScheduleNote");

  // No meals logged yet — nothing to count from.
  if (state.phase === "none") {
    noSchedule.hidden = false;
    noSchedule.innerHTML = "No meals logged yet. Tap <strong>Ended eating</strong> below when you finish your last meal to start your fast.";
    label.textContent = "Ready";
    label.style.color = "var(--turmeric)";
    countdown.textContent = "--:--:--";
    sub.textContent = "";
    nextMealRow.textContent = "";
    ring.style.stroke = "var(--turmeric)";
    ring.style.strokeDashoffset = RING_CIRC;
    lastPhase = null;
    updateStreakBadge(now);
    return;
  }
  noSchedule.hidden = true;

  if (state.phase === "fasting") {
    label.textContent = "Fasting";
    label.style.color = "var(--chili)";
    ring.style.stroke = "var(--chili)";
    const remaining = Math.max(0, state.goalAt - now);
    countdown.textContent = formatHMS(remaining);
    sub.textContent = `until your ${state.target}h goal`;
    const elapsed = now - state.fastStart;
    const frac = Math.min(1, Math.max(0, elapsed / (state.target * 3600000)));
    ring.style.strokeDashoffset = RING_CIRC * (1 - frac);
    nextMealRow.textContent = `Goal at ${state.goalAt.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}`;
  } else if (state.phase === "goal") {
    // Goal reached — count up total time fasted until you start eating again.
    label.textContent = "Eating Window";
    label.style.color = "var(--leaf)";
    ring.style.stroke = "var(--leaf)";
    countdown.textContent = formatHMS(now - state.fastStart);
    sub.textContent = `${state.target}h goal reached — tap Started eating when you eat`;
    ring.style.strokeDashoffset = 0;   // full ring
    nextMealRow.textContent = "";
  } else {
    // Actively eating — count up the eating window until you tap Ended eating.
    label.textContent = "Eating";
    label.style.color = "var(--leaf)";
    ring.style.stroke = "var(--leaf)";
    countdown.textContent = formatHMS(now - state.eatingSince);
    sub.textContent = "eating — tap Ended eating to begin your fast";
    ring.style.strokeDashoffset = 0;   // full ring
    nextMealRow.textContent = `Started ${state.eatingSince.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}`;
  }

  // Only notify on the passive fasting → goal-reached transition (the one you
  // aren't watching for). Manual button taps don't self-notify.
  if (lastPhase === "fasting" && state.phase === "goal") {
    notifyGoalReached();
  }
  lastPhase = state.phase;

  updateStreakBadge(now);
}

function notifyGoalReached() {
  const title = "Fasting goal reached";
  const body = "You hit your fasting target — enjoy your meal.";
  showToast(title);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch (e) {}
  }
}

// Timer-tab shortcuts: log an eating marker at the current time.
function logEatMarker(marker) {
  const note = marker === "start" ? "Started eating" : "Ended eating";
  logs.unshift({ id: uid(), type: "Meal", marker, note, timestamp: new Date().toISOString() });
  save(STORE_KEYS.logs, logs);
  renderRecent();
  renderTimer();
  showToast(marker === "start" ? "Started eating" : "Fast started");
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, 3000);
}

document.getElementById("startEatingBtn").addEventListener("click", () => logEatMarker("start"));
document.getElementById("endEatingBtn").addEventListener("click", () => logEatMarker("end"));

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

/* ---------- Weight logging (on the Log tab) ---------- */
const WEIGHT_MIN = 40, WEIGHT_MAX = 160;   // scroll-picker range (kg), 0.1 steps

// Build the weight scroll wheel, preselected to your most recent weight (or 70)
// so you only nudge it a little each time.
function populateWeightSelect() {
  const sel = document.getElementById("weightSelect");
  const last = weights.length ? weights[weights.length - 1].weightKg : 70;
  const def = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(last * 10) / 10));
  const defStr = def.toFixed(1);
  let out = "";
  for (let i = 0; i <= (WEIGHT_MAX - WEIGHT_MIN) * 10; i++) {
    const s = (WEIGHT_MIN + i / 10).toFixed(1);
    out += `<option value="${s}"${s === defStr ? " selected" : ""}>${s} kg</option>`;
  }
  sel.innerHTML = out;
  sel.value = defStr;
}
populateWeightSelect();

document.getElementById("saveWeightBtn").addEventListener("click", () => {
  const val = parseFloat(document.getElementById("weightSelect").value);
  if (isNaN(val)) return;
  weights.push({ id: uid(), weightKg: val, timestamp: new Date().toISOString() });
  weights.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  save(STORE_KEYS.weights, weights);
  populateWeightSelect();   // default now reflects the just-saved weight
  drawWeightChart();        // safe if the Trends tab isn't visible (guarded below)
  showToast("Weight saved");
});

/* ---- chart helpers ---- */
const AXIS = "#3A4757", GRID = "#2C3846", TICK = "#8B96A3";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(d) {
  return `${String(d.getDate()).padStart(2,"0")}-${MONTHS[d.getMonth()]}`;
}

// Round a min/max range out to "nice" tick boundaries for a readable axis.
function niceScale(min, max, ticks) {
  ticks = ticks || 4;
  if (min === max) { min -= 1; max += 1; }
  const rawStep = (max - min) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

// Size the canvas to its CSS box at device resolution so lines/text stay crisp.
function prepCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  return { ctx, W: cssW, H: cssH };
}

// Draw Y grid + value labels and 45°-rotated X date labels. Returns scale fns.
// mode "line": points sit at the plot edges; "bar": points sit at slot centers.
function drawAxes(ctx, W, H, scale, xs, yUnit, mode) {
  const padL = 40, padR = 12, padT = 12, padB = 42;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = xs.length;
  const sx = mode === "bar"
    ? i => padL + (plotW / n) * (i + 0.5)
    : i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const sy = v => padT + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;

  // Y gridlines + labels
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = scale.min; v <= scale.max + 1e-9; v += scale.step) {
    const y = sy(v);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = TICK;
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    ctx.fillText(label, padL - 6, y);
  }
  // axis lines
  ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(W - padR, padT + plotH); ctx.stroke();

  // Y unit
  ctx.fillStyle = TICK; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(yUnit, 4, 2);

  // X date labels, rotated 45°, thinned so at most ~7 show
  const stepEvery = Math.max(1, Math.ceil(xs.length / 7));
  ctx.fillStyle = TICK; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  xs.forEach((d, i) => {
    if (i % stepEvery !== 0 && i !== xs.length - 1) return;
    ctx.save();
    ctx.translate(sx(i), padT + plotH + 8);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(fmtDate(d), 0, 0);
    ctx.restore();
  });

  return { sx, sy, padL, padR, padT, padB, plotW, plotH };
}

function drawWeightChart() {
  const canvas = document.getElementById("weightChart");
  const empty = document.getElementById("weightEmpty");
  if (weights.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  if (canvas.clientWidth === 0) return;   // Trends tab hidden — will redraw on show

  const pts = weights.map(w => ({ x: new Date(w.timestamp), y: w.weightKg }));
  const ys = pts.map(p => p.y);
  const scale = niceScale(Math.min(...ys), Math.max(...ys), 4);

  const { ctx, W, H } = prepCanvas(canvas, 210);
  const a = drawAxes(ctx, W, H, scale, pts.map(p => p.x), "kg", "line");

  ctx.strokeStyle = "#D9A441"; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((p, i) => { const x = a.sx(i), y = a.sy(p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = "#D9A441";
  pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(a.sx(i), a.sy(p.y), 3, 0, Math.PI * 2); ctx.fill(); });
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
  const pts = Object.entries(byDay).map(([key, times]) => {
    const eatingHours = (Math.max(...times) - Math.min(...times)) / 3600000;
    return { x: new Date(key), y: Math.max(0, 24 - eatingHours) };
  }).sort((a,b) => a.x - b.x);

  if (pts.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  if (canvas.clientWidth === 0) return;

  const maxY = Math.max(...pts.map(p => p.y), 1);
  const scale = niceScale(0, maxY, 4);   // fasting hours start at 0

  const { ctx, W, H } = prepCanvas(canvas, 210);
  const a = drawAxes(ctx, W, H, scale, pts.map(p => p.x), "hours", "bar");

  const slot = a.plotW / pts.length;
  const barW = Math.min(slot * 0.6, 26);
  ctx.fillStyle = "#C1683F";
  pts.forEach((p, i) => {
    const cx = a.sx(i);
    const y = a.sy(p.y);
    ctx.fillRect(cx - barW / 2, y, barW, (a.padT + a.plotH) - y);
  });
}

/* ---------- Schedule tab ---------- */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const HOUR_MIN = 8, HOUR_MAX = 23;   // selectable fasting-target range (hours)

function hoursOptions(selected) {
  let out = "";
  for (let h = HOUR_MIN; h <= HOUR_MAX; h++) {
    out += `<option value="${h}"${h === selected ? " selected" : ""}>${h} h</option>`;
  }
  return out;
}

function renderSchedule() {
  const container = document.getElementById("scheduleList");
  container.innerHTML = "";
  schedule.forEach(day => {
    const row = document.createElement("div");
    row.className = "sched-row";
    row.innerHTML = `
      <span class="sched-day">${DAY_NAMES[day.weekday]}</span>
      <select class="hours-select" data-weekday="${day.weekday}">
        ${hoursOptions(day.targetHours)}
      </select>`;
    container.appendChild(row);
  });

  container.querySelectorAll(".hours-select").forEach(el => {
    el.addEventListener("change", () => {
      const d = schedule.find(s => s.weekday == el.dataset.weekday);
      d.targetHours = parseInt(el.value, 10);
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
