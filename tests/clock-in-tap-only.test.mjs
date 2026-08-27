/* JustUs TimeClock — clocking in is TAP-ONLY.
   Drives the real wizard step 0 out of the real app.js. A worker must not be
   able to type a job name; they pick from what already exists. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require_ = createRequire('/Users/tg2.0/Documents/FGA-Brain/cortana-ui/');
const { parseHTML } = require_('linkedom');
const META_KEY = 'justus-tc-meta-v1';

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const tpl = (id, name) => ({ id, name, policyKeys: [], startHour: 10, startMin: 0, endHour: 22, endMin: 0, emails: [], duration: 'custom', savedAt: 1000 });
const future = (h) => new Date(Date.now() + h * 3600000).toISOString();

function boot({ events = [], meta = null } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);
  const store = {};
  if (meta) store[META_KEY] = JSON.stringify(meta);
  const posts = [];
  const shim = {
    addEventListener: () => {}, removeEventListener: () => {}, scrollTo: () => {},
    TC_API: 'https://stub.invalid/webhook',
    location: { hash: '#home' }, history: { pushState() {}, replaceState() {}, back() {}, forward() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    prompt: () => { throw new Error('window.prompt must not be used any more'); },
    confirm: () => true,
  };
  const win = new Proxy(window, {
    get: (t, k) => (k in shim ? shim[k] : t[k]),
    set: (t, k, v) => { shim[k] = v; return true; },
    has: (t, k) => k in shim || k in t,
  });
  const fetchStub = async (url, opts = {}) => {
    const u = String(url);
    if (opts.body) posts.push({ url: u, body: JSON.parse(opts.body) });
    let data = [];
    if (u.includes('tc-events') && !opts.body) data = events;
    if (u.includes('tc-crew-flags')) data = [{ id: 1, profile_id: '7', can_create_events: true, archived: false }];
    return { ok: true, status: 200, json: async () => data };
  };
  const ctx = vm.createContext({
    window: win, document, location: shim.location, history: shim.history,
    navigator: { userAgent: 'test', mediaDevices: { getUserMedia: async () => { throw new Error('no cam'); } } },
    fetch: fetchStub, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: shim.requestAnimationFrame,
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    btoa: (b) => Buffer.from(b, 'binary').toString('base64'),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return { document, shim, posts, store };
}

const baseMeta = (templates, deletedTemplates = {}) => ({
  templates, deletedTemplates, tplCleanupV1: true, emails: [], archived: {}, deleted: {},
  eventPolicy: {}, createdAt: {}, eventEdits: {}, crewPerms: {}, crewArchived: {}, updatedAt: 1,
});

/* ---------- 1. no free-text job box anywhere in the shipped markup ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  check('the typed-job input is gone from the source', !/wizJobName/.test(js) && !/wizJobName/.test(html));
  check('its USE button is gone too', !/wizJobGo/.test(js) && !/wizJobGo/.test(html));
}

/* ---------- 2. only a job that is running RIGHT NOW is offered ---------- */
{
  const evs = [
    { id: 9, name: 'Wildlands', start_at: future(-1), end_at: future(6), owner_email: '' },   // live now
    { id: 10, name: 'Next Saturday', start_at: future(120), end_at: future(130), owner_email: '' }, // not started
    { id: 11, name: 'Last Week', start_at: future(-200), end_at: future(-190), owner_email: '' },   // finished
  ];
  const a = boot({ events: evs, meta: baseMeta([tpl('t1', 'Rbar')]) });
  const tc = a.shim.__tc;
  tc.current.profile = { id: 7, first_name: 'Dee', last_name: 'R' };
  tc.current.punches = [];
  await tc.startWizard();
  const body = a.document.getElementById('wizBody');
  check('no text input is rendered on the job step',
    body.querySelectorAll('input').length === 0, `${body.querySelectorAll('input').length} inputs`);
  const live = a.document.getElementById('wizEvents');
  const shown = live ? [...live.children].map((c) => c.textContent) : [];
  check('the running event is offered', shown.some((t) => t.includes('Wildlands')), shown.join(' | '));
  check('an event that has not started yet is NOT offered',
    !shown.some((t) => t.includes('Next Saturday')), shown.join(' | '));
  check('an event that already finished is NOT offered',
    !shown.some((t) => t.includes('Last Week')), shown.join(' | '));
  check('exactly one option is shown', live && live.children.length === 1, `${shown.length}`);
  check('every option is a button, never a field',
    !!live && [...live.children].every((c) => c.tagName === 'BUTTON'));
  check('saved events are NOT offered as a fallback', !a.document.getElementById('wizJobChips'));
}

/* ---------- 3. a saved event with nothing running gives the worker nothing ---------- */
{
  const a = boot({ events: [], meta: baseMeta([tpl('t1', 'Rbar'), tpl('t2', 'Music in the mountains')]) });
  const tc = a.shim.__tc;
  tc.current.profile = { id: 7, first_name: 'Dee', last_name: 'R' };
  tc.current.punches = [{ id: 1, event_name: 'Rbar' }];
  await tc.startWizard();
  const body = a.document.getElementById('wizBody');
  check('no saved-event chips appear when nothing is live', !a.document.getElementById('wizJobChips'));
  check('no input appears either', body.querySelectorAll('input').length === 0);
  check('the worker is told nothing is active', /No job is active right now/.test(body.textContent),
    body.textContent.replace(/\s+/g, ' ').slice(0, 100));
}

/* ---------- 4. an event with no usable dates is not offered ---------- */
{
  const evs = [{ id: 12, name: 'Broken Dates', start_at: '', end_at: '', owner_email: '' }];
  const a = boot({ events: evs, meta: baseMeta([]) });
  const tc = a.shim.__tc;
  tc.current.profile = { id: 7, first_name: 'Dee', last_name: 'R' };
  tc.current.punches = [];
  await tc.startWizard();
  check('an event with no start/end is not offered',
    !a.document.getElementById('wizEvents'),
    a.document.getElementById('wizBody').textContent.replace(/\s+/g, ' ').slice(0, 80));
}

/* ---------- 5. permitted crew get a real form with a start AND end date ---------- */
{
  const a = boot({ events: [], meta: baseMeta([]) });
  const tc = a.shim.__tc;
  await tc.renderCreateEventAccess({ id: 7, first_name: 'Dee', last_name: 'R' });
  const d = a.document;
  check('a create-event form is rendered, not a prompt chain', !!d.getElementById('pfCreateForm'));
  ['pfEvName', 'pfEvStartDate', 'pfEvStartTime', 'pfEvEndDate', 'pfEvEndTime'].forEach((id) => {
    check(`the form has ${id}`, !!d.getElementById(id));
  });
  check('the end date is its own field, so an event can span days',
    d.getElementById('pfEvEndDate').type === 'date');

  // Multi-day create actually posts the later end date.
  d.getElementById('pfEvName').value = 'Three Day Fest';
  d.getElementById('pfEvStartDate').value = '2026-09-04';
  d.getElementById('pfEvStartTime').value = '10:00';
  d.getElementById('pfEvEndDate').value = '2026-09-06';
  d.getElementById('pfEvEndTime').value = '23:00';
  await d.getElementById('pfEvCreate').onclick();
  const post = a.posts.find((p) => p.url.includes('tc-events'));
  check('a multi-day event posts with the real end date',
    !!post && post.body.start_at.startsWith('2026-09-04') && post.body.end_at.startsWith('2026-09-06'),
    post ? `${post.body.start_at} → ${post.body.end_at}` : 'no post');
  check('it posts as the creator, with no admin PIN', !!post && post.body.creator_id === 7 && post.body.pass === undefined);
}

/* ---------- 6. a night shift that ends after midnight rolls to the next day ---------- */
{
  const a = boot({ events: [], meta: baseMeta([]) });
  await a.shim.__tc.renderCreateEventAccess({ id: 7, first_name: 'Dee', last_name: 'R' });
  const d = a.document;
  d.getElementById('pfEvName').value = 'Night Gig';
  d.getElementById('pfEvStartDate').value = '2026-09-04';
  d.getElementById('pfEvStartTime').value = '20:00';
  d.getElementById('pfEvEndDate').value = '2026-09-04';
  d.getElementById('pfEvEndTime').value = '02:00';
  await d.getElementById('pfEvCreate').onclick();
  const post = a.posts.find((p) => p.url.includes('tc-events'));
  check('an end time before the start rolls to the next morning',
    !!post && post.body.end_at.startsWith('2026-09-05'), post ? post.body.end_at : 'no post');
}

/* ---------- 7. a backwards multi-day range is refused, not silently rolled ---------- */
{
  const a = boot({ events: [], meta: baseMeta([]) });
  await a.shim.__tc.renderCreateEventAccess({ id: 7, first_name: 'Dee', last_name: 'R' });
  const d = a.document;
  d.getElementById('pfEvName').value = 'Backwards';
  d.getElementById('pfEvStartDate').value = '2026-09-06';
  d.getElementById('pfEvStartTime').value = '10:00';
  d.getElementById('pfEvEndDate').value = '2026-09-04';
  d.getElementById('pfEvEndTime').value = '10:00';
  await d.getElementById('pfEvCreate').onclick();
  check('nothing is posted for a backwards range', !a.posts.some((p) => p.url.includes('tc-events') && p.body.name === 'Backwards'));
  check('and the reason is shown', !d.getElementById('pfEvErr').classList.contains('hidden'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
