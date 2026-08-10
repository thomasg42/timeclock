# JustUs Entertainment TimeClock

Event-staffing clock-in/clock-out app. Live at https://thomasg42.github.io/timeclock/

## How it works
- **Workers**: open the URL on their phone → Create Profile or Select Profile → CLOCK IN → **"What's this job for?"** (tap a scheduled event, tap a recent-job chip, or just type it — e.g. "Maintenance on Midtown") → live selfie → clocked in. If the chosen job has policy packs there's one more step: **scroll & acknowledge every pack** first. Then optional BREAK → CLOCK OUT (single confirm, no photo). Shift history persists forever on the profile.
- **Self-serve jobs**: a worker is never blocked from clocking in — with no scheduled event they type the job themselves. A typed job stores `event_id = job-<slug-of-name>`, so everyone who types or taps the same job name groups onto the same id. Typing the name of a *live scheduled event* routes into that real event instead, so its policy gate can't be bypassed by typing around it. Typed jobs land on the Admin **Day Sheet** (it reads punches) but are **not** rows in `tc_events`, so they get no auto-emailed event report — that stays for admin-created events.
- **Admin** (third home button, code `1111`): Day Sheet, **Crew & Weekly Time Sheets**, **Events** (Active / Archive — tap for detail + policies, swipe left archive, swipe right delete), and **Create Event** (saved event chips + type-new-name field, multi-check policy packs that stick to that event forever, calendar duration, scroll/type 12h AM–PM start/end times, multi-select report emails).
- **Weekly time sheets**: pay week runs **Wednesday → Tuesday**. Every Tuesday 11:30 PM Mountain, the business owner gets one combined sheet of every shift that week (per-person subtotals, every shift's job / clock in / clock out / break / hours, grand total, CSV attached) — plus red flags for any shift over 16 hours or never clocked out. Each employee the admin has switched **ON** in Crew also gets their own private sheet, same columns, with their week total. Permission is per person and stored server-side on the profile (`weekly_email`); it only controls the employee's own email — it never gates clocking in, and the owner sheet always includes everyone. Profiles with no email address can't be switched on.
- **Policies**: check one or many packs per event (General Handbook, PBR & Rodeo, …). Opening an event shows summaries plus expandable full policy text. Creating “Wildlands” (etc.) saves it as a reusable chip with those policies remembered.
- **Auto report**: when an event's end time passes, an n8n schedule workflow emails the full time sheet (HTML table + CSV attachment) to the event's report email(s) — multiple recipients stored comma-separated on the event, once.
- **Note:** archive/delete/email-history/policy bindings/edits sync across phone + desktop via a hidden shared n8n meta event (`__JUSTUS_TC_META__`). Each browser still caches in `localStorage`, but Admin unlock / Events refresh / clock-in pull the shared copy so both devices stay on the same playing field. Live events and punches still come from n8n.

## Backend (n8n cloud — tggai.app.n8n.cloud)
- **TimeClock API** (workflow `HgZ6HgjJXs8vCtr6`, active): webhooks `tc-profiles` (GET/POST), `tc-events` (GET/POST, POST needs `pass`), `tc-history?profileId=`, `tc-admin?pass=&date=`, `tc-punch` (POST: `clock_in` | `break_start` | `break_end` | `clock_out`), `tc-perm` (POST `{pass, profile_id, weekly_email}` — needs `pass`), `tc-settings` (GET `?pass=` / POST `{pass, key, value}`). CORS open (`allowedOrigins: *`).
- **TimeClock Event Reporter** (workflow `wwD7J5rhbCcYXadc`, active): fires off the event's own end time, emails that event's sheet via Gmail, marks sent.
- **TimeClock Weekly Timesheet** (workflow `n85a2XVX23hpZm25`, active): Schedule Trigger every **Tuesday 11:30 PM America/Denver**, plus a `Manual Run` Execute-Workflow trigger taking optional `weekEnd` (`YYYY-MM-DD`) and `dryRun` for testing. Builds one email per permitted employee + one combined owner email, each with a CSV attachment.
  - **The week window is filtered in the `Build Timesheets` Code node, not in the data-table node.** The `Get Week Punches` node's `gte`/`lte` filter on `work_date` silently returned *every* row (verified: 10 rows for a window holding 7). Do not move that filter back into the node.
  - `Get Week Punches` / `Get Crew` / `Get Settings` are chained and each set `executeOnce` — without it, a node fans out once per input item and multiplies the results.
- **Data tables**: `tc_profiles` (Rwe78rrEQ6u89HaC — now also `weekly_email` bool + `perm_set_at`), `tc_events` (6tT5Wq1Ha9sXUKeD), `tc_punches` (AGbbobPaY3y09Ntl), `tc_settings` (cFR3bQJmEtgF983H — key/value; `owner_emails` row).
- **Photos**: uploaded to Google Drive folder `FGA TimeClock Photos` (`1lC4a8821-FXtgUb_wvgR1HC8L7iT4hcw`); punch rows store the Drive links (private to the Drive owner).

## Files
- `index.html` / `styles.css` / `clock-flow.css` / `app.js` — static app, no build step; exactly two loaded stylesheets
- `config.js` — webhook base URL (`window.TC_API`)
- `assets/justus-employee-showtime-bg.jpg` — original front-of-house concert / DJ / crowd background
- `assets/justus-admin-backstage-bg.jpg` — original backstage production-control background
- `assets/justus-home-gate-v2.jpg` + `justus-home-gate-mobile-v2.jpg` — responsive door-of-greatness entrance with two bouncers, sky/lights, and crowd at the bottom
- `assets/justus-admin-boss-v2.jpg` — backstage command view behind the artists and DJ/production desk
- `tests/self-clock-in.test.mjs` — headless-Chrome QA for the clock-in and admin-crew flows against a stubbed n8n backend and a fake camera (48 assertions: typed jobs, policy gating, new-profile path, recent-job chips, events-endpoint outage, crew permission grant/revoke, owner-email save, admin-pass scoping). Run with `node tests/self-clock-in.test.mjs` from this directory.

## Visual system
- Home is its own gate-of-greatness scene with the time centered over the cracked-open venue door and only three actions: Select Profile, Create Profile, and Admin.
- Select/Create share the same spectator/crowd environment. The selected employee profile, clock-in wizard, and policy acknowledgment switch to a clean white/ice-blue clarity layer.
- Admin switches to a distinct star-lit backstage command view behind the artists, production console, and DJ desk.
- Retro dimensional typography, ticket geometry, glass production panels, blue status accents, and 44px+ controls keep the entertainment theme clear without sacrificing phone readability.
- The visual pass was isolated to `index.html`, the two stylesheets, and image assets. `app.js` then changed for self-serve clock-in (2026-08-08) — it is no longer byte-identical to Lane 3's `71290e9` meta-sync build.
- Current redesign state: **live on GitHub Pages at deploy commit `fa9b1ee`**.

Source of truth: `FGA-Brain/client-sites/timeclock/`. Deploy mirror: `~/Documents/timeclock` → `thomasg42/timeclock`.
