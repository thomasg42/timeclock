/* ============================================================
   JustUs Entertainment TimeClock — EMPLOYEE app logic
   Backend: n8n cloud webhooks (see config.js)

   This is the EMPLOYEE half of the split (2026-09-10). Tapping CLOCK IN no
   longer stamps anything: it files a REQUEST and puts the worker on a waiting
   screen. An admin, standing in front of them on the admin app, approves it —
   and that tap is the stamp. There is no admin section in this app at all.
   Admin app: ../timeclock-admin/ (separate repo, separate URL).
   ============================================================ */
(() => {
  'use strict';

  const API = window.TC_API;
  const $ = (id) => document.getElementById(id);

  /* ---------- tiny helpers ---------- */
  const rows = (data) => (Array.isArray(data) ? data : [data]).filter((r) => r && r.id != null);

  async function api(path, opts = {}) {
    const res = await fetch(`${API}/${path}`, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    if (!res.ok) {
      const err = new Error(`API ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const pad = (n) => String(n).padStart(2, '0');
  const localISO = (d = new Date()) => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  };
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(`${s}T12:00:00`);
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };
  const shiftHours = (p) => {
    if (!p.clock_in || !p.clock_out) return null;
    let ms = new Date(p.clock_out) - new Date(p.clock_in);
    if (p.break_start && p.break_end) ms -= new Date(p.break_end) - new Date(p.break_start);
    return Math.max(0, ms / 3600000);
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Worker-typed jobs get a deterministic id from the name, so two people typing
  // the same job land on the same event_id and their hours group together.
  const jobSlug = (name) => {
    const body = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return body ? `job-${body}` : `job-${Date.now()}`;
  };

  let toastTimer;
  function toast(msg, isErr = false, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function confirmAsk(title, text) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmModal').classList.remove('hidden');
      const done = (v) => {
        $('confirmModal').classList.add('hidden');
        $('confirmYes').onclick = $('confirmNo').onclick = null;
        resolve(v);
      };
      $('confirmYes').onclick = () => done(true);
      $('confirmNo').onclick = () => done(false);
    });
  }

  /* ---------- clocks ---------- */
  function tickClocks() {
    const now = new Date();
    $('liveClock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const hm = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const [time, ampm] = hm.split(' ');
    $('heroClock').textContent = time;
    $('heroAmpm').textContent = ampm || '';
    $('heroDate').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  setInterval(tickClocks, 1000);
  tickClocks();

  /* ---------- view router ----------

     Every page owns a URL (#home, #create, #select, #profile, #admin). Before
     this the whole app lived at one address: a refresh always dumped you back
     on the home screen, the phone's back arrow left the site entirely, and the
     only way home was tapping the brand. Now a refresh keeps you where you
     were and back/forward walk the pages.

     VIEW_PARENT is what the on-screen back arrow follows — deterministic "up
     one level", so it can never bounce you out of the app the way a raw
     history.back() can when the page was opened cold on a URL. */
  const VIEWS = ['home', 'create', 'select', 'profile'];
  const VIEW_PARENT = { home: null, create: 'home', select: 'home', profile: 'select' };
  let applyingHash = false;

  function show(view) {
    VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== view));
    window.scrollTo(0, 0);
    if (view !== 'profile') stopPendingPoll();
    const back = $('backBtn');
    if (back) back.classList.toggle('hidden', !VIEW_PARENT[view]);
    // Never push while a hash is being applied — that would fight the entry the
    // browser is already sitting on and break forward navigation.
    if (!applyingHash && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  }

  function currentView() {
    return VIEWS.find((v) => !$(`view-${v}`).classList.contains('hidden')) || 'home';
  }

  function syncHash(view) {
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  }

  /**
   * The URL decides which page is showing. Runs on boot, on hashchange, and on
   * back/forward. Idempotent, because a traversal fires both popstate and
   * hashchange and this must not do the work twice.
   */
  function routeFromHash() {
    const raw = String(location.hash || '').replace(/^#/, '').toLowerCase();
    let view = VIEWS.includes(raw) ? raw : 'home';
    // A refresh keeps the URL but not the in-memory state. A page that needs
    // state it no longer has redirects to the one that can rebuild it.
    if (view === 'profile' && !current.profile) view = 'select';
    if (currentView() === view) { syncHash(view); return; }
    applyingHash = true;
    try {
      if (view === 'select') { show('select'); loadProfiles(); }
      else show(view);
    } finally { applyingHash = false; }
    syncHash(view);
  }

  window.addEventListener('hashchange', routeFromHash);
  window.addEventListener('popstate', routeFromHash);

  function spinnerHtml() {
    return '<span class="tc-spinner" aria-hidden="true"></span> ';
  }

  $('brandHome').onclick = () => show('home');
  $('btnGoCreate').onclick = () => show('create');
  $('btnGoSelect').onclick = () => { show('select'); loadProfiles(); };
  // Up one level, never out of the app. The phone's own back button still walks
  // the full history separately.
  $('backBtn').onclick = () => {
    const parent = VIEW_PARENT[currentView()] || 'home';
    if (parent === 'select') { show('select'); loadProfiles(); }
    else show(parent);
  };

  /* ============================================================
     PROFILES
     ============================================================ */
  async function loadProfiles() {
    const list = $('profileList');
    list.innerHTML = '<p class="muted center">Loading crew…</p>';
    try {
      const profiles = rows(await api('tc-profiles'));
      if (!profiles.length) {
        list.innerHTML = '<p class="muted center">No profiles yet — create the first one.</p>';
        return;
      }
      list.innerHTML = '';
      profiles
        .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
        .forEach((p) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'profile-item';
          btn.innerHTML = `
            <span class="profile-avatar">${esc((p.first_name || '?')[0] || '')}${esc((p.last_name || '')[0] || '')}</span>
            <span><span class="profile-item-name">${esc(p.first_name)} ${esc(p.last_name)}</span><br>
            <span class="profile-item-sub">${esc(p.phone || p.email || '')}</span></span>`;
          btn.onclick = () => openProfile(p);
          list.appendChild(btn);
        });
    } catch {
      list.innerHTML = '<p class="form-err center">Couldn\'t load profiles. Check connection and retry.</p>';
    }
  }

  $('createForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('cpSubmit');
    // First name, last name and email are what the Tuesday time sheet needs to
    // reach this person. The fields are `required`, but that lets a space
    // through and can pin the browser's popup to a field scrolled out of the
    // card — so check here and say plainly what is missing.
    const first = $('cpFirst').value.trim();
    const last = $('cpLast').value.trim();
    const email = $('cpEmail').value.trim();
    const missing = [];
    if (!first) missing.push('first name');
    if (!last) missing.push('last name');
    if (!email) missing.push('email address');
    if (!missing.length && !/.+@.+\..+/.test(email)) missing.push('a valid email address');
    if (missing.length) {
      $('cpErr').textContent = `Add your ${missing.join(' and ')} — your time sheet is emailed to you every Tuesday.`;
      $('cpErr').classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    $('cpErr').classList.add('hidden');
    try {
      const profile = await api('tc-profiles', {
        method: 'POST',
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          dob: $('cpDob').value,
          email,
          phone: $('cpPhone').value.trim(),
        }),
      });
      $('createForm').reset();
      toast('Profile created. Welcome aboard!');
      openProfile(profile);
    } catch {
      $('cpErr').textContent = 'Could not create profile — try again.';
      $('cpErr').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };

  /* ============================================================
     PROFILE VIEW — punch lifecycle
     ============================================================ */
  let current = { profile: null, punches: [], open: null };

  async function openProfile(profile) {
    current.profile = profile;
    $('pfName').textContent = `${profile.first_name} ${profile.last_name}`;
    $('pfMeta').textContent = profile.email || '';
    show('profile');
    renderCreateEventAccess(profile);
    // Load before refreshing: a request filed earlier (or before the app was
    // closed) has to be known about before the screen decides what to draw.
    loadPendingReq();
    await refreshProfile();
    startPendingPoll();
  }

  /**
   * Whoever an admin has switched ON in Crew can post an event themselves —
   * the first person to arrive doesn't have to wait for Thomas or Josh. They
   * cannot delete one: deleting is still behind the admin PIN, by design.
   */
  async function renderCreateEventAccess(profile) {
    const slot = $('pfCreateEvent');
    if (!slot) return;
    slot.classList.add('hidden');
    slot.innerHTML = '';
    let allowed = false;
    try {
      allowed = rows(await api('tc-crew-flags'))
        .some((f) => String(f.profile_id) === String(profile.id) && f.can_create_events === true);
    } catch { return; }
    if (!allowed) return;

    /* A real form with native date/time pickers, not five window.prompt boxes.
       Prompts could only ever describe ONE day, and an event that runs Friday
       to Sunday is normal here — so start and end each get their own date. */
    slot.innerHTML = `
      <button type="button" class="big-btn outline" id="pfCreateToggle">
        <span class="big-btn-title">＋ CREATE EVENT</span>
        <span class="big-btn-sub">Everyone will see it on the clock-in list</span>
      </button>
      <div class="pf-create-form hidden" id="pfCreateForm">
        <div class="field-block">
          <label class="field-label" for="pfEvName">Event name</label>
          <input type="text" id="pfEvName" maxlength="60" autocomplete="off" placeholder="e.g. Maintenance at Midtown">
        </div>
        <div class="field-block">
          <span class="field-label">Starts</span>
          <div class="pf-when">
            <input type="date" id="pfEvStartDate">
            <input type="time" id="pfEvStartTime" value="16:00">
          </div>
        </div>
        <div class="field-block">
          <span class="field-label">Ends</span>
          <div class="pf-when">
            <input type="date" id="pfEvEndDate">
            <input type="time" id="pfEvEndTime" value="23:00">
          </div>
          <p class="field-note muted">Same day for a normal shift. Set a later end date for anything that runs more than one day.</p>
        </div>
        <p class="form-err hidden" id="pfEvErr"></p>
        <button type="button" class="big-btn primary" id="pfEvCreate"><span class="big-btn-title">CREATE EVENT</span></button>
      </div>`;

    const form = $('pfCreateForm');
    const errBox = $('pfEvErr');
    const today = localDate();
    $('pfEvStartDate').value = today;
    $('pfEvEndDate').value = today;

    $('pfCreateToggle').onclick = () => {
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) $('pfEvName').focus();
    };

    const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); };

    $('pfEvCreate').onclick = async () => {
      errBox.classList.add('hidden');
      const name = String($('pfEvName').value || '').trim().replace(/\s+/g, ' ');
      const sd = $('pfEvStartDate').value;
      const st = $('pfEvStartTime').value;
      const ed = $('pfEvEndDate').value;
      const et = $('pfEvEndTime').value;
      if (name.length < 2) return fail('Give the event a name first.');
      if (!sd || !st || !ed || !et) return fail('Fill in both dates and both times.');
      const startAt = new Date(`${sd}T${st}`);
      let endAt = new Date(`${ed}T${et}`);
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return fail('That date or time didn\'t read right.');
      // Same day with an earlier end time means it runs past midnight — the
      // normal case for a night shift, so roll it rather than reject it.
      let rolled = false;
      if (endAt <= startAt && sd === ed) { endAt = new Date(endAt.getTime() + 86400000); rolled = true; }
      if (endAt <= startAt) return fail('The end has to come after the start.');

      const btn = $('pfEvCreate');
      btn.disabled = true;
      btn.querySelector('.big-btn-title').textContent = 'CREATING…';
      try {
        await api('tc-events', {
          method: 'POST',
          body: JSON.stringify({
            creator_id: profile.id,
            name,
            start_at: localISO(startAt),
            end_at: localISO(endAt),
            owner_email: '',
          }),
        });
        toast(rolled
          ? `"${name}" is live — it ends the next morning, everyone can clock into it now.`
          : `"${name}" is live — everyone can clock into it now.`, false, 4500);
        $('pfEvName').value = '';
        form.classList.add('hidden');
      } catch {
        fail('Couldn\'t create that event — ask Thomas or Josh.');
      }
      btn.disabled = false;
      btn.querySelector('.big-btn-title').textContent = 'CREATE EVENT';
    };

    slot.classList.remove('hidden');
  }

  async function refreshProfile(opts = {}) {
    const silent = opts.silent === true;
    const histBox = $('pfHistory');
    if (!silent) {
      $('pfAction').innerHTML = '<p class="muted center">Loading…</p>';
      histBox.innerHTML = '<p class="muted center">Loading…</p>';
    }
    try {
      const punches = rows(await api(`tc-history?profileId=${encodeURIComponent(current.profile.id)}`))
        .sort((a, b) => String(b.clock_in).localeCompare(String(a.clock_in)));
      current.punches = punches;
      current.open = punches.find((p) => p.status === 'in' || p.status === 'break') || null;

      /* Did a manager act while this phone was waiting? The approved punch
         appearing in the worker's OWN history is the proof — no extra endpoint
         and no extra n8n execution just to ask "am I in yet?". */
      if (pendingReq) {
        if (pendingReq.kind === 'clock_in' && current.open) {
          savePendingReq(null);
          stopPendingPoll();
          toast('You\'re on the clock. Have a good shift!', false, 5000);
        } else if (pendingReq.kind === 'clock_out') {
          const done = punches.find((x) => String(x.id) === String(pendingReq.punch_id) && x.status === 'out');
          if (done) {
            savePendingReq(null);
            stopPendingPoll();
            showSummary(done);
          }
        }
      }

      renderAction();
      renderHistory();
    } catch {
      if (!silent) {
        $('pfAction').innerHTML = '<p class="form-err center">Couldn\'t reach the time clock. Retry.</p>';
        histBox.innerHTML = '';
      }
    }
  }

  function renderAction() {
    const box = $('pfAction');
    box.innerHTML = '';

    // A filed request outranks every other state. Until a manager acts, the
    // only honest thing this screen can say is that nothing has been stamped.
    if (pendingReq) { renderWaitingCard(box); return; }

    const p = current.open;

    if (!p) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'big-btn green';
      btn.innerHTML = '<span class="big-btn-title">⏱ CLOCK IN</span><span class="big-btn-sub">Asks a manager to let you in</span>';
      btn.onclick = startWizard;
      box.appendChild(btn);
      return;
    }

    // live shift card
    const card = document.createElement('div');
    card.className = 'shift-card';
    card.innerHTML = `
      <div class="shift-event">${esc(p.event_name || 'On the clock')}</div>
      <div class="shift-row"><span>Clocked in</span><b>${fmtTime(p.clock_in)}</b><span class="stamp in">IN</span></div>
      ${p.break_start ? `<div class="shift-row"><span>Break start</span><b>${fmtTime(p.break_start)}</b><span class="stamp break">BREAK</span></div>` : ''}
      ${p.break_end ? `<div class="shift-row"><span>Break end</span><b>${fmtTime(p.break_end)}</b><span class="stamp in">BACK</span></div>` : ''}`;
    box.appendChild(card);

    // break checkbox row
    const br = document.createElement('div');
    br.className = 'break-row';
    const canStartBreak = !p.break_start;
    const onBreak = p.status === 'break';
    br.innerHTML = `
      <span class="break-label"><span class="tc-check ${p.break_taken ? 'checked' : ''}"></span> BREAK</span>`;
    const brBtn = document.createElement('button');
    brBtn.type = 'button';
    brBtn.className = 'chip-btn';
    if (onBreak) {
      brBtn.textContent = 'END BREAK';
      brBtn.onclick = () => punchUpdate('break_end', 'End your break?', 'You\'ll be back on the clock.');
    } else if (canStartBreak) {
      brBtn.textContent = 'START BREAK';
      brBtn.onclick = () => punchUpdate('break_start', 'Start your break?', 'Break time will be logged on your sheet.');
    } else {
      brBtn.textContent = 'BREAK TAKEN';
      brBtn.disabled = true;
    }
    br.appendChild(brBtn);
    box.appendChild(br);

    // clock out
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'big-btn danger';
    out.innerHTML = '<span class="big-btn-title">ASK TO CLOCK OUT</span><span class="big-btn-sub">A manager confirms it</span>';
    out.disabled = onBreak;
    out.title = onBreak ? 'End your break first' : '';
    // Clocking out is a request too — the summary now appears when the manager
    // approves it, driven by the same poll that watches for the clock-in.
    out.onclick = requestClockOut;
    box.appendChild(out);
  }

  async function punchUpdate(action, title, text) {
    if (!current.open) return null;
    const yes = await confirmAsk(title, text);
    if (!yes) return null;
    try {
      const updated = await api('tc-punch', {
        method: 'POST',
        body: JSON.stringify({ action, punch_id: current.open.id, time: localISO() }),
      });
      await refreshProfile();
      if (action !== 'clock_out') toast(action === 'break_start' ? 'Break started.' : 'Back on the clock.');
      return updated;
    } catch {
      toast('That didn\'t go through — try again.', true);
      return null;
    }
  }

  function renderHistory() {
    const box = $('pfHistory');
    box.innerHTML = '';
    if (!current.punches.length) {
      box.innerHTML = '<p class="muted center">No shifts yet. Your history sticks around forever once you clock in.</p>';
      return;
    }
    current.punches.forEach((p) => {
      const live = p.status === 'in' || p.status === 'break';
      const h = shiftHours(p);
      const card = document.createElement('div');
      card.className = `hist-card${live ? ' hist-live' : ''}`;
      card.innerHTML = `
        <div class="hist-top">
          <span class="hist-date">${fmtDate(p.work_date)}</span>
          <span class="hist-event">${esc(p.event_name || '')}</span>
        </div>
        <div class="hist-grid">
          <div><span>In:</span> <b>${fmtTime(p.clock_in)}</b></div>
          <div><span>Out:</span> <b>${live ? 'on the clock' : fmtTime(p.clock_out)}</b></div>
          <div><span>Break in:</span> <b>${fmtTime(p.break_start)}</b></div>
          <div><span>Break out:</span> <b>${fmtTime(p.break_end)}</b></div>
        </div>
        <div class="hist-break">
          <span class="tc-check ${p.break_taken ? 'checked' : ''}"></span>
          ${p.break_taken ? 'BREAK TAKEN' : 'NO BREAK'}
          ${h != null ? `<span style="margin-left:auto"><b>${h.toFixed(2)} hrs</b></span>` : ''}
        </div>`;
      box.appendChild(card);
    });
  }

  /* ============================================================
     CLOCK-IN WIZARD — event pick + 1 required selfie
     ============================================================ */
  const SHOTS = [
    { key: 'selfie', title: 'YOU, ON SITE', sub: 'Selfie proving you\'re here. Look alive.', facing: 'user' },
  ];
  let wiz = null;

  async function startWizard() {
    wiz = { step: 0, event: null, photos: {}, stream: null };
    $('wizard').classList.remove('hidden');
    await renderWizard();
  }

  function stopStream() {
    if (wiz && wiz.stream) {
      wiz.stream.getTracks().forEach((t) => t.stop());
      wiz.stream = null;
    }
  }

  $('wizClose').onclick = () => { stopStream(); $('wizard').classList.add('hidden'); wiz = null; };

  async function renderWizard() {
    if (!wiz) return;
    const body = $('wizBody');
    stopStream();

    /* step 0 — what's this job for? (scheduled event, recent job, or typed) */
    if (wiz.step === 0) {
      $('wizStep').textContent = 'STEP 1 — JOB';
      body.innerHTML = '<div class="wiz-title">WHAT\'S THIS JOB FOR?</div><div class="wiz-sub">Checking today\'s events…</div>';
      let events = [];
      try {
        meta = loadMeta();
        await (metaSyncReady || Promise.resolve());
        await ensureMetaSynced({ allowPush: false });
        // LIVE RIGHT NOW only. The old filter kept anything not yet finished,
        // which offered events that had not started — so a worker could clock
        // into next Saturday's gig today. An event is offered only while the
        // clock is actually inside its window.
        const now = Date.now();
        events = rows(await api('tc-events')).map(applyEventEdit).filter((ev) => {
          if (isMetaEvent(ev) || isDeleted(ev.id) || isArchived(ev.id)) return false;
          const startsAt = Date.parse(ev.start_at || '');
          const endsAt = Date.parse(ev.end_at || '');
          if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return false;
          return startsAt <= now && now <= endsAt;
        });
      } catch { /* couldn't reach the schedule — the empty state below says so */ }

      /* Clocking in is TAP-ONLY, and only ACTIVE events are offered (Thomas,
         2026-08-26). No text box and no saved-event chips: both could put a
         worker on a job that is not running, and a typed one created an ad-hoc
         event carrying no policy packs — one typo split a crew's hours across
         two names on the time sheet. If nothing is live, nothing is offered.
         Creating an event belongs in Create Event, to whoever is permitted. */
      const sub = events.length
        ? 'Tap the event you\'re working.'
        : 'Nothing is running right now.';
      body.innerHTML = `
        <div class="wiz-title">WHAT'S THIS JOB FOR?</div>
        <div class="wiz-sub">${sub}</div>
        ${events.length
          ? '<div class="wiz-events" id="wizEvents"></div>'
          : `<p class="form-err center">No job is active right now, so there is nothing to clock into.
             A job only appears here while it is running. If you should be working, ask whoever runs
             the schedule to create the event under CREATE EVENT.</p>`}`;

      const choose = (ev) => { wiz.event = ev; wiz.step = 1; renderWizard(); };

      const list = $('wizEvents');
      if (list) {
        events.forEach((ev) => {
          const packs = policiesForEvent(ev);
          const packLabel = packs.length ? packs.map((p) => p.title).join(' + ') : 'No policies set';
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'profile-item';
          b.innerHTML = `<span><span class="profile-item-name">${esc(ev.name)}</span><br>
            <span class="profile-item-sub">${fmtTime(ev.start_at)} → ${fmtTime(ev.end_at)} · ${esc(packLabel)}</span></span>`;
          b.onclick = () => choose(ev);
          list.appendChild(b);
        });
      }

      return;
    }

    /* step 1 — selfie */
    if (wiz.step === 1) {
      const shot = SHOTS[0];
      const needsPolicies = policiesForEvent(wiz.event).length > 0;
      $('wizStep').textContent = needsPolicies ? 'STEP 2/4 — SELFIE' : 'STEP 2/3 — SELFIE';
      body.innerHTML = `
        <div class="wiz-title">${shot.title}</div>
        <div class="wiz-sub">${shot.sub} <b>Required.</b></div>
        <div class="cam-stage">
          <video id="camVideo" autoplay playsinline muted></video>
          <img id="camPreview" class="hidden" alt="preview">
          <div class="cam-frame"></div>
        </div>
        <div class="wiz-actions" id="camActions">
          <button class="big-btn outline" id="camFlip" type="button"><span class="big-btn-title">🔄 FLIP CAMERA</span></button>
          <button class="big-btn primary" id="camSnap" type="button"><span class="big-btn-title">📸 SNAP</span></button>
        </div>
        <div class="wiz-fallback">
          <label>Camera not working? Take it with your phone camera<input type="file" id="camFile" accept="image/*" capture></label>
        </div>`;

      const video = $('camVideo');
      const camErr = (msg) => {
        const stage = body.querySelector('.cam-stage');
        if (!stage || body.querySelector('.cam-error')) return;
        stage.insertAdjacentHTML('beforebegin', `<p class="form-err cam-error">${esc(msg)}</p>`);
      };

      // Which way the camera is pointing. Starts on the selfie camera and the
      // worker can flip to the back camera to show where they are.
      if (!wiz.facing) wiz.facing = shot.facing;

      async function startCam(facing) {
        stopStream();
        try {
          wiz.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false,
          });
        } catch {
          camErr('Camera blocked — allow camera access, or use the phone-camera link below.');
          return false;
        }
        video.srcObject = wiz.stream;
        // The selfie view is mirrored the way a mirror is, which is what people
        // expect; the captured frame is drawn from the unmirrored video, so the
        // saved photo is never backwards.
        video.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
        // iOS Safari does not reliably autoplay a stream attached after the
        // element was inserted, and a video that never plays reports
        // videoWidth 0 — which is what made SNAP capture a blank frame.
        if (video.readyState < 1) {
          await new Promise((resolve) => {
            const done = () => resolve();
            video.addEventListener('loadedmetadata', done, { once: true });
            setTimeout(done, 4000);
          });
        }
        try { await video.play(); } catch { /* already playing, or blocked; videoWidth still tells us */ }
        return true;
      }

      await startCam(wiz.facing);

      $('camFlip').onclick = async () => {
        const btn = $('camFlip');
        btn.disabled = true;
        wiz.facing = wiz.facing === 'user' ? 'environment' : 'user';
        const ok = await startCam(wiz.facing);
        // A phone with only one camera keeps working — flip back rather than
        // leaving the worker staring at a dead stage.
        if (!ok) {
          wiz.facing = wiz.facing === 'user' ? 'environment' : 'user';
          await startCam(wiz.facing);
        }
        btn.disabled = false;
      };

      const accept = (dataUrl) => {
        wiz.photos[shot.key] = dataUrl;
        stopStream();
        $('camVideo').classList.add('hidden');
        const img = $('camPreview');
        img.src = dataUrl;
        img.classList.remove('hidden');
        $('camActions').innerHTML = '';
        const retake = document.createElement('button');
        retake.type = 'button';
        retake.className = 'big-btn outline';
        retake.innerHTML = '<span class="big-btn-title">RETAKE</span>';
        retake.onclick = () => renderWizard();
        const next = document.createElement('button');
        next.type = 'button';
        next.id = 'wizPunch';
        // No policy pack on this job (typed jobs never have one) — the photo IS the last step.
        next.className = needsPolicies ? 'big-btn primary' : 'big-btn green';
        next.innerHTML = `<span class="big-btn-title">${needsPolicies ? 'CONTINUE →' : '⏱ CLOCK IN'}</span>`;
        next.onclick = needsPolicies
          ? () => { wiz.step = 2; renderWizard(); }
          : () => submitClockIn();
        $('camActions').append(retake, next);
        if (!needsPolicies && !$('wizErr')) {
          $('camActions').insertAdjacentHTML('afterend',
            '<p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>');
        }
      };

      $('camSnap').onclick = () => {
        // videoWidth is 0 until the stream is actually playing. Capturing then
        // produces a blank frame that looks like a white box, so refuse it.
        if (!video.videoWidth || !video.videoHeight) {
          toast('Camera not ready yet — give it a second, or use the phone-camera link.', true);
          return;
        }
        accept(frameToJpeg(video, video.videoWidth, video.videoHeight));
      };
      $('camFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const img = new Image();
        img.onload = () => accept(frameToJpeg(img, img.naturalWidth, img.naturalHeight));
        img.src = URL.createObjectURL(f);
      };
      return;
    }

    /* step 2 — acknowledge every policy attached to this event (after selfie) */
    if (wiz.step === 2) {
      meta = loadMeta();
      const packs = policiesForEvent(wiz.event);
      $('wizStep').textContent = packs.length ? 'STEP 3/4 — POLICIES' : 'STEP 3/3 — CLOCK IN';
      if (!packs.length) {
        body.innerHTML = `
          <div class="wiz-title">READY TO CLOCK IN</div>
          <div class="wiz-sub">No policy pack on <b>${esc(wiz.event.name)}</b>. Hit the button and a manager gets your request.</div>
          <div class="wiz-actions">
            <button class="big-btn green" id="wizPunch" type="button"><span class="big-btn-title">⏱ ASK TO CLOCK IN</span></button>
          </div>
          <p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>`;
        $('wizPunch').onclick = submitClockIn;
        return;
      }
      const packTitles = packs.map((p) => p.title).join(' · ');
      body.innerHTML = `
        <div class="wiz-title">READ & ACKNOWLEDGE</div>
        <div class="wiz-sub">${esc(wiz.event.name)} — scroll through every policy below, then confirm.</div>
        <p class="wiz-policy-list muted">${esc(packTitles)}</p>
        <div class="wiz-policy-scroll" id="wizPolicyScroll">${renderPolicyAckHtml(packs)}</div>
        <p class="wiz-scroll-hint" id="wizScrollHint">Scroll to the bottom to unlock acknowledge.</p>
        <label class="wiz-ack-check" id="wizAckLabel">
          <input type="checkbox" id="wizAckCheck" disabled>
          <span>I understand this policy and will conduct by such</span>
        </label>
        <div class="wiz-actions">
          <button class="big-btn green" id="wizPunch" type="button" disabled>
            <span class="big-btn-title">OK — ASK TO CLOCK IN</span>
          </button>
        </div>
        <p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>`;

      const scroller = $('wizPolicyScroll');
      const check = $('wizAckCheck');
      const punch = $('wizPunch');
      const hint = $('wizScrollHint');
      const unlock = () => {
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 12;
        if (atBottom) {
          check.disabled = false;
          hint.textContent = 'Check the box, then hit OK.';
          hint.classList.add('ready');
        }
        punch.disabled = !(atBottom && check.checked);
      };
      // short policies: unlock immediately if nothing to scroll
      requestAnimationFrame(() => {
        if (scroller.scrollHeight <= scroller.clientHeight + 4) {
          check.disabled = false;
          hint.textContent = 'Check the box, then hit OK.';
          hint.classList.add('ready');
        }
        unlock();
      });
      scroller.addEventListener('scroll', unlock, { passive: true });
      check.addEventListener('change', unlock);
      punch.onclick = submitClockIn;
      return;
    }

    /* step 3 — request filed. NOT clocked in: this used to say CONGRATULATIONS
       and it must never say that again, because at this point nothing has been
       stamped. A manager still has to approve it on the admin app. */
    $('wizStep').textContent = policiesForEvent(wiz.event).length ? 'STEP 4/4 — SENT' : 'STEP 3/3 — SENT';
    body.innerHTML = `
      <div class="wiz-congrats">
        <div class="wiz-title">REQUEST SENT</div>
        <div class="wiz-sub">You are <b>not on the clock yet</b>. A manager has to let you in for
          <b>${esc(wiz.event.name)}</b>. Go find whoever is running the door — the second they
          tap CLOCK IN, this page updates by itself.</div>
        <div class="wiz-actions">
          <button class="big-btn primary" id="wizDone" type="button"><span class="big-btn-title">DONE</span></button>
        </div>
      </div>`;
    $('wizDone').onclick = () => {
      $('wizard').classList.add('hidden');
      wiz = null;
    };
  }

  function renderPolicyListHtml(items) {
    if (!items || !items.length) return '';
    return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
  }
  function renderPolicySectionHtml(section) {
    const note = section.note ? `<p class="policy-group-note">${esc(section.note)}</p>` : '';
    const body = section.body ? esc(section.body) : '';
    const groups = (section.groups || []).map((g) => {
      const gNote = g.note ? `<p class="policy-group-note">${esc(g.note)}</p>` : '';
      return `<div class="policy-group"><h6>${esc(g.h)}</h6>${gNote}${renderPolicyListHtml(g.items)}</div>`;
    }).join('');
    return `<h5>${esc(section.h)}</h5>${note}${body}${renderPolicyListHtml(section.items)}${groups}`;
  }
  function packHasChecklists(pack) {
    return (pack.sections || []).some((s) =>
      (s.items && s.items.length) || (s.groups && s.groups.length)
    );
  }
  function renderPolicyBlockHtml(pack, { expandable } = {}) {
    const blurb = pack.blurb ? `<p class="policy-blurb">${esc(pack.blurb)}</p>` : '';
    const bullets = renderPolicyListHtml(pack.bullets);
    const full = (pack.sections || []).map(renderPolicySectionHtml).join('');
    const open = packHasChecklists(pack);
    let body = '';
    if (full) {
      if (open || !expandable) {
        body = `<div class="policy-full${open ? ' policy-full-open' : ''}">${full}</div>`;
      } else {
        body = `<details><summary>FULL POLICY — READ WORD FOR WORD</summary><div class="policy-full">${full}</div></details>`;
      }
    }
    return `<div class="policy-block">
      <h4>${esc(pack.title)}</h4>
      ${blurb}
      ${bullets}
      ${body}
    </div>`;
  }
  function renderPolicyAckHtml(packs) {
    return (packs || []).map((pack) => renderPolicyBlockHtml(pack, { expandable: false })).join('');
  }

  function frameToJpeg(source, w, h) {
    const MAX = 1024;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  async function submitClockIn() {
    const btn = $('wizPunch');
    if (!btn) return;
    btn.disabled = true;
    const title = btn.querySelector('.big-btn-title');
    const originalLabel = title ? title.textContent : '';
    if (title) title.textContent = 'SENDING…';
    try {
      // This posts to tc-request, NOT tc-punch. No punch row exists until an
      // admin approves it, so nothing here can put hours on a time sheet.
      const created = await api('tc-request', {
        method: 'POST',
        body: JSON.stringify({
          action: 'request',
          kind: 'clock_in',
          profile_id: current.profile.id,
          profile_name: `${current.profile.first_name} ${current.profile.last_name}`,
          event_id: wiz.event.id,
          event_name: wiz.event.name,
          work_date: localDate(),
          requested_at: localISO(),
          photos: wiz.photos,
          policies_acked: policiesForEvent(wiz.event).map((p) => p.id),
        }),
      });
      const row = Array.isArray(created) ? created[0] : created;
      if (!row || row.id == null) throw new Error('no pending row returned');
      savePendingReq({
        id: row.id,
        kind: 'clock_in',
        event_name: wiz.event.name,
        requested_at: row.requested_at || localISO(),
      });
      wiz.step = 3;
      await renderWizard();
      toast('Request sent — a manager has to let you in.', false, 5000);
      await refreshProfile();
      startPendingPoll();
    } catch {
      const err = $('wizErr');
      if (err) {
        err.textContent = 'Couldn\'t send the request — check signal and try again.';
        err.classList.remove('hidden');
      } else {
        toast('Couldn\'t send the request — check signal and try again.', true);
      }
      btn.disabled = false;
      if (title) title.textContent = originalLabel;
    }
  }

  /* ============================================================
     WAITING ON A MANAGER
     A request is a note on a whiteboard, not a punch. It lives in localStorage
     so closing the app doesn't lose it, and the page polls the worker's own
     history until the approved punch actually shows up.
     ============================================================ */
  let pendingReq = null;
  let pendingPollTimer = null;

  function pendingKey() {
    return `tc_pending_req_${current.profile ? current.profile.id : 'none'}`;
  }
  function loadPendingReq() {
    try {
      const raw = localStorage.getItem(pendingKey());
      pendingReq = raw ? JSON.parse(raw) : null;
    } catch { pendingReq = null; }
    return pendingReq;
  }
  function savePendingReq(req) {
    pendingReq = req || null;
    try {
      if (req) localStorage.setItem(pendingKey(), JSON.stringify(req));
      else localStorage.removeItem(pendingKey());
    } catch { /* private mode — the in-memory copy still drives this session */ }
  }

  function stopPendingPoll() {
    if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
  }
  function startPendingPoll() {
    stopPendingPoll();
    if (!pendingReq) return;
    const startedAt = Date.now();
    pendingPollTimer = setInterval(() => {
      if (!pendingReq) { stopPendingPoll(); return; }
      // A phone in a pocket, or one left on this screen and forgotten, must not
      // keep asking. Every poll is a billed n8n execution and this account has
      // been locked out by quota before. Screen off, or 30 minutes with no
      // answer, and it stops — the worker can pull to refresh by reopening.
      if (document.hidden) return;
      if (Date.now() - startedAt > 30 * 60 * 1000) { stopPendingPoll(); return; }
      if ($('view-profile').classList.contains('hidden')) return;
      refreshProfile({ silent: true });
    }, 8000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pendingReq && !$('view-profile').classList.contains('hidden')) {
      refreshProfile({ silent: true });
    }
  });

  async function cancelPendingReq() {
    if (!pendingReq) return;
    const yes = await confirmAsk('Take back your request?',
      'The manager will stop seeing it. You can ask again whenever you\'re ready.');
    if (!yes) return;
    const req = pendingReq;
    try {
      await api('tc-request', {
        method: 'POST',
        body: JSON.stringify({ action: 'cancel', pending_id: String(req.id) }),
      });
      savePendingReq(null);
      stopPendingPoll();
      toast('Request taken back.');
      await refreshProfile();
    } catch {
      toast('Couldn\'t take it back — try again.', true);
    }
  }

  async function requestClockOut() {
    if (!current.open) return;
    const yes = await confirmAsk('Ask to clock out?',
      'A manager has to confirm it. Your shift keeps running until they do.');
    if (!yes) return;
    try {
      const created = await api('tc-request', {
        method: 'POST',
        body: JSON.stringify({
          action: 'request',
          kind: 'clock_out',
          profile_id: current.profile.id,
          profile_name: `${current.profile.first_name} ${current.profile.last_name}`,
          punch_id: String(current.open.id),
          event_id: current.open.event_id || '',
          event_name: current.open.event_name || '',
          work_date: current.open.work_date || localDate(),
          requested_at: localISO(),
        }),
      });
      const row = Array.isArray(created) ? created[0] : created;
      if (!row || row.id == null) throw new Error('no pending row returned');
      savePendingReq({
        id: row.id,
        kind: 'clock_out',
        punch_id: String(current.open.id),
        event_name: current.open.event_name || '',
        requested_at: row.requested_at || localISO(),
      });
      toast('Asked to clock out — find a manager.', false, 5000);
      await refreshProfile();
      startPendingPoll();
    } catch {
      toast('Couldn\'t send that — try again.', true);
    }
  }

  function renderWaitingCard(box) {
    const isOut = pendingReq.kind === 'clock_out';
    const card = document.createElement('div');
    card.className = 'waiting-card';
    card.innerHTML = `
      <div class="waiting-pulse" aria-hidden="true"></div>
      <div class="waiting-title">${isOut ? 'WAITING TO CLOCK OUT' : 'WAITING TO CLOCK IN'}</div>
      <div class="waiting-sub">
        ${isOut
          ? 'You are still on the clock. A manager has to confirm your clock-out.'
          : `You are <b>not on the clock yet</b> for <b>${esc(pendingReq.event_name || 'this job')}</b>.`}
      </div>
      <div class="waiting-hint">Go to whoever is running the door and ask them to let you
        ${isOut ? 'out' : 'in'} on their app. This screen updates on its own.</div>`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'chip-btn waiting-cancel';
    cancel.textContent = isOut ? 'NEVER MIND' : 'TAKE IT BACK';
    cancel.onclick = cancelPendingReq;
    card.appendChild(cancel);
    box.appendChild(card);
  }

  /* ---------- shift summary after clock-out ---------- */
  function showSummary(p) {
    const h = shiftHours(p);
    $('summaryBody').innerHTML = `
      <div class="summary-sheet">
        <div class="shift-event">${esc(p.event_name || '')} — ${fmtDate(p.work_date)}</div>
        <div class="shift-row"><span>Shift start</span><b>${fmtTime(p.clock_in)}</b></div>
        <div class="shift-row"><span>Clocked in</span><b>${fmtTime(p.clock_in)}</b></div>
        ${p.break_taken
          ? `<div class="shift-row"><span>Break start</span><b>${fmtTime(p.break_start)}</b></div>
             <div class="shift-row"><span>Break end</span><b>${fmtTime(p.break_end)}</b></div>`
          : '<div class="shift-row"><span>Break</span><b>none taken ☐</b></div>'}
        <div class="shift-row"><span>Clocked out</span><b>${fmtTime(p.clock_out)}</b></div>
        <div class="summary-total"><span>TOTAL</span><span>${h != null ? `${h.toFixed(2)} HRS` : '—'}</span></div>
      </div>`;
    $('summaryModal').classList.remove('hidden');
  }
  $('summaryClose').onclick = () => $('summaryModal').classList.add('hidden');

  /* ============================================================
     EVENT META (archive / delete / emails / policies)
     localStorage is a cache. Cloud sync = sentinel n8n event
     __JUSTUS_TC_META__ so phone + desktop share one playing field.
     ============================================================ */
  const META_KEY = 'justus-tc-meta-v1';
  const META_EVENT_NAME = '__JUSTUS_TC_META__';
  const META_PREFIX = 'META_V1.';
  const POLICY_PACKS = {
    general: {
      id: 'general',
      title: 'General Staff Handbook',
      blurb: 'All events, all staff — alcohol, conduct, attendance, clock-in, vest, breaks, phones, discipline.',
      bullets: [
        'Zero-tolerance alcohol/sobriety on site — termination if violated.',
        'Clock in/out on your own device with a live selfie — no buddy punching.',
        'Arrive ~15 min early, vest on, ready at your post.',
        'Professional conduct with clients, guests, and crew at all times.',
        'Breaks logged accurately; clock-out blocked while on break.',
        'Personal phone use limited to clock-in/out, emergencies, or scheduled breaks.',
        'Client names, event details, and pricing stay confidential.',
      ],
      sections: [
        { h: 'Policy #1 — Alcohol & Sobriety (Zero Tolerance)', body: 'If you are at an event working, helping out, or on site in any capacity for JustUs Entertainment, you do not drink. At all. Not one drink. This applies whether you are clocked in or not, on break or not, in a vest or not, and whether alcohol is free. You may not arrive already under the influence, and you may not leave to drink and come back.\n\nCaught drinking or impaired: (1) immediate removal, unpaid for the rest of the shift, safe transport arranged — you will not drive yourself; (2) termination effective immediately — outside progressive discipline; (3) off the schedule. Rehire is owner discretion only, not a built-in second chance.\n\nIf offered a drink: “I appreciate it, but I\'m working.” If on impairing medication, tell your lead before the shift. If you see a coworker drinking, tell your lead immediately.' },
        { h: '02 — Code of Conduct', body: 'Treat every client, guest, coworker, and vendor with respect. No yelling, profanity directed at others, discrimination, or harassment — zero tolerance. No drugs or impairing substances before or during a shift. Represent JustUs Entertainment professionally on site. Follow reasonable direction from event leads; concerns go through the chain of command, not in front of clients.' },
        { h: '03 — Attendance, Punctuality & No-Show', body: 'Show up ~15 minutes early. Ready means parked, walked in, vest on, at your post. Up to 15 minutes late is workable only with a heads-up. More than 15 late or late with no heads-up: 1st verbal warning (logged), 2nd written, 3rd sat at home for that shift. No-call / no-show = suspended pending a management conversation. Schedule drops Wednesday — request off then. Day-of backing out is not acceptable except genuine emergencies.' },
        { h: '04 — Clock-In / Clock-Out & Photo Verification', body: 'All shifts tracked in this TimeClock app. Clock in/out on your own device — buddy punching is termination for both people. Clock-in requires one live selfie. Select the correct event. Log breaks accurately. Review the shift summary at clock-out; report discrepancies same day.' },
        { h: '05 — Appearance & High-Visibility Vest', body: 'Look professional. Wear your vest wherever issued (e.g. yellow PBR vests) at all times at your post. Closed-toe shoes for physical/outdoor posts. No offensive or alcohol/drug-branded apparel. The vest makes you findable, shows you are at post, signals support to security/police, and is a safety marker.' },
        { h: '06 — Event Day Conduct', body: 'You are a guest on the client\'s property. Stay at your assigned post unless directed otherwise. No personal guests at your post. Do not consume client food/drink unless lead-approved — alcohol never. Handle equipment with care; report damage. Direct pricing/contract/complaint questions to your lead — do not negotiate for the company.' },
        { h: '07 — Break Policy', body: '6+ hour shift: one 30-minute break (does not stack). Under 6 hours: no break. Log break start/end in the app. Do not leave post until lead confirms coverage. Do not clock out while a break is active. Policy #1 still applies on break.' },
        { h: '08 — Cell Phone & Communication', body: 'Personal phone use limited to clock-in/out, emergencies, or scheduled breaks. No phone use in front of clients during active work. No public photos/videos of clients/guests/private details without written client and management approval. Ringer silent on shift.' },
        { h: '09 — Progressive Discipline', body: 'Verbal warning → written warning → final written / suspension → termination. Zero-tolerance (no steps): drinking/impairment, harassment, discrimination, theft, buddy-punching.' },
        { h: '10 — Confidentiality & Social Media', body: 'Client names, event details, guest info, and pricing are confidential. No personal social posts about a client event without written approval. Approved content must reflect positively. Do not share internal scheduling, pay, or staffing outside the company.' },
      ],
    },
    pbr: {
      id: 'pbr',
      title: 'PBR & Rodeo (Big Sky)',
      blurb: 'Event-specific — parking, ticket booth, skyboxes. Check this plus the General Handbook when both apply.',
      bullets: [
        'Three stations: Parking Lot, Ticket Booth (scan + bracelets), Skyboxes & Crowd Control.',
        'Yellow high-vis vest on the entire post — never take it off on site.',
        'Parking: never box cars in; front lot only for handicapped / reserved / authorities / competitors.',
        'Ticket booth: security clears bags first, then one scan per person; match bracelet to ticket type.',
        'Skyboxes are lanyard-only. No lanyard = no access.',
        'Know your post (top / middle / bottom) and gate times before doors open.',
      ],
      sections: [
        { h: 'Overview', body: 'Stacks on the General Staff Policy Handbook. Three stations: (1) Parking Lot, (2) Ticket Booth — Scanning & Bracelets, (3) Skyboxes & Crowd Control. Know which station and position before gates open. When it is a rodeo, follow RODEO notes where they differ from PBR.' },
        { h: 'Section 1 — Parking Lot', body: 'Parking crew has the most authority of any station — be firm, clear, keep cars moving. Never let anyone park behind another car or box someone in.\n\nPBR Lower / Roundabout: send everyone into the lot up to the left. Spectators: straight, then left into general lot. Trail users: same left lot; warn trail closes at 6:00 PM ~2 hours. VIP parks in general lot — NOT front. FRONT LOT only: Handicapped, Reserved, Authorities/police, Competitors. Vendors/staff: general only. Media: one vehicle up front; extras in the big lot.\n\nDrop-off/bus script: “Keep going straight, go PAST the road closed sign, then there’s a stop sign — stop there and hop out. Then take the left down the parking entrance and come back out the way you came in.” Emphasize past the road-closed sign.\n\nTop lot (PBR): blocked for buses; no through traffic; run drop-off up top; reserved/handicapped go to bottom roundabout. VIP/reserved post: keep entrance AND exit open.\n\nPBR staffing (3): top, middle, bottom (strongest / lead).\n\nRODEO: keep RIGHT lane free. Buses up right, drop at gate, out to bottom lot. Top/bottom gate people open for buses. Extra person guides bottom lot; use rocks for lines. Cowboy trailers may change layout — use discretion. Always know top / middle / bottom and roundabout vs gate.' },
        { h: 'Section 2 — Ticket Booth', body: 'Security clears bags FIRST — then scan. One scan per person. Call out ticket type so bracelet person matches VIP vs GA. No outside drinks until finished. Usually NO re-entry — confirm with lead. Bracelets: snug but not tight (two bottom fingers underneath) — especially for kids. Backup phone ready; do not lock phone; use search by name if ticket fails.\n\nPresentation: smile, upbeat, yellow vest always on, no eating on post. Gates ~6:00 PM (sometimes 5:45); event ~7:00; real action ~7:30–8:00. Aspen Lane CLOSED — detour via Simkins Street.' },
        { h: 'Section 3 — Skyboxes & Crowd Control', body: 'Skyboxes are lanyard-only. Skybox 1 closest to entrance; 1–4 first bleacher set; 5–7 next; 8–10 far end by GA. Number is on bottom-left of lanyard. Sky View Platform is the tallest separate section — wristband-only guests not allowed; stop lanyard hand-offs.\n\nBleachers: check lanyard/wristband on the walk path. After show starts, no one against the rail blocking views. Escalation after two warnings: call on walkie with position (South/East/North bleachers) for backup/escort.' },
      ],
    },
    vip: {
      id: 'vip',
      title: 'VIP Policy',
      blurb: 'VIP Barber & Whisky Lounge — opening and closing lists. Scan, work, done.',
      bullets: [
        'Never leave a dirty bar.',
        'Never skip cash reconciliation.',
      ],
      sections: [
        {
          h: 'OPENING PROCEDURES',
          groups: [
            { h: 'Security + Entry', items: [
              'Unlock doors / Check cameras / Lights on',
              'Check for overnight issues (leaks, smell, power)',
              'Open blinds',
              'Water plants',
            ] },
            { h: 'Clean + Reset', items: [
              'Wipe all surfaces (bar top, prep, sinks, tables, convenient store wipe down)',
              'Empty trash if needed',
              'Restrooms quick check',
              'Remove clutter',
              'Set up seating outside and any other outdoor setups',
              'Organize Convenient Store / Restock',
            ] },
            { h: 'Bar Setup', items: [
              'Fill main ice bins / Make spheres',
              'Cut fresh citrus',
              'Restock napkins',
              'Set tools: shaker, jigger, bar spoon, etc.',
              'Polish 10–12 of each key glass',
              'Stage upside down, ready for speed',
            ] },
            { h: 'Liquor + Beer Check', items: [
              'Face all bottles and cans (labels forward, clean look)',
              'Restock wells',
              'Check cooler / Remove empties',
            ] },
            { h: 'Cash + POS', items: [
              'Grab drawer from back / Count drawer',
              'Set starting bank / Log it',
              'Turn on Square reader',
            ] },
            {
              h: 'Experience Check',
              note: 'Stand where the customer stands:',
              items: [
                'Does it look clean / Is lighting right? (Daytime bright fun, night time warmer darker)',
              ],
            },
            { h: 'Open Doors', items: [
              'Music on / Smile on / Guest gets attention immediately',
            ] },
            {
              h: 'Greeting — customers and barber clients (first 10 seconds)',
              items: [
                '“Welcome in. You drinking whiskey tonight or feeling something lighter?”',
              ],
            },
            {
              h: 'Order Upgrade',
              note: 'Customer: “I’ll take a whiskey.”',
              items: [
                'Response: “Want to keep it clean or go Old Fashioned?”',
              ],
            },
            { h: 'Add-on Script', items: [
              '“Want to add a beer with that?” “Want to add a Shot?” / “How Bout a Double?”',
              '“You want one more before your cut/service is finished?”',
            ] },
            { h: 'Weekly Premium Push', items: [
              '“McCallan normally $40. It’s $20 this week. Totally Worth it.”',
            ] },
          ],
        },
        {
          h: 'CLOSING PROCEDURES',
          groups: [
            { h: 'Last Call (30 min before close)', items: [
              'Announce clearly / Push final round / Start soft cleanup',
            ] },
            { h: 'Bar Breakdown — Liquor', items: [
              'Return to proper positions',
              'Note anything low',
            ] },
            { h: 'Bar Breakdown — Beer + Cooler', items: [
              'Consolidate / Face product / Remove empties',
            ] },
            { h: 'Cash Out', items: [
              'Count drawer',
              'Add profits to Safe in Back',
              'Log totals Cash / Credit / Comp',
            ] },
            { h: 'Cleaning — Bar Area', items: [
              'Wipe all surfaces',
              'Clean sinks',
              'Empty trash',
            ] },
            { h: 'Cleaning — Glassware', items: [
              'Wash all remaining',
              'Air dry properly',
            ] },
            { h: 'Cleaning — Floors', items: [
              'Sweep',
              'Mop (especially behind bar)',
            ] },
            { h: 'Restock for Tomorrow', items: [
              'Refill napkins',
              'Stage glassware',
              'Wrap garnishes & add to cooler',
            ] },
            { h: 'Inventory Quick Check (5 min)', items: [
              'What ran low?',
              'What sold best?',
              'What needs ordering?',
            ] },
            { h: 'Shutdown', items: [
              'Turn off: Lights / Equipment',
              'Move cash drawer to back',
              'Lock doors',
            ] },
            { h: 'Non-Negotiables', items: [
              'Never leave a dirty bar',
              'Never skip cash reconciliation',
            ] },
          ],
        },
      ],
    },
  };
  const DEFAULT_TEMPLATES = [
    { id: 'tpl-pbr', name: 'PBR / Rodeo — Big Sky', policyKeys: ['general', 'pbr'] },
    { id: 'tpl-vip', name: 'VIP Barber & Whisky Lounge', policyKeys: ['vip'] },
  ];

  function isVipLoungeName(name) {
    const n = String(name || '');
    if (/\bpbr\b|rodeo/i.test(n)) return false;
    return /\bvip\b|whisky|whiskey|barber/i.test(n);
  }
  function normalizePolicyKeys(val) {
    if (Array.isArray(val)) return val.filter((k) => POLICY_PACKS[k]);
    if (typeof val === 'string' && POLICY_PACKS[val]) return [val];
    return [];
  }
  function normalizeTemplate(t) {
    if (!t || !t.name) return null;
    if (/^general event$/i.test(String(t.name).trim())) return null; // retired placeholder
    const policyKeys = normalizePolicyKeys(t.policyKeys != null ? t.policyKeys : t.policyKey);
    return {
      id: t.id || `tpl-${Date.now()}`,
      name: String(t.name).trim(),
      policyKeys: policyKeys.length ? policyKeys : [],
      startHour: Number.isFinite(t.startHour) ? t.startHour : 10,
      startMin: Number.isFinite(t.startMin) ? t.startMin : 0,
      endHour: Number.isFinite(t.endHour) ? t.endHour : 22,
      endMin: Number.isFinite(t.endMin) ? t.endMin : 0,
      emails: Array.isArray(t.emails) ? t.emails.map(normalizeEmail).filter(isEmail) : [],
      duration: ['today', 'tomorrow', 'weekend', 'week', 'custom'].includes(t.duration) ? t.duration : 'custom',
      savedAt: Number(t.savedAt) || Date.now(),
    };
  }
  function migrateEventPolicyMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach((id) => {
      const keys = normalizePolicyKeys(raw[id]);
      if (keys.length) out[id] = keys;
    });
    return out;
  }
  /* ---------- Choose Event tombstones ----------

     Deleting a saved event USED TO ONLY REMOVE IT LOCALLY. mergeTemplates is a
     union of the local list and the blob on the server, so the very next cloud
     sync merged the deleted chip straight back — you could tap delete all night
     and they kept coming back. Events already had a `deleted` tombstone map;
     Choose Event had none. This is that missing map.

     Keyed by LOWERCASED NAME, not id, because mergeTemplates keys by name and
     the same event carries different ids on different devices (tpl-sync-6 here,
     tpl-1785531594210 there). An id-keyed tombstone would miss its twin. */
  const tplKey = (name) => String(name || '').trim().toLowerCase();
  const isTemplateDeleted = (map, name) => !!(map && map[tplKey(name)]);
  const dropDeletedTemplates = (list, map) =>
    (list || []).filter((t) => t && !isTemplateDeleted(map, t.name));

  // The four Thomas asked to keep (2026-08-26). Everything else in Choose Event
  // at that point was test junk — PBR1, Real Test Event, Webhook Test Event.
  const CLEANUP_V1_KEEP = ['pbr / rodeo — big sky', 'wildlands', 'music in the mountains', 'rbar', 'vip barber & whisky lounge'];

  function loadMeta() {
    try {
      const raw = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      const deletedTemplates = raw.deletedTemplates && typeof raw.deletedTemplates === 'object'
        ? { ...raw.deletedTemplates } : {};
      let templates = (Array.isArray(raw.templates) ? raw.templates : [])
        .map(normalizeTemplate)
        .filter(Boolean);
      // One-time cleanup of the accumulated test entries. Runs once per device,
      // then never again — so anything created afterwards is left alone.
      let cleanupV1 = raw.tplCleanupV1 === true;
      const ranCleanup = !cleanupV1;
      if (ranCleanup) {
        templates.forEach((t) => {
          if (!CLEANUP_V1_KEEP.includes(tplKey(t.name))) deletedTemplates[tplKey(t.name)] = true;
        });
        cleanupV1 = true;
      }
      templates = dropDeletedTemplates(templates, deletedTemplates);
      // Dedupe by name. mergeTemplates keys by name, so a blob written by an
      // older build (or a half-merged one) can carry the same event twice and
      // it would show as two identical chips.
      {
        const seen = new Set();
        templates = templates.filter((t) => {
          const k = tplKey(t.name);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      // Reseed AFTER the tombstone filter, or a deleted entry walks back in.
      if (!templates.length && !isTemplateDeleted(deletedTemplates, DEFAULT_TEMPLATES[0].name)) {
        templates = DEFAULT_TEMPLATES.map((t) => ({ ...t, policyKeys: t.policyKeys.slice() }));
      }
      // ensure seeded PBR exists if someone wiped it while keeping other names
      if (!templates.some((t) => /pbr|rodeo/i.test(t.name))
        && !isTemplateDeleted(deletedTemplates, DEFAULT_TEMPLATES[0].name)) {
        templates = [DEFAULT_TEMPLATES[0], ...templates];
      }
      const vipTpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tpl-vip');
      if (vipTpl
        && !templates.some((t) => isVipLoungeName(t.name))
        && !isTemplateDeleted(deletedTemplates, vipTpl.name)) {
        templates = [...templates, { ...vipTpl, policyKeys: vipTpl.policyKeys.slice() }];
      }
      const out = {
        deletedTemplates,
        tplCleanupV1: cleanupV1,
        emails: Array.isArray(raw.emails) ? raw.emails : ['thomasg@forevergoldai.com'],
        templates,
        archived: raw.archived && typeof raw.archived === 'object' ? raw.archived : {},
        deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {},
        eventPolicy: migrateEventPolicyMap(raw.eventPolicy),
        createdAt: raw.createdAt && typeof raw.createdAt === 'object' ? raw.createdAt : {},
        eventEdits: raw.eventEdits && typeof raw.eventEdits === 'object' ? raw.eventEdits : {},
        // Per-person admin flags. These gate UI only — the admin PIN is the
        // real lock — so they ride the shared meta blob and sync across
        // devices without needing a column the data table cannot grow.
        crewPerms: raw.crewPerms && typeof raw.crewPerms === 'object' ? raw.crewPerms : {},
        crewArchived: raw.crewArchived && typeof raw.crewArchived === 'object' ? raw.crewArchived : {},
        updatedAt: Number(raw.updatedAt) || 0,
      };
      // Persist the migration the moment it runs. Without this the flag never
      // reaches storage, the cleanup re-runs on EVERY load, and any event
      // created afterwards gets tombstoned on the next open — the cleanup would
      // quietly eat new work forever. Bump updatedAt so the tombstones win the
      // next cloud merge instead of losing to the server's older copy.
      if (ranCleanup) {
        out.updatedAt = Date.now();
        try { localStorage.setItem(META_KEY, JSON.stringify(out)); } catch { /* storage full — the in-memory copy still holds */ }
      }
      return out;
    } catch (err) {
      // A silent catch here hid a real bug: any throw inside loadMeta looked
      // exactly like "first run", quietly replacing every saved event with the
      // default. Say so.
      console.warn('[timeclock] loadMeta failed, falling back to defaults', err);
      return {
        emails: ['thomasg@forevergoldai.com'],
        templates: DEFAULT_TEMPLATES.map((t) => ({ ...t, policyKeys: t.policyKeys.slice() })),
        deletedTemplates: {},
        tplCleanupV1: true,
        archived: {},
        deleted: {},
        eventPolicy: {},
        createdAt: {},
        eventEdits: {},
        crewPerms: {},
        crewArchived: {},
        updatedAt: 0,
      };
    }
  }

  let meta = loadMeta();
  let cloudPushTimer = null;
  let cloudSyncing = false;
  let cloudPushPromise = null;
  let lastPushedAt = 0;
  let metaSyncReady = null;

  function isMetaEvent(ev) {
    return !!ev && String(ev.name || '').trim() === META_EVENT_NAME;
  }

  function encodeMetaBlob(snapshot) {
    const json = JSON.stringify(snapshot);
    return META_PREFIX + btoa(unescape(encodeURIComponent(json)));
  }

  function decodeMetaBlob(ownerEmail) {
    const s = String(ownerEmail || '');
    if (!s.startsWith(META_PREFIX)) return null;
    try {
      return JSON.parse(decodeURIComponent(escape(atob(s.slice(META_PREFIX.length)))));
    } catch {
      return null;
    }
  }

  function uniqEmails(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((e) => {
      const n = normalizeEmail(e);
      if (!isEmail(n) || seen.has(n)) return;
      seen.add(n);
      out.push(n);
    });
    return out;
  }

  function mergeTemplates(localList, remoteList, tombstones) {
    const map = new Map();
    [...(remoteList || []), ...(localList || [])].forEach((t) => {
      const n = normalizeTemplate(t);
      if (!n) return;
      const key = n.name.toLowerCase();
      // A tombstone beats a surviving copy on either side. Without this the
      // remote blob resurrects everything the admin just deleted.
      if (isTemplateDeleted(tombstones, key)) return;
      const prev = map.get(key);
      if (!prev || (n.savedAt || 0) >= (prev.savedAt || 0)) map.set(key, n);
    });
    return [...map.values()]
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 24);
  }

  function mergeEdits(localMap, remoteMap) {
    const out = { ...(remoteMap || {}) };
    Object.keys(localMap || {}).forEach((id) => {
      const loc = localMap[id];
      const rem = out[id];
      if (!rem) out[id] = loc;
      else if ((loc.updatedAt || 0) >= (rem.updatedAt || 0)) out[id] = { ...rem, ...loc };
    });
    return out;
  }

  function mergeBoolMaps(localMap, remoteMap, localAt, remoteAt) {
    // Same-key conflict: newer whole-meta timestamp wins; otherwise OR so neither device drops a hide.
    const out = { ...(remoteMap || {}) };
    Object.keys(localMap || {}).forEach((id) => {
      if (out[id] == null) out[id] = localMap[id];
      else if ((localAt || 0) >= (remoteAt || 0)) out[id] = localMap[id];
      else out[id] = !!(out[id] || localMap[id]);
    });
    return out;
  }

  function mergeMetaState(local, remote) {
    if (!remote || remote.v !== 1) return local;
    const localAt = Number(local.updatedAt) || 0;
    const remoteAt = Number(remote.updatedAt) || 0;
    const policy = (localAt >= remoteAt)
      ? { ...(remote.eventPolicy || {}), ...(local.eventPolicy || {}) }
      : { ...(local.eventPolicy || {}), ...(remote.eventPolicy || {}) };
    const created = { ...(remote.createdAt || {}), ...(local.createdAt || {}) };
    const mergedTplTombs = mergeBoolMaps(local.deletedTemplates, remote.deletedTemplates, localAt, remoteAt);
    return {
      emails: uniqEmails([...(remote.emails || []), ...(local.emails || [])]).slice(0, 20),
      // Tombstones merge FIRST so the template merge below can honour them.
      deletedTemplates: mergedTplTombs,
      tplCleanupV1: local.tplCleanupV1 === true || remote.tplCleanupV1 === true,
      templates: mergeTemplates(local.templates, remote.templates, mergedTplTombs),
      archived: mergeBoolMaps(local.archived, remote.archived, localAt, remoteAt),
      deleted: mergeBoolMaps(local.deleted, remote.deleted, localAt, remoteAt),
      eventPolicy: migrateEventPolicyMap(policy),
      createdAt: created,
      eventEdits: mergeEdits(local.eventEdits, remote.eventEdits),
      crewPerms: mergeBoolMaps(local.crewPerms, remote.crewPerms, localAt, remoteAt),
      crewArchived: mergeBoolMaps(local.crewArchived, remote.crewArchived, localAt, remoteAt),
      updatedAt: Math.max(localAt, remoteAt),
    };
  }

  function saveMeta(m, opts = {}) {
    const sync = opts.sync !== false;
    m.updatedAt = Date.now();
    localStorage.setItem(META_KEY, JSON.stringify(m));
    meta = m;
    if (sync) scheduleCloudMetaPush();
  }

  function scheduleCloudMetaPush() {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
      pushCloudMeta().catch(() => {});
    }, 450);
  }

  async function listMetaEventRows() {
    const events = rows(await api('tc-events'));
    return events
      .filter(isMetaEvent)
      .map((ev) => ({ ev, blob: decodeMetaBlob(ev.owner_email) }))
      .filter((row) => row.blob && row.blob.v === 1)
      .sort((a, b) => (b.blob.updatedAt || 0) - (a.blob.updatedAt || 0));
  }

  async function pullAndMergeCloudMeta() {
    const rowsMeta = await listMetaEventRows();
    if (!rowsMeta.length) return false;
    const latest = rowsMeta[0];
    // Hide every sentinel row from Active/Archive UI on all devices
    rowsMeta.forEach(({ ev }) => {
      if (ev && ev.id != null) meta.deleted[String(ev.id)] = true;
    });
    meta = mergeMetaState(meta, latest.blob);
    localStorage.setItem(META_KEY, JSON.stringify(meta));
    return true;
  }

  async function pushCloudMeta() {
    if (!adminPinOk) return false;
    if (cloudPushPromise) {
      await cloudPushPromise;
      if ((Number(meta.updatedAt) || 0) > lastPushedAt) return pushCloudMeta();
      return true;
    }
    if ((Number(meta.updatedAt) || 0) <= lastPushedAt) return true;

    cloudSyncing = true;
    cloudPushPromise = (async () => {
      try {
        // Merge the newest shared copy immediately before writing. This keeps a
        // phone delete from being overwritten by a computer that was already open.
        try {
          const prior = await listMetaEventRows();
          if (prior[0]) meta = mergeMetaState(meta, prior[0].blob);
          prior.forEach(({ ev }) => {
            if (ev && ev.id != null) meta.deleted[String(ev.id)] = true;
          });
        } catch { /* still push the local pending change */ }

        const snapshot = {
          v: 1,
          updatedAt: meta.updatedAt || Date.now(),
          emails: meta.emails,
          templates: meta.templates,
          // Without these two in the snapshot the tombstone never leaves the
          // phone, and the next device to sync hands every deleted chip back.
          deletedTemplates: meta.deletedTemplates || {},
          tplCleanupV1: meta.tplCleanupV1 === true,
          archived: meta.archived,
          deleted: meta.deleted,
          eventPolicy: meta.eventPolicy,
          createdAt: meta.createdAt,
          eventEdits: meta.eventEdits,
          crewPerms: meta.crewPerms,
          crewArchived: meta.crewArchived,
        };
        if (snapshot.updatedAt <= lastPushedAt) return true;
        const owner = encodeMetaBlob(snapshot);
        if (owner.length > 100000) {
          console.warn('[timeclock] meta blob too large to sync');
          return false;
        }

        const created = await api('tc-events', {
          method: 'POST',
          body: JSON.stringify({
            pass: adminPinOk,
            name: META_EVENT_NAME,
            start_at: '2099-01-01T00:00:00-07:00',
            end_at: '2099-01-01T00:01:00-07:00',
            owner_email: owner,
          }),
        });
        const row = Array.isArray(created) ? created[0] : created;
        if (row && row.id != null) meta.deleted[String(row.id)] = true;
        lastPushedAt = snapshot.updatedAt;
        localStorage.setItem(META_KEY, JSON.stringify(meta));
        return true;
      } finally {
        cloudSyncing = false;
      }
    })();

    try {
      return await cloudPushPromise;
    } finally {
      cloudPushPromise = null;
      // A save/delete may have landed while the previous shared write was in flight.
      if ((Number(meta.updatedAt) || 0) > lastPushedAt) scheduleCloudMetaPush();
    }
  }

  async function flushCloudMeta() {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = null;
    try {
      return await pushCloudMeta();
    } catch (err) {
      scheduleCloudMetaPush();
      throw err;
    }
  }

  async function ensureMetaSynced({ allowPush = true } = {}) {
    try {
      await pullAndMergeCloudMeta();
    } catch { /* offline / API — keep local cache */ }
    if (allowPush && adminPinOk) {
      try { await pushCloudMeta(); } catch { /* retry on next save */ }
    }
  }

  // Warm shared meta as soon as the app loads (read-only until admin unlocks)
  metaSyncReady = ensureMetaSynced({ allowPush: false });

  function rememberEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    meta.emails = [e, ...meta.emails.filter((x) => x.toLowerCase() !== e)].slice(0, 20);
    saveMeta(meta);
  }
  function markCreated(eventId) {
    if (eventId == null) return;
    meta.createdAt[String(eventId)] = Date.now();
    saveMeta(meta);
  }
  function createdRank(ev) {
    const stamped = meta.createdAt[String(ev.id)];
    if (stamped) return stamped;
    // fallback: start time so older events without a stamp sink below new ones
    const t = Date.parse(ev.start_at || '') || 0;
    return t;
  }
  function setEventPolicies(eventId, policyKeys) {
    if (!eventId) return;
    meta.eventPolicy[String(eventId)] = normalizePolicyKeys(policyKeys);
    saveMeta(meta);
  }
  function saveEventEdit(eventId, patch) {
    if (eventId == null) return;
    const id = String(eventId);
    meta.eventEdits[id] = { ...(meta.eventEdits[id] || {}), ...patch, updatedAt: Date.now() };
    saveMeta(meta);
  }
  function applyEventEdit(ev) {
    if (!ev || ev.id == null) return ev;
    const ed = meta.eventEdits[String(ev.id)];
    if (!ed) return ev;
    return {
      ...ev,
      name: ed.name != null ? ed.name : ev.name,
      start_at: ed.start_at != null ? ed.start_at : ev.start_at,
      end_at: ed.end_at != null ? ed.end_at : ev.end_at,
      owner_email: ed.owner_email != null ? ed.owner_email : ev.owner_email,
    };
  }
  function rememberTemplate(name, extras = {}) {
    const n = String(name || '').trim();
    if (!n) return;
    const keys = normalizePolicyKeys(extras.policyKeys);
    const payload = {
      id: `tpl-${Date.now()}`,
      name: n,
      policyKeys: keys,
      startHour: Number.isFinite(extras.startHour) ? extras.startHour : 10,
      startMin: Number.isFinite(extras.startMin) ? extras.startMin : 0,
      endHour: Number.isFinite(extras.endHour) ? extras.endHour : 22,
      endMin: Number.isFinite(extras.endMin) ? extras.endMin : 0,
      emails: Array.isArray(extras.emails) ? extras.emails.map(normalizeEmail).filter(isEmail) : [],
      duration: ['today', 'tomorrow', 'weekend', 'week', 'custom'].includes(extras.duration) ? extras.duration : 'custom',
      savedAt: Date.now(),
    };
    // Creating this event again is a deliberate undo of any earlier delete.
    if (meta.deletedTemplates) delete meta.deletedTemplates[tplKey(n)];
    const existing = meta.templates.find((t) => t.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      existing.name = n;
      existing.policyKeys = payload.policyKeys;
      existing.startHour = payload.startHour;
      existing.startMin = payload.startMin;
      existing.endHour = payload.endHour;
      existing.endMin = payload.endMin;
      existing.emails = payload.emails;
      existing.duration = payload.duration;
      existing.savedAt = payload.savedAt;
      // bump to front of Choose Event
      meta.templates = [existing, ...meta.templates.filter((t) => t.id !== existing.id)];
    } else {
      meta.templates = [payload, ...meta.templates].slice(0, 24);
    }
    saveMeta(meta);
  }

  /** Pull event names from the live list into Choose Event chips (covers typed creates that need to stick). */
  function syncTemplatesFromEvents(events) {
    let changed = false;
    (events || []).forEach((ev) => {
      if (!ev || isMetaEvent(ev) || isDeleted(ev.id) || !ev.name) return;
      const n = String(ev.name).trim();
      if (!n) return;
      // The second resurrection path: this backfills a chip from every live
      // event row, so a deleted chip whose event still exists came back on the
      // next admin load. A tombstone stops that too.
      if (isTemplateDeleted(meta.deletedTemplates, n)) return;
      const already = meta.templates.find((t) => t.name.toLowerCase() === n.toLowerCase());
      if (already) return;
      const keys = normalizePolicyKeys(meta.eventPolicy[String(ev.id)]);
      meta.templates.unshift({
        id: `tpl-sync-${ev.id}`,
        name: n,
        policyKeys: keys,
        startHour: 10,
        startMin: 0,
        endHour: 22,
        endMin: 0,
        emails: String(ev.owner_email || '')
          .split(/[,;]+/)
          .map(normalizeEmail)
          .filter(isEmail),
        duration: 'custom',
        savedAt: Date.parse(ev.start_at || '') || Date.now(),
      });
      changed = true;
    });
    if (changed) {
      meta.templates = meta.templates.slice(0, 24);
      saveMeta(meta);
    }
  }
  function policiesForEvent(ev) {
    const id = String(ev && ev.id != null ? ev.id : '');
    const fromEdit = meta.eventEdits && meta.eventEdits[id] && meta.eventEdits[id].policyKeys;
    if (Array.isArray(fromEdit) && fromEdit.length) {
      return normalizePolicyKeys(fromEdit).map((k) => POLICY_PACKS[k]).filter(Boolean);
    }
    const stored = meta.eventPolicy[id];
    if (stored && stored.length) return stored.map((k) => POLICY_PACKS[k]).filter(Boolean);
    const tpl = meta.templates.find((t) => t.name.toLowerCase() === String(ev.name || '').toLowerCase());
    if (tpl && tpl.policyKeys.length) return tpl.policyKeys.map((k) => POLICY_PACKS[k]).filter(Boolean);
    if (/\bpbr\b|rodeo/i.test(ev.name || '')) return [POLICY_PACKS.general, POLICY_PACKS.pbr];
    if (isVipLoungeName(ev.name)) return [POLICY_PACKS.vip];
    return [];
  }
  function isArchived(id) { return !!meta.archived[String(id)]; }
  function isDeleted(id) { return !!meta.deleted[String(id)]; }
  function archiveEvent(id) {
    meta.archived[String(id)] = true;
    delete meta.deleted[String(id)];
    saveMeta(meta);
  }
  function restoreEvent(id) {
    delete meta.archived[String(id)];
    saveMeta(meta);
  }
  function deleteEvent(id) {
    meta.deleted[String(id)] = true;
    delete meta.archived[String(id)];
    saveMeta(meta);
  }

  async function deleteEventEverywhere(id) {
    deleteEvent(id);
    try {
      return await flushCloudMeta();
    } catch {
      return false;
    }
  }

  /* ---------- admin lives in a SEPARATE APP now (split 2026-09-10) ----------
     The dashboard, the PIN pad, the day sheet, crew, events and the week view
     all moved to ../timeclock-admin/ (its own repo and URL). Workers never see
     them here. This constant stays because the shared cloud-meta sync uses the
     admin pass to decide whether it may PUSH: with no pass this app can only
     ever PULL, which is exactly right for a worker's phone. ---------- */
  const adminPinOk = null;

  /* ---------- boot: the URL decides which page opens ----------
     Last, not at the top: routing can call loadProfiles, so every view
     function has to exist before the first route runs. */
  routeFromHash();

  /* ---------- QA hooks (harmless in production) ---------- */
  window.__tc = {
    show, openProfile, loadProfiles, api,
    // The real functions, not test-only wrappers — a hook that reimplements the
    // path it is meant to check proves nothing.
    startWizard, renderCreateEventAccess,
    policiesForEvent, renderPolicyAckHtml,
    // The real wizard object and the real renderer, so a test can step past the
    // camera (which no headless DOM can drive) without faking the punch path.
    renderWizard, get wiz() { return wiz; },
    requestClockOut, cancelPendingReq, loadPendingReq, savePendingReq, refreshProfile,
    get pendingReq() { return pendingReq; },
    get current() { return current; },
    get meta() { return meta; },
    ensureMetaSynced, pushCloudMeta, pullAndMergeCloudMeta,
  };
})();
