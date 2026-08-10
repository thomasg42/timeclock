/* JustUs TimeClock — self-serve clock-in QA.
   Serves the real source dir, stubs the n8n webhooks, drives the flow in Chrome. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire('/Users/tg2.0/Documents/Claude/')('puppeteer');

const ROOT = '/Users/tg2.0/Documents/FGA-Brain/client-sites/timeclock';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---------- fake n8n backend ---------- */
function makeBackend(events) {
  return {
    events,
    profiles: [{ id: 1, first_name: 'Dee', last_name: 'Ramos', email: 'dee@justus.test', phone: '4065550100', weekly_email: null }],
    punches: [],
    settings: [{ id: 1, setting_key: 'owner_emails', setting_value: 'owner@justus.test' }],
    calls: [],
  };
}

async function runScenario(label, events, drive) {
  const be = makeBackend(events);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('https://fonts.')) return req.respond({ status: 200, body: '' });
    if (!url.includes('tggai.app.n8n.cloud/webhook/')) return req.continue();
    const route = url.split('/webhook/')[1].split('?')[0];
    if (req.method() === 'OPTIONS') {
      return req.respond({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
        body: '',
      });
    }
    const qs = new URLSearchParams(url.split('?')[1] || '');
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    be.calls.push({ route, method: req.method(), body });
    const json = (o) => req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(o),
    });

    if (route === 'tc-admin') {
      if (qs.get('pass') !== '1111') return req.respond({ status: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"unauthorized"}' });
      return json(be.punches.length ? be.punches : [{}]);
    }
    if (route === 'tc-perm') {
      if (!body || body.pass !== '1111') return req.respond({ status: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"unauthorized"}' });
      const row = be.profiles.find((p) => String(p.id) === String(body.profile_id));
      row.weekly_email = body.weekly_email;
      row.perm_set_at = '2026-08-08T16:00:00-06:00';
      return json(row);
    }
    if (route === 'tc-settings') {
      const pass = req.method() === 'GET' ? qs.get('pass') : (body || {}).pass;
      if (pass !== '1111') return req.respond({ status: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"unauthorized"}' });
      if (req.method() === 'POST') {
        const row = be.settings.find((s) => s.setting_key === body.key);
        row.setting_value = body.value;
        return json(row);
      }
      return json(be.settings);
    }
    if (route === 'tc-profiles' && req.method() === 'GET') return json(be.profiles);
    if (route === 'tc-profiles' && req.method() === 'POST') {
      const row = { id: be.profiles.length + 1, ...body };
      be.profiles.push(row);
      return json(row);
    }
    if (route === 'tc-events' && req.method() === 'GET') {
      if (be.events === 'BOOM') return req.respond({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'down' });
      return json(be.events.length ? be.events : [{}]);
    }
    if (route === 'tc-events' && req.method() === 'POST') {
      const row = { id: 900 + be.events.length, ...body, report_sent: false };
      be.events.push(row);
      return json(row);
    }
    if (route === 'tc-history') {
      const id = qs.get('profileId');
      const mine = be.punches.filter((p) => String(p.profile_id) === String(id));
      return json(mine.length ? mine : [{}]);
    }
    if (route === 'tc-punch') {
      if (body.action === 'clock_in') {
        const row = {
          id: be.punches.length + 1,
          profile_id: body.profile_id, profile_name: body.profile_name,
          event_id: body.event_id, event_name: body.event_name,
          work_date: body.work_date, clock_in: body.clock_in,
          break_start: '', break_end: '', break_taken: false, clock_out: '', status: 'in',
          photo_selfie: body.photos && body.photos.selfie ? 'https://drive.test/selfie' : '',
        };
        be.punches.push(row);
        return json(row);
      }
      const row = be.punches.find((p) => p.id === body.punch_id);
      if (body.action === 'clock_out') { row.clock_out = body.time; row.status = 'out'; }
      if (body.action === 'break_start') { row.break_start = body.time; row.status = 'break'; row.break_taken = true; }
      if (body.action === 'break_end') { row.break_end = body.time; row.status = 'in'; }
      return json(row);
    }
    return json([{}]);
  });

  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  console.log(`\n--- ${label} ---`);
  try {
    await drive(page, be);
  } finally {
    // the injected outage logs an expected network 500; anything else is a real defect
    const realErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
    check(`${label}: no console errors`, realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
    await browser.close();
  }
}

const wait = (page, sel, opts = {}) => page.waitForSelector(sel, { visible: true, timeout: 8000, ...opts });
const clickText = async (page, sel, text) => {
  const handle = await page.evaluateHandle((s, t) => {
    return [...document.querySelectorAll(s)].find((el) => el.textContent.includes(t));
  }, sel, text);
  const el = handle.asElement();
  if (!el) throw new Error(`no ${sel} containing "${text}"`);
  await el.click();
};

/* =========================================================
   Scenario A — NO scheduled events at all (the old dead-end)
   ========================================================= */
await runScenario('A: no events, typed job', [], async (page, be) => {
  await wait(page, '#btnGoSelect');
  await page.click('#btnGoSelect');
  await wait(page, '#profileList .profile-item');
  await page.click('#profileList .profile-item');
  await wait(page, '#pfAction .big-btn.green');

  await page.click('#pfAction .big-btn.green'); // CLOCK IN
  await wait(page, '#wizJobName');
  const deadEnd = await page.$eval('#wizBody', (el) => el.textContent.includes('NO OPEN EVENTS'));
  check('A: no dead-end when zero events', !deadEnd);

  // short input is rejected
  await page.type('#wizJobName', 'x');
  await page.click('#wizJobGo');
  await wait(page, '#wizJobErr:not(.hidden)');
  check('A: rejects a 1-char job name', true);

  await page.focus('#wizJobName');
  await page.$eval('#wizJobName', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('#wizJobName', '  Maintenance on   Midtown ');
  await page.keyboard.press('Enter'); // enter key path

  await wait(page, '#camSnap');
  const step2 = await page.$eval('#wizStep', (el) => el.textContent);
  check('A: photo step labelled 2/3', step2.includes('2/3'), step2);

  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; }, { timeout: 8000 });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  const punchLabel = await page.$eval('#wizPunch', (el) => el.textContent.trim());
  check('A: photo step ends in CLOCK IN (no policy step)', punchLabel.includes('CLOCK IN'), punchLabel);

  await page.click('#wizPunch');
  await wait(page, '#wizDone');
  const congrats = await page.$eval('#wizBody', (el) => el.textContent);
  check('A: congrats names the typed job', congrats.includes('Maintenance on Midtown'), congrats.slice(0, 90));

  const punch = be.calls.find((c) => c.route === 'tc-punch' && c.body.action === 'clock_in');
  check('A: punch event_name is the typed job, whitespace collapsed',
    punch.body.event_name === 'Maintenance on Midtown', punch.body.event_name);
  check('A: punch event_id is the deterministic slug',
    punch.body.event_id === 'job-maintenance-on-midtown', String(punch.body.event_id));
  check('A: selfie sent with the punch', !!(punch.body.photos && punch.body.photos.selfie));
  check('A: no admin pass leaked into the worker punch',
    !JSON.stringify(punch.body).includes('1111'));

  await page.click('#wizDone');
  await wait(page, '#pfAction .big-btn.danger');
  const live = await page.$eval('#pfAction .shift-event', (el) => el.textContent);
  check('A: live shift card shows the job', live === 'Maintenance on Midtown', live);

  // clock out
  await page.click('#pfAction .big-btn.danger');
  await wait(page, '#confirmModal:not(.hidden)');
  await page.click('#confirmYes');
  await wait(page, '#summaryModal:not(.hidden)');
  const out = be.calls.find((c) => c.route === 'tc-punch' && c.body.action === 'clock_out');
  check('A: clock-out punched', !!out);
  check('A: clocked out with no extra photo/steps', !out.body.photos);
});

/* =========================================================
   Scenario B — scheduled event with policies still gated
   ========================================================= */
const pbr = [{
  id: 42, name: 'PBR Night', start_at: '2026-08-08T18:00:00-06:00',
  end_at: '2099-01-01T23:00:00-07:00', owner_email: 'boss@justus.test', report_sent: false,
}];

await runScenario('B: scheduled event keeps policy gate', pbr, async (page, be) => {
  await page.click('#btnGoSelect');
  await wait(page, '#profileList .profile-item');
  await page.click('#profileList .profile-item');
  await wait(page, '#pfAction .big-btn.green');
  await page.click('#pfAction .big-btn.green');

  await wait(page, '#wizEvents .profile-item');
  const hasTyped = await page.$('#wizJobName');
  check('B: typed field offered alongside scheduled events', !!hasTyped);
  await page.click('#wizEvents .profile-item');

  await wait(page, '#camSnap');
  const step2 = await page.$eval('#wizStep', (el) => el.textContent);
  check('B: photo step labelled 2/4 (policies pending)', step2.includes('2/4'), step2);
  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  const label = await page.$eval('#wizPunch', (el) => el.textContent.trim());
  check('B: photo step continues to policies, does NOT clock in', label.includes('CONTINUE'), label);
  await page.click('#wizPunch');

  await wait(page, '#wizPolicyScroll');
  const gated = await page.$eval('#wizPunch', (el) => el.disabled);
  check('B: clock-in still blocked until policy acknowledged', gated === true);
});

/* =========================================================
   Scenario C — typing a live event's name reuses that event
   ========================================================= */
await runScenario('C: typed name matches live event', pbr, async (page, be) => {
  await page.click('#btnGoSelect');
  await wait(page, '#profileList .profile-item');
  await page.click('#profileList .profile-item');
  await wait(page, '#pfAction .big-btn.green');
  await page.click('#pfAction .big-btn.green');
  await wait(page, '#wizJobName');
  await page.type('#wizJobName', 'pbr night');
  await page.click('#wizJobGo');

  await wait(page, '#camSnap');
  const step = await page.$eval('#wizStep', (el) => el.textContent);
  check('C: routed into the real event (4-step, policies apply)', step.includes('2/4'), step);
  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  const label = await page.$eval('#wizPunch', (el) => el.textContent.trim());
  check('C: no policy bypass by typing the event name', label.includes('CONTINUE'), label);
});

/* =========================================================
   Scenario D — brand-new profile can clock straight in
   ========================================================= */
await runScenario('D: new profile → clock in', [], async (page, be) => {
  await page.click('#btnGoCreate');
  await wait(page, '#cpFirst');
  await page.type('#cpFirst', 'Sam');
  await page.type('#cpLast', 'Cruz');
  await page.$eval('#cpDob', (el) => { el.value = '1998-04-02'; });
  await page.type('#cpEmail', 'sam@justus.test');
  await page.type('#cpPhone', '4065550111');
  await page.click('#cpSubmit');
  await wait(page, '#pfAction .big-btn.green');
  check('D: lands on profile with CLOCK IN right after creating', true);

  await page.click('#pfAction .big-btn.green');
  await wait(page, '#wizJobName');
  await page.type('#wizJobName', 'Yard cleanup');
  await page.click('#wizJobGo');
  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  await page.click('#wizPunch');
  await wait(page, '#wizDone');
  const p = be.calls.find((c) => c.route === 'tc-punch' && c.body.action === 'clock_in');
  check('D: new profile clocked into typed job', p.body.event_name === 'Yard cleanup', p.body.event_name);
  check('D: punch carries the new profile id + name',
    String(p.body.profile_id) === '2' && p.body.profile_name === 'Sam Cruz',
    `${p.body.profile_id} / ${p.body.profile_name}`);
});

/* =========================================================
   Scenario E — recent-job chip reuses the same event_id
   ========================================================= */
await runScenario('E: recent job chip', [], async (page, be) => {
  be.punches.push({
    id: 1, profile_id: 1, profile_name: 'Dee Ramos',
    event_id: 'job-maintenance-on-midtown', event_name: 'Maintenance on Midtown',
    work_date: '2026-08-07', clock_in: '2026-08-07T08:00:00-06:00',
    break_start: '', break_end: '', break_taken: false,
    clock_out: '2026-08-07T16:00:00-06:00', status: 'out',
  });
  await page.click('#btnGoSelect');
  await wait(page, '#profileList .profile-item');
  await page.click('#profileList .profile-item');
  await wait(page, '#pfAction .big-btn.green');
  await page.click('#pfAction .big-btn.green');
  await wait(page, '#wizJobChips button');
  const chip = await page.$eval('#wizJobChips button', (el) => el.textContent);
  check('E: yesterday\'s job offered as a chip', chip === 'Maintenance on Midtown', chip);
  await page.click('#wizJobChips button');
  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  await page.click('#wizPunch');
  await wait(page, '#wizDone');
  const p = be.calls.find((c) => c.route === 'tc-punch' && c.body.action === 'clock_in');
  check('E: chip reuses the same event_id as the old shift',
    p.body.event_id === 'job-maintenance-on-midtown', String(p.body.event_id));
});

/* =========================================================
   Scenario F — a typed job whose name carries policies must
   still hit the policy gate (no compliance bypass by typing)
   ========================================================= */
await runScenario('F: policy-bearing job name still gated', [], async (page, be) => {
  await page.click('#btnGoSelect');
  await wait(page, '#profileList .profile-item');
  await page.click('#profileList .profile-item');
  await wait(page, '#pfAction .big-btn.green');
  await page.click('#pfAction .big-btn.green');
  await wait(page, '#wizJobName');

  // admin template chip "PBR / Rodeo — Big Sky" carries policyKeys [general, pbr]
  const chips = await page.$$eval('#wizJobChips button', (els) => els.map((e) => e.textContent));
  check('F: admin job template offered as a chip', chips.includes('PBR / Rodeo — Big Sky'), chips.join(' | '));

  await page.type('#wizJobName', 'pbr / rodeo — big sky'); // typed, wrong case, not tapped
  await page.click('#wizJobGo');
  await wait(page, '#camSnap');
  const step = await page.$eval('#wizStep', (el) => el.textContent);
  check('F: typed policy-bearing job routed to the 4-step path', step.includes('2/4'), step);
  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  const label = await page.$eval('#wizPunch', (el) => el.textContent.trim());
  check('F: cannot clock in straight off the photo', label.includes('CONTINUE'), label);
  await page.click('#wizPunch');
  await wait(page, '#wizPolicyScroll');
  const disabled = await page.$eval('#wizPunch', (el) => el.disabled);
  check('F: policy acknowledgement still required', disabled === true);
  const noPunch = !be.calls.some((c) => c.route === 'tc-punch');
  check('F: no punch written before acknowledgement', noPunch);
});

/* =========================================================
   Scenario G — events endpoint down: typing still works
   ========================================================= */
await runScenario('G: events endpoint down', 'BOOM', async (page, be) => {
  await page.click('#btnGoSelect');
  await wait(page, '#profileList .profile-item');
  await page.click('#profileList .profile-item');
  await wait(page, '#pfAction .big-btn.green');
  await page.click('#pfAction .big-btn.green');
  await wait(page, '#wizJobName');
  check('G: typed field still reachable when tc-events 500s', true);
  await page.type('#wizJobName', 'Storm cleanup');
  await page.click('#wizJobGo');
  await page.waitForFunction(() => { const v = document.getElementById('camVideo'); return v && v.videoWidth > 0; });
  await page.click('#camSnap');
  await wait(page, '#wizPunch');
  await page.click('#wizPunch');
  await wait(page, '#wizDone');
  const p = be.calls.find((c) => c.route === 'tc-punch' && c.body.action === 'clock_in');
  check('G: clocked in despite the events outage', p.body.event_name === 'Storm cleanup', p.body.event_name);
});

/* =========================================================
   Scenario H — admin grants weekly-sheet permission + owner email
   ========================================================= */
await runScenario('H: admin crew permissions', [], async (page, be) => {
  be.profiles.push(
    { id: 2, first_name: 'Alex', last_name: 'Boone', email: 'alex@justus.test', weekly_email: true },
    { id: 3, first_name: 'No', last_name: 'Mail', email: '', weekly_email: null },
  );
  await wait(page, '#adminBtn');
  await page.click('#adminBtn');
  await wait(page, '#pinPad');
  for (const d of ['1', '1', '1', '1']) await clickText(page, '#pinPad button', d);
  await wait(page, '#adminCrew .crew-item');

  const labels = await page.$$eval('#adminCrew .crew-toggle', (els) => els.map((e) => e.textContent.trim()));
  const names = await page.$$eval('#adminCrew .crew-name', (els) => els.map((e) => e.textContent.trim()));
  check('H: crew listed alphabetically', names.join('|') === 'Alex Boone|Dee Ramos|No Mail', names.join('|'));
  check('H: existing permission renders ON', labels[0].includes('ON'), labels[0]);
  check('H: unset permission renders OFF', labels[1].includes('OFF'), labels[1]);

  const noMailDisabled = await page.$$eval('#adminCrew .crew-toggle', (els) => els[2].disabled);
  check('H: profile with no email cannot be switched on', noMailDisabled === true);

  // owner email loaded from the backend
  const owner = await page.$eval('#ownerEmails', (el) => el.value);
  check('H: owner email prefilled from settings', owner === 'owner@justus.test', owner);

  // grant Dee permission
  await page.$$eval('#adminCrew .crew-toggle', (els) => els[1].click());
  await page.waitForFunction(() => {
    const b = document.querySelectorAll('#adminCrew .crew-toggle')[1];
    return b && !b.disabled && b.textContent.includes('ON');
  }, { timeout: 8000 });
  const permCall = be.calls.filter((c) => c.route === 'tc-perm').pop();
  check('H: perm POST carries the admin pass and the right profile',
    permCall.body.pass === '1111' && String(permCall.body.profile_id) === '1' && permCall.body.weekly_email === true,
    JSON.stringify(permCall.body));
  check('H: backend state actually flipped', be.profiles.find((p) => p.id === 1).weekly_email === true);

  // toggling back off
  await page.$$eval('#adminCrew .crew-toggle', (els) => els[1].click());
  await page.waitForFunction(() => {
    const b = document.querySelectorAll('#adminCrew .crew-toggle')[1];
    return b && !b.disabled && b.textContent.includes('OFF');
  }, { timeout: 8000 });
  check('H: permission is revocable', be.profiles.find((p) => p.id === 1).weekly_email === false);

  // save a new owner email
  await page.focus('#ownerEmails');
  await page.$eval('#ownerEmails', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('#ownerEmails', 'boss@justus.test, books@justus.test');
  await page.click('#ownerEmailsSave');
  await page.waitForFunction(() => document.getElementById('ownerEmailsSave').textContent.trim() === 'SAVE', { timeout: 8000 });
  const setCall = be.calls.filter((c) => c.route === 'tc-settings' && c.method === 'POST').pop();
  check('H: owner emails saved with pass',
    setCall.body.pass === '1111' && setCall.body.key === 'owner_emails' && setCall.body.value === 'boss@justus.test, books@justus.test',
    JSON.stringify(setCall.body));
  check('H: worker-facing calls never carried the pass',
    !be.calls.some((c) => ['tc-profiles', 'tc-punch', 'tc-history'].includes(c.route) && c.body && c.body.pass));
});

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(` - ${f.name}: ${f.detail}`)); process.exit(1); }
