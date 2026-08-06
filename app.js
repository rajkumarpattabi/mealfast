/* ---------- Storage helpers (all data stays in this browser, on this device) ---------- */
const STORE_KEYS = { logs: "mf_logs", weights: "mf_weights", schedule: "mf_schedule" };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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
  return Math.min(36, Math.max(8, Math.round(h)));
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

// A fast running past 40h almost always means a meal wasn't logged. When that
// happens, record the stale fast as a capped 24h fast and restart the timer
// from there. Loops so a very stale fast (app unopened for days) catches up in
// one pass; returns true if anything was written.
const FAST_AUTOCAP_MS = 40 * 3600000;   // ongoing fast beyond 40h triggers the cap
const FAST_CAP_MS      = 24 * 3600000;  // ...recorded as a 24h fast, then restart

function autoCapStaleFast() {
  let changed = false;
  for (let guard = 0; guard < 60; guard++) {
    const nowMs = new Date().getTime();
    const last = lastEatEntryBefore(new Date(nowMs));
    if (!last || last.marker === "start") break;   // no fast running / actively eating
    const startMs = new Date(last.timestamp).getTime();
    if (nowMs - startMs <= FAST_AUTOCAP_MS) break;  // under 40h — leave it alone

    const capT = new Date(startMs + FAST_CAP_MS);
    logs.unshift({ id: uid(), type: "Meal", note: "Fast auto-capped (24h)", timestamp: capT.toISOString() });
    save(STORE_KEYS.logs, logs);
    changed = true;
  }
  return changed;
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

/* ---------- Streak / per-day fasting (shared) ----------
   A day is "on target" if the fast that STARTED that day — measured from your
   last meal of the day to the next time you ate — was at least that day's goal.
   Measuring the real gap between eating events (not a single calendar day) lets
   fasts run past midnight, so 24h+ targets are credited correctly. The day a
   long fast spends entirely fasting has no eating logs and simply isn't counted. */

// All fast-breaking (Meal/Drink) timestamps, ascending. Shared by streak + trends.
function eatsAscending() {
  return logs
    .filter(l => l.type === "Meal" || l.type === "Drink")
    .map(l => new Date(l.timestamp).getTime())
    .sort((a, b) => a - b);
}

// Evaluate the fast that started on calendar day `d`: { counted, onTarget }.
function dayFastEval(d, eats, nowMs) {
  const dayStr = d.toDateString();
  const dayEats = eats.filter(t => new Date(t).toDateString() === dayStr);
  if (dayEats.length === 0) return { counted: false, onTarget: false };  // no fast started
  const lastMeal = Math.max(...dayEats);
  const targetMs = targetHoursFor(d) * 3600000;
  const nextMeal = eats.find(t => t > lastMeal);
  if (nextMeal != null) return { counted: true, onTarget: (nextMeal - lastMeal) >= targetMs };
  if (nowMs - lastMeal >= targetMs) return { counted: true, onTarget: true };  // ongoing, already past goal
  return { counted: false, onTarget: false };  // ongoing, undetermined
}

function weeklyStreak(now) {
  const day = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - day); weekStart.setHours(0,0,0,0);
  const eats = eatsAscending();
  const nowMs = now.getTime();
  let hit = 0, total = 0;
  for (let d = new Date(weekStart); d <= now; d.setDate(d.getDate() + 1)) {
    const r = dayFastEval(d, eats, nowMs);
    if (!r.counted) continue;
    total++;
    if (r.onTarget) hit++;
  }
  return { hit, total };
}

// Current + longest on-target streaks across the whole history.
// On-target days extend a run; a real miss (counted but not on target) breaks it;
// days with no fast started / undetermined are transparent (neither break nor extend).
function streakStats(now) {
  const eats = eatsAscending();
  if (eats.length === 0) return { current: 0, best: 0 };
  const nowMs = now.getTime();
  const day = new Date(eats[0]); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);

  const results = [];
  for (let d = new Date(day); d <= today; d.setDate(d.getDate() + 1)) {
    results.push(dayFastEval(new Date(d), eats, nowMs));
  }

  let best = 0, run = 0;
  for (const r of results) {
    if (!r.counted) continue;
    if (r.onTarget) { run++; if (run > best) best = run; }
    else run = 0;
  }

  let current = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (!r.counted) continue;      // skip today-undetermined / no-data days
    if (r.onTarget) current++;
    else break;                    // a miss ends the current streak
  }
  return { current, best };
}

/* ---------- Timer tab rendering ---------- */
const USER_NAME = "Raj";   // shown in the greeting — change to taste

function greetingWord(h) {
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

function relFast(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// General intermittent-fasting milestones by hours elapsed (informational, not
// medical advice).
function fastMilestone(h) {
  if (h < 4)  return "fed state — digesting";
  if (h < 8)  return "blood sugar settling";
  if (h < 12) return "glycogen burning";
  if (h < 16) return "fat-burning zone";
  if (h < 18) return "ketosis deepening";
  if (h < 24) return "autophagy ramping up";
  return "deep fast — autophagy peak";
}

function updateGreeting(now) {
  document.getElementById("greetingLine").innerHTML =
    `${greetingWord(now.getHours())}, <span class="name">${USER_NAME}</span>`;

  const st = streakStats(now);
  const streakEl = document.getElementById("greetingStreak");
  const dayWord = n => n === 1 ? "day" : "days";
  if (st.current > 0) {
    streakEl.textContent = `Current streak: ${st.current} ${dayWord(st.current)} · Best: ${st.best} ${dayWord(st.best)}`;
  } else if (st.best > 0) {
    streakEl.textContent = `Best streak: ${st.best} ${dayWord(st.best)} — start a new one today`;
  } else {
    streakEl.textContent = "Hit your target to start a streak";
  }
}

/* ---- Fasting-stage background art (driven by ELAPSED hours, not goal %) ---- */
const ART_OPACITY = 0.16;
const STAGE_ART = {
  digesting: `<svg viewBox="0 0 100 100" class="art-svg"><circle cx="50" cy="70" r="22"/><circle cx="50" cy="70" r="13"/></svg>`,
  glycogen:  `<svg viewBox="0 0 100 100" class="art-svg"><polygon points="50,70 44,80.4 32,80.4 26,70 32,59.6 44,59.6"/><polygon points="74,70 68,80.4 56,80.4 50,70 56,59.6 68,59.6"/></svg>`,
  fat:       `<svg viewBox="0 0 100 100" class="art-svg"><path d="M50,50 C62,68 62,82 50,88 C38,82 38,68 50,50 Z"/></svg>`,
  ketosis:   `<svg viewBox="0 0 100 100" class="art-svg"><line x1="50" y1="58" x2="38" y2="78"/><line x1="50" y1="58" x2="62" y2="78"/><line x1="38" y1="78" x2="62" y2="78"/><circle cx="50" cy="58" r="6"/><circle cx="38" cy="78" r="6"/><circle cx="62" cy="78" r="6"/></svg>`,
  autophagy: `<svg viewBox="0 0 100 100" class="art-svg"><circle cx="50" cy="70" r="22"/><path d="M40,62 A12,12 0 1 0 44,58"/><circle cx="50" cy="70" r="5"/></svg>`,
  deep:      `<svg viewBox="0 0 100 100" class="art-svg"><line x1="50" y1="92" x2="50" y2="64"/><path d="M50,74 C40,74 33,66 35,58 C45,58 50,66 50,74 Z"/><path d="M50,70 C60,70 67,62 65,54 C55,54 50,62 50,70 Z"/></svg>`
};
function stageForHours(h) {
  if (h < 4)  return { key: "digesting", name: "Digesting" };
  if (h < 12) return { key: "glycogen",  name: "Glycogen Burning" };
  if (h < 18) return { key: "fat",       name: "Fat-Adaptation" };
  if (h < 24) return { key: "ketosis",   name: "Ketosis" };
  if (h < 48) return { key: "autophagy", name: "Autophagy Rising" };
  return { key: "deep", name: "Deep Autophagy" };
}
let currentArtKey = "__init", artFadeTimer = null;
function setStageArt(key) {
  const el = document.getElementById("stageArt");
  if (!el || key === currentArtKey) return;
  currentArtKey = key;
  clearTimeout(artFadeTimer);
  el.style.opacity = "0";                        // fade out, swap, fade in (crossfade-through)
  artFadeTimer = setTimeout(() => {
    el.innerHTML = key ? (STAGE_ART[key] || "") : "";
    el.style.opacity = key ? String(ART_OPACITY) : "0";
  }, 260);
}

// Glowing dot at the arc's leading edge (only while fasting toward the goal).
function setRingDot(frac, col, show) {
  const dot = document.getElementById("ringDot");
  if (!dot) return;
  if (!show) { dot.style.display = "none"; return; }
  const theta = 2 * Math.PI * frac;
  dot.setAttribute("cx", (100 + 88 * Math.cos(theta)).toFixed(2));
  dot.setAttribute("cy", (100 + 88 * Math.sin(theta)).toFixed(2));
  dot.setAttribute("fill", col);
  dot.style.filter = `drop-shadow(0 0 4px ${col})`;
  dot.style.display = "";
}

const RING_CIRC = 2 * Math.PI * 88;
document.getElementById("ringProgress").style.strokeDasharray = RING_CIRC;

let lastPhase = null;
// While fasting, the ring can emphasise time REMAINING (default) or time ELAPSED.
// Tapping the ring toggles it; the choice is remembered.
let timerMode = localStorage.getItem("mf_timer_mode") === "elapsed" ? "elapsed" : "remaining";

function formatHMS(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function fastColor(elapsedFrac) {
  const f = Math.min(1, Math.max(0, elapsedFrac));
  return `hsl(${Math.round(f * 120)}, 68%, 47%)`;   // red (0) → green (1)
}

function updateStreakBadge(now) {
  const streak = weeklyStreak(now);
  document.getElementById("streakBadge").textContent = `${streak.hit}/${streak.total} this week`;
}

function renderTimer() {
  let logsChanged = autoCloseStaleEating();
  if (autoCapStaleFast()) logsChanged = true;
  if (logsChanged) renderLogs();
  const now = new Date();
  const state = rollingFastState(now);
  updateGreeting(now);

  const ring = document.getElementById("ringProgress");
  const heading = document.getElementById("stageHeading");
  const goalLine = document.getElementById("goalLine");
  const countdown = document.getElementById("countdownText");
  const secondary = document.getElementById("phaseSecondary");
  const noSchedule = document.getElementById("noScheduleNote");

  if (state.phase === "none") {
    noSchedule.hidden = false;
    noSchedule.innerHTML = "No meals logged yet. Tap <strong>Ended eating</strong> below when you finish your last meal to start your fast.";
    heading.textContent = "Ready";
    heading.style.color = "var(--turmeric)";
    goalLine.textContent = "Log your last meal to begin";
    countdown.textContent = "--:--:--";
    secondary.textContent = "";
    ring.style.stroke = "var(--turmeric)";
    ring.style.strokeDashoffset = RING_CIRC;
    setRingDot(0, "", false);
    setStageArt(null);
    lastPhase = null;
    updateStreakBadge(now);
    return;
  }
  noSchedule.hidden = true;

  if (state.phase === "fasting" || state.phase === "goal") {
    const total = state.target * 3600000;
    const elapsed = Math.max(0, now - state.fastStart);
    const remaining = Math.max(0, state.goalAt - now);
    const frac = Math.min(1, Math.max(0, elapsed / total));
    const col = fastColor(frac);
    const stage = stageForHours(elapsed / 3600000);

    heading.textContent = stage.name;          // stage name is the heading
    heading.style.color = col;
    ring.style.stroke = col;
    ring.style.strokeDashoffset = RING_CIRC * (1 - frac);
    setStageArt(stage.key);

    if (state.phase === "fasting") {
      const pctDone = Math.min(100, Math.round((elapsed / total) * 100));
      const by = state.goalAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      goalLine.textContent = `${pctDone}% of ${state.target}h goal · by ${by}`;
      setRingDot(frac, col, true);
      if (timerMode === "elapsed") {
        countdown.textContent = formatHMS(elapsed);
        secondary.textContent = `${formatHMS(remaining)} to goal`;
      } else {
        countdown.textContent = formatHMS(remaining);
        secondary.textContent = `${formatHMS(elapsed)} elapsed`;
      }
    } else {   // goal reached — extended fast
      const over = elapsed - total;
      goalLine.textContent = over > 60000 ? `Goal reached · ${relFast(over)} into extended fast` : "Goal reached";
      countdown.textContent = formatHMS(elapsed);
      secondary.textContent = "tap Started eating when you eat";
      setRingDot(0, "", false);   // ring is full; no leading dot
    }
  } else {
    // Actively eating.
    heading.textContent = "Eating";
    heading.style.color = "var(--leaf)";
    goalLine.textContent = "Eating window";
    ring.style.stroke = "var(--leaf)";
    ring.style.strokeDashoffset = 0;
    countdown.textContent = formatHMS(now - state.eatingSince);
    secondary.textContent = "tap Ended eating to begin your fast";
    setRingDot(0, "", false);
    setStageArt(null);
  }

  if (lastPhase === "fasting" && state.phase === "goal") notifyGoalReached();
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
  renderLogs();
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

// Tap the ring to flip between Remaining and Fasting (elapsed) emphasis.
document.getElementById("ringWrap").addEventListener("click", () => {
  timerMode = timerMode === "elapsed" ? "remaining" : "elapsed";
  localStorage.setItem("mf_timer_mode", timerMode);
  renderTimer();
});

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
    if (btn.dataset.tab === "schedule") { renderSchedule(); renderBackupStatus(); }
    if (btn.dataset.tab === "logs") { renderLogs(); }
    if (btn.dataset.tab === "entries") { populateWeightSelect(); }
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
  renderLogs();
  renderTimer();      // a new meal changes the current fast immediately
  showToast("Saved");
});

// The Logs tab: every meal/drink/water/electrolyte log (including the Timer-tab
// eating markers) plus every weight entry, newest first, each deletable.
function renderLogs() {
  const list = document.getElementById("logList");
  const empty = document.getElementById("logsEmpty");

  const items = [];
  logs.forEach(l => items.push({
    kind: "log", id: l.id, when: new Date(l.timestamp),
    type: l.type, note: l.note || "",
    value: new Date(l.timestamp).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})
  }));
  weights.forEach(w => items.push({
    kind: "weight", id: w.id, when: new Date(w.timestamp),
    type: "Weight", note: "",
    value: `${Number(w.weightKg).toFixed(1)} kg`
  }));
  items.sort((a,b) => b.when - a.when);

  list.innerHTML = "";
  if (items.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;

  items.forEach(it => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.dataset.kind = it.kind;
    li.dataset.id = it.id;
    li.innerHTML = `
      <span class="li-date">${fmtDate(it.when)}</span>
      <div class="li-main">
        <div class="li-type">${it.type}</div>
        ${it.note ? `<div class="li-note">${escapeHtml(it.note)}</div>` : ""}
      </div>
      <span class="li-val">${it.value}</span>
      <span class="li-chev">›</span>`;
    list.appendChild(li);
  });

  // Tap a row to edit or delete it.
  list.querySelectorAll(".log-item").forEach(li => {
    li.addEventListener("click", () => openEditSheet(li.dataset.kind, li.dataset.id));
  });
}

// Re-render everything that depends on logs/weights after an edit or delete.
function afterEntryChange() {
  renderLogs();
  renderTimer();       // fasting phase + streak recompute from the changed data
  drawWeightChart();   // trends stay in sync (guarded no-op when Trends is hidden)
  drawFastChart();
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
renderLogs();

/* ---------- Weight logging (on the Log tab) ---------- */
const WEIGHT_MIN = 40, WEIGHT_MAX = 160;   // scroll-picker range (kg), 0.1 steps

// Show/hide the chosen weight. Until you tap the field it stays blank (just a
// placeholder); the default only appears once you open the picker.
function setWeightPicked(picked) {
  const field = document.getElementById("weightField");
  if (picked) field.classList.add("picked"); else field.classList.remove("picked");
}

// Build the weight scroll wheel, preselected to your most recent weight (or 70)
// so opening it lands right at the value to confirm or nudge — but keep the
// field blank until it's opened.
function weightOptionsHtml(selectedStr) {
  let out = "";
  for (let i = 0; i <= (WEIGHT_MAX - WEIGHT_MIN) * 10; i++) {
    const s = (WEIGHT_MIN + i / 10).toFixed(1);
    out += `<option value="${s}"${s === selectedStr ? " selected" : ""}>${s} kg</option>`;
  }
  return out;
}

function populateWeightSelect() {
  const sel = document.getElementById("weightSelect");
  const last = weights.length ? weights[weights.length - 1].weightKg : 70;
  const def = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(last * 10) / 10));
  const defStr = def.toFixed(1);
  sel.innerHTML = weightOptionsHtml(defStr);
  sel.value = defStr;
  setWeightPicked(false);   // reset to the blank placeholder state
}
populateWeightSelect();

// Reveal the value as soon as the picker is opened (focus) or changed.
document.getElementById("weightSelect").addEventListener("focus", () => setWeightPicked(true));
document.getElementById("weightSelect").addEventListener("change", () => setWeightPicked(true));

document.getElementById("saveWeightBtn").addEventListener("click", () => {
  const field = document.getElementById("weightField");
  if (!field.classList.contains("picked")) { showToast("Tap the field to set your weight"); return; }
  const val = parseFloat(document.getElementById("weightSelect").value);
  if (isNaN(val)) return;
  weights.push({ id: uid(), weightKg: val, timestamp: new Date().toISOString() });
  weights.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  save(STORE_KEYS.weights, weights);
  populateWeightSelect();   // resets to blank; default now reflects the saved weight
  drawWeightChart();        // safe if the Trends tab isn't visible (guarded below)
  showToast("Weight saved");
});

/* ---------- Edit / delete an entry (tap a row in the Logs tab) ---------- */
let editingKind = null, editingId = null;

function openEditSheet(kind, id) {
  editingKind = kind; editingId = id;
  const title = document.getElementById("editTitle");
  const body = document.getElementById("editBody");

  if (kind === "weight") {
    const w = weights.find(x => x.id === id);
    if (!w) return;
    title.textContent = "Edit weight";
    const cur = (Math.round(Number(w.weightKg) * 10) / 10).toFixed(1);
    body.innerHTML = `
      <label class="edit-label">Weight</label>
      <select id="editWeight" class="edit-input">${weightOptionsHtml(cur)}</select>
      <label class="edit-label">Date &amp; time</label>
      <input type="datetime-local" id="editTime" class="edit-input" value="${toLocalInputValue(new Date(w.timestamp))}">`;
  } else {
    const l = logs.find(x => x.id === id);
    if (!l) return;
    title.textContent = "Edit entry";
    const typeBtns = ["Meal","Drink","Water","Electrolyte"]
      .map(t => `<button class="type-btn${t === l.type ? " active" : ""}" data-type="${t}">${t}</button>`).join("");
    body.innerHTML = `
      <div class="type-row" id="editTypeRow">${typeBtns}</div>
      <label class="edit-label">Date &amp; time</label>
      <input type="datetime-local" id="editTime" class="edit-input" value="${toLocalInputValue(new Date(l.timestamp))}">
      <label class="edit-label">Note</label>
      <input type="text" id="editNote" class="edit-input" placeholder="Note (optional)" value="${escapeHtml(l.note || "")}">`;
    body.querySelector("#editTypeRow").addEventListener("click", (e) => {
      const b = e.target.closest(".type-btn"); if (!b) return;
      body.querySelectorAll(".type-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
    });
  }
  document.getElementById("editSheet").hidden = false;
}

function closeEditSheet() {
  document.getElementById("editSheet").hidden = true;
  editingKind = null; editingId = null;
}

function saveEdit() {
  const timeVal = document.getElementById("editTime").value;
  const ts = timeVal ? new Date(timeVal) : null;
  if (!ts || isNaN(ts.getTime())) { showToast("Pick a valid date & time"); return; }

  if (editingKind === "weight") {
    const w = weights.find(x => x.id === editingId);
    if (w) {
      w.weightKg = parseFloat(document.getElementById("editWeight").value);
      w.timestamp = ts.toISOString();
      weights.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
      save(STORE_KEYS.weights, weights);
      populateWeightSelect();
    }
  } else {
    const l = logs.find(x => x.id === editingId);
    if (l) {
      const active = document.querySelector("#editTypeRow .type-btn.active");
      if (active) l.type = active.dataset.type;
      l.note = document.getElementById("editNote").value.trim();
      l.timestamp = ts.toISOString();
      save(STORE_KEYS.logs, logs);
    }
  }
  closeEditSheet();
  afterEntryChange();
  showToast("Changes saved");
}

function deleteEdit() {
  let restore = null;
  if (editingKind === "weight") {
    const idx = weights.findIndex(x => x.id === editingId);
    if (idx >= 0) {
      const removed = weights[idx];
      weights.splice(idx, 1);
      save(STORE_KEYS.weights, weights);
      populateWeightSelect();
      restore = () => {
        weights.push(removed);
        weights.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
        save(STORE_KEYS.weights, weights);
        populateWeightSelect();
        afterEntryChange();
      };
    }
  } else {
    const idx = logs.findIndex(x => x.id === editingId);
    if (idx >= 0) {
      const removed = logs[idx];
      logs.splice(idx, 1);
      save(STORE_KEYS.logs, logs);
      restore = () => {
        logs.splice(Math.min(idx, logs.length), 0, removed);
        save(STORE_KEYS.logs, logs);
        afterEntryChange();
      };
    }
  }
  closeEditSheet();
  afterEntryChange();
  if (restore) showUndoToast("Entry deleted", restore);
}

let undoTimer = null;
function showUndoToast(msg, undoFn) {
  const t = document.getElementById("undoToast");
  t.querySelector(".undo-msg").textContent = msg;
  t.hidden = false;
  clearTimeout(undoTimer);
  t.querySelector(".undo-btn").onclick = () => {
    clearTimeout(undoTimer);
    t.hidden = true;
    undoFn();
    showToast("Restored");
  };
  undoTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

document.getElementById("editSaveBtn").addEventListener("click", saveEdit);
document.getElementById("editDeleteBtn").addEventListener("click", deleteEdit);
document.getElementById("editCancelBtn").addEventListener("click", closeEditSheet);
document.getElementById("editSheet").addEventListener("click", (e) => {
  if (e.target.id === "editSheet") closeEditSheet();   // tap the dimmed backdrop to dismiss
});

/* ---- chart helpers ---- */
const AXIS = "#3A4757", GRID = "#2C3846", TICK = "#8B96A3";

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

// Draw Y grid + value labels and 45°-rotated X labels. Returns scale fns.
// mode "line": points sit at the plot edges; "bar": points sit at slot centers.
function drawAxes(ctx, W, H, scale, labels, yUnit, mode) {
  const padL = 40, padR = 12, padT = 12, padB = 42;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = labels.length;
  const sx = mode === "bar"
    ? i => padL + (plotW / n) * (i + 0.5)
    : i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const sy = v => padT + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;

  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = scale.min; v <= scale.max + 1e-9; v += scale.step) {
    const y = sy(v);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = TICK;
    ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), padL - 6, y);
  }
  ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(W - padR, padT + plotH); ctx.stroke();

  ctx.fillStyle = TICK; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(yUnit, 4, 2);

  const stepEvery = Math.max(1, Math.ceil(n / 7));
  ctx.fillStyle = TICK; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  labels.forEach((lab, i) => {
    if (i % stepEvery !== 0 && i !== n - 1) return;
    ctx.save();
    ctx.translate(sx(i), padT + plotH + 8);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(lab, 0, 0);
    ctx.restore();
  });

  return { sx, sy, padL, padR, padT, padB, plotW, plotH };
}

/* ---- Trends range + bucketing (Week / Month / Year) ---- */
let trendRange = localStorage.getItem("mf_trend_range") || "week";

// Ordered oldest→newest buckets for the selected range.
function trendBuckets(range, now) {
  const buckets = [];
  if (range === "week") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
      buckets.push({ label: fmtDate(d), day: new Date(d), start: d.getTime(), end: d.getTime() + 86400000 - 1 });
    }
  } else if (range === "month") {
    for (let b = 4; b >= 0; b--) {                       // 5 rolling 7-day buckets back from today
      const end = new Date(now); end.setDate(now.getDate() - 7 * b); end.setHours(23, 59, 59, 999);
      const start = new Date(end); start.setDate(end.getDate() - 6); start.setHours(0, 0, 0, 0);
      buckets.push({ label: fmtDate(start), start: start.getTime(), end: end.getTime() });
    }
  } else {                                               // year: 12 calendar months
    for (let b = 11; b >= 0; b--) {
      const first = new Date(now.getFullYear(), now.getMonth() - b, 1, 0, 0, 0, 0);
      const last = new Date(now.getFullYear(), now.getMonth() - b + 1, 0, 23, 59, 59, 999);
      buckets.push({ label: MONTHS[first.getMonth()], start: first.getTime(), end: last.getTime() });
    }
  }
  return buckets;
}

// Average of weigh-ins inside a bucket, or null if none.
function weightAvgInRange(startMs, endMs) {
  const vals = weights
    .filter(w => { const t = new Date(w.timestamp).getTime(); return t >= startMs && t <= endMs; })
    .map(w => Number(w.weightKg));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Actual fast that STARTED on day `d`: real duration (last meal of the day →
// next time you ate, or now if still fasting), that day's target, and whether
// it was met. null if no fast started that day.
function dayActualFast(d, eats, nowMs) {
  const dayStr = d.toDateString();
  const dayEats = eats.filter(t => new Date(t).toDateString() === dayStr);
  if (!dayEats.length) return null;
  const lastMeal = Math.max(...dayEats);
  const target = targetHoursFor(d);
  const nextMeal = eats.find(t => t > lastMeal);
  const endMs = nextMeal != null ? nextMeal : nowMs;   // completed, or ongoing so far
  const hours = Math.max(0, (endMs - lastMeal) / 3600000);
  return { hours, target, met: hours >= target };
}

// Bucket value for the fasting chart: actual fast hours (per day for Week,
// averaged over the bucket's days for Month/Year), plus the applicable target
// and whether it was met. null if no fast in the bucket.
function fastBucketValue(bucket, isWeek, eats, nowMs) {
  if (isWeek) {
    const r = dayActualFast(bucket.day, eats, nowMs);
    return r ? { value: r.hours, target: r.target, met: r.met } : null;
  }
  let sum = 0, tsum = 0, n = 0;
  const d = new Date(bucket.start); d.setHours(0, 0, 0, 0);
  const endDay = new Date(bucket.end);
  while (d <= endDay) {
    const r = dayActualFast(new Date(d), eats, nowMs);
    if (r) { sum += r.hours; tsum += r.target; n++; }
    d.setDate(d.getDate() + 1);
  }
  if (!n) return null;
  const avg = sum / n, avgT = tsum / n;
  return { value: avg, target: avgT, met: avg >= avgT };
}

function drawWeightChart() {
  const canvas = document.getElementById("weightChart");
  const empty = document.getElementById("weightEmpty");
  const buckets = trendBuckets(trendRange, new Date());
  const ys = buckets.map(b => weightAvgInRange(b.start, b.end));
  const present = ys.filter(v => v != null);
  if (present.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  if (canvas.clientWidth === 0) return;   // Trends tab hidden — will redraw on show

  const scale = niceScale(Math.min(...present), Math.max(...present), 4);
  const { ctx, W, H } = prepCanvas(canvas, 210);
  const a = drawAxes(ctx, W, H, scale, buckets.map(b => b.label), "kg", "line");

  ctx.strokeStyle = "#D9A441"; ctx.lineWidth = 2; ctx.beginPath();
  let started = false;
  ys.forEach((v, i) => {
    if (v == null) return;
    const x = a.sx(i), y = a.sy(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#D9A441";
  ys.forEach((v, i) => { if (v == null) return; ctx.beginPath(); ctx.arc(a.sx(i), a.sy(v), 3, 0, Math.PI * 2); ctx.fill(); });
}

function drawFastChart() {
  const canvas = document.getElementById("fastChart");
  const empty = document.getElementById("fastEmpty");
  const now = new Date(), nowMs = now.getTime();
  const isWeek = trendRange === "week";
  const buckets = trendBuckets(trendRange, now);
  const eats = eatsAscending();
  const data = buckets.map(b => fastBucketValue(b, isWeek, eats, nowMs));   // {value,target,met}|null
  const present = data.filter(x => x != null);
  if (present.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  if (canvas.clientWidth === 0) return;

  // Scale to include the target so bars that fall short visibly don't reach it.
  const maxV = Math.max(...present.map(x => x.value), 1);
  const maxT = Math.max(...present.map(x => x.target), 1);
  const scale = niceScale(0, Math.max(maxV, maxT), 4);

  const { ctx, W, H } = prepCanvas(canvas, 210);
  const a = drawAxes(ctx, W, H, scale, buckets.map(b => b.label), "hours", "bar");

  const barW = Math.min((a.plotW / buckets.length) * 0.6, 26);
  data.forEach((x, i) => {
    if (x == null) return;
    ctx.fillStyle = x.met ? fastColor(1) : fastColor(0);   // green if target met, red if short
    const cx = a.sx(i), y = a.sy(x.value);
    ctx.fillRect(cx - barW / 2, y, barW, (a.padT + a.plotH) - y);
  });
}

function setTrendRange(r) {
  trendRange = r;
  localStorage.setItem("mf_trend_range", r);
  document.querySelectorAll("#trendRange .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.range === r));
  drawWeightChart();
  drawFastChart();
}
document.getElementById("trendRange").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (b) setTrendRange(b.dataset.range);
});
document.querySelectorAll("#trendRange .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.range === trendRange));

/* ---------- Schedule tab ---------- */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
// Sun→Sat: an even hue sweep, one matched saturation/lightness per day, so the
// grid reads as one cohesive system rather than seven clashing colours.
const DAY_HUES = [10, 61, 112, 163, 214, 265, 316];
const HOUR_MIN = 8, HOUR_MAX = 36;   // selectable fasting-target range (hours; fasts can span past midnight)

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
    const hue = DAY_HUES[day.weekday];
    const cell = document.createElement("div");
    cell.className = "sched-cell";
    cell.style.background = `hsl(${hue}, 30%, 15%)`;
    cell.innerHTML = `
      <span class="sched-day" style="color:hsl(${hue}, 70%, 72%)">${DAY_NAMES[day.weekday].slice(0,3)}</span>
      <select class="hours-select" data-weekday="${day.weekday}"
        style="color:hsl(${hue}, 62%, 80%); background:hsl(${hue}, 24%, 24%)">
        ${hoursOptions(day.targetHours)}
      </select>`;
    container.appendChild(cell);
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

/* ---------- Backup: export / import (Schedule tab) ---------- */
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function triggerDownload(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  const payload = { app: "MealFast", version: 1, exportedAt: new Date().toISOString(), logs, weights, schedule };
  triggerDownload(JSON.stringify(payload, null, 2), "application/json", `mealfast-backup-${dateStamp()}.json`);
  showToast("JSON backup exported");
}

// CSV: one download with two clearly-separated sections (reliable single tap on
// iOS), oldest-first, spreadsheet-friendly.
function csvCell(v) {
  v = String(v == null ? "" : v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function csvDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function csvTime(d) {
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function exportCsv() {
  const entryRows = logs.slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(l => { const d = new Date(l.timestamp); return [csvDate(d), csvTime(d), l.type, l.note || ""].map(csvCell).join(","); });
  const weightRows = weights.slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(w => { const d = new Date(w.timestamp); return [csvDate(d), csvTime(d), Number(w.weightKg).toFixed(1)].map(csvCell).join(","); });

  const csv = [
    "Entries", "date,time,type,note", ...entryRows,
    "", "Weights", "date,time,weight_kg", ...weightRows
  ].join("\n");
  triggerDownload(csv, "text/csv", `mealfast-${dateStamp()}.csv`);
  showToast("CSV exported");
}

// Replace all data from a parsed backup object. Returns true on success.
function applyImportedData(data) {
  const ok = data && (Array.isArray(data.logs) || Array.isArray(data.weights) || Array.isArray(data.schedule));
  if (!ok) { showToast("Not a MealFast backup"); return false; }
  logs = Array.isArray(data.logs) ? data.logs : [];
  weights = Array.isArray(data.weights) ? data.weights : [];
  schedule = migrateSchedule(Array.isArray(data.schedule) ? data.schedule : defaultSchedule());
  save(STORE_KEYS.logs, logs);
  save(STORE_KEYS.weights, weights);
  save(STORE_KEYS.schedule, schedule);
  renderLogs(); renderSchedule(); populateWeightSelect(); renderTimer();
  drawWeightChart(); drawFastChart();
  return true;
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { showToast("Couldn't read that file"); return; }
    if (!data || (!Array.isArray(data.logs) && !Array.isArray(data.weights) && !Array.isArray(data.schedule))) {
      showToast("Not a MealFast backup"); return;
    }
    if (!confirm("Replace all current MealFast data with this backup? This cannot be undone.")) return;
    if (applyImportedData(data)) showToast("Backup imported");
  };
  reader.onerror = () => showToast("Couldn't read that file");
  reader.readAsText(file);
}

document.getElementById("exportBtn").addEventListener("click", exportData);
document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
document.getElementById("importFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importData(file);
  e.target.value = "";   // allow re-importing the same file name later
});

/* ---------- Google Drive backup ---------- */
const GDRIVE_CLIENT_ID = "806898124104-agpuoau8aruceh5tte1hj079gjukr1r7.apps.googleusercontent.com";
const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GDRIVE_FILE_NAME = "mealfast-backup.json";
const GD = { connected: "mf_gd_connected", last: "mf_gd_last", fileId: "mf_gd_fileid", err: "mf_gd_err" };
const BACKUP_INTERVAL_MS = 24 * 3600000;

function relTime(iso) {
  if (!iso) return null;
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

let gdTokenClient = null, gdAccessToken = null, gdTokenExpiry = 0;
function gdReady() { return typeof google !== "undefined" && google.accounts && google.accounts.oauth2; }

// Acquire an access token, then run cb(token).
// - Reuses a still-valid cached token so repeat syncs don't re-prompt at all.
// - Uses prompt:"" (never "consent"): Google shows the account/consent screen
//   only the FIRST time (or if you revoke access) — afterwards it's silent.
function gdGetToken(interactive, cb, onFail) {
  if (gdAccessToken && Date.now() < gdTokenExpiry) { cb(gdAccessToken); return; }
  if (!gdReady()) { if (onFail) onFail("Google sign-in still loading — try again"); return; }
  if (!gdTokenClient) {
    gdTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GDRIVE_CLIENT_ID, scope: GDRIVE_SCOPE, callback: () => {}
    });
  }
  gdTokenClient.callback = (resp) => {
    if (resp && resp.access_token) {
      gdAccessToken = resp.access_token;
      const ttl = (resp.expires_in ? resp.expires_in * 1000 : 3600000) - 60000; // 1-min safety buffer
      gdTokenExpiry = Date.now() + Math.max(0, ttl);
      cb(resp.access_token);
    } else if (onFail) onFail("no token");
  };
  gdTokenClient.error_callback = (err) => { if (onFail) onFail((err && err.type) || "auth error"); };
  try { gdTokenClient.requestAccessToken({ prompt: "" }); }
  catch (e) { if (onFail) onFail("popup blocked"); }
}

function gdBackupBody() {
  return JSON.stringify({ app: "MealFast", version: 1, exportedAt: new Date().toISOString(), logs, weights, schedule });
}

function gdPatch(token, id, body, done, fail) {
  fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body
  }).then(r => { if (!r.ok) throw 0; return r.json(); }).then(() => done()).catch(() => fail());
}

function gdCreate(token, body, done, fail) {
  const boundary = "mfb" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: GDRIVE_FILE_NAME, mimeType: "application/json" });
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart
  }).then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(j => { if (j.id) localStorage.setItem(GD.fileId, j.id); done(); })
    .catch(() => fail());
}

// Find the app's existing backup file id (survives a localStorage wipe), else null.
function gdFindFile(token) {
  const q = encodeURIComponent(`name='${GDRIVE_FILE_NAME}' and trashed=false`);
  return fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`, {
    headers: { Authorization: "Bearer " + token }
  }).then(r => r.json()).then(j => (j.files && j.files[0] && j.files[0].id) || null);
}

function gdUpload(token, done, fail) {
  const body = gdBackupBody();
  const id = localStorage.getItem(GD.fileId);
  const create = () => gdCreate(token, body, done, fail);
  if (id) {
    gdPatch(token, id, body, done, () => {           // stale id? drop it and re-resolve
      localStorage.removeItem(GD.fileId);
      gdFindFile(token).then(fid => fid ? gdPatch(token, fid, body, () => { localStorage.setItem(GD.fileId, fid); done(); }, create) : create()).catch(create);
    });
  } else {
    gdFindFile(token).then(fid => fid ? gdPatch(token, fid, body, () => { localStorage.setItem(GD.fileId, fid); done(); }, create) : create()).catch(create);
  }
}

function gdBackup(interactive) {
  gdGetToken(interactive, (token) => {
    gdUpload(token, () => {
      localStorage.setItem(GD.last, new Date().toISOString());  // last-known-good
      localStorage.setItem(GD.connected, "1");
      localStorage.removeItem(GD.err);
      renderBackupStatus();
      if (interactive) showToast("Backed up to Drive");
    }, () => {
      localStorage.setItem(GD.err, "Last sync failed — will retry");  // keep previous GD.last
      renderBackupStatus();
      if (interactive) showToast("Drive backup failed");
    });
  }, (msg) => {
    localStorage.setItem(GD.err, "Sign-in needed to sync");
    renderBackupStatus();
    if (interactive) showToast("Google sign-in: " + msg);
  });
}

function gdRestore() {
  gdGetToken(true, (token) => {
    const apply = (data) => {
      if (!confirm("Replace all current data with the backup from Google Drive?")) return;
      if (applyImportedData(data)) { renderBackupStatus(); showToast("Restored from Drive"); }
    };
    const pull = (id) => fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { Authorization: "Bearer " + token }
    }).then(r => {
      if (r.status === 404) throw "stale";   // cached id points to a deleted file
      return r.json();
    }).then(apply);

    // Re-find the file by name (used first-time, or as fallback if the id is stale).
    const findAndPull = () => gdFindFile(token).then(fid => {
      if (!fid) { showToast("No Drive backup found"); return; }
      localStorage.setItem(GD.fileId, fid);
      return pull(fid);
    });

    const id = localStorage.getItem(GD.fileId);
    if (id) {
      pull(id).catch(err => {
        if (err === "stale") { localStorage.removeItem(GD.fileId); return findAndPull(); }
        showToast("Restore failed");
      });
    } else {
      findAndPull().catch(() => showToast("Restore failed"));
    }
  }, (msg) => showToast("Drive: " + msg));
}

// On open: if connected and it's been > 24h, quietly refresh the Drive backup.
function gdMaybeAutoBackup() {
  if (localStorage.getItem(GD.connected) !== "1") return;
  const last = localStorage.getItem(GD.last);
  const lastMs = last ? new Date(last).getTime() : 0;
  if (Date.now() - lastMs < BACKUP_INTERVAL_MS) return;
  gdBackup(false);
}

function renderBackupStatus() {
  const area = document.getElementById("gdriveArea");
  if (!area) return;
  const connected = localStorage.getItem(GD.connected) === "1";
  const err = localStorage.getItem(GD.err);
  const errLine = err ? `<div class="gd-err">${err}</div>` : "";

  if (!connected) {
    area.innerHTML = `<button id="gdConnectBtn" class="eat-btn primary">Connect Google Drive</button>${errLine}`;
    document.getElementById("gdConnectBtn").addEventListener("click", () => gdBackup(true));
    return;
  }

  const rel = relTime(localStorage.getItem(GD.last));
  const status = rel ? `Last synced: ${rel}` : "Connected · not synced yet";
  area.innerHTML = `
    <div class="gd-status">${status}</div>
    <div class="backup-row">
      <button id="gdBackupBtn" class="eat-btn">Sync now</button>
      <button id="gdRestoreBtn" class="eat-btn">Restore from Drive</button>
    </div>
    ${errLine}
    <button id="gdDisconnectBtn" class="gd-disconnect">Disconnect Drive</button>`;
  document.getElementById("gdBackupBtn").addEventListener("click", () => gdBackup(true));
  document.getElementById("gdRestoreBtn").addEventListener("click", gdRestore);
  document.getElementById("gdDisconnectBtn").addEventListener("click", () => {
    [GD.connected, GD.last, GD.fileId, GD.err].forEach(k => localStorage.removeItem(k));
    renderBackupStatus();
  });
}
renderBackupStatus();

// GIS script loads async; once ready, run the daily auto-backup check.
(function waitForGis() {
  let tries = 0;
  const t = setInterval(() => {
    if (gdReady()) { clearInterval(t); gdMaybeAutoBackup(); }
    else if (++tries > 20) clearInterval(t);
  }, 500);
})();

/* ---------- Service worker registration ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
