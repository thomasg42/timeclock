/* JustUs TimeClock — hash routing.
   Boots the REAL app.js inside the REAL index.html in a DOM, with a fake
   location/history, and drives navigation the way a phone would. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require_ = createRequire('/Users/tg2.0/Documents/FGA-Brain/cortana-ui/');
const { parseHTML } = require_('linkedom');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function boot(startHash = '') {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);

  // --- fake location + history that behave like a browser's hash history ---
  const listeners = { hashchange: [], popstate: [] };
  const stack = [`https://x/${startHash}`];
  let idx = 0;
  const loc = {
    get hash() { const h = stack[idx].indexOf('#'); return h === -1 ? '' : stack[idx].slice(h); },
    set hash(v) {
      const next = `https://x/${v.startsWith('#') ? v : `#${v}`}`;
      if (next === stack[idx]) return;
      stack.length = idx + 1; stack.push(next); idx++;
      listeners.hashchange.forEach((f) => f());
    },
  };
  const history = {
    pushState(_s, _t, url) { stack.length = idx + 1; stack.push(`https://x/${url}`); idx++; },
    replaceState(_s, _t, url) { stack[idx] = `https://x/${url}`; },
    back() { if (idx > 0) { idx--; listeners.popstate.forEach((f) => f()); listeners.hashchange.forEach((f) => f()); } },
    forward() { if (idx < stack.length - 1) { idx++; listeners.popstate.forEach((f) => f()); listeners.hashchange.forEach((f) => f()); } },
    get length() { return stack.length; },
  };

  // linkedom's window guards its own properties, so overlay the handful the app
  // touches rather than assigning onto it.
  const shim = {
    addEventListener: (type, fn) => { if (listeners[type]) listeners[type].push(fn); },
    removeEventListener: () => {},
    scrollTo: () => {},
    TC_API: 'https://stub.invalid/webhook',
    location: loc,
    history,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    prompt: () => null,
    confirm: () => false,
  };
  const win = new Proxy(window, {
    get: (t, k) => (k in shim ? shim[k] : t[k]),
    set: (t, k, v) => { shim[k] = v; return true; },
    has: (t, k) => k in shim || k in t,
  });

  const calls = [];
  const fetchStub = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => [] };
  };

  const ctx = vm.createContext({
    window: win, document, location: loc, history, navigator: { userAgent: 'test' },
    fetch: fetchStub, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: win.requestAnimationFrame, localStorage: {
      _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

  const visible = () => ['home', 'create', 'select', 'profile', 'admin']
    .find((v) => !document.getElementById(`view-${v}`).classList.contains('hidden'));
  return { document, loc, history, visible, calls, win };
}

/* ---------- 1. cold boot with no hash lands on home and stamps the URL ---------- */
{
  const a = boot('');
  check('cold boot with no hash shows home', a.visible() === 'home', `saw ${a.visible()}`);
  check('cold boot stamps #home in the URL', a.loc.hash === '#home', `saw "${a.loc.hash}"`);
  check('back arrow hidden on home', a.document.getElementById('backBtn').classList.contains('hidden'));
}

/* ---------- 2. THE REFRESH BUG: reloading on #admin stays on admin ---------- */
{
  const a = boot('#admin');
  check('refresh on #admin stays on admin', a.visible() === 'admin', `saw ${a.visible()}`);
  check('refresh on #admin shows the PIN gate, not the dashboard',
    !a.document.getElementById('adminGate').classList.contains('hidden')
    && a.document.getElementById('adminDash').classList.contains('hidden'));
  check('back arrow visible on admin', !a.document.getElementById('backBtn').classList.contains('hidden'));
}
{
  const a = boot('#create');
  check('refresh on #create stays on create', a.visible() === 'create', `saw ${a.visible()}`);
}
{
  const a = boot('#select');
  check('refresh on #select stays on select', a.visible() === 'select', `saw ${a.visible()}`);
  check('refresh on #select reloads the profile list', a.calls.some((u) => u.includes('tc-profiles')), a.calls.join(','));
}

/* ---------- 3. a cold #profile has no profile in memory — must not strand ---------- */
{
  const a = boot('#profile');
  check('refresh on #profile falls back to select', a.visible() === 'select', `saw ${a.visible()}`);
  check('the URL is corrected to #select', a.loc.hash === '#select', `saw "${a.loc.hash}"`);
}

/* ---------- 4. garbage hash degrades to home ---------- */
{
  const a = boot('#nonsense');
  check('unknown hash falls back to home', a.visible() === 'home', `saw ${a.visible()}`);
  check('unknown hash is rewritten to #home', a.loc.hash === '#home', `saw "${a.loc.hash}"`);
}

/* ---------- 5. tapping ADMIN changes the URL, and BACK returns ---------- */
{
  const a = boot('');
  a.document.getElementById('adminBtn').onclick();
  check('tapping ADMIN shows admin', a.visible() === 'admin', `saw ${a.visible()}`);
  check('tapping ADMIN pushes #admin', a.loc.hash === '#admin', `saw "${a.loc.hash}"`);
  a.history.back();
  check('phone back button returns to home', a.visible() === 'home', `saw ${a.visible()}`);
  check('phone back button restores #home', a.loc.hash === '#home', `saw "${a.loc.hash}"`);
  a.history.forward();
  check('phone forward button returns to admin', a.visible() === 'admin', `saw ${a.visible()}`);
}

/* ---------- 6. the on-screen back arrow goes up one level, never off-site ---------- */
{
  const a = boot('#admin');
  a.document.getElementById('backBtn').onclick();
  check('back arrow from admin lands on home', a.visible() === 'home', `saw ${a.visible()}`);
  check('back arrow from admin sets #home', a.loc.hash === '#home', `saw "${a.loc.hash}"`);
}
{
  const a = boot('#create');
  a.document.getElementById('backBtn').onclick();
  check('back arrow from create lands on home', a.visible() === 'home', `saw ${a.visible()}`);
}

/* ---------- 7. traversal fires popstate AND hashchange — must not double-work ---------- */
{
  const a = boot('');
  a.document.getElementById('btnGoSelect').onclick();
  const before = a.calls.filter((u) => u.includes('tc-profiles')).length;
  a.history.back();
  a.history.forward();
  const after = a.calls.filter((u) => u.includes('tc-profiles')).length;
  check('one profile fetch per arrival, not one per event', after - before === 1, `${after - before} fetches`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
