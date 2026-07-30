/* ============================================================
   JustUs Entertainment TimeClock — app logic
   Backend: n8n cloud webhooks (see config.js)
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

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
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

  /* ---------- view router ---------- */
  const VIEWS = ['home', 'create', 'select', 'profile', 'admin'];
  function show(view) {
    VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== view));
    window.scrollTo(0, 0);
  }

  $('brandHome').onclick = () => show('home');
  $('btnGoCreate').onclick = () => show('create');
  $('btnGoSelect').onclick = () => { show('select'); loadProfiles(); };
  $('adminBtn').onclick = () => { openAdmin(); };

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
    btn.disabled = true;
    $('cpErr').classList.add('hidden');
    try {
      const profile = await api('tc-profiles', {
        method: 'POST',
        body: JSON.stringify({
          first_name: $('cpFirst').value.trim(),
          last_name: $('cpLast').value.trim(),
          dob: $('cpDob').value,
          email: $('cpEmail').value.trim(),
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
    await refreshProfile();
  }

  async function refreshProfile() {
    const histBox = $('pfHistory');
    $('pfAction').innerHTML = '<p class="muted center">Loading…</p>';
    histBox.innerHTML = '<p class="muted center">Loading…</p>';
    try {
      const punches = rows(await api(`tc-history?profileId=${encodeURIComponent(current.profile.id)}`))
        .sort((a, b) => String(b.clock_in).localeCompare(String(a.clock_in)));
      current.punches = punches;
      current.open = punches.find((p) => p.status === 'in' || p.status === 'break') || null;
      renderAction();
      renderHistory();
    } catch {
      $('pfAction').innerHTML = '<p class="form-err center">Couldn\'t reach the time clock. Retry.</p>';
      histBox.innerHTML = '';
    }
  }

  function renderAction() {
    const box = $('pfAction');
    box.innerHTML = '';
    const p = current.open;

    if (!p) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'big-btn green';
      btn.innerHTML = '<span class="big-btn-title">⏱ CLOCK IN</span><span class="big-btn-sub">Create clock-in time</span>';
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
    out.innerHTML = '<span class="big-btn-title">CLOCK OUT</span><span class="big-btn-sub">End your shift</span>';
    out.disabled = onBreak;
    out.title = onBreak ? 'End your break first' : '';
    out.onclick = async () => {
      const updated = await punchUpdate('clock_out', 'Are you sure?', 'This ends your shift and stamps your clock-out time.');
      if (updated) showSummary(updated);
    };
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

    /* step 0 — pick event */
    if (wiz.step === 0) {
      $('wizStep').textContent = 'STEP 1/3 — EVENT';
      body.innerHTML = '<div class="wiz-title">PICK YOUR EVENT</div><div class="wiz-sub">Loading events…</div>';
      let events = [];
      try {
        meta = loadMeta();
        events = rows(await api('tc-events')).filter((ev) =>
          !isDeleted(ev.id) && !isArchived(ev.id) && (!ev.end_at || new Date(ev.end_at) > new Date()));
      } catch { /* fall through */ }
      if (!events.length) {
        body.innerHTML = `
          <div class="wiz-title">NO OPEN EVENTS</div>
          <div class="wiz-sub">There's no event to clock into yet. Ask the admin to create today's event, then try again.</div>`;
        return;
      }
      body.innerHTML = '<div class="wiz-title">PICK YOUR EVENT</div><div class="wiz-sub">Which job are you clocking into?</div><div class="wiz-events" id="wizEvents"></div>';
      const list = $('wizEvents');
      events.forEach((ev) => {
        const packs = policiesForEvent(ev);
        const packLabel = packs.length ? packs.map((p) => p.title).join(' + ') : 'No policies set';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'profile-item';
        b.innerHTML = `<span><span class="profile-item-name">${esc(ev.name)}</span><br>
          <span class="profile-item-sub">${fmtTime(ev.start_at)} → ${fmtTime(ev.end_at)} · ${esc(packLabel)}</span></span>`;
        b.onclick = () => { wiz.event = ev; wiz.step = 1; renderWizard(); };
        list.appendChild(b);
      });
      return;
    }

    /* step 1 — selfie */
    if (wiz.step === 1) {
      const shot = SHOTS[0];
      $('wizStep').textContent = 'STEP 2/3 — SELFIE';
      body.innerHTML = `
        <div class="wiz-title">${shot.title}</div>
        <div class="wiz-sub">${shot.sub} <b>Required.</b></div>
        <div class="cam-stage">
          <video id="camVideo" autoplay playsinline muted></video>
          <img id="camPreview" class="hidden" alt="preview">
          <div class="cam-frame"></div>
        </div>
        <div class="wiz-actions" id="camActions">
          <button class="big-btn primary" id="camSnap" type="button"><span class="big-btn-title">📸 SNAP</span></button>
        </div>
        <div class="wiz-fallback">
          <label>Camera not working? Take it with your phone camera<input type="file" id="camFile" accept="image/*" capture></label>
        </div>`;

      const video = $('camVideo');
      try {
        wiz.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: shot.facing, width: { ideal: 1280 } }, audio: false,
        });
        video.srcObject = wiz.stream;
      } catch {
        body.querySelector('.cam-stage').insertAdjacentHTML('beforebegin',
          '<p class="form-err">Camera blocked — allow camera access, or use the phone-camera link below.</p>');
      }

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
        next.className = 'big-btn primary';
        next.innerHTML = '<span class="big-btn-title">REVIEW →</span>';
        next.onclick = () => { wiz.step += 1; renderWizard(); };
        $('camActions').append(retake, next);
      };

      $('camSnap').onclick = () => {
        if (!video.videoWidth) { toast('Camera not ready yet.', true); return; }
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

    /* step 2 — review + punch */
    $('wizStep').textContent = 'STEP 3/3 — CONFIRM';
    const now = new Date();
    body.innerHTML = `
      <div class="wiz-title">STAMP IT</div>
      <div class="wiz-sub">${esc(wiz.event.name)} — ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} at <b>${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b></div>
      <div class="wiz-review">
        ${SHOTS.map((s) => `<figure><img src="${wiz.photos[s.key]}" alt="${s.key}"><figcaption>${s.key}</figcaption></figure>`).join('')}
      </div>
      <div class="wiz-actions">
        <button class="big-btn green" id="wizPunch" type="button"><span class="big-btn-title">⏱ CLOCK IN NOW</span></button>
      </div>
      <p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>`;
    $('wizPunch').onclick = submitClockIn;
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
    btn.disabled = true;
    btn.querySelector('.big-btn-title').textContent = 'STAMPING…';
    try {
      await api('tc-punch', {
        method: 'POST',
        body: JSON.stringify({
          action: 'clock_in',
          profile_id: current.profile.id,
          profile_name: `${current.profile.first_name} ${current.profile.last_name}`,
          event_id: wiz.event.id,
          event_name: wiz.event.name,
          work_date: localDate(),
          clock_in: localISO(),
          photos: wiz.photos,
        }),
      });
      $('wizard').classList.add('hidden');
      wiz = null;
      toast('Clocked in. Have a good shift!');
      await refreshProfile();
    } catch {
      $('wizErr').textContent = 'Clock-in failed — check signal and try again.';
      $('wizErr').classList.remove('hidden');
      btn.disabled = false;
      btn.querySelector('.big-btn-title').textContent = '⏱ CLOCK IN NOW';
    }
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
     Shared UI on phone + desktop. Archive/delete flags live in
     localStorage until n8n gains PATCH — same browser profile syncs.
     ============================================================ */
  const META_KEY = 'justus-tc-meta-v1';
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
  };
  const DEFAULT_TEMPLATES = [
    { id: 'tpl-pbr', name: 'PBR / Rodeo — Big Sky', policyKeys: ['general', 'pbr'] },
  ];

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
  function loadMeta() {
    try {
      const raw = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      let templates = (Array.isArray(raw.templates) ? raw.templates : [])
        .map(normalizeTemplate)
        .filter(Boolean);
      if (!templates.length) templates = DEFAULT_TEMPLATES.map((t) => ({ ...t, policyKeys: t.policyKeys.slice() }));
      // ensure seeded PBR exists if someone wiped it while keeping other names
      if (!templates.some((t) => /pbr|rodeo/i.test(t.name))) {
        templates = [DEFAULT_TEMPLATES[0], ...templates];
      }
      return {
        emails: Array.isArray(raw.emails) ? raw.emails : ['thomasg@forevergoldai.com'],
        templates,
        archived: raw.archived && typeof raw.archived === 'object' ? raw.archived : {},
        deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {},
        eventPolicy: migrateEventPolicyMap(raw.eventPolicy),
      };
    } catch {
      return {
        emails: ['thomasg@forevergoldai.com'],
        templates: DEFAULT_TEMPLATES.map((t) => ({ ...t, policyKeys: t.policyKeys.slice() })),
        archived: {},
        deleted: {},
        eventPolicy: {},
      };
    }
  }
  function saveMeta(m) { localStorage.setItem(META_KEY, JSON.stringify(m)); }
  let meta = loadMeta();

  function rememberEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    meta.emails = [e, ...meta.emails.filter((x) => x.toLowerCase() !== e)].slice(0, 20);
    saveMeta(meta);
  }
  function setEventPolicies(eventId, policyKeys) {
    if (!eventId) return;
    meta.eventPolicy[String(eventId)] = normalizePolicyKeys(policyKeys);
    saveMeta(meta);
  }
  function rememberTemplate(name, policyKeys) {
    const n = String(name || '').trim();
    if (!n) return;
    const keys = normalizePolicyKeys(policyKeys);
    const existing = meta.templates.find((t) => t.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      existing.policyKeys = keys;
      existing.name = n;
    } else {
      meta.templates = [{ id: `tpl-${Date.now()}`, name: n, policyKeys: keys }, ...meta.templates].slice(0, 24);
    }
    saveMeta(meta);
  }
  function policiesForEvent(ev) {
    const stored = meta.eventPolicy[String(ev.id)];
    if (stored && stored.length) return stored.map((k) => POLICY_PACKS[k]).filter(Boolean);
    const tpl = meta.templates.find((t) => t.name.toLowerCase() === String(ev.name || '').toLowerCase());
    if (tpl && tpl.policyKeys.length) return tpl.policyKeys.map((k) => POLICY_PACKS[k]).filter(Boolean);
    if (/\bpbr\b|rodeo/i.test(ev.name || '')) return [POLICY_PACKS.general, POLICY_PACKS.pbr];
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

  function renderPolicyHtml(packs) {
    const list = Array.isArray(packs) ? packs : (packs ? [packs] : []);
    if (!list.length) return '<p class="muted">No policies attached to this event yet.</p>';
    return list.map((pack) => {
      const full = (pack.sections || []).map((s) => `<h5>${esc(s.h)}</h5>${esc(s.body)}`).join('');
      return `<div class="policy-block">
        <h4>${esc(pack.title)}</h4>
        <ul>${(pack.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        ${full ? `<details><summary>FULL POLICY — READ WORD FOR WORD</summary><div class="policy-full">${full}</div></details>` : ''}
      </div>`;
    }).join('');
  }

  /* ============================================================
     ADMIN
     ============================================================ */
  let adminPin = '';
  let adminPinOk = null;
  let eventTab = 'active';
  let calCursor = new Date();
  let rangeStart = null; // YYYY-MM-DD
  let rangeEnd = null;
  let selectedTemplateId = null;

  function openAdmin() {
    show('admin');
    if (adminPinOk) { $('adminGate').classList.add('hidden'); $('adminDash').classList.remove('hidden'); loadAdmin(); return; }
    adminPin = '';
    paintPin();
    $('adminGate').classList.remove('hidden');
    $('adminDash').classList.add('hidden');
  }

  function paintPin() {
    [...$('pinDots').children].forEach((dot, i) => dot.classList.toggle('on', i < adminPin.length));
  }

  $('pinPad').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.k === 'del') { adminPin = adminPin.slice(0, -1); paintPin(); return; }
    if (adminPin.length >= 4) return;
    adminPin += b.textContent.trim();
    paintPin();
    $('pinErr').classList.add('hidden');
    if (adminPin.length === 4) {
      try {
        await api(`tc-admin?pass=${encodeURIComponent(adminPin)}&date=${localDate()}`);
        adminPinOk = adminPin;
        $('adminGate').classList.add('hidden');
        $('adminDash').classList.remove('hidden');
        $('adminDate').value = localDate();
        loadAdmin();
      } catch {
        $('pinErr').classList.remove('hidden');
        $('pinDots').classList.add('shake');
        setTimeout(() => $('pinDots').classList.remove('shake'), 400);
        adminPin = '';
        setTimeout(paintPin, 350);
      }
    }
  });

  async function loadAdmin() {
    if (!$('adminDate').value) $('adminDate').value = localDate();
    const date = $('adminDate').value;
    const tbody = $('adminRows');
    tbody.innerHTML = '<tr><td colspan="9" class="muted center">Loading…</td></tr>';
    try {
      const punches = rows(await api(`tc-admin?pass=${encodeURIComponent(adminPinOk)}&date=${encodeURIComponent(date)}`))
        .sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
      if (!punches.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="muted center">No punches for this day.</td></tr>';
      } else {
        tbody.innerHTML = punches.map((p) => {
          const h = shiftHours(p);
          const photo = (url, label) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>` : '·');
          return `<tr>
            <td>${esc(p.profile_name)}</td>
            <td>${esc(p.event_name || '')}</td>
            <td>${fmtTime(p.clock_in)}</td>
            <td>${fmtTime(p.break_start)}</td>
            <td>${fmtTime(p.break_end)}</td>
            <td>${p.break_taken ? '☑' : '☐'}</td>
            <td>${p.status === 'out' ? fmtTime(p.clock_out) : '<b style="color:var(--in-green)">on clock</b>'}</td>
            <td>${h != null ? h.toFixed(2) : '—'}</td>
            <td>${photo(p.photo_selfie, 'SELFIE')}</td>
          </tr>`;
        }).join('');
      }
    } catch {
      tbody.innerHTML = '<tr><td colspan="9" class="form-err center">Couldn\'t load the sheet.</td></tr>';
    }
    loadAdminEvents();
  }

  $('eventTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    eventTab = tab.dataset.tab;
    [...$('eventTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.tab === eventTab));
    loadAdminEvents();
  });

  async function loadAdminEvents() {
    const box = $('adminEvents');
    try {
      const events = rows(await api('tc-events'))
        .filter((ev) => !isDeleted(ev.id))
        .sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)));
      const shown = events.filter((ev) => eventTab === 'archived' ? isArchived(ev.id) : !isArchived(ev.id));
      box.innerHTML = shown.length ? '' : `<p class="muted center">${eventTab === 'archived' ? 'Archive is empty.' : 'No active events — create one.'}</p>`;
      shown.forEach((ev) => box.appendChild(buildEventRow(ev)));
    } catch {
      box.innerHTML = '<p class="form-err center">Couldn\'t load events.</p>';
    }
  }

  function buildEventRow(ev) {
    const ended = ev.end_at && new Date(ev.end_at) <= new Date();
    const badge = isArchived(ev.id)
      ? '<span class="badge arch">ARCHIVED</span>'
      : ev.report_sent
        ? '<span class="badge sent">SHEET SENT</span>'
        : ended ? '<span class="badge done">ENDED</span>' : '<span class="badge live">LIVE</span>';
    const wrap = document.createElement('div');
    wrap.className = 'event-swipe';
    wrap.innerHTML = `<div class="event-swipe-bg"><span class="arch">ARCHIVE</span><span class="del">DELETE</span></div>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'event-item';
    btn.innerHTML = `<span><span class="ev-name">${esc(ev.name)}</span><br>
      <span class="ev-times">${new Date(ev.start_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      → ${new Date(ev.end_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      · ${esc(ev.owner_email || '')}</span></span>${badge}`;
    btn.onclick = () => openEventDetail(ev);
    wrap.appendChild(btn);
    attachSwipe(wrap, btn, {
      left: async () => {
        if (isArchived(ev.id)) {
          restoreEvent(ev.id);
          toast('Restored to active.');
        } else {
          archiveEvent(ev.id);
          toast('Archived.');
        }
        loadAdminEvents();
      },
      right: async () => {
        const yes = await confirmAsk('Delete this event?', `"${ev.name}" will be hidden from Active and Archive. Past punch history stays on worker profiles.`);
        if (!yes) { btn.style.transform = ''; return; }
        deleteEvent(ev.id);
        toast('Event removed from the list.');
        $('eventModal').classList.add('hidden');
        loadAdminEvents();
      },
    });
    return wrap;
  }

  function attachSwipe(wrap, btn, handlers) {
    let x0 = null;
    let dx = 0;
    const THRESH = 72;
    const start = (x) => { x0 = x; dx = 0; btn.style.transition = 'none'; };
    const move = (x) => {
      if (x0 == null) return;
      dx = x - x0;
      btn.style.transform = `translateX(${Math.max(-110, Math.min(110, dx))}px)`;
    };
    const end = async () => {
      if (x0 == null) return;
      btn.style.transition = 'transform .15s ease';
      if (dx <= -THRESH) await handlers.left();
      else if (dx >= THRESH) await handlers.right();
      else btn.style.transform = '';
      x0 = null; dx = 0;
    };
    btn.addEventListener('touchstart', (e) => start(e.changedTouches[0].clientX), { passive: true });
    btn.addEventListener('touchmove', (e) => move(e.changedTouches[0].clientX), { passive: true });
    btn.addEventListener('touchend', end);
    btn.addEventListener('mousedown', (e) => {
      start(e.clientX);
      const onMove = (ev) => move(ev.clientX);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); end(); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function openEventDetail(ev) {
    const packs = policiesForEvent(ev);
    const ended = ev.end_at && new Date(ev.end_at) <= new Date();
    $('evDetailTag').textContent = isArchived(ev.id) ? 'ARCHIVED EVENT' : ended ? 'PAST EVENT' : 'LIVE EVENT';
    $('evDetailBody').innerHTML = `
      <h3 class="confirm-title" style="text-align:left;margin-bottom:.4rem">${esc(ev.name)}</h3>
      <div class="ev-detail-meta">
        <div><b>Starts</b> — ${new Date(ev.start_at).toLocaleString()}</div>
        <div><b>Ends</b> — ${new Date(ev.end_at).toLocaleString()}</div>
        <div><b>Report email</b> — ${esc(ev.owner_email || '—')}</div>
        <div><b>Sheet</b> — ${ev.report_sent ? 'sent' : ended ? 'pending / ended' : 'open'}</div>
        <div><b>Policies</b> — ${packs.length ? esc(packs.map((p) => p.title).join(' · ')) : 'none selected'}</div>
      </div>
      <h3 class="section-label" style="margin-top:1rem">POLICIES</h3>
      ${renderPolicyHtml(packs)}
      <div class="ev-detail-actions">
        ${isArchived(ev.id)
          ? '<button class="big-btn outline" id="evRestoreBtn" type="button"><span class="big-btn-title">RESTORE TO ACTIVE</span></button>'
          : '<button class="big-btn outline" id="evArchiveBtn" type="button"><span class="big-btn-title">ARCHIVE</span></button>'}
        <button class="big-btn danger" id="evDeleteBtn" type="button"><span class="big-btn-title">DELETE</span></button>
      </div>`;
    $('eventModal').classList.remove('hidden');
    const arch = $('evArchiveBtn');
    const rest = $('evRestoreBtn');
    if (arch) arch.onclick = () => { archiveEvent(ev.id); toast('Archived.'); $('eventModal').classList.add('hidden'); loadAdminEvents(); };
    if (rest) rest.onclick = () => { restoreEvent(ev.id); toast('Restored.'); $('eventModal').classList.add('hidden'); loadAdminEvents(); };
    $('evDeleteBtn').onclick = async () => {
      const yes = await confirmAsk('Delete this event?', `"${ev.name}" will be hidden from the lists.`);
      if (!yes) return;
      deleteEvent(ev.id);
      toast('Event removed from the list.');
      $('eventModal').classList.add('hidden');
      loadAdminEvents();
    };
  }
  $('evDetailClose').onclick = () => $('eventModal').classList.add('hidden');

  /* ---------- create-event form: templates, calendar, emails ---------- */
  function paintEmailUI() {
    const list = $('evEmailList');
    const chips = $('evEmailChips');
    list.innerHTML = meta.emails.map((e) => `<option value="${esc(e)}"></option>`).join('');
    chips.innerHTML = '';
    meta.emails.slice(0, 6).forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.onclick = () => { $('evOwner').value = e; };
      chips.appendChild(b);
    });
    if (!$('evOwner').value) $('evOwner').value = meta.emails[0] || '';
  }

  function paintPolicyChecks(selectedKeys) {
    const selected = new Set(normalizePolicyKeys(selectedKeys));
    const box = $('evPolicyChecks');
    box.innerHTML = '';
    Object.values(POLICY_PACKS).forEach((p) => {
      const on = selected.has(p.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `policy-check${on ? ' on' : ''}`;
      btn.dataset.policy = p.id;
      btn.innerHTML = `
        <span class="tc-check ${on ? 'checked' : ''}"></span>
        <span class="policy-check-text">
          <span class="policy-check-title">${esc(p.title)}</span>
          <span class="policy-check-sub">${esc(p.blurb || '')}</span>
        </span>`;
      btn.onclick = () => {
        if (selected.has(p.id)) selected.delete(p.id);
        else selected.add(p.id);
        paintPolicyChecks([...selected]);
      };
      box.appendChild(btn);
    });
  }
  function selectedPolicyKeys() {
    return [...$('evPolicyChecks').querySelectorAll('.policy-check.on')].map((b) => b.dataset.policy);
  }

  function paintTemplates() {
    const box = $('evTemplates');
    box.innerHTML = '';
    meta.templates.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.name;
      b.classList.toggle('on', selectedTemplateId === t.id);
      b.onclick = () => {
        selectedTemplateId = t.id;
        $('evName').value = t.name;
        paintPolicyChecks(t.policyKeys || []);
        paintTemplates();
      };
      box.appendChild(b);
    });
  }

  // Typing a new name clears the chip highlight so it becomes a fresh saved event on create
  $('evName').addEventListener('input', () => {
    const v = $('evName').value.trim().toLowerCase();
    const match = meta.templates.find((t) => t.name.toLowerCase() === v);
    if (match) {
      selectedTemplateId = match.id;
      paintPolicyChecks(match.policyKeys || []);
    } else {
      selectedTemplateId = null;
    }
    paintTemplates();
  });

  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) {
    const x = new Date(d); const day = x.getDay();
    x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x;
  }

  function setDuration(kind) {
    [...$('evDurationChips').children].forEach((b) => b.classList.toggle('on', b.dataset.dur === kind));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (kind === 'today') {
      rangeStart = ymd(today); rangeEnd = ymd(today);
    } else if (kind === 'weekend') {
      const sat = addDays(startOfWeek(today), 6);
      const sun = addDays(sat, 1);
      const use = today.getDay() === 0 ? addDays(today, -1) : (today.getDay() === 6 ? today : sat);
      rangeStart = ymd(use);
      rangeEnd = ymd(addDays(parseYmd(rangeStart), 1));
      calCursor = parseYmd(rangeStart);
    } else if (kind === 'week') {
      const sun = startOfWeek(today);
      rangeStart = ymd(sun);
      rangeEnd = ymd(addDays(sun, 6));
      calCursor = sun;
    } else {
      /* custom — keep current picks */
    }
    paintCalendar();
  }

  function paintCalendar() {
    const title = $('calTitle');
    const grid = $('calGrid');
    const y = calCursor.getFullYear();
    const m = calCursor.getMonth();
    title.textContent = new Date(y, m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    grid.innerHTML = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < firstDow; i++) grid.innerHTML += '<button type="button" class="cal-day" disabled></button>';
    const todayStr = localDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const s = `${y}-${pad(m + 1)}-${pad(day)}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-day';
      b.textContent = String(day);
      if (s === todayStr) b.classList.add('today');
      if (rangeStart && rangeEnd && s >= rangeStart && s <= rangeEnd) b.classList.add('in-range');
      if (s === rangeStart || s === rangeEnd) b.classList.add('edge');
      b.onclick = () => {
        if (!rangeStart || (rangeStart && rangeEnd)) {
          rangeStart = s; rangeEnd = null;
        } else if (s < rangeStart) {
          rangeEnd = rangeStart; rangeStart = s;
        } else {
          rangeEnd = s;
        }
        [...$('evDurationChips').children].forEach((c) => c.classList.toggle('on', c.dataset.dur === 'custom'));
        paintCalendar();
      };
      grid.appendChild(b);
    }
    const label = $('calRange');
    if (rangeStart && rangeEnd) {
      label.textContent = rangeStart === rangeEnd
        ? `Selected: ${fmtDate(rangeStart)}`
        : `Selected: ${fmtDate(rangeStart)} → ${fmtDate(rangeEnd)}`;
    } else if (rangeStart) {
      label.textContent = `Start ${fmtDate(rangeStart)} — now tap the end day.`;
    } else {
      label.textContent = 'Tap a start day, then an end day.';
    }
  }

  $('calPrev').onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); paintCalendar(); };
  $('calNext').onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); paintCalendar(); };
  $('evDurationChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dur]');
    if (b) setDuration(b.dataset.dur);
  });

  function openEventForm() {
    const form = $('eventForm');
    form.classList.toggle('hidden');
    if (form.classList.contains('hidden')) return;
    meta = loadMeta();
    selectedTemplateId = null;
    $('evName').value = '';
    paintTemplates();
    paintPolicyChecks([]);
    paintEmailUI();
    rangeStart = localDate();
    rangeEnd = localDate();
    calCursor = new Date();
    setDuration('today');
    $('evName').focus();
  }

  $('adminRefresh').onclick = loadAdmin;
  $('adminDate').onchange = loadAdmin;
  $('adminNewEvent').onclick = openEventForm;

  $('eventForm').onsubmit = async (e) => {
    e.preventDefault();
    $('evErr').classList.add('hidden');
    const name = $('evName').value.trim();
    if (!name) {
      $('evErr').textContent = 'Pick a template or type an event name.';
      $('evErr').classList.remove('hidden');
      return;
    }
    if (!rangeStart || !rangeEnd) {
      $('evErr').textContent = 'Select start and end days on the calendar.';
      $('evErr').classList.remove('hidden');
      return;
    }
    const [sh, sm] = $('evStartTime').value.split(':').map(Number);
    const [eh, em] = $('evEndTime').value.split(':').map(Number);
    const start = parseYmd(rangeStart); start.setHours(sh, sm, 0, 0);
    const end = parseYmd(rangeEnd); end.setHours(eh, em, 0, 0);
    if (!(end > start)) {
      $('evErr').textContent = 'End must be after start — check days and times.';
      $('evErr').classList.remove('hidden');
      return;
    }
    const owner = $('evOwner').value.trim();
    const policyKeys = selectedPolicyKeys();
    try {
      const created = await api('tc-events', {
        method: 'POST',
        body: JSON.stringify({
          pass: adminPinOk,
          name,
          start_at: localISO(start),
          end_at: localISO(end),
          owner_email: owner,
          policy_keys: policyKeys,
        }),
      });
      const row = Array.isArray(created) ? created[0] : created;
      if (row && row.id != null) setEventPolicies(row.id, policyKeys);
      rememberTemplate(name, policyKeys);
      rememberEmail(owner);
      $('eventForm').classList.add('hidden');
      toast('Event created — saved with its policies for next time.');
      eventTab = 'active';
      [...$('eventTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.tab === 'active'));
      loadAdminEvents();
    } catch {
      $('evErr').textContent = 'Could not create event — check the admin code and retry.';
      $('evErr').classList.remove('hidden');
    }
  };

  /* ---------- QA hooks (harmless in production) ---------- */
  window.__tc = { show, openProfile, loadProfiles, api, get current() { return current; }, get meta() { return meta; } };
})();
