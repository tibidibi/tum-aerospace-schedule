/**
 * App state, settings and the TUMonline connection. Uses the same localStorage keys as the
 * Flight Deck app next door, so your groups, home address and TUMonline token carry over.
 * Calls render() and toast() from app.js when something changes.
 */

// ================= SCHEDULE STATE =================
const STATE = {
  selectedGroups: { math: 'Group 1', mech: 'Room OTN 1', cf: 'Group 2', cad: 'Group 3 & 4' },
  courseVisibility: { math: true, mech: true, cf: true, ee: true, cad: true, aero_mat: true, intro_aero: true },
  skippedClasses: new Set(),
  manualGroups: new Set(),   // courses whose group you picked yourself (TUMonline won't override)
  detectedGroups: {},        // groups TUMonline has you in
  attendance: {},            // 'YYYY-MM-DD|classId' -> 'went' | 'skipped'
  autopilot: 'latestStart',
  view: 'today',             // 'today' | 'week' | 'groups' | 'squad'
  weekIdx: 0,
  custom: [],                // your own appointments: { id, title, date, start, end, location, notes, repeat: 'none' | 'weekly' }
  customRev: 0               // bumps on every change, for the week cache
};

// ================= YOUR OWN APPOINTMENTS =================
const CUSTOM_KEY = 'fd_custom';

function loadCustom() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    if (Array.isArray(saved)) STATE.custom = saved;
  } catch (e) {}
}

function saveCustom() {
  STATE.customRev++;
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(STATE.custom)); } catch (e) {}
}

// Your appointments on these dates, shaped like class sessions (custom: true)
function customFor(dates) {
  const out = [];
  for (const a of STATE.custom) {
    for (const date of dates) {
      const hit = a.repeat === 'weekly'
        ? date >= a.date && date <= SEMESTER.end && daysBetween(a.date, date) % 7 === 0
        : date === a.date;
      if (!hit) continue;
      const startMin = timeToMinutes(a.start), endMin = timeToMinutes(a.end);
      out.push({
        id: a.id, custom: true, courseId: 'custom', course: a.title, type: 'C', typeName: 'Appointment', group: null,
        date, dayIndex: weekdayIndex(date), startMin, endMin, startTime: a.start, endTime: a.end, durationMin: endMin - startMin,
        room: a.location || '', lecturer: '', campus: null, notes: a.notes || '', repeat: a.repeat,
        cancelled: false, changed: { room: false, time: false }
      });
    }
  }
  return out;
}

const STORAGE_KEY = 'tum_aerospace_calendar_wise26_27';

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.selectedGroups) Object.assign(STATE.selectedGroups, saved.selectedGroups);
    if (saved.courseVisibility) Object.assign(STATE.courseVisibility, saved.courseVisibility);
    if (Array.isArray(saved.skippedClasses)) STATE.skippedClasses = new Set(saved.skippedClasses);
    if (Array.isArray(saved.manualGroups)) STATE.manualGroups = new Set(saved.manualGroups);
    if (saved.attendance && typeof saved.attendance === 'object') STATE.attendance = saved.attendance;
    if (saved.autopilot in OBJECTIVES) STATE.autopilot = saved.autopilot;
  } catch (e) {}
}

function saveState() {
  try {
    // Keep keys only the Flight Deck app uses (agenda mode, ghost groups…)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...saved,
      selectedGroups: STATE.selectedGroups,
      courseVisibility: STATE.courseVisibility,
      skippedClasses: [...STATE.skippedClasses],
      manualGroups: [...STATE.manualGroups],
      attendance: STATE.attendance,
      autopilot: STATE.autopilot
    }));
  } catch (e) {}
}

// ================= SETTINGS =================
const SETTINGS_KEY = 'fd_settings';
const SETTINGS = {
  name: '',
  home: null,               // { name, place, lat, lon } from the MVG address search
  modes: { mvg: true, car: false, bike: false },
  routeSort: 'latest',      // 'latest' | 'changes' | 'walking'
  arriveEarlyMin: 5,
  diet: 'all',
  favourites: '',
  workerUrl: '',
  notify: false,
  leadMinutes: {},
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

// ================= TUMONLINE =================
const TUM_KEY = 'fd_tum';
const TUM = { tumId: '', token: null, status: 'off', events: [], coverage: null, syncedAt: null, error: null, syncing: false };
const TUM_ID_PATTERN = /^[a-z]{2}\d{2}[a-z]{3}$/i;

function loadTum() {
  try { Object.assign(TUM, JSON.parse(localStorage.getItem(TUM_KEY) || '{}'), { syncing: false }); } catch (e) {}
}

function saveTum() {
  try {
    const { syncing, ...rest } = TUM;
    localStorage.setItem(TUM_KEY, JSON.stringify(rest));
  } catch (e) {}
}

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
  render();
  try {
    const xml = await tumGet('kalender', { pToken: TUM.token });
    TUM.events = parseTumCalendar(xml).map(({ description, url, status, endDate, ...ev }) => ev);
    TUM.coverage = tumCoverage(TUM.events);
    TUM.syncedAt = Date.now();
    TUM.error = null;
    const changed = applyDetectedGroups();
    saveTum();
    if (!quiet) toast(`Synced ${TUM.events.length} TUMonline events${changed.length ? ` · groups: ${changed.join(', ')}` : ''}`);
  } catch (e) {
    TUM.error = e.message;
    if (/token/i.test(e.message)) TUM.status = 'off'; // revoked in TUMonline: start over
    saveTum();
    if (!quiet) toast(`TUMonline sync failed: ${e.message}`);
  } finally {
    TUM.syncing = false;
    render();
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
  saveState();
  return changed;
}

function tumDisconnect() {
  clearInterval(tumPollTimer);
  Object.assign(TUM, { tumId: '', token: null, status: 'off', events: [], coverage: null, syncedAt: null, error: null });
  STATE.detectedGroups = {};
  saveTum();
  render();
  toast('Disconnected. Revoke the token under TUMonline › Token-Management too.');
}

// ================= SCHEDULE QUERIES =================

function templateClasses() {
  return scheduleFor(STATE.selectedGroups, { visibility: STATE.courseVisibility });
}

// One semester week with TUMonline merged in: { items, closures, covered, days }
const weekCache = new Map();
function getWeek(weekIdx) {
  const key = `${weekIdx}|${JSON.stringify(STATE.selectedGroups)}|${JSON.stringify(STATE.courseVisibility)}|${TUM.syncedAt}|${TUM.status}|${STATE.customRev}`;
  if (!weekCache.has(key)) {
    if (weekCache.size > 40) weekCache.clear();
    const connected = TUM.status === 'connected';
    const week = mergeWeek({
      template: templateClasses(),
      tumEvents: connected ? TUM.events : [],
      weekIdx,
      coverage: connected ? TUM.coverage : null
    });
    week.items = week.items.filter(c => STATE.courseVisibility[c.courseId] !== false)
      .concat(customFor(week.days))
      .sort((a, b) => a.dayIndex - b.dayIndex || a.startMin - b.startMin);
    weekCache.set(key, week);
  }
  return weekCache.get(key);
}

function currentWeekIndex() {
  return clampWeek(weekIndexOf(munichNow().date));
}

const attending = c => !c.cancelled && !STATE.skippedClasses.has(c.id);

function sessionsOn(date) {
  const w = weekIndexOf(date);
  if (w < 0 || w >= semesterWeeks()) return [];
  return getWeek(w).items.filter(c => c.date === date).sort((a, b) => a.startMin - b.startMin);
}

// Today while classes or appointments remain, otherwise the next day with any (up to three weeks ahead).
// `live` holds classes only: commute, lunch and Moodle ignore your own appointments.
function focusDay(now = munichNow()) {
  for (let i = 0; i < 21; i++) {
    const date = addDays(now.date, i);
    const sessions = sessionsOn(date);
    const pending = sessions.filter(attending);
    if (!pending.length || (i === 0 && Math.max(...pending.map(c => c.endMin)) <= now.minutes)) continue;
    return { date, isToday: i === 0, sessions, live: pending.filter(c => !c.custom) };
  }
  return null;
}

// The class whose Moodle you want: the one running, else the next one
function moodleTarget(now, focus) {
  if (!focus) return null;
  const withMoodle = focus.live.filter(c => moodleUrl(c.courseId, c.type));
  if (!focus.isToday) return withMoodle[0] ? { cls: withMoodle[0], when: 'next' } : null;
  const current = withMoodle.find(c => c.startMin <= now.minutes && c.endMin > now.minutes);
  if (current) return { cls: current, when: 'now' };
  const next = withMoodle.find(c => c.startMin > now.minutes);
  return next ? { cls: next, when: 'next' } : null;
}

function selectGroup(courseId, group) {
  STATE.selectedGroups[courseId] = group;
  STATE.manualGroups.add(courseId);
  saveState();
}
