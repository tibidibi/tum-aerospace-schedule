/**
 * Your settings, the TUMonline connection (same token flow as the TUM Campus app),
 * the settings sheet, squad links and the subscribable feed.
 */

// ================= SETTINGS =================
const SETTINGS_KEY = 'fd_settings';
const SETTINGS = {
  name: '',                 // shown on squad links and the feed
  home: null,               // { name, place, lat, lon } from the MVG address search
  modes: { mvg: true, car: false, bike: false },
  routeSort: 'latest',      // 'latest' | 'changes' | 'walking'
  arriveEarlyMin: 5,        // be at the room this many minutes before class
  diet: 'all',              // key of DIETS
  favourites: '',           // comma-separated dish keywords
  workerUrl: '',
  notify: false,
  leadMinutes: {},          // { dayIndex: minutes from leave-by to first class }, for the feed's alarms
  squad: []                 // [{ name, groups, skipped }]
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    Object.assign(SETTINGS, saved, { modes: { ...SETTINGS.modes, ...(saved.modes || {}) } });
  } catch (e) {}
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {}
}

function workerUrl() {
  return (SETTINGS.workerUrl || '').trim().replace(/\/$/, '');
}

// ================= TUMONLINE CONNECTION =================
const TUM_KEY = 'fd_tum';
const TUM = { tumId: '', token: null, status: 'off', events: [], coverage: null, syncedAt: null, error: null, syncing: false };

function loadTum() {
  try { Object.assign(TUM, JSON.parse(localStorage.getItem(TUM_KEY) || '{}'), { syncing: false }); } catch (e) {}
}

function saveTum() {
  try {
    const { syncing, ...rest } = TUM;
    localStorage.setItem(TUM_KEY, JSON.stringify(rest));
  } catch (e) {
    console.warn('Could not store the TUMonline calendar:', e);
  }
}

const TUM_ID_PATTERN = /^[a-z]{2}\d{2}[a-z]{3}$/i;

async function tumGet(endpoint, params) {
  let res;
  try {
    res = await fetch(tumUrl(endpoint, params));
  } catch (e) {
    throw new Error('Could not reach TUMonline. Check your connection and try again.');
  }
  const xml = await res.text();
  const err = tumError(xml);
  if (err) throw new Error(err);
  return xml;
}

// Step 1: TUMonline creates a token and emails you to activate it
async function tumConnect(tumId) {
  tumId = tumId.trim().toLowerCase();
  if (!TUM_ID_PATTERN.test(tumId)) throw new Error('A TUM ID looks like ab12cde: two letters, two digits, three letters.');
  const xml = await tumGet('requestToken', { pUsername: tumId, pTokenName: 'TUM Flight Deck' });
  const token = xmlValues(xml, 'token')[0];
  if (!token) throw new Error('TUMonline did not send a token. Try again in a minute.');
  Object.assign(TUM, { tumId, token, status: 'pending', error: null });
  saveTum();
  pollTumToken();
}

// Step 2: wait until you've activated the token in TUMonline
let tumPollTimer = null;
function pollTumToken() {
  clearInterval(tumPollTimer);
  const started = Date.now();
  tumPollTimer = setInterval(async () => {
    if (TUM.status !== 'pending' || Date.now() - started > 30 * 60e3) return clearInterval(tumPollTimer);
    try {
      const xml = await tumGet('isTokenConfirmed', { pToken: TUM.token });
      if (xmlValues(xml, 'confirmed')[0] === 'true') {
        clearInterval(tumPollTimer);
        TUM.status = 'connected';
        saveTum();
        await tumSync();
      }
    } catch (e) { /* keep polling; the token may not exist yet */ }
  }, 5000);
}

// Step 3: fetch the calendar, merge, and pick up your groups
async function tumSync({ quiet = false } = {}) {
  if (TUM.status !== 'connected' || TUM.syncing) return;
  TUM.syncing = true;
  renderTumPanel();
  try {
    const xml = await tumGet('kalender', { pToken: TUM.token });
    TUM.events = parseTumCalendar(xml).map(({ description, url, status, endDate, ...ev }) => ev);
    TUM.coverage = tumCoverage(TUM.events);
    TUM.syncedAt = Date.now();
    TUM.error = null;
    const changed = applyDetectedGroups();
    saveTum();
    if (!quiet) showToast(`Synced ${TUM.events.length} TUMonline events${changed.length ? ` · groups from TUMonline: ${changed.join(', ')}` : ''}`);
  } catch (e) {
    TUM.error = e.message;
    // An invalid token means it was revoked in TUMonline: start over
    if (/token/i.test(e.message)) TUM.status = 'off';
    saveTum();
    if (!quiet) showToast(`TUMonline sync failed: ${e.message}`);
  } finally {
    TUM.syncing = false;
    renderTumPanel();
    updateAll();
  }
}

// TUMonline knows which group you're registered in; your manual picks still win
function applyDetectedGroups() {
  STATE.detectedGroups = detectGroups(TUM.events);
  const changed = [];
  for (const [courseId, group] of Object.entries(STATE.detectedGroups)) {
    if (STATE.manualGroups.has(courseId) || STATE.selectedGroups[courseId] === group) continue;
    STATE.selectedGroups[courseId] = group;
    changed.push(`${COURSES.find(c => c.id === courseId).shortName} ${group}`);
  }
  persistState();
  return changed;
}

function tumDisconnect() {
  clearInterval(tumPollTimer);
  Object.assign(TUM, { tumId: '', token: null, status: 'off', events: [], coverage: null, syncedAt: null, error: null });
  STATE.detectedGroups = {};
  saveTum();
  renderTumPanel();
  updateAll();
  showToast('Disconnected from TUMonline. Revoke the token under TUMonline › Token-Management too.');
}

function timeAgo(t) {
  const min = Math.round((Date.now() - t) / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// The TUMonline block, shown in the settings sheet and the sidebar
function renderTumPanel() {
  for (const panel of document.querySelectorAll('[data-tum-panel]')) {
    const compact = panel.dataset.tumPanel === 'compact';
    if (TUM.status === 'connected') {
      panel.innerHTML = `
        <div class="tum-status ok">
          <span class="material-symbols-outlined icon-sm" aria-hidden="true">${TUM.syncing ? 'sync' : 'verified'}</span>
          <span><strong>TUMonline connected</strong> · ${TUM.tumId}<br>
            <small>${TUM.syncing ? 'Syncing…' : `${TUM.events.length} events · synced ${TUM.syncedAt ? timeAgo(TUM.syncedAt) : 'never'}`}</small></span>
        </div>
        ${TUM.error ? `<p class="tum-error">${escapeHtml(TUM.error)}</p>` : ''}
        <div class="tum-actions">
          <button class="btn btn-outline btn-sm" type="button" data-tum-action="sync" ${TUM.syncing ? 'disabled' : ''}>Sync now</button>
          ${compact ? '' : '<button class="btn btn-outline btn-sm danger" type="button" data-tum-action="disconnect">Disconnect</button>'}
        </div>`;
    } else if (TUM.status === 'pending') {
      panel.innerHTML = `
        <div class="tum-status pending">
          <span class="material-symbols-outlined icon-sm spin" aria-hidden="true">progress_activity</span>
          <span><strong>Activate your token</strong><br><small>Waiting for TUMonline…</small></span>
        </div>
        <ol class="tum-steps">
          <li>Open the email TUMonline just sent to <strong>${TUM.tumId}</strong>, or go to
            <a href="https://campus.tum.de/tumonline/" target="_blank" rel="noopener">TUMonline</a> › your profile › <em>Token-Management</em>.</li>
          <li>Activate the token named <strong>TUM Flight Deck</strong>. Give it the calendar permission.</li>
          <li>Come back here. Sync starts on its own.</li>
        </ol>
        <div class="tum-actions">
          <button class="btn btn-outline btn-sm" type="button" data-tum-action="cancel">Cancel</button>
        </div>`;
    } else {
      panel.innerHTML = compact ? `
        <p class="tum-pitch">Get your real schedule: room changes, cancellations and exams, straight from TUMonline.</p>
        <button class="btn btn-primary btn-sm" type="button" data-open-settings="set-tum">Connect TUMonline</button>` : `
        <p class="tum-pitch">Uses the same access as the TUM Campus app: a read token you activate in TUMonline.
          Your TUMonline schedule then replaces the timetable PDF, and anything only the PDF has is greyed out.</p>
        ${TUM.error ? `<p class="tum-error">${escapeHtml(TUM.error)}</p>` : ''}
        <form class="tum-connect" data-tum-form>
          <label class="field">
            <span>TUM ID</span>
            <input name="tumId" required autocomplete="username" spellcheck="false" placeholder="ab12cde" pattern="[A-Za-z]{2}[0-9]{2}[A-Za-z]{3}" value="${TUM.tumId || ''}">
          </label>
          <button class="btn btn-primary" type="submit">Request token</button>
        </form>
        <p class="field-note">The token stays in this browser. You can revoke it any time in TUMonline › Token-Management.</p>`;
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ================= SETTINGS SHEET =================

function openSettings(sectionId) {
  const dialog = document.getElementById('settingsDialog');
  if (!dialog) return;
  renderSettings();
  if (!dialog.open) dialog.showModal();
  if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ block: 'start' });
}

function renderSettings() {
  renderTumPanel();
  renderStylePicker();
  const home = document.getElementById('homeCurrent');
  if (home) home.innerHTML = SETTINGS.home
    ? `<span class="material-symbols-outlined icon-sm" aria-hidden="true">home</span> <strong>${escapeHtml(SETTINGS.home.name)}</strong>${SETTINGS.home.place ? `, ${escapeHtml(SETTINGS.home.place)}` : ''}`
    : 'No address set yet. Leave-by times need one.';
  for (const mode of ['mvg', 'car', 'bike']) {
    const box = document.getElementById(`mode-${mode}`);
    if (box) box.checked = !!SETTINGS.modes[mode];
  }
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('arriveEarly', SETTINGS.arriveEarlyMin);
  set('dietSelect', SETTINGS.diet);
  set('favouritesInput', SETTINGS.favourites);
  set('workerUrlInput', SETTINGS.workerUrl);
  set('nameInput', SETTINGS.name);
  renderFeedPanel();
  renderNotifyStatus();
  const roadNote = document.getElementById('roadModesNote');
  if (roadNote) roadNote.hidden = !!workerUrl();
}

// One card per app style, each with a small preview drawn in that style's own colours
function renderStylePicker() {
  const picker = document.getElementById('stylePicker');
  if (!picker) return;
  const current = document.documentElement.getAttribute('data-style') || 'flightdeck';
  picker.innerHTML = Object.entries(APP_STYLES).map(([id, s]) => `
    <label class="style-opt">
      <input type="radio" name="appStyle" value="${id}" ${id === current ? 'checked' : ''}>
      <span class="style-swatch sw-${id}" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="style-name">${escapeHtml(s.name)}</span>
      <small>${escapeHtml(s.blurb)}${s.darkOnly ? ' · always dark' : ''}</small>
    </label>`).join('');
}

function feedUrl() {
  if (!workerUrl()) return null;
  const code = encodeShare({ name: SETTINGS.name, groups: STATE.selectedGroups, skipped: STATE.skippedClasses, alarms: SETTINGS.leadMinutes });
  return `${workerUrl()}/feed.ics?s=${code}`;
}

function renderFeedPanel() {
  const panel = document.getElementById('feedPanel');
  if (!panel) return;
  const url = feedUrl();
  panel.innerHTML = url ? `
    <p class="field-note">Subscribe once and your phone's calendar shows your classes with a <strong>"leave now"</strong> alert
      at your usual leave-by time${Object.keys(SETTINGS.leadMinutes).length ? '' : ' (alerts appear after the Today view has worked out a commute)'}.</p>
    <div class="feed-row">
      <input class="feed-url" readonly value="${escapeHtml(url)}" aria-label="Calendar subscription link">
      <button class="btn btn-outline btn-sm" type="button" data-copy="${escapeHtml(url)}">Copy</button>
      <a class="btn btn-primary btn-sm" href="${escapeHtml(url.replace(/^https?:/, 'webcal:'))}">Subscribe</a>
    </div>` : '<p class="field-note">Add a Worker URL to get a calendar subscription with "leave now" alerts.</p>';
}

function renderNotifyStatus() {
  const status = document.getElementById('notifyStatus');
  const btn = document.getElementById('notifyBtn');
  if (!status || !btn) return;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  btn.hidden = !supported || (SETTINGS.notify && perm === 'granted');
  btn.textContent = perm === 'denied' ? 'Blocked in browser settings' : 'Turn on reminders';
  btn.disabled = perm === 'denied';
  status.textContent = !supported ? 'This browser has no notifications. Use the calendar subscription instead.'
    : SETTINGS.notify && perm === 'granted' ? 'On: you get "leave in 10 min" while this app is open. For alerts when it’s closed, subscribe to the calendar feed.'
    : 'Get a "leave in 10 min" notification while the app is open.';
}

let homeSearchTimer = null;
function wireSettings() {
  const dialog = document.getElementById('settingsDialog');
  if (!dialog) return;

  dialog.addEventListener('click', async e => {
    if (e.target === dialog) return dialog.close(); // backdrop
    const action = e.target.closest('[data-tum-action]')?.dataset.tumAction;
    if (action === 'sync') tumSync();
    if (action === 'disconnect') tumDisconnect();
    if (action === 'cancel') tumDisconnect();
    const pick = e.target.closest('[data-home-index]');
    if (pick) {
      SETTINGS.home = homeResults[Number(pick.dataset.homeIndex)];
      SETTINGS.leadMinutes = {};
      saveSettings();
      document.getElementById('homeResults').innerHTML = '';
      document.getElementById('homeSearch').value = '';
      renderSettings();
      if (STATE.currentView === 'today') renderToday();
      showToast(`Home set to ${SETTINGS.home.name}`);
    }
  });

  dialog.addEventListener('submit', async e => {
    const form = e.target.closest('[data-tum-form]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    try {
      await tumConnect(form.tumId.value);
      renderTumPanel();
    } catch (err) {
      TUM.error = err.message;
      renderTumPanel();
    }
  });

  document.getElementById('homeSearch')?.addEventListener('input', e => {
    clearTimeout(homeSearchTimer);
    const q = e.target.value.trim();
    const list = document.getElementById('homeResults');
    if (q.length < 3) { list.innerHTML = ''; return; }
    homeSearchTimer = setTimeout(async () => {
      try {
        homeResults = (await mvgSearch(q)).slice(0, 6);
        list.innerHTML = homeResults.length ? homeResults.map((r, i) => `
          <button type="button" class="result-row" data-home-index="${i}" role="option">
            <span class="material-symbols-outlined icon-sm" aria-hidden="true">${r.type === 'STATION' ? 'directions_transit' : r.type === 'ADDRESS' ? 'home_pin' : 'place'}</span>
            <span><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(r.place)}</small></span>
          </button>`).join('') : '<p class="field-note">No match. Try street and house number, then the town.</p>';
      } catch (err) {
        list.innerHTML = `<p class="tum-error">${escapeHtml(err.message)}</p>`;
      }
    }, 300);
  });

  const bind = (id, event, fn) => document.getElementById(id)?.addEventListener(event, fn);
  for (const mode of ['mvg', 'car', 'bike']) {
    bind(`mode-${mode}`, 'change', e => { SETTINGS.modes[mode] = e.target.checked; saveSettings(); });
  }
  bind('arriveEarly', 'change', e => { SETTINGS.arriveEarlyMin = Math.max(0, Math.min(30, Number(e.target.value) || 0)); saveSettings(); });
  bind('stylePicker', 'change', e => { if (e.target.name === 'appStyle') setStyle(e.target.value); });
  bind('dietSelect', 'change', e => { SETTINGS.diet = e.target.value; saveSettings(); });
  bind('favouritesInput', 'change', e => { SETTINGS.favourites = e.target.value; saveSettings(); });
  bind('nameInput', 'change', e => { SETTINGS.name = e.target.value.trim().slice(0, 40); saveSettings(); renderFeedPanel(); renderSquad(); });
  bind('workerUrlInput', 'change', e => {
    const v = e.target.value.trim();
    if (v && !/^https:\/\/[^\s/]+(\/.*)?$/.test(v)) { showToast('The Worker URL must start with https://'); return; }
    SETTINGS.workerUrl = v;
    saveSettings();
    renderSettings();
  });
  bind('notifyBtn', 'click', async () => {
    const perm = await Notification.requestPermission();
    SETTINGS.notify = perm === 'granted';
    saveSettings();
    renderNotifyStatus();
  });
  dialog.addEventListener('close', () => { if (STATE.currentView === 'today') renderToday(); });
}
let homeResults = [];

// Copy buttons anywhere in the app
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-copy]');
  if (btn) {
    try { await navigator.clipboard.writeText(btn.dataset.copy); showToast('Link copied'); }
    catch (err) { showToast('Copy failed. Select the link and copy it by hand.'); }
  }
  const open = e.target.closest('[data-open-settings]');
  if (open) openSettings(open.dataset.openSettings);
});

// ================= SQUAD =================

function mySquadLink() {
  const code = encodeShare({ name: SETTINGS.name, groups: STATE.selectedGroups, skipped: STATE.skippedClasses });
  return `${location.origin}${location.pathname}#join=${code}`;
}

// Opening someone's link (#join=…) offers to add them
function handleJoinLink() {
  const m = location.hash.match(/^#join=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const friend = decodeShare(m[1]);
  if (!friend) return showToast('That squad link is broken or out of date.');
  const name = friend.name || 'A classmate';
  if (!confirm(`Add ${name}'s schedule to your squad? You'll see shared classes and free time together.`)) return;
  SETTINGS.squad = SETTINGS.squad.filter(f => f.name !== friend.name).concat([{ name, groups: friend.groups, skipped: friend.skipped }]);
  saveSettings();
  renderSquad();
  updateAll();
  showToast(`${name} joined your squad`);
}

// Friends who also attend this PDF session id
function squadIn(classId) {
  return SETTINGS.squad.filter(f => friendSchedule(f).some(c => c.id === classId));
}

function renderSquad() {
  const box = document.getElementById('squadPanel');
  if (!box) return;
  const mine = getTemplateClasses().filter(c => !STATE.skippedClasses.has(c.id));
  const friends = SETTINGS.squad.map(f => ({ ...f, schedule: friendSchedule(f) }));
  const together = friends.length ? DAYS.map((day, d) => ({ day, slots: freeTogether([mine, ...friends.map(f => f.schedule)], d) })).filter(x => x.slots.length) : [];

  box.innerHTML = `
    ${friends.length ? `<ul class="squad-list">${friends.map((f, i) => {
      const shared = f.schedule.filter(c => mine.some(m => m.id === c.id && c.group)).map(c => `${COURSES.find(x => x.id === c.courseId).shortName} ${c.group}`);
      return `<li>
        <span class="avatar" aria-hidden="true">${escapeHtml(initials(f.name))}</span>
        <span class="squad-who"><strong>${escapeHtml(f.name)}</strong><small>${shared.length ? `Same group: ${escapeHtml(shared.join(', '))}` : 'No shared exercise groups'}</small></span>
        <button class="icon-btn" type="button" data-squad-remove="${i}" aria-label="Remove ${escapeHtml(f.name)} from squad"><span class="material-symbols-outlined icon-sm">close</span></button>
      </li>`;
    }).join('')}</ul>
    <div class="squad-free"><strong>Free together</strong>${together.length
      ? together.map(x => `<span>${x.day.slice(0, 3)} ${x.slots.map(s => `${minutesToTime(s.from)}–${minutesToTime(s.to)}`).join(', ')}</span>`).join('')
      : '<span>No shared breaks of 45 min or more on days you’re all on campus.</span>'}</div>`
    : '<p class="field-note">Send your link to classmates. When they open it, they can add you, and you them with theirs.</p>'}
    <button class="btn btn-outline btn-sm squad-share" type="button" data-copy="${escapeHtml(mySquadLink())}">
      <span class="material-symbols-outlined icon-sm" aria-hidden="true">link</span> Copy my squad link
    </button>`;
  box.querySelectorAll('[data-squad-remove]').forEach(btn => btn.addEventListener('click', () => {
    SETTINGS.squad.splice(Number(btn.dataset.squadRemove), 1);
    saveSettings();
    renderSquad();
    updateAll();
  }));
}
