# JustUs Entertainment TimeClock

Event-staffing clock-in/clock-out app. Live at https://thomasg42.github.io/timeclock/

## How it works
- **Workers**: open the URL on their phone → Create Profile (first name, last name, DOB, email, phone) or Select Profile → CLOCK IN (pick the event, then 1 required live selfie) → optional BREAK (start/end, checkbox on the sheet) → CLOCK OUT ("Are you sure?") → full shift summary. Shift history persists forever on the profile.
- **Admin** (top right, code `1111`): Day Sheet, **Events** (Active / Archive — tap for detail + policies, swipe left archive, swipe right delete), and **Create Event** (saved event chips + type-new-name field, multi-check policy packs that stick to that event forever, calendar duration, scroll/type 12h AM–PM start/end times, multi-select report emails).
- **Policies**: check one or many packs per event (General Handbook, PBR & Rodeo, …). Opening an event shows summaries plus expandable full policy text. Creating “Wildlands” (etc.) saves it as a reusable chip with those policies remembered.
- **Auto report**: when an event's end time passes, an n8n schedule workflow emails the full time sheet (HTML table + CSV attachment) to the event's report email(s) — multiple recipients stored comma-separated on the event, once.
- **Note:** archive/delete/email-history/policy bindings are stored in the browser (`localStorage`) until an n8n PATCH lands — same phone/desktop browser profile keeps them; a fresh browser starts clean on those flags only. Live events and punches still come from n8n.

## Backend (n8n cloud — tggai.app.n8n.cloud)
- **TimeClock API** (workflow `HgZ6HgjJXs8vCtr6`, active): webhooks `tc-profiles` (GET/POST), `tc-events` (GET/POST, POST needs `pass`), `tc-history?profileId=`, `tc-admin?pass=&date=`, `tc-punch` (POST: `clock_in` | `break_start` | `break_end` | `clock_out`). CORS open (`allowedOrigins: *`).
- **TimeClock Event Reporter** (workflow `wwD7J5rhbCcYXadc`, active): every 10 min, finds ended events with `report_sent=false`, emails the sheet via Gmail, marks sent.
- **Data tables**: `tc_profiles` (Rwe78rrEQ6u89HaC), `tc_events` (6tT5Wq1Ha9sXUKeD), `tc_punches` (AGbbobPaY3y09Ntl).
- **Photos**: uploaded to Google Drive folder `FGA TimeClock Photos` (`1lC4a8821-FXtgUb_wvgR1HC8L7iT4hcw`); punch rows store the Drive links (private to the Drive owner).

## Files
- `index.html` / `styles.css` / `app.js` — static app, no build step
- `config.js` — webhook base URL (`window.TC_API`)

Source of truth: `FGA-Brain/client-sites/timeclock/`. Deploy: copy files to the `thomasg42/timeclock` repo and push.
