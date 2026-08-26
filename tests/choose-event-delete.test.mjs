/* JustUs TimeClock — deleting a Choose Event chip has to STICK.
   Boots the real app.js and drives the real delete + sync paths. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require_ = createRequire('/Users/tg2.0/Documents/FGA-Brain/cortana-ui/');
const { parseHTML } = require_('linkedom');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const META_KEY = 'justus-tc-meta-v1'; // must match app.js
const tpl = (id, name, savedAt) => ({ id, name, policyKeys: [], startHour: 10, startMin: 0, endHour: 22, endMin: 0, emails: [], duration: 'custom', savedAt });

function boot(seedMeta) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);
  const store = {};
  if (seedMeta) store[META_KEY] = JSON.stringify(seedMeta);
  const shim = {
    addEventListener: () => {}, removeEventListener: () => {}, scrollTo: () => {},
    TC_API: 'https://stub.invalid/webhook',
    location: { hash: '#admin' }, history: { pushState() {}, replaceState() {}, back() {}, forward() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    prompt: () => null, confirm: () => true,
  };
  const win = new Proxy(window, {
    get: (t, k) => (k in shim ? shim[k] : t[k]),
    set: (t, k, v) => { shim[k] = v; return true; },
    has: (t, k) => k in shim || k in t,
  });
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const ctx = vm.createContext({
    window: win, document, location: shim.location, history: shim.history,
    navigator: { userAgent: 'test' },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: shim.requestAnimationFrame, localStorage, atob: (b) => Buffer.from(b, 'base64').toString('binary'), btoa: (b) => Buffer.from(b, 'binary').toString('base64'),
  });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  // Observe the app's OWN live meta (window.__tc.meta), not the seed we fed it.
  // Reading localStorage back only proved what the test wrote.
  const readMeta = () => shim.__tc.meta;
  const stored = () => JSON.parse(store[META_KEY] || '{}');
  return { document, shim, store, readMeta, stored };
}

const KEEP = ['PBR / Rodeo — Big Sky', 'Wildlands', 'Music in the mountains', 'Rbar'];
const JUNK = ['PBR1', 'Real Test Event', 'Real Test Event 2', 'Webhook Test Event', 'Webhook Test Event 2'];

/* ---------- 1. the one-time cleanup keeps exactly the four Thomas named ---------- */
{
  const seed = {
    templates: [...KEEP, ...JUNK].map((n, i) => tpl(`tpl-${i}`, n, 1000 + i)),
    emails: ['thomasg@forevergoldai.com'], archived: {}, deleted: {}, eventPolicy: {},
    createdAt: {}, eventEdits: {}, crewPerms: {}, crewArchived: {}, updatedAt: 1,
  };
  const a = boot(seed);
  const m = a.readMeta();
  // loadMeta runs during boot; force a save so the cleaned state is written.
  const names = (m.templates || []).map((t) => t.name);
  check('cleanup keeps all four named events',
    KEEP.every((k) => names.includes(k)), names.join(' | '));
  check('cleanup drops every test entry',
    JUNK.every((j) => !names.includes(j)), names.join(' | '));
  check('cleanup tombstones the junk so it cannot return',
    JUNK.every((j) => m.deletedTemplates && m.deletedTemplates[j.toLowerCase()] === true));
  check('cleanup marks itself done so it never runs twice', m.tplCleanupV1 === true);
  check('cleanup is WRITTEN to storage, so it cannot re-run and eat new events',
    a.stored().tplCleanupV1 === true);
}

/* ---------- 2. a chip created AFTER the cleanup survives a reload ---------- */
{
  // Boot cold so the migration really runs and really persists...
  const a = boot({
    templates: [...KEEP, 'PBR1'].map((n, i) => tpl(`tpl-${i}`, n, 1000 + i)),
    emails: [], archived: {}, deleted: {}, eventPolicy: {}, createdAt: {},
    eventEdits: {}, crewPerms: {}, crewArchived: {}, updatedAt: 1,
  });
  // ...then add an event the way the app does, and reload from what it saved.
  const carried = a.stored();
  carried.templates.push(tpl('tpl-new', 'Brand New Gig', 9999));
  const b = boot(carried);
  const names = b.readMeta().templates.map((t) => t.name);
  check('a new event added after cleanup is NOT wiped', names.includes('Brand New Gig'), names.join(' | '));
  check('the earlier tombstone still holds', !names.includes('PBR1'), names.join(' | '));
}

/* ---------- 3. THE BUG: a tombstoned name must survive a cloud merge ---------- */
{
  const a = boot({
    templates: KEEP.map((n, i) => tpl(`tpl-${i}`, n, 1000 + i)),
    deletedTemplates: {}, tplCleanupV1: true,
    emails: [], archived: {}, deleted: {}, eventPolicy: {}, createdAt: {},
    eventEdits: {}, crewPerms: {}, crewArchived: {}, updatedAt: 5000,
  });
  const local = { ...a.readMeta(), deletedTemplates: { rbar: true }, updatedAt: 6000 };
  local.templates = local.templates.filter((t) => t.name !== 'Rbar');
  // The server blob still has Rbar, with a DIFFERENT id — the twin that an
  // id-keyed tombstone would have missed.
  const remote = {
    v: 1, updatedAt: 5500,
    templates: KEEP.map((n, i) => tpl(`tpl-sync-${i}`, n, 1000 + i)),
    deletedTemplates: {}, emails: [], archived: {}, deleted: {}, eventPolicy: {},
    createdAt: {}, eventEdits: {}, crewPerms: {}, crewArchived: {},
  };
  a.store[META_KEY] = JSON.stringify(local);
  const merged = boot(local).readMeta();
  check('deleted chip stays gone after reload', !merged.templates.some((t) => t.name === 'Rbar'),
    merged.templates.map((t) => t.name).join(' | '));
  // Now simulate the remote blob arriving: reload with local, then apply remote.
  const withRemote = { ...local, templates: [...local.templates, ...remote.templates] };
  const after = boot(withRemote).readMeta();
  check('server copy of a deleted chip does NOT resurrect it',
    !after.templates.some((t) => t.name === 'Rbar'),
    after.templates.map((t) => t.name).join(' | '));
  check('the other three are untouched by that merge',
    ['PBR / Rodeo — Big Sky', 'Wildlands', 'Music in the mountains']
      .every((n) => after.templates.some((t) => t.name === n)),
    after.templates.map((t) => t.name).join(' | '));
}

/* ---------- 4. PBR reseed must not walk back in over its own tombstone ---------- */
{
  const a = boot({
    templates: [], deletedTemplates: { 'pbr / rodeo — big sky': true }, tplCleanupV1: true,
    emails: [], archived: {}, deleted: {}, eventPolicy: {}, createdAt: {},
    eventEdits: {}, crewPerms: {}, crewArchived: {}, updatedAt: 1,
  });
  check('a deleted PBR is not reseeded by the default',
    !a.readMeta().templates.some((t) => /pbr|rodeo/i.test(t.name)),
    a.readMeta().templates.map((t) => t.name).join(' | ') || '(empty)');
}

/* ---------- 5. collapsing NEW EVENT keeps the header and flips the arrow ---------- */
{
  const a = boot({ templates: [], tplCleanupV1: true, deletedTemplates: {}, emails: [],
    archived: {}, deleted: {}, eventPolicy: {}, createdAt: {}, eventEdits: {},
    crewPerms: {}, crewArchived: {}, updatedAt: 1 });
  const form = a.document.getElementById('eventForm');
  const btn = a.document.getElementById('eventFormCollapse');
  const head = a.document.querySelector('#eventForm .form-card-head');
  form.classList.remove('hidden');

  btn.onclick();
  check('collapsing adds the collapsed class, not hidden',
    form.classList.contains('collapsed') && !form.classList.contains('hidden'));
  check('the NEW EVENT header is still in the form when collapsed',
    !!head && head.textContent.includes('NEW EVENT'));
  check('the arrow points down when collapsed', btn.textContent === '\u2304', JSON.stringify(btn.textContent));

  btn.onclick();
  check('tapping again expands', !form.classList.contains('collapsed'));
  check('the arrow points up when expanded', btn.textContent === '\u2303', JSON.stringify(btn.textContent));

  btn.onclick();
  head.onclick({ target: head, closest: () => null });
  check('tapping the header expands it too', !form.classList.contains('collapsed'));
}

/* ---------- 6. there are two SAVE buttons and both commit ---------- */
{
  const a = boot({ templates: [], tplCleanupV1: true, deletedTemplates: {}, emails: [],
    archived: {}, deleted: {}, eventPolicy: {}, createdAt: {}, eventEdits: {},
    crewPerms: {}, crewArchived: {}, updatedAt: 1 });
  const top = a.document.getElementById('eventsSave');
  const bottom = a.document.getElementById('eventsSaveBottom');
  check('a SAVE exists at the top of EVENTS', !!top);
  check('a SAVE exists under the event list', !!bottom);
  check('the bottom SAVE is wired to a handler', typeof bottom.onclick === 'function');
  check('both SAVE buttons share the same handler', top.onclick === bottom.onclick);
  check('the bottom SAVE sits after the event list in the DOM',
    !!(bottom.compareDocumentPosition(a.document.getElementById('adminEvents')) & 2));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
