# JustUs Entertainment TimeClock

Event-staffing clock-in/clock-out app. Live at https://thomasg42.github.io/timeclock/

## How it works
- **Workers**: open the URL on their phone → Create Profile or Select Profile → CLOCK IN (pick event → live selfie → **scroll & acknowledge every policy pack attached to that event** → clocked-in congratulations) → optional BREAK → CLOCK OUT. Shift history persists forever on the profile.
- **Admin** (top right, code `1111`): Day Sheet, **Events** (Active / Archive — tap for detail + policies, swipe left archive, swipe right delete), and **Create Event** (saved event chips + type-new-name field, multi-check policy packs that stick to that event forever, calendar duration, scroll/type 12h AM–PM start/end times, multi-select report emails).
- **Policies**: check one or many packs per event (General Handbook, PBR & Rodeo, …). Opening an event shows summaries plus expandable full policy text. Creating “Wildlands” (etc.) saves it as a reusable chip with those policies remembered.
- **Auto report**: when an event's end time passes, an n8n schedule workflow emails the full time sheet (HTML table + CSV attachment) to the event's report email(s) — multiple recipients stored comma-separated on the event, once.
- **Note:** archive/delete/email-history/policy bindings/edits sync across phone + desktop via a hidden shared n8n meta event (`__JUSTUS_TC_META__`). Each browser still caches in `localStorage`, but Admin unlock / Events refresh / clock-in pull the shared copy so both devices stay on the same playing field. Live events and punches still come from n8n.

## Backend (n8n cloud — tggai.app.n8n.cloud)
- **TimeClock API** (workflow `HgZ6HgjJXs8vCtr6`, active): webhooks `tc-profiles` (GET/POST), `tc-events` (GET/POST, POST needs `pass`), `tc-history?profileId=`, `tc-admin?pass=&date=`, `tc-punch` (POST: `clock_in` | `break_start` | `break_end` | `clock_out`). CORS open (`allowedOrigins: *`).
- **TimeClock Event Reporter** (workflow `wwD7J5rhbCcYXadc`, active): every 10 min, finds ended events with `report_sent=false`, emails the sheet via Gmail, marks sent.
- **Data tables**: `tc_profiles` (Rwe78rrEQ6u89HaC), `tc_events` (6tT5Wq1Ha9sXUKeD), `tc_punches` (AGbbobPaY3y09Ntl).
- **Photos**: uploaded to Google Drive folder `FGA TimeClock Photos` (`1lC4a8821-FXtgUb_wvgR1HC8L7iT4hcw`); punch rows store the Drive links (private to the Drive owner).

## Files
- `index.html` / `styles.css` / `app.js` — static app, no build step
- `config.js` — webhook base URL (`window.TC_API`)
- `assets/justus-employee-showtime-bg.jpg` — original front-of-house concert / DJ / crowd background
- `assets/justus-admin-backstage-bg.jpg` — original backstage production-control background

## Visual system
- Employee and profile views use the concert/showtime scene; Admin switches to the backstage scene automatically.
- Both entertainment images are blue-duotoned over black so the entire visible palette stays white and electric blue.
- Retro dimensional typography, ticket geometry, glass production panels, blue status accents, and 44px+ controls keep the entertainment theme clear without sacrificing phone readability.
- The visual pass is isolated to `index.html`, `styles.css`, and the two background assets. `app.js` remains byte-for-byte identical to the live `fa76ced` no-duplicate logic.
- Current redesign state: **live on GitHub Pages at deploy commit `6f343e6`** (`76396f5` original visual release, then the strict white/blue/black palette lock).

Source of truth: `FGA-Brain/client-sites/timeclock/`. Deploy mirror: `~/Documents/timeclock` → `thomasg42/timeclock`.
