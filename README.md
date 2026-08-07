# MealFast — Web App (PWA)

A single-user meal logging & intermittent fasting tracker that installs to
your iPhone home screen like an app — no Mac, no Xcode, no App Store.

## How the data works

Everything is stored **only in your iPhone's browser storage** (localStorage),
on-device. There's no server, no account, no sync, no one else can see it.
Uninstalling / clearing Safari data for the site will erase it, so don't
clear Safari website data for this site.

## Files

```
index.html      — the app screens (Timer, Log, Trends, Schedule)
style.css       — styling
app.js          — all the logic: fasting calculations, storage, charts
manifest.json   — lets iOS treat this as an installable app
sw.js           — offline caching, so it still opens without signal
icons/          — home screen icon
```

## Step 1 — Host the files somewhere (required)

iOS needs these files served over `https://` for "Add to Home Screen" to
work as a real installed app (icon, no Safari address bar, offline caching).
**GitHub Pages is free and takes about 5 minutes, no Mac needed:**

1. Go to github.com and create a free account if you don't have one.
2. Create a new repository (e.g. `mealfast`), keep it **public**.
3. On the repo page, click "Add file" → "Upload files," and drag in all the
   files from this folder (keep the `icons` folder structure intact).
4. Commit the files.
5. Go to the repo's **Settings → Pages**. Under "Source," choose the `main`
   branch and `/ (root)`, then save.
6. GitHub gives you a URL like `https://yourusername.github.io/mealfast/`.
   Wait a minute or two for it to go live.

(Netlify Drop — netlify.com/drop — is a faster alternative: drag the folder
onto the page and it gives you a live URL instantly, no account needed.
GitHub Pages is preferred if you want it to keep working long-term.)

## Step 2 — Install it on your iPhone

1. Open the URL from Step 1 in **Safari** on your iPhone (must be Safari,
   not Chrome — "Add to Home Screen" only works fully from Safari on iOS).
2. Tap the Share icon (square with an arrow) at the bottom of the screen.
3. Scroll down and tap **"Add to Home Screen."**
4. Tap **Add.**

You'll now have a MealFast icon on your home screen that opens full-screen,
no browser bar, like a normal app.

## Step 3 — Allow notifications (optional, with a real limitation)

The app will ask for notification permission the first time you tap
something. If you allow it, it can show a banner when your fasting or
eating window completes — **but only while the app is open in the
foreground.** iOS Safari web apps cannot reliably wake up in the background
to fire a notification the way a native app can. In practice: check the app
when you expect a window to be closing, and it'll show you a toast + banner
at that moment. This is the one trade-off of going the no-Mac route — I've
noted it clearly rather than overselling what it can do.

## What's in the app

- **Timer tab** — live countdown ring showing fasting or eating phase, next
  meal time, and your weekly streak ("X/7 days on target").
- **Log tab** — log Meal / Drink / Water / Electrolyte with one-tap "Now /
  15m ago / 30m ago / 1h ago," or set an exact time. Optional note field.
- **Trends tab** — log weight, see a weight trend line and a 14-day fasting
  window bar chart (derived from your actual meal/drink log timestamps).
- **Schedule tab** — set a different eating window per day of the week,
  toggle any day off entirely.

## Updating the app later

If you want to tweak anything (colors, add a feature), edit the files and
re-upload them to the same GitHub repo — the installed icon on your phone
will pick up changes next time you open it (may take one extra reopen for
the offline cache to refresh).

## Set the User Name
Raj