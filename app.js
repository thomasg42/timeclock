/* ============================================================
   FGA TimeClock — app logic
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
        events = rows(await api('tc-events')).filter((ev) => !ev.end_at || new Date(ev.end_at) > new Date());
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
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'profile-item';
        b.innerHTML = `<span><span class="profile-item-name">${esc(ev.name)}</span><br>
          <span class="profile-item-sub">${fmtTime(ev.start_at)} → ${fmtTime(ev.end_at)}</span></span>`;
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
          <button class="big-btn gold" id="camSnap" type="button"><span class="big-btn-title">📸 SNAP</span></button>
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
        next.className = 'big-btn gold';
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
     ADMIN
     ============================================================ */
  let adminPin = '';
  let adminPinOk = null; // verified pin

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

  async function loadAdminEvents() {
    const box = $('adminEvents');
    try {
      const events = rows(await api('tc-events')).sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)));
      box.innerHTML = events.length ? '' : '<p class="muted center">No events yet.</p>';
      events.slice(0, 12).forEach((ev) => {
        const ended = ev.end_at && new Date(ev.end_at) <= new Date();
        const badge = ev.report_sent
          ? '<span class="badge sent">SHEET SENT</span>'
          : ended ? '<span class="badge done">ENDED — SENDING</span>' : '<span class="badge live">LIVE</span>';
        const div = document.createElement('div');
        div.className = 'event-item';
        div.innerHTML = `<span><span class="ev-name">${esc(ev.name)}</span><br>
          <span class="ev-times">${new Date(ev.start_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          → ${new Date(ev.end_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          · report → ${esc(ev.owner_email || '')}</span></span>${badge}`;
        box.appendChild(div);
      });
    } catch {
      box.innerHTML = '<p class="form-err center">Couldn\'t load events.</p>';
    }
  }

  $('adminRefresh').onclick = loadAdmin;
  $('adminDate').onchange = loadAdmin;
  $('adminNewEvent').onclick = () => {
    $('eventForm').classList.toggle('hidden');
    if (!$('evStart').value) {
      const now = new Date();
      $('evStart').value = `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const end = new Date(now.getTime() + 8 * 3600000);
      $('evEnd').value = `${localDate(end)}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
    }
  };

  $('eventForm').onsubmit = async (e) => {
    e.preventDefault();
    $('evErr').classList.add('hidden');
    const start = new Date($('evStart').value);
    const end = new Date($('evEnd').value);
    if (!(end > start)) {
      $('evErr').textContent = 'End must be after start.';
      $('evErr').classList.remove('hidden');
      return;
    }
    try {
      await api('tc-events', {
        method: 'POST',
        body: JSON.stringify({
          pass: adminPinOk,
          name: $('evName').value.trim(),
          start_at: localISO(start),
          end_at: localISO(end),
          owner_email: $('evOwner').value.trim(),
        }),
      });
      $('eventForm').reset();
      $('evOwner').value = 'thomasg@forevergoldai.com';
      $('eventForm').classList.add('hidden');
      toast('Event created — crew can clock in now.');
      loadAdminEvents();
    } catch {
      $('evErr').textContent = 'Could not create event — check the admin code and retry.';
      $('evErr').classList.remove('hidden');
    }
  };

  /* ---------- QA hooks (harmless in production) ---------- */
  window.__tc = { show, openProfile, loadProfiles, api, get current() { return current; } };
})();
