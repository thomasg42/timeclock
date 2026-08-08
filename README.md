# JustUs Entertainment TimeClock

Event-staffing clock-in/clock-out app. Live at https://thomasg42.github.io/timeclock/

## How it works
- **Workers**: open the URL on their phone → Create Profile or Select Profile → CLOCK IN → **"What's this job for?"** (tap a scheduled event, tap a recent-job chip, or just type it — e.g. "Maintenance on Midtown") → live selfie → clocked in. If the chosen job has policy packs there's one more step: **scroll & acknowledge every pack** first. Then optional BREAK → CLOCK OUT (single confirm, no photo). Shift history persists forever on the profile.
- **Self-serve jobs**: a worker is never blocked from clocking in — with no scheduled event they type the job themselves. A typed job stores `event_id = job-<slug-of-name>`, so everyone who types or taps the same job name groups onto the same id. Typing the name of a *live scheduled event* routes into that real event instead, so its policy gate can't be bypassed by typing around it. Typed jobs land on the Admin **Day Sheet** (it reads punches) but are **not** rows in `tc_events`, so they get no auto-emailed event report — that stays for admin-created events.
- **Admin** (third home button, code `1111`): Day Sheet, **Events** (Active / Archive — tap for detail + policies, swipe left archive, swipe right delete), and **Create Event** (saved event chips + type-new-name field, multi-check policy packs that stick to that event forever, calendar duration, scroll/type 12h AM–PM start/end times, multi-select report emails).
- **Policies**: check one or many packs per event (General Handbook, PBR & Rodeo, …). Opening an event shows summaries plus expandable full policy text. Creating “Wildlands” (etc.) saves it as a reusable chip with those policies remembered.
- **Auto report**: when an event's end time passes, an n8n schedule workflow emails the full time sheet (HTML table + CSV attachment) to the event's report email(s) — multiple recipients stored comma-separated on the event, once.
- **Note:** archive/delete/email-history/policy bindings/edits sync across phone + desktop via a hidden shared n8n meta event (`__JUSTUS_TC_META__`). Each browser still caches in `localStorage`, but Admin unlock / Events refresh / clock-in pull the shared copy so both devices stay on the same playing field. Live events and punches still come from n8n.

## Backend (n8n cloud — tggai.app.n8n.cloud)
- **TimeClock API** (workflow `HgZ6HgjJXs8vCtr6`, active): webhooks `tc-profiles` (GET/POST), `tc-events` (GET/POST, POST needs `pass`), `tc-history?profileId=`, `tc-admin?pass=&date=`, `tc-punch` (POST: `clock_in` | `break_start` | `break_end` | `clock_out`). CORS open (`allowedOrigins: *`).
- **TimeClock Event Reporter** (workflow `wwD7J5rhbCcYXadc`, active): every 10 min, finds ended events with `report_sent=false`, emails the sheet via Gmail, marks sent.
- **Data tables**: `tc_profiles` (Rwe78rrEQ6u89HaC), `tc_events` (6tT5Wq1Ha9sXUKeD), `tc_punches` (AGbbobPaY3y09Ntl).
- **Photos**: uploaded to Google Drive folder `FGA TimeClock Photos` (`1lC4a8821-FXtgUb_wvgR1HC8L7iT4hcw`); punch rows store the Drive links (private to the Drive owner).

## Files
- `index.html` / `styles.css` / `clock-flow.css` / `app.js` — static app, no build step; exactly two loaded stylesheets
- `config.js` — webhook base URL (`window.TC_API`)
- `assets/justus-employee-showtime-bg.jpg` — original front-of-house concert / DJ / crowd background
- `assets/justus-admin-backstage-bg.jpg` — original backstage production-control background
- `assets/justus-home-gate-v2.jpg` + `justus-home-gate-mobile-v2.jpg` — responsive door-of-greatness entrance with two bouncers, sky/lights, and crowd at the bottom
- `assets/justus-admin-boss-v2.jpg` — backstage command view behind the artists and DJ/production desk

## Visual system
- Home is its own gate-of-greatness scene with the time centered over the cracked-open venue door and only three actions: Select Profile, Create Profile, and Admin.
- Select/Create share the same spectator/crowd environment. The selected employee profile, clock-in wizard, and policy acknowledgment switch to a clean white/ice-blue clarity layer.
- Admin switches to a distinct star-lit backstage command view behind the artists, production console, and DJ desk.
- Retro dimensional typography, ticket geometry, glass production panels, blue status accents, and 44px+ controls keep the entertainment theme clear without sacrificing phone readability.
- The visual pass was isolated to `index.html`, the two stylesheets, and image assets. `app.js` then changed for self-serve clock-in (2026-08-08) — it is no longer byte-identical to Lane 3's `71290e9` meta-sync build.
- Current redesign state: **live on GitHub Pages at deploy commit `fa9b1ee`**.

Source of truth: `FGA-Brain/client-sites/timeclock/`. Deploy mirror: `~/Documents/timeclock` → `thomasg42/timeclock`.
