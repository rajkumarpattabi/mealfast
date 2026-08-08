/* ---------- Storage helpers (all data stays in this browser, on this device) ---------- */
const STORE_KEYS = { logs: "mf_logs", weights: "mf_weights", waist: "mf_waist", schedule: "mf_schedule", wtarget: "mf_wtarget" };
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
let waist = load(STORE_KEYS.waist, []);   // [{id, cm, timestamp}] — optional waist measurements
let schedule = migrateSchedule(load(STORE_KEYS.schedule, defaultSchedule()));
save(STORE_KEYS.schedule, schedule);
// Weight target: { dir: "off"|"reduce"|"increase", rate: kg per week }
let wtarget = load(STORE_KEYS.wtarget, { dir: "off", rate: 0.5 });

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
// Shown in the greeting. Read from README.md ("## Set the User Name") so anyone
// cloning the repo can personalise it by editing the README — no code changes.
// Falls back to the last-known name (cached) or "Raj" while offline / on first load.
let USER_NAME = localStorage.getItem("mf_username") || "Raj";

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
}

// Pull the display name from README.md: the first non-empty line under a
// "## Set the User Name" heading. Returns null if the section isn't found.
function parseUserName(md) {
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s*Set the User Name\s*$/i.test(lines[i].trim())) {
      let inFence = false;
      for (let j = i + 1; j < lines.length; j++) {
        let v = lines[j].trim();
        if (v.startsWith("```")) { inFence = !inFence; continue; }   // skip fenced blocks
        if (inFence) continue;
        if (!v) continue;
        if (/^#{1,6}\s/.test(v)) return null;      // next heading — no name given
        v = v.replace(/^[-*>|\s]+/, "").replace(/[`*_]/g, "").trim();
        if (v) return v;
      }
    }
  }
  return null;
}

async function loadUserName() {
  try {
    const res = await fetch("README.md", { cache: "no-store" });
    if (!res.ok) return;
    const name = parseUserName(await res.text());
    if (!name) return;
    localStorage.setItem("mf_username", name);
    if (name !== USER_NAME) { USER_NAME = name; updateGreeting(new Date()); }
  } catch (e) { /* offline: keep the cached / default name */ }
}
loadUserName();

/* ---- Fasting-stage background art (driven by ELAPSED hours, not goal %) ---- */
const ART_OPACITY = 0.16;
const STAGE_ART = {
  digesting:      `<svg viewBox="0 0 100 100" class="art-svg"><circle cx="50" cy="70" r="22"/><circle cx="50" cy="70" r="13"/></svg>`,
  postabsorptive: `<svg viewBox="0 0 100 100" class="art-svg"><line x1="50" y1="50" x2="50" y2="84"/><path d="M36,70 L50,86 L64,70"/></svg>`,
  glycogen:       `<svg viewBox="0 0 100 100" class="art-svg"><polygon points="50,70 44,80.4 32,80.4 26,70 32,59.6 44,59.6"/><polygon points="74,70 68,80.4 56,80.4 50,70 56,59.6 68,59.6"/></svg>`,
  fat:            `<svg viewBox="0 0 100 100" class="art-svg"><path d="M50,50 C62,68 62,82 50,88 C38,82 38,68 50,50 Z"/></svg>`,
  earlyketosis:   `<svg viewBox="0 0 100 100" class="art-svg"><circle cx="40" cy="70" r="9"/><circle cx="64" cy="70" r="9"/><line x1="49" y1="70" x2="55" y2="70"/></svg>`,
  ketosis:        `<svg viewBox="0 0 100 100" class="art-svg"><line x1="50" y1="58" x2="38" y2="78"/><line x1="50" y1="58" x2="62" y2="78"/><line x1="38" y1="78" x2="62" y2="78"/><circle cx="50" cy="58" r="6"/><circle cx="38" cy="78" r="6"/><circle cx="62" cy="78" r="6"/></svg>`,
  autophagy:      `<svg viewBox="0 0 100 100" class="art-svg"><circle cx="50" cy="70" r="22"/><path d="M40,62 A12,12 0 1 0 44,58"/><circle cx="50" cy="70" r="5"/></svg>`,
  deep:           `<svg viewBox="0 0 100 100" class="art-svg"><line x1="50" y1="92" x2="50" y2="64"/><path d="M50,74 C40,74 33,66 35,58 C45,58 50,66 50,74 Z"/><path d="M50,70 C60,70 67,62 65,54 C55,54 50,62 50,70 Z"/></svg>`
};
// Elapsed-hour fasting stages. The 4–18h window is split finely since that's
// where most fasts live. Names kept physiologically accurate (no invented terms).
function stageForHours(h) {
  if (h < 4)  return { key: "digesting",      name: "Digesting" };
  if (h < 8)  return { key: "postabsorptive", name: "Post-Absorptive" };
  if (h < 12) return { key: "glycogen",       name: "Glycogen Burning" };
  if (h < 16) return { key: "fat",            name: "Fat Burning" };
  if (h < 18) return { key: "earlyketosis",   name: "Early Ketosis" };
  if (h < 24) return { key: "ketosis",        name: "Ketosis" };
  if (h < 48) return { key: "autophagy",      name: "Autophagy Rising" };
  return { key: "deep", name: "Deep Autophagy" };
}

// The next fasting stage and how long until it begins, given elapsed ms.
// Returns null once you're in the deepest stage (nothing further to count to).
const STAGE_BOUNDS_H = [4, 8, 12, 16, 18, 24, 48];
function nextStageInfo(elapsedMs) {
  const h = elapsedMs / 3600000;
  for (const bh of STAGE_BOUNDS_H) {
    if (h < bh) return { name: stageForHours(bh).name, ms: bh * 3600000 - elapsedMs };
  }
  return null;
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
  const el = document.getElementById("streakBadge");
  if (!el) return;                       // badge removed from the header
  const streak = weeklyStreak(now);
  el.textContent = `${streak.hit}/${streak.total} this week`;
}

// On-target days this calendar month (same rule as weeklyStreak).
function monthlyStreak(now) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const eats = eatsAscending();
  const nowMs = now.getTime();
  let hit = 0, total = 0;
  for (let d = new Date(monthStart); d <= now; d.setDate(d.getDate() + 1)) {
    const r = dayFastEval(new Date(d), eats, nowMs);
    if (!r.counted) continue;
    total++;
    if (r.onTarget) hit++;
  }
  return { hit, total };
}

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// "3–9 Aug" (or "31 Jul – 6 Aug" when the week spans two months)
function weekRangeLabel(now) {
  const start = new Date(now); start.setDate(now.getDate() - now.getDay()); start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()}–${end.getDate()} ${MON[end.getMonth()]}`;
  }
  return `${start.getDate()} ${MON[start.getMonth()]} – ${end.getDate()} ${MON[end.getMonth()]}`;
}

// Box (c) shows weekly or monthly consistency; tapping it flips the period.
let periodMode = localStorage.getItem("mf_period_mode") === "month" ? "month" : "week";
function renderPeriodBox(now) {
  const lbl = document.getElementById("perLabel");
  const val = document.getElementById("perVal");
  const sub = document.getElementById("perDate");
  if (!lbl) return;
  if (periodMode === "month") {
    const m = monthlyStreak(now);
    lbl.textContent = "This Month";
    val.textContent = `${m.hit}/${m.total}`;
    sub.textContent = `${MON[now.getMonth()]} ${now.getFullYear()}`;
  } else {
    const w = weeklyStreak(now);
    lbl.textContent = "This Week";
    val.textContent = `${w.hit}/${w.total}`;
    sub.textContent = weekRangeLabel(now);
  }
}

// Render the fasting-stage name + subtle icon into box (a).
let currentBoxArt = "__init";
function setStageBox(name, key) {
  const nameEl = document.getElementById("stageName");
  const iconEl = document.getElementById("stageIcon");
  if (nameEl) nameEl.textContent = name;
  if (iconEl && key !== currentBoxArt) {
    currentBoxArt = key;
    let svg = key ? (STAGE_ART[key] || "") : "";
    // Reframe the 0..100 art onto a tighter, vertically-centred viewBox so the
    // stage art fills the square without its bottom being clipped.
    if (svg) svg = svg.replace('viewBox="0 0 100 100"', 'viewBox="24 45 58 52"');
    iconEl.innerHTML = svg;
  }
}

function renderTimer() {
  let logsChanged = autoCloseStaleEating();
  if (autoCapStaleFast()) logsChanged = true;
  if (logsChanged) renderLogs();
  const now = new Date();
  const state = rollingFastState(now);
  updateGreeting(now);

  const ring = document.getElementById("ringProgress");
  const countdown = document.getElementById("countdownText");
  const pctEl = document.getElementById("timerPct");
  const tglLabel = document.getElementById("tglLabel");
  const tglIn = document.getElementById("tglIn");
  const tglVal = document.getElementById("tglVal");
  const noSchedule = document.getElementById("noScheduleNote");

  // Box (b): countdown to the next fasting stage (set per phase below).
  const setNextBox = (label, showIn, val) => {
    tglLabel.textContent = label;
    tglIn.style.display = showIn ? "" : "none";
    tglVal.textContent = val;
  };

  // Box (c) — weekly/monthly consistency — updates in every phase.
  renderPeriodBox(now);

  if (state.phase === "none") {
    noSchedule.hidden = false;
    noSchedule.innerHTML = "No meals logged yet. Tap <strong>Ended eating</strong> below when you finish your last meal to start your fast.";
    countdown.textContent = "--:--:--";
    pctEl.textContent = "Log your last meal to begin";
    // Ring visuals unchanged from the original.
    ring.style.stroke = "var(--turmeric)";
    ring.style.strokeDashoffset = RING_CIRC;
    setRingDot(0, "", false);
    setStageBox("Ready", null);
    setNextBox("Next phase", false, "--:--:--");
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

    // --- Ring progress & colour: unchanged from the original design ---
    ring.style.stroke = col;
    ring.style.strokeDashoffset = RING_CIRC * (1 - frac);

    setStageBox(stage.name, stage.key);

    // Box (b): countdown to the NEXT fasting stage (same in fasting + extended).
    const nx = nextStageInfo(elapsed);
    if (nx) setNextBox(nx.name, true, formatHMS(nx.ms));
    else    setNextBox(stage.name, false, "deepest");   // already in the final stage

    // Circle: tap the ring to flip between Remaining and Elapsed emphasis.
    const pctDone = Math.min(100, Math.round(frac * 100));
    if (state.phase === "fasting") {
      setRingDot(frac, col, true);
      if (timerMode === "elapsed") {
        countdown.textContent = formatHMS(elapsed);
        pctEl.textContent = `${pctDone}% of goal`;
      } else {
        countdown.textContent = formatHMS(remaining);
        pctEl.textContent = `${Math.max(0, 100 - pctDone)}% to go`;
      }
    } else {   // goal reached — extended fast (circle counts up)
      setRingDot(0, "", false);   // ring is full; no leading dot
      const over = elapsed - total;
      countdown.textContent = formatHMS(elapsed);
      pctEl.textContent = over > 60000 ? `Goal +${relFast(over)}` : "Goal reached";
    }
  } else {
    // Actively eating — ring visuals unchanged from the original.
    ring.style.stroke = "var(--leaf)";
    ring.style.strokeDashoffset = 0;
    setRingDot(0, "", false);
    countdown.textContent = formatHMS(now - state.eatingSince);
    pctEl.textContent = "Eating window";
    setStageBox("Eating", null);
    setNextBox("Next phase", false, "—");
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

// Tap the ring (or the middle box) to flip between Remaining and Fasting emphasis.
function flipTimerMode() {
  timerMode = timerMode === "elapsed" ? "remaining" : "elapsed";
  localStorage.setItem("mf_timer_mode", timerMode);
  renderTimer();
}
document.getElementById("ringWrap").addEventListener("click", flipTimerMode);

// Tap the third box to switch between weekly and monthly consistency.
document.getElementById("periodBox").addEventListener("click", () => {
  periodMode = periodMode === "month" ? "week" : "month";
  localStorage.setItem("mf_period_mode", periodMode);
  renderPeriodBox(new Date());
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
    if (btn.dataset.tab === "trends") { renderInsight(); drawWeightChart(); renderFastCard(); renderHeatmap(); }
    if (btn.dataset.tab === "schedule") { renderSchedule(); renderWeightTarget(); renderBackupStatus(); }
    if (btn.dataset.tab === "logs") { renderLogs(); }
    if (btn.dataset.tab === "entries") { populateWeightSelect(); populateWaistSelect(); }
  });
});

/* ---------- Entries tab: log a meal / drink ---------- */

function toDateInput(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function toTimeInput(d) {
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toLocalInputValue(date) {   // used by the edit sheet's datetime-local
  return `${toDateInput(date)}T${toTimeInput(date)}`;
}

// Reset the date/time inputs to "now" (called on load + after each save).
function resetEntryDateTime() {
  const now = new Date();
  document.getElementById("exactDate").value = toDateInput(now);
  document.getElementById("exactTime").value = toTimeInput(now);
}

// Save a meal/drink log at the given time, using the current note field.
function saveMealLog(when) {
  const noteEl = document.getElementById("noteInput");
  const note = noteEl.value.trim();
  logs.unshift({ id: uid(), type: "Meal", note, timestamp: when.toISOString() });
  save(STORE_KEYS.logs, logs);
  noteEl.value = "";
  resetEntryDateTime();
  renderLogs();
  renderTimer();      // a new meal changes the current fast immediately
  showToast("Logged");
}

// One-click quick buttons: log instantly at (now − N minutes).
document.getElementById("quickRow").addEventListener("click", (e) => {
  const b = e.target.closest(".quick-btn");
  if (!b) return;
  const mins = parseInt(b.dataset.min, 10);
  saveMealLog(new Date(Date.now() - mins * 60000));
});

// Save button: log at the date & time shown in the inputs (defaults to now).
document.getElementById("saveLogBtn").addEventListener("click", () => {
  const dv = document.getElementById("exactDate").value;
  const tv = document.getElementById("exactTime").value;
  const d = (dv && tv) ? new Date(`${dv}T${tv}`) : new Date();
  if (isNaN(d.getTime())) { showToast("Enter a valid date & time"); return; }
  saveMealLog(d);
});

resetEntryDateTime();

// Collapse state for the Logs tab sections (Today open by default).
const logSectionsOpen = { today: true, week: false, older: false };

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
  waist.forEach(x => items.push({
    kind: "waist", id: x.id, when: new Date(x.timestamp),
    type: "Waist", note: "",
    value: `${Number(x.cm).toFixed(1)} cm`
  }));
  items.sort((a,b) => b.when - a.when);

  list.innerHTML = "";
  if (items.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;

  // Group into Today / This Week (past 6 days) / Older (7+ days ago).
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const weekBound = todayStart.getTime() - 6 * 86400000;   // start of the day 6 days ago
  const groups = { today: [], week: [], older: [] };
  items.forEach(it => {
    const t = it.when.getTime();
    if (t >= todayStart.getTime()) groups.today.push(it);
    else if (t >= weekBound) groups.week.push(it);
    else groups.older.push(it);
  });

  const sections = [
    { key: "today", title: "Today",     items: groups.today, always: true },
    { key: "week",  title: "This Week", items: groups.week },
    { key: "older", title: "Older",     items: groups.older }
  ];

  sections.forEach(sec => {
    if (!sec.always && sec.items.length === 0) return;
    const open = logSectionsOpen[sec.key];

    const secEl = document.createElement("div");
    secEl.className = "log-section";

    const head = document.createElement("button");
    head.className = "log-sec-head" + (open ? " open" : "");
    head.innerHTML =
      `<span class="log-sec-chev">▸</span>` +
      `<span class="log-sec-title">${sec.title}</span>` +
      `<span class="log-sec-count">${sec.items.length}</span>`;
    head.addEventListener("click", () => {
      logSectionsOpen[sec.key] = !logSectionsOpen[sec.key];
      renderLogs();
    });
    secEl.appendChild(head);

    const body = document.createElement("div");
    body.className = "log-sec-body";
    if (!open) body.hidden = true;
    if (sec.items.length === 0) {
      body.innerHTML = `<div class="log-sec-empty">No entries yet today.</div>`;
    } else {
      const ul = document.createElement("ul");
      ul.className = "log-list";
      sec.items.forEach(it => ul.appendChild(buildLogItem(it)));
      body.appendChild(ul);
    }
    secEl.appendChild(body);
    list.appendChild(secEl);
  });
}

// Build one log row (with its tap-to-edit handler).
function buildLogItem(it) {
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
  li.addEventListener("click", () => openEditSheet(li.dataset.kind, li.dataset.id));
  return li;
}

// Re-render everything that depends on logs/weights after an edit or delete.
function afterEntryChange() {
  renderLogs();
  renderTimer();       // fasting phase + streak recompute from the changed data
  drawWeightChart();   // trends stay in sync (guarded no-op when Trends is hidden)
  renderFastCard();
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

// Reset the weight date/time inputs to "now".
function resetWeightDateTime() {
  const now = new Date();
  document.getElementById("weightDate").value = toDateInput(now);
  document.getElementById("weightTime").value = toTimeInput(now);
}

function populateWeightSelect() {
  const sel = document.getElementById("weightSelect");
  const last = weights.length ? weights[weights.length - 1].weightKg : 70;
  const def = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(last * 10) / 10));
  const defStr = def.toFixed(1);
  sel.innerHTML = weightOptionsHtml(defStr);
  sel.value = defStr;
  setWeightPicked(false);   // reset to the blank placeholder state
  resetWeightDateTime();
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
  const dv = document.getElementById("weightDate").value;
  const tv = document.getElementById("weightTime").value;
  const when = (dv && tv) ? new Date(`${dv}T${tv}`) : new Date();
  if (isNaN(when.getTime())) { showToast("Enter a valid date & time"); return; }
  weights.push({ id: uid(), weightKg: val, timestamp: when.toISOString() });
  weights.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  save(STORE_KEYS.weights, weights);
  populateWeightSelect();   // resets to blank; default now reflects the saved weight
  drawWeightChart();        // safe if the Trends tab isn't visible (guarded below)
  showToast("Weight saved");
});

/* ---------- Waist logging (Entries tab) ---------- */
const WAIST_MIN = 40, WAIST_MAX = 160;   // cm, 0.5-cm steps

function setWaistPicked(picked) {
  const f = document.getElementById("waistField");
  if (f) f.classList.toggle("picked", picked);
}
function waistOptionsHtml(selStr) {
  let out = "";
  for (let i = 0; i <= (WAIST_MAX - WAIST_MIN) * 2; i++) {
    const s = (WAIST_MIN + i / 2).toFixed(1);
    out += `<option value="${s}"${s === selStr ? " selected" : ""}>${s} cm</option>`;
  }
  return out;
}
function resetWaistDateTime() {
  const now = new Date();
  document.getElementById("waistDate").value = toDateInput(now);
  document.getElementById("waistTime").value = toTimeInput(now);
}
function populateWaistSelect() {
  const sel = document.getElementById("waistSelect");
  if (!sel) return;
  const last = waist.length ? waist[waist.length - 1].cm : 85;
  const def = Math.min(WAIST_MAX, Math.max(WAIST_MIN, Math.round(last * 2) / 2));
  const defStr = def.toFixed(1);
  sel.innerHTML = waistOptionsHtml(defStr);
  sel.value = defStr;
  setWaistPicked(false);
  resetWaistDateTime();
}
populateWaistSelect();
document.getElementById("waistSelect").addEventListener("focus", () => setWaistPicked(true));
document.getElementById("waistSelect").addEventListener("change", () => setWaistPicked(true));

document.getElementById("saveWaistBtn").addEventListener("click", () => {
  const field = document.getElementById("waistField");
  if (!field.classList.contains("picked")) { showToast("Tap the field to set your waist"); return; }
  const val = parseFloat(document.getElementById("waistSelect").value);
  if (isNaN(val)) return;
  const dv = document.getElementById("waistDate").value;
  const tv = document.getElementById("waistTime").value;
  const when = (dv && tv) ? new Date(`${dv}T${tv}`) : new Date();
  if (isNaN(when.getTime())) { showToast("Enter a valid date & time"); return; }
  waist.push({ id: uid(), cm: val, timestamp: when.toISOString() });
  waist.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  save(STORE_KEYS.waist, waist);
  populateWaistSelect();
  drawWeightChart();
  showToast("Waist saved");
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
  } else if (kind === "waist") {
    const x = waist.find(v => v.id === id);
    if (!x) return;
    title.textContent = "Edit waist";
    const cur = (Math.round(Number(x.cm) * 2) / 2).toFixed(1);
    body.innerHTML = `
      <label class="edit-label">Waist (cm)</label>
      <select id="editWaist" class="edit-input">${waistOptionsHtml(cur)}</select>
      <label class="edit-label">Date &amp; time</label>
      <input type="datetime-local" id="editTime" class="edit-input" value="${toLocalInputValue(new Date(x.timestamp))}">`;
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
  } else if (editingKind === "waist") {
    const x = waist.find(v => v.id === editingId);
    if (x) {
      x.cm = parseFloat(document.getElementById("editWaist").value);
      x.timestamp = ts.toISOString();
      waist.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
      save(STORE_KEYS.waist, waist);
      populateWaistSelect();
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
  } else if (editingKind === "waist") {
    const idx = waist.findIndex(x => x.id === editingId);
    if (idx >= 0) {
      const removed = waist[idx];
      waist.splice(idx, 1);
      save(STORE_KEYS.waist, waist);
      populateWaistSelect();
      restore = () => {
        waist.push(removed);
        waist.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
        save(STORE_KEYS.waist, waist);
        populateWaistSelect();
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
  const padL = 56, padR = 12, padT = 12, padB = 42;
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

  // Y-axis unit title: rotated vertical and centred, clear of the tick numbers.
  ctx.save();
  ctx.translate(12, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = TICK;
  ctx.fillText(yUnit, 0, 0);
  ctx.restore();

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
let measureMode = localStorage.getItem("mf_measure_mode") === "waist" ? "waist" : "weight";  // weight | waist toggle on the trend card
let fastMode = localStorage.getItem("mf_fast_mode") === "stages" ? "stages" : "duration";     // duration | stages toggle on the fasting card

// Ordered oldest→newest buckets for the selected range.
function trendBuckets(range, now) {
  const buckets = [];
  if (range === "week") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
      buckets.push({ label: fmtDate(d), day: new Date(d), start: d.getTime(), end: d.getTime() + 86400000 - 1 });
    }
  } else if (range === "month") {
    for (let i = 29; i >= 0; i--) {                      // last 30 days, one bucket per day
      const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
      buckets.push({ label: fmtDate(d), day: new Date(d), start: d.getTime(), end: d.getTime() + 86400000 - 1 });
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

// Bucket weight value: collapse each date to its HIGHEST weigh-in, then average
// those per-date values across the bucket. null if none. (For the Week view each
// bucket is a single date, so this is simply that day's highest weigh-in.)
function seriesAvgInRange(arr, key, startMs, endMs) {
  const byDate = {};
  arr.forEach(w => {
    const t = new Date(w.timestamp).getTime();
    if (t < startMs || t > endMs) return;
    const d = new Date(w.timestamp).toDateString();
    const v = Number(w[key]);
    if (byDate[d] == null || v > byDate[d]) byDate[d] = v;   // highest-per-date, then averaged
  });
  const vals = Object.values(byDate);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function weightAvgInRange(startMs, endMs) { return seriesAvgInRange(weights, "weightKg", startMs, endMs); }

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
  if (bucket.day) {                                    // single-day bucket (Week + Month)
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
  const isWaist = measureMode === "waist";
  const buckets = trendBuckets(trendRange, new Date());
  const ys = buckets.map(b => isWaist
    ? seriesAvgInRange(waist, "cm", b.start, b.end)
    : weightAvgInRange(b.start, b.end));
  const present = ys.filter(v => v != null);
  empty.textContent = isWaist ? "No waist entries in this range." : "No weight entries in this range.";
  if (present.length === 0) { empty.hidden = false; canvas.style.display = "none";
    document.getElementById("weightLegend").hidden = true;
    document.getElementById("weightStatus").hidden = true; return; }
  empty.hidden = true; canvas.style.display = "block";
  if (canvas.clientWidth === 0) return;   // Trends tab hidden — will redraw on show

  // Weight target trajectory (weight only — waist has no target line).
  const wt = isWaist ? null : weightTargetLine(buckets);   // { active, targetYs, baseKg, targetToday } | null
  const scaleVals = present.slice();
  if (wt) buckets.forEach((b, i) => { if (wt.targetYs[i] != null) scaleVals.push(wt.targetYs[i]); });

  const scale = niceScale(Math.min(...scaleVals), Math.max(...scaleVals), 4);
  const { ctx, W, H } = prepCanvas(canvas, 210);
  const a = drawAxes(ctx, W, H, scale, buckets.map(b => b.label), isWaist ? "cm" : "kg", "line");

  // Target line (leaf green).
  if (wt) {
    ctx.save();
    ctx.strokeStyle = "#6E9B72"; ctx.lineWidth = 2; ctx.setLineDash([2, 3]);
    ctx.beginPath();
    let stt = false;
    wt.targetYs.forEach((v, i) => {
      if (v == null) return;
      const x = a.sx(i), y = a.sy(v);
      if (!stt) { ctx.moveTo(x, y); stt = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Rolling average (trailing, up to 3 present points) — smooths daily noise.
  const showAvg = present.length >= 3;
  if (showAvg) {
    const seen = [];
    const avg = ys.map(v => {
      if (v == null) return null;
      seen.push(v);
      const w = seen.slice(-3);
      return w.reduce((s, x) => s + x, 0) / w.length;
    });
    ctx.save();
    ctx.strokeStyle = "rgba(242,237,228,0.55)";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    let st = false;
    avg.forEach((v, i) => {
      if (v == null) return;
      const x = a.sx(i), y = a.sy(v);
      if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Raw weight line + points.
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

  // Legend + target status.
  const legend = document.getElementById("weightLegend");
  if (legend) {
    legend.hidden = !(showAvg || (wt && wt.active));
    const solidLabel = document.getElementById("lgSolidLabel");
    if (solidLabel) solidLabel.textContent = isWaist ? "waist" : "weight";
    const avgItem = legend.querySelector(".lg-item-avg");
    const tgtItem = legend.querySelector(".lg-item-target");
    if (avgItem) avgItem.style.display = showAvg ? "" : "none";
    if (tgtItem) tgtItem.style.display = (wt && wt.active) ? "" : "none";
  }
  const statusEl = document.getElementById("weightStatus");
  if (statusEl) {
    if (wt && wt.active) {
      const latest = Number(weights[weights.length - 1].weightKg);
      const ahead = wtarget.dir === "reduce" ? (wt.targetToday - latest) : (latest - wt.targetToday);
      const word = ahead >= -0.05 ? "ahead of" : "behind";
      statusEl.textContent = `Target: ${wtarget.dir} ${wtarget.rate} kg/wk · ${Math.abs(ahead).toFixed(1)} kg ${word} target`;
      statusEl.style.color = ahead >= -0.05 ? "#6E9B72" : "var(--chili)";
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }
}

// Compute the target weight for each bucket from the first weigh-in + rate.
function weightTargetLine(buckets) {
  if (wtarget.dir === "off" || weights.length === 0) return null;
  const base = weights[0];                       // earliest weigh-in = baseline
  const baseKg = Number(base.weightKg);
  const baseMs = new Date(base.timestamp).getTime();
  const sign = wtarget.dir === "reduce" ? -1 : 1;
  const at = ms => baseKg + sign * wtarget.rate * ((ms - baseMs) / (7 * 86400000));   // baseKg ± rate·weeks
  const repMs = b => b.day ? (b.day.getTime() + 43200000) : (b.start + b.end) / 2;
  // Start the target line at the first weigh-in — never extrapolate it backwards
  // onto dates before you had any weight logged.
  const targetYs = buckets.map(b => (b.end < baseMs ? null : at(Math.max(repMs(b), baseMs))));
  return { active: true, targetYs, baseKg, targetToday: at(Date.now()) };
}

function drawFastChart() {
  const canvas = document.getElementById("fastChart");
  const empty = document.getElementById("fastEmpty");
  const now = new Date(), nowMs = now.getTime();
  const isWeek = trendRange === "week";
  const isYear = trendRange === "year";
  const buckets = trendBuckets(trendRange, now);
  const eats = eatsAscending();

  // Week/Month: actual fast hours per bar. Year: monthly adherence % (share of the
  // month's counted days that hit target) — a clearer yearly "how consistent" story
  // than averaging fast lengths, and it pairs with the year heatmap below.
  const data = isYear
    ? buckets.map(b => monthAdherence(b, eats, nowMs))     // {value(0-100), rate}|null
    : buckets.map(b => fastBucketValue(b, isWeek, eats, nowMs));  // {value(hrs),target,met}|null
  const present = data.filter(x => x != null);
  if (present.length === 0) { empty.hidden = false; canvas.style.display = "none"; return; }
  empty.hidden = true; canvas.style.display = "block";
  if (canvas.clientWidth === 0) return;

  const scale = isYear
    ? niceScale(0, 100, 4)
    : niceScale(0, Math.max(Math.max(...present.map(x => x.value), 1), Math.max(...present.map(x => x.target), 1)), 4);

  const { ctx, W, H } = prepCanvas(canvas, 210);
  const a = drawAxes(ctx, W, H, scale, buckets.map(b => b.label), isYear ? "% on target" : "hours", "bar");

  const barW = Math.min((a.plotW / buckets.length) * 0.6, 26);
  const base = a.padT + a.plotH;
  data.forEach((x, i) => {
    if (x == null) return;
    const cx = a.sx(i), y = a.sy(x.value), barH = base - y;
    // Year: colour by adherence (red→green gradient). Week/Month: green if met, else red.
    ctx.fillStyle = isYear ? fastColor(x.rate) : (x.met ? fastColor(1) : fastColor(0));
    ctx.fillRect(cx - barW / 2, y, barW, barH);

    // Tiny value label inside the bar — only when bars are wide/sparse enough to
    // read (skipped for the dense 30-day Month view and the 12-bar Year %, which
    // would otherwise overlap; the y-axis carries the scale there).
    if (barW < 12 || isYear) return;
    ctx.font = "600 9px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    const label = isYear ? `${Math.round(x.value)}%` : String(Math.floor(x.value));
    if (barH >= 16) {
      ctx.fillStyle = "#1B2430";       // dark, reads on the bright bar
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, (y + base) / 2);
    } else {                            // bar too short — sit the number just above it
      ctx.fillStyle = TICK;
      ctx.textBaseline = "bottom";
      ctx.fillText(label, cx, y - 2);
    }
  });
}

// Adherence over a bucket's days: share (0–100) of counted days that hit target.
function monthAdherence(bucket, eats, nowMs) {
  let hit = 0, tot = 0;
  const d = new Date(bucket.start); d.setHours(0, 0, 0, 0);
  const end = new Date(bucket.end);
  while (d <= end) {
    const ev = dayFastEval(new Date(d), eats, nowMs);
    if (ev.counted) { tot++; if (ev.onTarget) hit++; }
    d.setDate(d.getDate() + 1);
  }
  return tot ? { value: (hit / tot) * 100, rate: hit / tot, hit, tot } : null;
}

/* ---- Time-in-stage breakdown (Stages toggle on the fasting card) ---- */
// Four grouped bands by elapsed-fast hours. Eating-window time falls here too:
// every gap between consecutive meals restarts at 0h (Warming up), so short
// between-meal gaps pile into Warming up and only long fasts reach the deep bands.
const STAGE_BANDS = [
  { key: "warm", lo: 0,  hi: 12,       name: "Warming up",  cls: "st-warm" },
  { key: "fat",  lo: 12, hi: 18,       name: "Fat-burning", cls: "st-fat" },
  { key: "keto", lo: 18, hi: 24,       name: "Ketosis",     cls: "st-keto" },
  { key: "auto", lo: 24, hi: Infinity, name: "Autophagy",   cls: "st-auto" }
];
const STAGE_GAP_CAP_H = 40;   // ignore stage time past 40h in one gap (likely a missed log)

function stageBandsForRange(range, now) {
  const nowMs = now.getTime();
  const windowDays = range === "week" ? 7 : range === "month" ? 30 : 365;
  const windowStart = nowMs - windowDays * 86400000;
  const eats = eatsAscending().filter(t => t <= nowMs);
  const bands = { warm: 0, fat: 0, keto: 0, auto: 0 };
  let total = 0;

  // Add the stage split of one gap [t0, t1], clipped to the window and capped.
  const addGap = (t0, t1) => {
    const s = Math.max(t0, windowStart), e = Math.min(t1, nowMs);
    if (e <= s) return;
    const startH = (s - t0) / 3600000;
    const endH = Math.min((e - t0) / 3600000, STAGE_GAP_CAP_H);
    if (endH <= startH) return;
    for (const b of STAGE_BANDS) {
      const a = Math.max(startH, b.lo), z = Math.min(endH, b.hi);
      if (z > a) { bands[b.key] += (z - a); total += (z - a); }
    }
  };
  for (let i = 0; i < eats.length - 1; i++) addGap(eats[i], eats[i + 1]);
  if (eats.length) addGap(eats[eats.length - 1], nowMs);   // ongoing fast → now
  return { bands, total };
}

// Compact "3h 48m" / "48m" / "12m" duration label.
function fmtDurH(h) {
  const mins = Math.round(h * 60);
  const H = Math.floor(mins / 60), M = mins % 60;
  if (H === 0) return `${M}m`;
  return M ? `${H}h ${M}m` : `${H}h`;
}

function renderStageBreakdown() {
  const host = document.getElementById("stageBreakdown");
  if (!host) return;
  const { bands, total } = stageBandsForRange(trendRange, new Date());
  if (total <= 0) {
    host.innerHTML = `<div class="empty-note">Log some meals to see your stage breakdown.</div>`;
    return;
  }
  const rep = k => bands[k] / total * 24;   // hours in a representative 24-hour day
  const rangeLabel = trendRange === "week" ? "last 7 days" : trendRange === "month" ? "last 30 days" : "last 12 months";
  // One labelled bar per band, stacked to fill the same height as the Duration
  // chart. Each bar's length is that band's share of a 24-hour day.
  let rows = "";
  STAGE_BANDS.forEach(b => {
    const h = rep(b.key), pct = Math.max(0, Math.min(100, h / 24 * 100));
    rows += `<div class="stage-row">` +
      `<div class="stage-row-head"><span class="stage-row-name ${b.cls}-t">${b.name}</span>` +
      `<span class="stage-row-val">${fmtDurH(h)}</span></div>` +
      `<div class="stage-track"><div class="stage-fill ${b.cls}" style="width:${pct}%"></div></div>` +
      `</div>`;
  });
  host.innerHTML =
    `<div class="stage-caption">Average day · ${rangeLabel}</div>` +
    `<div class="stage-rows">${rows}</div>`;
}

// Show the fasting card in whichever mode is active (bars vs stage breakdown).
function renderFastCard() {
  const canvas = document.getElementById("fastChart");
  const emptyD = document.getElementById("fastEmpty");
  const stagesEl = document.getElementById("stageBreakdown");
  if (fastMode === "stages") {
    canvas.style.display = "none";
    if (emptyD) emptyD.hidden = true;
    stagesEl.hidden = false;
    renderStageBreakdown();
  } else {
    stagesEl.hidden = true;
    drawFastChart();   // manages the canvas + its own empty note
  }
}

function setTrendRange(r) {
  trendRange = r;
  localStorage.setItem("mf_trend_range", r);
  document.querySelectorAll("#trendRange .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.range === r));
  drawWeightChart();
  renderFastCard();
  renderHeatmap();
}
document.getElementById("trendRange").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (b) setTrendRange(b.dataset.range);
});
document.querySelectorAll("#trendRange .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.range === trendRange));

// Weight / Waist toggle on the trend card.
function setMeasureMode(m) {
  measureMode = m;
  localStorage.setItem("mf_measure_mode", m);
  document.querySelectorAll("#measToggle .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.meas === m));
  drawWeightChart();
}
document.getElementById("measToggle").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (b) setMeasureMode(b.dataset.meas);
});
document.querySelectorAll("#measToggle .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.meas === measureMode));

// Duration / Stages toggle on the fasting card.
function setFastMode(m) {
  fastMode = m;
  localStorage.setItem("mf_fast_mode", m);
  document.querySelectorAll("#fastToggle .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.fmode === m));
  renderFastCard();
}
document.getElementById("fastToggle").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (b) setFastMode(b.dataset.fmode);
});
document.querySelectorAll("#fastToggle .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.fmode === fastMode));

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

/* ---------- Weight target (Targets tab) ---------- */
function renderWeightTarget() {
  const dir = document.getElementById("wtDir");
  const rate = document.getElementById("wtRate");
  const baseHint = document.getElementById("wtBase");
  if (!dir || !rate) return;

  // rate options 0.1 .. 2.0 kg/week in 0.1 (100 g) steps
  if (!rate.options.length) {
    let out = "";
    for (let i = 1; i <= 20; i++) out += `<option value="${(i/10).toFixed(1)}">${(i/10).toFixed(1)}</option>`;
    rate.innerHTML = out;
  }
  dir.value = wtarget.dir;
  rate.value = wtarget.rate.toFixed(1);
  rate.disabled = wtarget.dir === "off";

  if (weights.length === 0) {
    baseHint.textContent = "Add a weight entry to set your baseline.";
  } else {
    const b = weights[0];
    baseHint.textContent = `Baseline: ${Number(b.weightKg).toFixed(1)} kg on ${fmtDate(new Date(b.timestamp))} (first weigh-in).`;
  }
}
document.getElementById("wtDir").addEventListener("change", (e) => {
  wtarget.dir = e.target.value;
  save(STORE_KEYS.wtarget, wtarget);
  renderWeightTarget();
  drawWeightChart();
});
document.getElementById("wtRate").addEventListener("change", (e) => {
  wtarget.rate = parseFloat(e.target.value);
  save(STORE_KEYS.wtarget, wtarget);
  drawWeightChart();
});
renderWeightTarget();

/* ---------- Weekly insight card (Trends tab) ---------- */
function renderInsight() {
  const el = document.getElementById("insightCard");
  if (!el) return;
  const now = new Date();
  const day = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - day); weekStart.setHours(0, 0, 0, 0);
  const eats = eatsAscending();
  const nowMs = now.getTime();

  // avg actual fast over this week's counted days + adherence
  let sum = 0, n = 0, hit = 0, total = 0;
  for (let d = new Date(weekStart); d <= now; d.setDate(d.getDate() + 1)) {
    const r = dayActualFast(new Date(d), eats, nowMs);
    if (r) { sum += r.hours; n++; }
    const ev = dayFastEval(new Date(d), eats, nowMs);
    if (ev.counted) { total++; if (ev.onTarget) hit++; }
  }
  if (n === 0 && weights.length === 0 && waist.length === 0) { el.hidden = true; return; }
  el.hidden = false;

  // weight change this week (highest per day: last day with data vs first)
  const wkW = weights.filter(w => new Date(w.timestamp).getTime() >= weekStart.getTime());
  let wtxt = "";
  if (wkW.length >= 2) {
    const delta = Number(wkW[wkW.length - 1].weightKg) - Number(wkW[0].weightKg);
    const val = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} kg`;
    // Colour vs. goal: green = met/exceeded weekly rate, red = wrong direction, else neutral.
    let cls = "";
    if (wtarget.dir === "reduce") {
      if (delta > 0.05) cls = "wt-bad";                 // gaining while trying to reduce
      else if (-delta >= wtarget.rate - 0.001) cls = "wt-good"; // met/exceeded weekly loss
    } else if (wtarget.dir === "increase") {
      if (delta < -0.05) cls = "wt-bad";                // losing while trying to gain
      else if (delta >= wtarget.rate - 0.001) cls = "wt-good";  // met/exceeded weekly gain
    }
    const span = cls ? `<span class="${cls}">${val}</span>` : val;
    wtxt = ` <span class="insight-sep">;</span> Weight ${span}`;
  }

  // waist change this week (highest per day: last vs first) — a loss is always "good".
  const wkX = waist.filter(x => new Date(x.timestamp).getTime() >= weekStart.getTime());
  let xtxt = "";
  if (wkX.length >= 2) {
    const delta = Number(wkX[wkX.length - 1].cm) - Number(wkX[0].cm);
    const val = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} cm`;
    const cls = delta < -0.05 ? "wt-good" : (delta > 0.05 ? "wt-bad" : "");
    const span = cls ? `<span class="${cls}">${val}</span>` : val;
    xtxt = ` <span class="insight-sep">;</span> Waist ${span}`;
  }

  const avgTxt = n ? `avg fast ${(sum / n).toFixed(1)}h` : "no fasts yet";
  const adhTxt = total ? ` · ${hit}/${total} on target` : "";
  el.innerHTML = `<div class="insight-title">This week</div><div class="insight-body">${avgTxt}${adhTxt}${wtxt}${xtxt}</div>`;
}

/* ---------- Consistency heatmap (Trends tab) ---------- */
function renderHeatmap() {
  const host = document.getElementById("heatmap");
  if (!host) return;
  const now = new Date();
  const eats = eatsAscending();
  const nowMs = now.getTime();

  // Span follows the Trends range: Week → 4 weeks, Month → 13 weeks, Year → 52.
  const WEEKS = trendRange === "week" ? 4 : trendRange === "year" ? 52 : 13;
  const gap = WEEKS > 30 ? 2 : 3;
  const showDow = trendRange !== "year";        // day labels only when cells are big enough
  const dayColW = showDow ? 20 : 0;
  const avail = (host.clientWidth || 320);
  let cell = Math.floor((avail - dayColW - gap * (WEEKS - 1)) / WEEKS);
  cell = Math.max(4, Math.min(cell, 28));       // clamp so Week isn't huge / Year isn't 0
  host.style.setProperty("--hc", cell + "px");
  host.style.setProperty("--hg", gap + "px");
  host.style.setProperty("--hdc", dayColW + "px");

  const cap = document.getElementById("heatCaption");
  if (cap) {
    const span = trendRange === "week" ? "4 weeks" : trendRange === "year" ? "52 weeks" : "13 weeks";
    cap.textContent = `Each square is one day over the last ${span} (columns = weeks, rows = Sun–Sat).`;
  }

  // start = Sunday of (WEEKS-1) weeks ago
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - now.getDay() - (WEEKS - 1) * 7);

  // Month labels above the columns — shown when a column's week enters a new month.
  let monthsHtml = "";
  let prevMonth = -1;
  for (let w = 0; w < WEEKS; w++) {
    const colSunday = new Date(start); colSunday.setDate(start.getDate() + w * 7);
    const m = colSunday.getMonth();
    monthsHtml += `<span class="heat-mon">${m !== prevMonth ? MONTHS[m] : ""}</span>`;
    prevMonth = m;
  }

  // Day-of-week labels down the left (rows are Sun→Sat) — omitted for Year (too small).
  const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  let daysHtml = "";
  if (showDow) for (let d = 0; d < 7; d++) daysHtml += `<span class="heat-dow">${DOW[d]}</span>`;

  // The grid: one column per week, one cell per day.
  let gridHtml = "";
  for (let w = 0; w < WEEKS; w++) {
    gridHtml += `<div class="heat-col">`;
    for (let d = 0; d < 7; d++) {
      const cell = new Date(start); cell.setDate(start.getDate() + w * 7 + d);
      let cls = "heat-none";
      if (cell <= now) {
        const r = dayFastEval(cell, eats, nowMs);
        cls = !r.counted ? "heat-none" : (r.onTarget ? "heat-green" : "heat-red");
      } else {
        cls = "heat-future";
      }
      gridHtml += `<span class="heat-cell ${cls}" title="${fmtDate(cell)}"></span>`;
    }
    gridHtml += `</div>`;
  }

  host.innerHTML =
    `<div class="heat-months">${monthsHtml}</div>` +
    `<div class="heat-body">${showDow ? `<div class="heat-days">${daysHtml}</div>` : ""}` +
    `<div class="heat-grid">${gridHtml}</div></div>`;
}

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
  const payload = { app: "MealFast", version: 1, exportedAt: new Date().toISOString(), logs, weights, waist, schedule };
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
  const waistRows = waist.slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(x => { const d = new Date(x.timestamp); return [csvDate(d), csvTime(d), Number(x.cm).toFixed(1)].map(csvCell).join(","); });

  const csv = [
    "Entries", "date,time,type,note", ...entryRows,
    "", "Weights", "date,time,weight_kg", ...weightRows,
    "", "Waist", "date,time,waist_cm", ...waistRows
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
  waist = Array.isArray(data.waist) ? data.waist : [];
  schedule = migrateSchedule(Array.isArray(data.schedule) ? data.schedule : defaultSchedule());
  save(STORE_KEYS.logs, logs);
  save(STORE_KEYS.weights, weights);
  save(STORE_KEYS.waist, waist);
  save(STORE_KEYS.schedule, schedule);
  renderLogs(); renderSchedule(); populateWeightSelect(); populateWaistSelect(); renderTimer();
  drawWeightChart(); renderFastCard();
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
  return JSON.stringify({ app: "MealFast", version: 1, exportedAt: new Date().toISOString(), logs, weights, waist, schedule });
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
