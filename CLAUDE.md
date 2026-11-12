# MealFast — Project Context & Handoff

> **Purpose of this file.** This is a context/onboarding document for Claude (Cowork or Claude Code)
> running on a new machine. Drop it in the repo and point Claude at it — or rename it to `CLAUDE.md`
> in the repo root so Claude Code auto-loads it — so the assistant picks up full project context
> without re-discovering everything. It summarizes what MealFast is, how it's built, how it's deployed,
> the hard constraints, and the state of recent work (through **v84**).

_Last updated: 2026-11-12. App version at handoff: **v84**._

---

## 1. What MealFast is

MealFast is a **single-user intermittent-fasting Progressive Web App (PWA)**.

- **Single user** (the owner). No accounts, no multi-tenant logic, no backend database.
- **localStorage-only persistence.** All data lives in the browser under `mf_*` keys. There is no server API.
- **Offline-first / local-first.** A cache-first (stale-while-revalidate) service worker precaches the
  app shell so the app opens instantly and works with no network at all.
- **Deployed to GitHub Pages** as a static site.
- **Optional Google Drive backup** (client-side only — see the security constraint below).

Design ethos: **keep it simple** and **keep the fasting physiology accurate**. Resist feature bloat;
prefer one coherent mechanism over two overlapping ones.

---

## 2. Repository layout

On the old machine the repo lived at `C:\Users\rajkumar_p\dev\mealfast` (mounted in Cowork as
`~/dev/mealfast`). Expect the same structure on the new machine wherever you cloned/copied it.

```
dev/
├── mealfast/                 # the app (this is what ships to GitHub Pages)
│   ├── app.js                # ~136 KB — all app logic (the big one)
│   ├── index.html            # ~17 KB — markup / tab structure
│   ├── style.css             # ~31 KB — styles
│   ├── sw.js                 # service worker (offline cache + update strategy)
│   ├── manifest.json         # PWA manifest
│   ├── README.md
│   ├── push.bat              # deploy script → commits & pushes to GitHub Pages
│   └── icons/                # app icons (apple-touch, 192, 512)
│
└── Backlog/                  # local preview + planning area (NOT shipped)
    ├── build_preview.py      # builds a single-file, clock-frozen preview with demo data
    ├── index.html            # the generated preview (output of build_preview.py)
    ├── mealfast-backup.json  # a REAL exported backup, reused as sample/seed data
    ├── NEXT FEATURES_*.md    # feature backlog notes
    └── variant-*.html        # design experiments
```

> **Note:** `build_preview.py` on the old machine was recreated from memory inside the Cowork
> container at one point (it had not been committed to the device before). Make sure it actually
> exists in `dev/Backlog/` on the new machine; if not, see §6 for what it does and regenerate it.

---

## 3. Hard constraints (do not violate)

1. **Google Client Secret must NEVER appear in code**, commits, or the deployed site. Only the
   **public** OAuth Client ID is allowed in the client:
   `806898124104-agpuoau8aruceh5tte1hj079gjukr1r7.apps.googleusercontent.com`
2. **Never corrupt the hosted git site.** Only write to `dev/mealfast` (the app) and `dev/Backlog`
   (the preview/planning area). Don't touch unrelated history.
3. **localStorage-only.** Don't introduce a backend, a build step, or a framework. It's vanilla
   HTML/CSS/JS by design. Single-file-ish, no bundler.
4. **Preserve offline-first behavior.** The service worker must stay cache-first; every deploy must
   bump the cache name (see §5) or returning users won't get the update.
5. **Keep the fasting-stage physiology honest.** Stage boundaries are physiological approximations;
   don't fudge them for UI convenience.

---

## 4. Architecture & key concepts (where things live in `app.js`)

### Persistence
- `STORE_KEYS` maps logical stores → localStorage keys (all `mf_*`):
  `logs, weights, waist, chest, schedule, wtarget, wtargetHistory, scheduleHistory`.
- `APP_VERSION` constant near the top of `app.js` (currently `"v84"`) — shown next to the wordmark.

### Fasting stages (physiology core)
- `STAGE_ORDER = ["digesting","postabsorptive","glycogen","fat","earlyketosis","ketosis","autophagy","hgh","deep","immune"]`
- `STAGE_BOUNDS_H = [4, 8, 12, 16, 18, 24, 36, 48, 72]` — upper bounds (hours) between stages.
  So: digesting 0–4, post-absorptive 4–8, glycogen 8–12, fat 12–16, early ketosis 16–18,
  ketosis 18–24, autophagy 24–36, HGH 36–48, deep 48–72, immune 72+.
- `stageForHours(h)` resolves the current stage. `nextStageInfo()` computes time-to-next.
- The old auto-cap on fast length was removed; `STAGE_GAP_CAP_H = 84` is the relevant cap constant.
- Per-stage art + notifications exist (`STAGE_ART`, `STAGE_BLURB`, stage-change notifications).

### Charts (canvas 2D, no chart library)
- `trendBuckets(range, anchor)` builds the bucketed window; `trendAnchor()` applies the `trendOffset`
  pager (Week / Month / Quarter / Year).
- Helpers: `prepCanvas`, `drawAxes`, `niceScale`, `seriesAvgInRange`, `lastSeriesValueBefore`
  (carry-forward fill so lines stay continuous).
- `drawWeightChart()`, `drawFastChart()`, heatmap, insight card, personal bests.

### Measurement chart modes
- `measureMode = "weight" | "body"`. In v81, waist + chest were consolidated into one **"body"** cm
  chart (old `"waist"`/`"chest"` modes migrate to `"body"`). The Measurement toggle shows **Weight · Body**.

### Non-retroactive timelines (important pattern)
Instead of a single live setting that re-judges all history when edited, targets are stored as a
**timeline of segments**, so editing today never rewrites the past:
- `wtargetHistory` — weight-target revisions (see §7).
- `scheduleHistory` — full 7-day fasting-schedule snapshots; historical reads (streak, heatmap,
  adherence, Duration chart) look up the snapshot in effect on each date.
- `weekStartMs(d)` — Sunday 00:00 of a date's week (used for schedule effective dates).

### Journal
- `renderLogs()` merges logs, weigh-ins, body measurements, weight-target revisions (`kind: "target"`,
  CSS `li-target`), and fasting-target changes (`kind: "ftarget"`) into one filterable list.
- Filter chips include **Target**, which shows both weight-target and fasting-target history.

### Reminders
- Per-measurement reminder pop-ups (a `.sheet-overlay` modal driven by `measureQueue` /
  `pendingMeasures`, dismissals tracked under `mf_measure_dismissed_<metric>`, first-run via `mf_first_use`).

---

## 5. Deploy process (every release)

1. Edit files in `dev/mealfast`.
2. **Bump BOTH version markers** (they must move together or caching breaks):
   - `APP_VERSION` in `app.js` (e.g. `const APP_VERSION = "v84";`)
   - `CACHE_NAME` in `sw.js` (e.g. `const CACHE_NAME = "mealfast-v84";`)
3. Rebuild the local preview: `python3 build_preview.py` (run from `dev/Backlog`).
4. Review the preview (`dev/Backlog/index.html`) — it has a frozen clock + demo data so charts render.
5. Run **`push.bat`** (from `dev/mealfast`) to commit and push to GitHub Pages.
6. Because the SW is cache-first, the new build appears on the **next** open after the user has been
   online once. The version tag next to the "MEALFAST" wordmark confirms which build is live.

---

## 6. `build_preview.py` — what it does

Produces a single self-contained HTML file (`dev/Backlog/index.html`, and `/tmp/backlog_index.html`
inside Cowork) for local preview without a server:
- Inlines `style.css` and `app.js` into `index.html`.
- Strips the PWA manifest / icons / Google sign-in script (not needed for preview).
- Injects a **frozen `Date`** (clock pinned to the backup's export time) and seeds demo
  `weights/waist/chest` (~120 days) plus a `wtarget`, so all charts have data to draw.
- Reads seed data from `dev/Backlog/mealfast-backup.json` (a real exported backup).

This is a **preview-only** harness — it is never shipped.

---

## 7. Recent work: the revisable weight-target (v82 → v84)

This was the main feature thread before the migration. Read this section before touching the
weight-target code.

### The requirement
A **revisable, non-retroactive** weight-reduction target. The user enters a **current weight** (the
anchor they type in) + an **as-on date** + a **direction** (reduce/increase) + a **rate (kg/week)**,
and hits **Save** to record a *revision*. Each revision starts a fresh trajectory and **does not
modify earlier trajectories**. The target line on the weight chart is therefore **piecewise** — e.g.
0.5 kg/wk in the past, then 0.4 kg/wk from the new anchor forward, both slopes visible at once.

### How it's modeled
- `wtargetHistory` = array of revisions `{ id, effMs, anchorKg, dir, rate }`, sorted by `effMs`.
- `wtarget` = `{ dir, rate }` mirror of the **latest** revision (used for the insight-card colour).
- `setTargetRevision(dir, rate, anchorKg, effMs)` — appends (or updates in place when the same
  `effMs` already exists) a revision. Non-retroactive.
- `segmentAt(t)` — the revision governing time `t` (last one with `effMs <= t`).
- `targetAnchoredAt(ms)` — target weight at a moment: `anchorKg ± rate·weeks` **from that revision's
  own anchor/date**. Piecewise; can step at a boundary (that's the intentional re-anchor).
- `weightTargetLine(buckets)` — per-bucket target Ys from the anchored timeline; returns
  `{ active, mode:"rate", targetYs, targetToday }`. Drives the green dashed target line + comparison.
- `weighKgNear(ms)` — nearest weigh-in value; used by a one-time **migration** that backfills
  `anchorKg` onto any legacy segment that predates the anchored model.
- `ensureTargetSeed()` — seeds the first segment at the first weigh-in, anchored at that weight.

### UI (Settings → Weight target)
- Direction select (`#wtDir`) + rate select (`#wtRate`, 0.05–2.0 kg/wk).
- **Current weight** (`#wtCur`) + **as-on date** (`#wtDate`) + **Save** (`#wtSave`).
- `#wtHint` shows the **current trajectory + now-vs-target comparison only**.
- As-on date is anchored at **day start (`T00:00:00`)** so a same-day revision is active immediately.
- Nothing commits until Save (changing dir just toggles the rate selector's disabled state).

### History location (v84 change)
The **revision history list was moved OUT of the Settings panel** and now lives on the **Journal page
under the Target filter** (one `li-target` row per revision, e.g. `Reduce 0.40 kg/wk @ 121.0 kg`).
The Settings hint only shows the current trajectory + comparison + a pointer to the Journal.

### What v82 was, and why it's gone
v82 briefly implemented a "**goal weight by date**" mechanism (`mf_wgoal`, fields `wgKg`/`wgDate`/
`wgSave`). That was **fully replaced** by the rate-per-revision model above (confirmed decision: one
coherent target system, not two). No `mf_wgoal` / `weightGoal` / `setTargetSegment` references should
remain — grep to confirm if you touch this area.

### Version history of this thread
- **v82** — goal-weight-by-date (removed).
- **v83** — revisable anchored rate timeline; replaced v82; history shown in Settings.
- **v84** — moved revision history to Journal; Settings shows current trajectory only; removed the
  unused `.wtarget-revs` CSS; as-on date anchored at day start.

---

## 8. How to verify changes (no server needed)

- **Syntax:** `node --check app.js` and `node --check sw.js`.
- **Preview + Playwright:** build the preview, then drive `/tmp/backlog_index.html` (or the device
  preview) headless. Chromium in the Cowork container is at
  `/opt/pw-browsers/chromium-<build>/chrome-linux64/chrome` (the build number changes — `find` it).
  Typical checks: click tabs via `[data-tab="..."]` (note: the **Settings** tab is `data-tab="schedule"`),
  save revisions through the real UI, then read `localStorage.mf_wtarget_history` and the
  `#weightStatus` / `#wtHint` text, and screenshot the weight chart to confirm the piecewise line.
- Watch the console for `pageerror`; the only expected benign error in preview is a `file://`
  `README.md` fetch (CORS) — that does not occur on the real HTTPS site.

---

## 9. User profile notes (for personalization features)

- Current weight ≈ **121 kg** (from logged weigh-ins).
- Typical routine: **16:8** intermittent fasting.
- We discussed (analysis only, no code yet):
  - **Meal size/composition affects fasting-stage timing** — stages are gated by liver-glycogen
    depletion + insulin falling, so a heavy carb-rich meal pushes stages later, a light low-carb meal
    pulls them earlier.
  - **Body weight is a weak lever** on stage timing — it mostly nudges the deeper stages slightly
    *later* (more absolute glycogen vs. a brain-dominated, non-scaling glucose drain), and is swamped
    by last-meal carbs and activity.
- **Possible next feature:** a "personalized stage estimate" toggle (weight / lean-mass / activity
  based) layered on top of the fixed `STAGE_BOUNDS_H`. Not started.

---

## 10. Quick-start checklist on the new machine

1. Confirm the repo is at `…/dev/mealfast` and the preview area at `…/dev/Backlog`.
2. Confirm `dev/Backlog/build_preview.py` exists (regenerate from §6 if missing).
3. `node --check dev/mealfast/app.js` to confirm the toolchain works.
4. Current live version should be **v84** (`APP_VERSION` in `app.js`, `CACHE_NAME` in `sw.js`).
5. For any change: edit → bump both version markers → `build_preview.py` → review → `push.bat`.
6. Never put the Google **Client Secret** in code; only the public Client ID is allowed.
