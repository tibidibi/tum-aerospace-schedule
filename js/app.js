/**
 * Flight Deck · Cupertino: Today (a narrow day plan, getting there and home, departures, lunch),
 * Week, Groups (with Autopilot), Squad and Settings, with Moodle in the right-hand inspector.
 */

const COURSE_COLORS = {
  mech: '#007AFF', cf: '#FF9500', aero_mat: '#34C759', math: '#AF52DE',
  cad: '#FF2D55', ee: '#D9A400', intro_aero: '#30B0C7', custom: '#7D5260'
};
const LINE_COLORS = { UBAHN: '#0065AE', SBAHN: '#408335', TRAM: '#D82020', BUS: '#00586A', REGIONAL_BUS: '#00586A', BAHN: '#6B6B6B' };
const TYPE_SHORT = { L: 'Lecture', VI: 'Lecture + exercise', CE: 'Central exercise', E: 'Exercise', X: 'Exam', T: 'Event', C: 'Appointment' };
const PX_PER_MIN = 0.9;

const UI = {
  commute: { key: null, at: 0, html: '', busy: false },
  leave: { date: null, mode: 'default', time: '' }, // when you leave: 'default' (for/after classes) | 'now' | 'custom'
  board: { key: null, html: '' },
  lunch: { key: null, html: '' },
  leaveBy: {},          // date -> last leave-by (ms), to flag when it moves earlier
  notified: {},         // date -> true once "leave in 10 min" fired
  moodleWin: null,
  moodleUrl: null,
  homeResults: [],
  sheet: null,          // 'settings' | 'class'
  tick: 0
};

// ================= HELPERS =================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const hhmm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const colorOf = courseId => COURSE_COLORS[courseId] || '#8E8E93';
const shortRoom = room => String(room || '').split(' (')[0];
const icon = (name, cls = '') => `<span class="msr ${cls}" aria-hidden="true">${name}</span>`;
const courseOf = c => COURSES.find(x => x.id === c.courseId) || { id: c.courseId, shortName: c.course, name: c.course };

function fmtDuration(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

function dayMonth(date) {
  return parseISODate(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function weekdayName(date) {
  return parseISODate(date).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

function timeAgo(t) {
  const min = Math.round((Date.now() - t) / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3800);
}

function statusTags(c) {
  const tags = [];
  if (c.cancelled) tags.push('<span class="tag red">Cancelled</span>');
  if (c.isExam) tags.push('<span class="tag orange">Exam</span>');
  if (c.changed && c.changed.room) tags.push('<span class="tag orange">Room changed</span>');
  if (c.changed && c.changed.time) tags.push('<span class="tag orange">Time changed</span>');
  if (c.pdfOnly) tags.push('<span class="tag" title="Not in your TUMonline calendar">PDF only</span>');
  if (STATE.skippedClasses.has(c.id)) tags.push('<span class="tag">Skipped</span>');
  return tags.join(' ');
}

// Up to two side-by-side lanes for overlapping sessions
function laneMap(list) {
  const lanes = new Map();
  let cluster = [], end = -1;
  const flush = () => { if (cluster.length > 1) cluster.forEach((c, i) => lanes.set(c, i % 2)); cluster = []; };
  for (const c of list) {
    if (c.startMin >= end) { flush(); end = c.endMin; } else end = Math.max(end, c.endMin);
    cluster.push(c);
  }
  flush();
  return lanes;
}

function hourRange(list) {
  const from = Math.min(8 * 60, ...list.map(c => Math.floor(c.startMin / 60) * 60));
  const to = Math.max(18 * 60 + 30, ...list.map(c => Math.ceil(c.endMin / 60) * 60));
  return { from, to };
}

function hoursHtml(from, to) {
  let html = '';
  for (let m = Math.ceil(from / 60) * 60; m < to; m += 60) {
    html += `<span style="top:${(m - from) * PX_PER_MIN}px">${String(m / 60).padStart(2, '0')}:00</span>`;
  }
  return html;
}

function eventsHtml(list, from, now, { compact = false } = {}) {
  const lanes = laneMap(list);
  return list.map(c => {
    const top = (c.startMin - from) * PX_PER_MIN;
    const height = Math.max((c.endMin - c.startMin) * PX_PER_MIN - 2, 18);
    const isToday = c.date === now.date;
    const past = isToday && c.endMin <= now.minutes;
    const live = isToday && c.startMin <= now.minutes && !past && !c.cancelled;
    const cls = [
      past ? 'past' : '', live ? 'now' : '',
      STATE.skippedClasses.has(c.id) ? 'skipped' : '', c.cancelled ? 'cancelled' : '',
      lanes.has(c) ? `lane-${lanes.get(c)}` : '', c.custom ? 'custom' : ''
    ].join(' ');
    const course = courseOf(c);
    const where = shortRoom(c.room);
    const sub = compact ? where : [`${c.startTime}–${c.endTime}`, where].filter(Boolean).join(' · ');
    return `<button type="button" class="ev ${cls}" style="--c:${colorOf(c.courseId)};top:${top}px;height:${height}px"
      data-class="${esc(c.id)}" data-date="${c.date}" aria-label="${esc([course.name, TYPE_SHORT[c.type] || c.typeName, `${c.startTime} to ${c.endTime}`, where].filter(Boolean).join(', '))}">
      <b>${c.custom ? esc(c.course) : `${esc(course.shortName)}${c.type !== 'L' ? ` · ${esc(TYPE_SHORT[c.type] || '')}` : ''}${c.group ? ` ${esc(c.group.replace(/^Group /, 'G'))}` : ''}`}</b>
      ${height >= 36 ? `<span class="ev-sub">${esc(sub)}</span>` : ''}
    </button>`;
  }).join('');
}

function findSession(id, date) {
  const w = weekIndexOf(date);
  const week = w >= 0 && w < semesterWeeks() ? getWeek(w) : null;
  return (week && week.items.find(c => c.id === id && c.date === date)) || CLASSES.find(c => c.id === id);
}

// ================= RENDER =================

function render() {
  document.querySelectorAll('[data-view]').forEach(b => {
    if (b.dataset.view === STATE.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelector('.app').classList.toggle('no-inspector', !['today', 'week'].includes(STATE.view));
  renderSidebar();
  if (STATE.view === 'today') renderToday();
  else if (STATE.view === 'week') renderWeek();
  else if (STATE.view === 'groups') renderGroups();
  else renderSquad();
  if (['today', 'week'].includes(STATE.view)) renderInspector();
  if (UI.sheet === 'settings') renderTumSection();
}

function setView(view) {
  STATE.view = view;
  if (view === 'week') STATE.weekIdx = STATE.weekIdx || currentWeekIndex();
  window.scrollTo(0, 0);
  render();
}

function setToolbar({ eyebrow = '', title = '', subtitle = '', actions = '' }) {
  $('eyebrow').textContent = eyebrow;
  $('title').textContent = title;
  $('subtitle').textContent = subtitle;
  $('toolbarActions').innerHTML = actions;
}

function renderSidebar() {
  $('courseList').innerHTML = COURSES.map(c => {
    const on = STATE.courseVisibility[c.id] !== false;
    return `<button type="button" class="side-item course-item ${on ? '' : 'off'}" style="--c:${colorOf(c.id)}" data-toggle-course="${c.id}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(c.name)}">
      <span class="dot"></span>${esc(c.shortName)}</button>`;
  }).join('');
  const n = semesterWeeks();
  const w = Math.min(n, Math.max(0, weekIndexOf(munichNow().date) + 1));
  const synced = TUM.status === 'connected';
  $('weekProgress').innerHTML = `<div class="progress-card">
    <span>Week ${w} of ${n}</span>
    <div class="bar"><span style="width:${(w / n) * 100}%"></span></div>
    <span class="sync-line"><span class="led ${synced ? 'on' : ''}"></span>${synced
      ? (TUM.syncing ? 'Syncing TUMonline…' : `TUMonline · ${TUM.syncedAt ? timeAgo(TUM.syncedAt) : 'connected'}`)
      : TUM.status === 'pending' ? 'Waiting for TUMonline token' : 'Timetable PDF only'}</span>
  </div>`;
}

// ================= TODAY =================

function renderToday() {
  const now = munichNow();
  const focus = focusDay(now);
  if (!focus) {
    setToolbar({ eyebrow: weekdayName(now.date), title: dayMonth(now.date), subtitle: 'No classes in the next three weeks' });
    $('view').innerHTML = '<p class="empty">Nothing on your schedule. Enjoy the break.</p>';
    return;
  }
  const tomorrow = addDays(now.date, 1) === focus.date;
  const campus = focus.live.length ? focus.live[0].campus : null;
  const own = focus.sessions.filter(c => c.custom).length;
  UI.subtitle = [campus ? `Campus ${campus}` : '', `${focus.live.length} class${focus.live.length === 1 ? '' : 'es'}`, own ? `${own} appointment${own === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  setToolbar({
    eyebrow: focus.isToday ? weekdayName(focus.date) : tomorrow ? `Tomorrow · ${weekdayName(focus.date)}` : weekdayName(focus.date),
    title: dayMonth(focus.date),
    subtitle: todaySubtitle(focus)
  });

  const { from, to } = hourRange(focus.sessions);
  const week = getWeek(weekIndexOf(focus.date));
  const closures = week.closures.filter(x => x.date === focus.date);
  const showNow = focus.isToday && now.minutes >= from && now.minutes <= to;

  $('view').innerHTML = `<div class="today">
    <section class="day-col" aria-label="Day plan">
      <div class="col-head"><h2>${focus.isToday ? 'Today' : tomorrow ? 'Tomorrow' : weekdayName(focus.date)}</h2><span>${focus.sessions[0].startTime}–${focus.sessions[focus.sessions.length - 1].endTime}</span></div>
      ${closures.map(x => `<div class="closure">${esc(x.label)}</div>`).join('')}
      <div class="timeline" style="--hour-px:${60 * PX_PER_MIN}px">
        <div class="tl-hours" style="height:${(to - from) * PX_PER_MIN}px">${hoursHtml(from, to)}</div>
        <div class="tl-track" style="height:${(to - from) * PX_PER_MIN}px">
          ${eventsHtml(focus.sessions, from, now)}
          ${showNow ? `<div class="now-line" style="top:${(now.minutes - from) * PX_PER_MIN}px"></div>` : ''}
        </div>
      </div>
    </section>
    <section class="travel" aria-label="Travel and lunch">
      <div id="commute" class="commute">
        ${commuteHead(now, focus)}
        <div id="commuteBody">${commuteKey(now, focus) === UI.commute.key ? UI.commute.html
          : UI.commute.key && UI.commute.key.startsWith(focus.date) ? `<div class="stale">${UI.commute.html}</div>` // keep the last trip on screen while the new one loads
          : '<p class="section-note">Finding connections…</p>'}</div>
      </div>
      <div id="board">${UI.board.key === focus.date ? UI.board.html : ''}</div>
      <div id="lunch">${UI.lunch.key === lunchKey(focus) ? UI.lunch.html : ''}</div>
    </section>
  </div>`;

  if (commuteKey(now, focus) !== UI.commute.key || Date.now() - UI.commute.at > 60e3) fillCommute(now, focus);
  if (UI.lunch.key !== lunchKey(focus)) fillLunch(focus);
}

// ================= COMMUTE =================

function commuteKey(now, focus) {
  if (!focus.live.length) return `${focus.date}|noclass`;
  if (!SETTINGS.home) return 'nohome';
  const plan = leavePlan(now, focus);
  return `${focus.date}|${plan.toCampus ? 'campus' : 'home'}|${plan.mode}|${plan.mode === 'custom' ? UI.leave.time : ''}|${SETTINGS.routeSort}|${JSON.stringify(SETTINGS.modes)}|${SETTINGS.home.lat}`;
}

// When you leave: for your first class / after your last one (default), right now, or at a time you pick.
// Direction follows the time: before your first class you're heading in, after it you're heading home.
function leavePlan(now, focus) {
  if (UI.leave.date !== focus.date) UI.leave = { date: focus.date, mode: 'default', time: UI.leave.time };
  const first = focus.live[0];
  const last = focus.live[focus.live.length - 1];
  const mode = UI.leave.mode === 'now' && !focus.isToday ? 'default' : UI.leave.mode;
  if (mode === 'default') {
    const toCampus = !focus.isToday || now.minutes < first.startMin;
    return {
      mode, toCampus, arrive: toCampus,
      when: toCampus ? munichDate(focus.date, first.startMin - SETTINGS.arriveEarlyMin) : munichDate(focus.date, last.endMin),
      label: toCampus ? `Getting there · ${shortRoom(first.room)} for ${first.startTime}` : `Going home · after ${last.endTime}`
    };
  }
  const min = mode === 'now' ? now.minutes : timeToMinutes(UI.leave.time || minutesToTime(last.endMin));
  const toCampus = min < first.startMin;
  return {
    mode, toCampus, arrive: false,
    when: mode === 'now' ? new Date() : munichDate(focus.date, min),
    label: `${toCampus ? 'To campus' : 'Going home'} · leaving ${mode === 'now' ? 'now' : `at ${minutesToTime(min)}`}`
  };
}

// Drawn right away on every render, so switching when you leave responds before the trips load
function commuteHead(now, focus) {
  if (!focus.live.length) return '';
  if (!SETTINGS.home) return '<div class="section-label">Getting there</div>';
  const plan = leavePlan(now, focus);
  return `<div class="section-label">${esc(plan.label)}</div>${leaveControls(now, focus, plan)}`;
}

function leaveControls(now, focus, plan) {
  const first = focus.live[0];
  const last = focus.live[focus.live.length - 1];
  const defaultIn = !focus.isToday || now.minutes < first.startMin;
  const options = [
    ['default', defaultIn ? `For ${first.startTime}` : `After ${last.endTime}`],
    ...(focus.isToday ? [['now', 'Now']] : []),
    ['custom', 'Pick a time']
  ];
  return `<div class="leave-controls">
    <span class="seg" role="group" aria-label="When you leave">${options.map(([k, label]) =>
      `<button type="button" data-leave-mode="${k}" aria-pressed="${plan.mode === k}">${label}</button>`).join('')}</span>
    ${plan.mode === 'custom' ? `<input class="field leave-at" type="time" id="leaveAt" aria-label="Leave at" value="${esc(UI.leave.time)}">` : ''}
  </div>`;
}

// Leaving at a set time: car and bike go right away, MVG with the next connection.
// The fastest is whichever gets you there first.
function departModes({ mvg, car, bike }, { leaveAt, carBufferMin = 0, bikeBufferMin = 0 }) {
  const road = (mode, trip, buffer) => {
    const minutes = trip.minutes + buffer;
    return { mode, minutes, leaveBy: leaveAt, arrive: new Date(leaveAt.getTime() + minutes * 60e3), delayMin: trip.delayMin || 0 };
  };
  const modes = [];
  if (mvg) modes.push({ mode: 'mvg', minutes: mvg.minutes, leaveBy: mvg.depart, arrive: mvg.arrive, delayMin: mvg.maxDelayMin });
  if (car) modes.push(road('car', car, carBufferMin));
  if (bike) modes.push(road('bike', bike, bikeBufferMin));
  if (!modes.length) return modes;
  const best = Math.min(...modes.map(m => m.arrive.getTime()));
  modes.find(m => m.arrive.getTime() === best).fastest = true;
  return modes;
}

function routeRow(r) {
  const legs = r.legs.map(l => l.walk
    ? `<span class="walk" title="Walk ${l.minutes} min">${icon('directions_walk')}${l.minutes}</span>`
    : `<span class="line ${l.cancelled ? 'cancelled' : ''}" style="--line:${LINE_COLORS[l.type] || '#555'}" title="${esc(`${l.label} → ${l.destination}, from ${l.from}${l.platform != null ? ` (platform ${l.platform})` : ''}`)}">${esc(l.label)}${l.delayMin > 0 ? `<sup>+${l.delayMin}</sup>` : ''}</span>`
  ).join('<span class="leg-sep" aria-hidden="true">›</span>');
  return `<div class="row ${r.unusable ? 'unusable' : ''}">
    <span class="route-times">${hhmm(r.depart)} → ${hhmm(r.arrive)}</span>
    <span class="grow"><span class="legs">${legs}</span>
      <span class="sub">${fmtDuration(r.minutes)} · ${r.changes} change${r.changes === 1 ? '' : 's'} · ${r.walkMin} min walk</span></span>
    ${r.cancelled ? '<span class="tag red">Cancelled</span>' : r.late ? '<span class="tag orange">Too late</span>' : ''}
  </div>`;
}

async function fillCommute(now, focus) {
  const key = commuteKey(now, focus);
  if (UI.commute.busy === key) return;
  UI.commute.busy = key;
  const out = {};
  let html;
  try {
    html = await commuteHtml(now, focus, out);
  } finally {
    UI.commute.busy = false;
  }
  // You may have picked another time while this was loading: only the current choice gets shown
  if (key !== commuteKey(munichNow(), focus)) return;
  UI.commute = { ...UI.commute, key, html, homeBy: out.homeBy || null, at: Date.now() };
  const el = $('commuteBody');
  if (el && STATE.view === 'today') {
    el.innerHTML = UI.commute.html;
    $('subtitle').textContent = todaySubtitle(focus);
  }
}

function todaySubtitle(focus) {
  const homeBy = UI.commute.key && UI.commute.key.startsWith(`${focus.date}|home`) ? UI.commute.homeBy : null;
  return homeBy ? `${UI.subtitle} · home by ${homeBy}` : UI.subtitle;
}

async function commuteHtml(now, focus, out = {}) {
  if (!focus.live.length) return '';
  if (!SETTINGS.home) {
    return `<div class="section">
      <div class="card"><strong>Add your home address</strong>
      <span class="sub">Then you'll see when to leave and the best way in: MVG, car or bike, with live delays.</span>
      <div><button type="button" class="btn" data-open-settings>Set home address</button></div></div></div>`;
  }
  const first = focus.live[0];
  const last = focus.live[focus.live.length - 1];
  const plan = leavePlan(now, focus);
  const { toCampus, arrive, when } = plan;
  const anchor = toCampus ? first : last;
  const campus = CAMPUSES[anchor.campus] || CAMPUSES.Ottobrunn;
  let place = { lat: campus.lat, lon: campus.lon, building: campus.name };
  try {
    const info = await roomInfo(anchor.room);
    if (info && info.lat) place = info;
  } catch (e) {}
  const home = SETTINGS.home;
  const from = toCampus ? home : place;
  const to = toCampus ? place : home;

  const [mvg, car, bike] = await Promise.all([
    SETTINGS.modes.mvg ? mvgRoutes(from, to, when, { arrive, cacheKey: `routes:${toCampus}` }).catch(e => ({ error: e.message })) : null,
    SETTINGS.modes.car && workerUrl() ? roadRoute(workerUrl(), 'car', from, to, when).catch(e => ({ error: e.message })) : null,
    SETTINGS.modes.bike && workerUrl() ? roadRoute(workerUrl(), 'bicycle', from, to, when).catch(e => ({ error: e.message })) : null
  ]);
  const raw = Array.isArray(mvg) ? mvg : [];
  // Arriving by a time: the latest connection that still makes it. Leaving at a time: the next ones to go.
  const routes = arrive ? rankRoutes(raw, SETTINGS.routeSort, when) : rankRoutes(raw, SETTINGS.routeSort).sort((a, b) => a.unusable - b.unusable || a.depart - b.depart);
  // A time you picked is taken as is (even if it's past, to plan); otherwise never before now
  const leaveAt = plan.mode === 'custom' ? when : new Date(Math.max(when.getTime(), Date.now()));
  const earliest = leaveAt.getTime() - 60e3;
  const bestMvg = arrive
    ? rankRoutes(raw, 'latest', when).find(r => !r.unusable) || null
    : routes.find(r => !r.unusable && r.depart >= earliest) || routes.find(r => !r.unusable) || null;
  // Leaving at a time: list only trips that go at or after it
  const later = arrive ? routes : routes.filter(r => r.depart >= earliest);
  const listed = (later.length ? later : routes).slice(0, 4);
  const ok = x => (x && !x.error ? x : null);
  const buffers = { carBufferMin: campus.carBufferMin, bikeBufferMin: campus.bikeBufferMin };
  const modes = arrive
    ? compareModes({ mvg: bestMvg, car: ok(car), bike: ok(bike) }, { arriveBy: when, ...buffers })
    : departModes({ mvg: bestMvg, car: ok(car), bike: ok(bike) }, { leaveAt, ...buffers });
  const pick = modes.find(m => m.fastest);
  const arrival = pick && (pick.arrive || (pick.mode === 'mvg' && bestMvg ? bestMvg.arrive : null));
  if (!toCampus && arrival) out.homeBy = hhmm(arrival);

  let moved = '';
  if (pick && toCampus && plan.mode === 'default') {
    const prev = UI.leaveBy[focus.date];
    if (prev && pick.leaveBy.getTime() < prev - 90e3) {
      const delayed = bestMvg ? bestMvg.legs.filter(l => !l.walk && l.delayMin > 0).map(l => `${l.label} +${l.delayMin} min`).join(', ') : '';
      moved = `${delayed ? `${delayed}: ` : ''}leave ${Math.round((prev - pick.leaveBy) / 60e3)} min earlier`;
    }
    UI.leaveBy[focus.date] = pick.leaveBy.getTime();
    const lead = first.startMin - munichNow(pick.leaveBy).minutes;
    if (lead > 0 && lead < 300) { SETTINGS.leadMinutes[first.dayIndex] = lead; saveSettings(); }
    maybeNotify(focus, first, pick, bestMvg);
  }

  // Weather at leave time and disruptions on your lines, in parallel
  const leaveMin = pick ? munichNow(pick.leaveBy).minutes : (toCampus ? first.startMin : last.endMin);
  const lines = new Set(listed.flatMap(r => r.lines));
  const [hour, incidents] = await Promise.all([
    weatherAt(from.lat, from.lon).then(h => hourForecast(h, focus.date, leaveMin)).catch(() => null),
    lines.size ? mvgIncidents().then(list => list.filter(m => (m.lines || []).some(l => lines.has(l.label)))).catch(() => []) : []
  ]);
  const wet = hour && hour.rainChance >= 50;
  const weather = hour ? `<span class="weather ${wet ? 'wet' : ''}">${Math.round(hour.tempC)}° · ${hour.rainChance}% rain${wet && modes.some(m => m.mode === 'bike') ? ' · skip the bike' : wet ? ' · umbrella' : ''}</span>` : '';

  const modeName = { mvg: 'MVG', car: 'Car', bike: 'Bike' };
  const modeCards = modes.length > 1 ? `<div class="modes">${modes.map(m => `
    <div class="mode ${m.fastest ? 'fastest' : ''}">
      <span class="m-name">${modeName[m.mode]}${m.fastest ? '<span class="tag green">Fastest</span>' : ''}</span>
      <span class="m-time">${fmtDuration(m.minutes)}</span>
      <span class="m-leave">leave ${hhmm(m.leaveBy)}${m.delayMin > 0 ? ` · <span class="late">+${m.delayMin} ${m.mode === 'car' ? 'traffic' : 'delay'}</span>` : ''}</span>
    </div>`).join('')}</div>` : '';
  const notes = [car, bike].filter(x => x && x.error).map(x => `<p class="err">${esc(x.error)}</p>`).join('')
    + ((SETTINGS.modes.car || SETTINGS.modes.bike) && !workerUrl() ? '<p class="section-note">Add a Worker URL in Settings to compare car and bike.</p>' : '');
  const inMin = pick && focus.isToday ? (pick.leaveBy - Date.now()) / 60e3 : null;

  return `
    <div class="section">
      <div class="leave-card">
        <div class="leave-top">
          <div>
            <div class="leave-meta">${pick ? (arrive ? 'Leave by' : 'Leave at') : 'No connection found'}</div>
            ${pick ? `<div class="leave-time ${moved ? 'moved' : ''}">${hhmm(pick.leaveBy)}</div>
            <div class="leave-meta">${modeName[pick.mode]} · ${fmtDuration(pick.minutes)}${inMin != null ? (inMin > 0 ? ` · in ${fmtDuration(inMin)}` : plan.mode === 'custom' ? '' : ' · now') : ''}${arrival ? ` · ${toCampus ? 'there' : 'home'} ${hhmm(arrival)}` : ''}</div>` : ''}
          </div>
          ${weather}
        </div>
        ${moved ? `<p class="moved-note">${esc(moved)}</p>` : ''}
        ${modeCards}
      </div>
      ${notes}
    </div>
    ${SETTINGS.modes.mvg ? `
    <div class="section">
      <div class="section-label">${toCampus ? 'Connections' : 'Trips home'}
        <span class="seg" role="group" aria-label="Sort connections">${[['latest', 'Latest'], ['changes', 'Fewest changes'], ['walking', 'Least walking']].map(([k, label]) =>
          `<button type="button" data-route-sort="${k}" aria-pressed="${SETTINGS.routeSort === k}">${label}</button>`).join('')}</span>
      </div>
      ${mvg && mvg.error ? `<p class="err">MVG: ${esc(mvg.error)}</p>` : ''}
      <div class="list" style="--inset:132px">${listed.map(routeRow).join('') || '<div class="row muted">No connections found.</div>'}</div>
      ${incidents.slice(0, 3).map(m => `<p class="section-note"><span class="tag orange">${esc([...new Set(m.lines.filter(l => lines.has(l.label)).map(l => l.label))].join(', '))}</span> ${esc(m.title)}</p>`).join('')}
    </div>` : ''}
    ${fillBoardLater(bestMvg, focus)}`;
}

// The departure board needs the route's first stop; fetch it after the commute is in place
function fillBoardLater(route, focus) {
  const stop = route && route.firstStop;
  if (!stop || !stop.id || !focus.isToday) { UI.board = { key: focus.date, html: '' }; return ''; }
  mvgDepartures(stop.id, 8).then(all => {
    const deps = all.filter(d => d.time > Date.now() - 60e3).slice(0, 6);
    UI.board = { key: focus.date, html: deps.length ? `
      <div class="section">
        <div class="section-label">Departures · ${esc(stop.name)}<span>${deps.some(d => d.realtime) ? '<span class="live-dot" aria-hidden="true"></span>Live' : 'Timetable'}</span></div>
        <div class="list"><table class="board">
          <thead><tr><th>Time</th><th>Line</th><th>Destination</th><th>Pl.</th></tr></thead>
          <tbody>${deps.map(d => `<tr class="${d.line === stop.line ? 'yours' : ''} ${d.cancelled ? 'cancelled' : ''}">
            <td class="t">${hhmm(d.time)}${d.delayMin > 0 ? ` <span class="late">+${d.delayMin}</span>` : ''}</td>
            <td><span class="line" style="--line:${LINE_COLORS[d.type] || '#555'}">${esc(d.line)}</span></td>
            <td>${esc(d.cancelled ? 'Cancelled' : d.destination)}</td>
            <td>${d.platform ?? ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : '' };
    const el = $('board');
    if (el && STATE.view === 'today') el.innerHTML = UI.board.html;
  }).catch(() => {});
  return '';
}

function maybeNotify(focus, first, pick, route) {
  if (!SETTINGS.notify || !focus.isToday || UI.notified[focus.date] || !('Notification' in window) || Notification.permission !== 'granted') return;
  const minsLeft = (pick.leaveBy - Date.now()) / 60e3;
  if (minsLeft > 10 || minsLeft < 0) return;
  UI.notified[focus.date] = true;
  const via = pick.mode === 'mvg' && route && route.firstStop ? ` · ${route.firstStop.line} from ${route.firstStop.name}` : '';
  const title = `Leave in ${Math.max(1, Math.round(minsLeft))} min`;
  const body = `${courseOf(first).shortName} at ${first.startTime}. Leave at ${hhmm(pick.leaveBy)}${via}.`;
  navigator.serviceWorker?.getRegistration().then(reg => reg
    ? reg.showNotification(title, { body, tag: 'leave', icon: 'icons/icon.svg' })
    : new Notification(title, { body })).catch(() => {});
}

// ================= LUNCH =================

function lunchKey(focus) {
  return `${focus.date}|${SETTINGS.diet}|${SETTINGS.favourites}|${workerUrl()}|${focus.live.length}`;
}

async function fillLunch(focus) {
  const key = lunchKey(focus);
  if (!focus.live.length) {
    UI.lunch = { key, html: '' };
    if ($('lunch')) $('lunch').innerHTML = '';
    return;
  }
  const campusName = (focus.live.find(c => c.campus) || {}).campus || 'Ottobrunn';
  const campus = CAMPUSES[campusName];
  const win = lunchWindow(focus.live, LUNCH_HOURS, 15);
  const favs = SETTINGS.favourites.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const diet = DIETS[SETTINGS.diet] || DIETS.all;
  const isFav = d => favs.some(f => d.name.toLowerCase().includes(f));

  let prices = {};
  try { prices = priceTable(await canteenWeek(CAMPUSES.Garching.canteens[0], focus.date)); } catch (e) {}
  const blocks = await Promise.all(campus.canteens.map(async (canteen, i) => {
    let days;
    try { days = await canteenWeek(canteen, focus.date, workerUrl()); } catch (e) {
      return `<div class="row muted">${esc(canteen.name)}: ${/404/.test(e.message) ? 'no menu published yet' : 'menu unavailable'}</div>`;
    }
    if (!days) return `<a class="row" href="${canteen.page}" target="_blank" rel="noopener"><span class="grow">${esc(canteen.name)}<span class="sub">Add a Worker URL in Settings to show the menu here</span></span>${icon('chevron_right', 'chev')}</a>`;
    const dishes = (days.find(d => d.date === focus.date) || { dishes: [] }).dishes.filter(diet);
    const head = campus.canteens.length > 1 ? `<div class="row"><strong>${esc(canteen.name)}</strong></div>` : '';
    return head + (dishes.map(d => `<div class="row dish">
      <span class="grow"><span>${isFav(d) ? '<span class="fav">★</span> ' : ''}${esc(d.name)}</span>
        <span class="sub">${esc(d.dish_type || '')}${d.labels.includes('VEGAN') ? ' · Vegan' : d.labels.includes('VEGETARIAN') ? ' · Veggie' : ''}</span></span>
      <span class="value num">${formatPrice(d.prices || prices[d.dish_type])}</span>
    </div>`).join('') || `<div class="row muted">${i === 0 ? 'Nothing on the menu for your diet filter.' : ''}</div>`);
  }));

  UI.lunch = { key, html: `
    <div class="section">
      <div class="section-label">Lunch · ${esc(campus.canteens[0].name)}
        <span class="seg" role="group" aria-label="Diet">${[['all', 'All'], ['vegetarian', 'Veggie'], ['vegan', 'Vegan']].map(([k, label]) =>
          `<button type="button" data-diet="${k}" aria-pressed="${SETTINGS.diet === k}">${label}</button>`).join('')}</span>
      </div>
      <p class="section-note">${win
        ? `Free ${minutesToTime(win.from)}–${minutesToTime(win.to)}${win.to - win.from < 30 ? ' · short, go straight to the counter' : ''}`
        : 'No break while the Mensa is open (11:00–14:00). Pack a snack.'}</p>
      <div class="list">${blocks.join('')}</div>
    </div>` };
  const el = $('lunch');
  if (el && STATE.view === 'today') el.innerHTML = UI.lunch.html;
}

// ================= INSPECTOR: MOODLE =================

function renderInspector() {
  const now = munichNow();
  const focus = focusDay(now);
  const target = moodleTarget(now, focus);
  followMoodle(now, target);
  const following = UI.moodleWin && !UI.moodleWin.closed;

  let card = `<div class="card"><strong>No class coming up</strong><a href="https://www.moodle.tum.de/my/" target="_blank" rel="noopener">Open your Moodle dashboard ↗</a></div>`;
  let links = '';
  if (target && target.cls) {
    const c = target.cls;
    const course = courseOf(c);
    const url = moodleUrl(c.courseId, c.type);
    const other = [course.moodle, course.moodleExercise].filter(u => u && u !== url);
    card = `<div class="course-card" style="--c:${colorOf(c.courseId)}">
      <span class="when">${target.when === 'now' ? `In class now · until ${c.endTime}` : `${focus.isToday ? 'Next' : weekdayName(c.date)} · ${c.startTime}`}</span>
      <span class="name">${esc(course.name)}</span>
      <span class="meta">${esc(TYPE_SHORT[c.type] || c.typeName)}${c.group ? ` · ${esc(c.group)}` : ''} · ${esc(shortRoom(c.room))}</span>
    </div>`;
    links = `<div class="list">
      <a class="row" href="${url}" target="_blank" rel="noopener"><span class="badge" style="--c:${colorOf(c.courseId)}">${icon('school')}</span><span class="grow">Open ${c.type === 'L' || c.type === 'VI' ? 'course' : 'exercise course'}</span>${icon('open_in_new', 'chev sm')}</a>
      ${other.map(u => `<a class="row" href="${u}" target="_blank" rel="noopener" style="--inset:54px"><span class="badge" style="--c:#8E8E93">${icon('menu_book')}</span><span class="grow">${u === course.moodleExercise ? 'Exercise course' : 'Lecture course'}</span>${icon('open_in_new', 'chev sm')}</a>`).join('')}
      <a class="row" href="${navLink(c.room)}" target="_blank" rel="noopener"><span class="badge" style="--c:#8E8E93">${icon('location_on')}</span><span class="grow">${esc(shortRoom(c.room))}<span class="sub">Room on NavigaTUM</span></span>${icon('open_in_new', 'chev sm')}</a>
    </div>`;
  }

  // Every course of the focus day, for quick jumps
  const dayCourses = focus ? [...new Map(focus.live.filter(c => moodleUrl(c.courseId, c.type)).map(c => [c.courseId, c])).values()] : [];
  const upNext = focus ? focus.live.filter(c => !focus.isToday || c.endMin > now.minutes).filter(c => !target || c !== target.cls).slice(0, 4) : [];

  $('inspector').innerHTML = `
    <div class="insp-head">
      <h2>Moodle</h2>
      <button type="button" class="switch" data-follow aria-pressed="${!!following}">Follow along<span class="track" aria-hidden="true"></span></button>
    </div>
    <p class="follow-note">${following
      ? '<span class="live-dot" aria-hidden="true"></span>The Moodle window switches to each class as it starts.'
      : 'Opens Moodle on the right half of your screen and moves it to the right course as your day goes on.'}</p>
    ${card}
    ${links}
    ${dayCourses.length > 1 ? `<div class="section">
      <div class="section-label">${focus.isToday ? "Today's courses" : `${weekdayName(focus.date)}'s courses`}</div>
      <div class="list" style="--inset:36px">${dayCourses.map(c => `<a class="row" href="${moodleUrl(c.courseId, c.type)}" target="_blank" rel="noopener">
        <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${colorOf(c.courseId)}"></span>
        <span class="grow">${esc(courseOf(c).name)}</span>${icon('open_in_new', 'chev sm')}</a>`).join('')}</div>
    </div>` : ''}
    ${upNext.length ? `<div class="section">
      <div class="section-label">Up next</div>
      <div class="list" style="--inset:66px">${upNext.map(c => `<button type="button" class="row" data-class="${esc(c.id)}" data-date="${c.date}">
        <span class="value num" style="width:40px">${c.startTime}</span>
        <span class="grow">${esc(courseOf(c).shortName)}<span class="sub">${esc(TYPE_SHORT[c.type] || '')} · ${esc(shortRoom(c.room))}</span></span>
        ${icon('chevron_right', 'chev')}</button>`).join('')}</div>
    </div>` : ''}`;
}

// Moodle forbids iframes, so we steer a window we opened instead
function startMoodleFollow() {
  const target = moodleTarget(munichNow(), focusDay());
  const url = (target && target.cls && moodleUrl(target.cls.courseId, target.cls.type)) || 'https://www.moodle.tum.de/my/';
  const w = Math.round(screen.availWidth / 2);
  const left = (screen.availLeft || 0) + screen.availWidth - w;
  UI.moodleWin = window.open(url, 'tum-moodle', `popup,width=${w},height=${screen.availHeight},left=${left},top=${screen.availTop || 0}`);
  UI.moodleUrl = url;
  if (!UI.moodleWin) toast('Your browser blocked the window. Allow pop-ups for this site, then try again.');
  renderInspector();
}

function followMoodle(now, target) {
  const win = UI.moodleWin;
  if (!win || win.closed || !target || !target.cls) return;
  // Switch when a class starts, or 10 min before the next one
  if (target.when !== 'now' && (target.cls.date !== now.date || target.cls.startMin - now.minutes > 10)) return;
  const url = moodleUrl(target.cls.courseId, target.cls.type);
  if (url && url !== UI.moodleUrl) {
    try { win.location.href = url; UI.moodleUrl = url; } catch (e) { UI.moodleWin = null; }
  }
}

// ================= WEEK =================

function renderWeek() {
  const n = semesterWeeks();
  const w = STATE.weekIdx;
  const week = getWeek(w);
  const now = munichNow();
  const counted = week.items.filter(c => attending(c) && !c.custom);
  const minutes = counted.reduce((s, c) => s + c.durationMin, 0);
  const campusDays = new Set(counted.map(c => c.dayIndex)).size;
  setToolbar({
    eyebrow: `Week ${w + 1} of ${n}`,
    title: `${formatDateShort(week.days[0])} – ${formatDateShort(week.days[4])}`,
    subtitle: `${fmtDuration(minutes)} of class · ${campusDays} campus day${campusDays === 1 ? '' : 's'}`,
    actions: `
      <div class="seg" role="group" aria-label="Change week">
        <button type="button" data-week="-1" aria-label="Previous week" ${w === 0 ? 'disabled' : ''}>${icon('chevron_left')}</button>
        <button type="button" data-week="today">Today</button>
        <button type="button" data-week="1" aria-label="Next week" ${w === n - 1 ? 'disabled' : ''}>${icon('chevron_right')}</button>
      </div>
      <button type="button" class="btn gray" data-export>Export .ics</button>`
  });

  const { from, to } = hourRange(week.items);
  const height = (to - from) * PX_PER_MIN;
  const heads = week.days.map((date, d) => {
    const items = week.items.filter(c => c.dayIndex === d && attending(c));
    const campus = [...new Set(items.map(c => c.campus).filter(Boolean))].join(' + ');
    return `<div class="week-head ${date === now.date ? 'is-today' : ''}">
      <span class="dname">${DAYS[d].slice(0, 3)}</span>
      <span class="dnum">${Number(date.slice(8))}</span>
      <span class="campus">${esc(campus || 'Free')}</span>
    </div>`;
  }).join('');
  const cols = week.days.map((date, d) => {
    const items = week.items.filter(c => c.dayIndex === d);
    const closure = week.closures.find(x => x.dayIndex === d);
    const nowLine = date === now.date && now.minutes >= from && now.minutes <= to;
    return `<div class="week-col tl-track" style="height:${height}px">
      ${closure ? `<div class="closure">${esc(closure.label)}</div>` : ''}
      ${eventsHtml(items, from, now, { compact: true })}
      ${nowLine ? `<div class="now-line" style="top:${(now.minutes - from) * PX_PER_MIN}px;left:0"></div>` : ''}
    </div>`;
  }).join('');

  $('view').innerHTML = `
    <div class="week-stats">
      ${TUM.status === 'connected'
        ? `<span><b>TUMonline</b> times, rooms and cancellations${week.covered ? '' : ' (this week is outside the synced range)'}</span>`
        : '<span><b>Timetable PDF</b> · <button type="button" class="btn plain" data-open-settings>connect TUMonline</button> for live rooms and cancellations</span>'}
    </div>
    <div class="week-wrap">
      <div class="week" style="--hour-px:${60 * PX_PER_MIN}px">
        <span></span>${heads}
        <div class="tl-hours" style="height:${height}px">${hoursHtml(from, to)}</div>${cols}
      </div>
    </div>`;
}

// Your own appointments as VEVENTs: one-off, or weekly until the end of the lecture period
function appointmentEvents(now = new Date()) {
  const compact = s => s.replace(/-/g, '');
  const time = t => t.replace(':', '') + '00';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return STATE.custom.flatMap(a => [
    'BEGIN:VEVENT',
    `UID:${a.id}@unofficial-draft-planner`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/Berlin:${compact(a.date)}T${time(a.start)}`,
    `DTEND;TZID=Europe/Berlin:${compact(a.date)}T${time(a.end)}`,
    ...(a.repeat === 'weekly' ? [`RRULE:FREQ=WEEKLY;UNTIL=${compact(SEMESTER.end)}T225959Z`] : []),
    `SUMMARY:${icsEscape(a.title)}`,
    ...(a.location ? [`LOCATION:${icsEscape(a.location)}`] : []),
    ...(a.notes ? [`DESCRIPTION:${icsEscape(a.notes)}`] : []),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT'
  ]).map(icsFold);
}

function exportICS() {
  const classes = templateClasses().filter(c => !STATE.skippedClasses.has(c.id));
  const own = STATE.custom.length;
  if (!classes.length && !own) return toast('Nothing to export: every class is hidden or skipped.');
  const extra = appointmentEvents();
  const ics = buildICS(classes).replace(/END:VCALENDAR\r\n$/, () => (extra.length ? extra.join('\r\n') + '\r\n' : '') + 'END:VCALENDAR\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'TUM_Aerospace_Schedule_WiSe26_27.ics' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${classes.length} weekly classes${own ? ` and ${own} appointment${own === 1 ? '' : 's'}` : ''}, Christmas break excluded for classes.`);
}

// ================= GROUPS =================

function groupSummary(courseId, group) {
  return CLASSES.filter(c => c.courseId === courseId && c.group === group)
    .map(c => `${c.day.slice(0, 3)} ${c.startTime}–${c.endTime} · ${shortRoom(c.room)}`).join(' / ');
}

function planSummary(m) {
  return [
    `${m.campusDays} campus day${m.campusDays === 1 ? '' : 's'}`,
    `${fmtDuration(m.gapMin)} of gaps`,
    m.noLunchDays ? `${m.noLunchDays} day${m.noLunchDays === 1 ? '' : 's'} without lunch` : 'lunch every day'
  ].join(' · ');
}

function renderGroups() {
  setToolbar({ eyebrow: 'Exercise groups', title: 'Groups', subtitle: 'Pick yours, or let Autopilot find the best mix.' });
  const fixed = {};
  for (const [courseId, g] of Object.entries(STATE.detectedGroups)) if (!STATE.manualGroups.has(courseId)) fixed[courseId] = g;
  let plans = optimize(STATE.autopilot, { fixed, visibility: STATE.courseVisibility, skipped: STATE.skippedClasses, limit: 3 });
  if (!plans.length) plans = optimize(STATE.autopilot, { visibility: STATE.courseVisibility, skipped: STATE.skippedClasses, limit: 3 });
  const isCurrent = p => Object.entries(p.groups).every(([k, g]) => STATE.selectedGroups[k] === g);
  const current = scoreSchedule(templateClasses().filter(c => !STATE.skippedClasses.has(c.id)));

  const autopilot = `<section class="autopilot" aria-label="Autopilot">
    <div class="section-label">Autopilot<span>${esc(OBJECTIVES[STATE.autopilot].hint)}</span></div>
    <div><span class="seg" role="group" aria-label="Rank by">${Object.entries(OBJECTIVES).map(([k, o]) =>
      `<button type="button" data-objective="${k}" aria-pressed="${STATE.autopilot === k}">${esc(o.label)}</button>`).join('')}</span></div>
    <div class="plans">${plans.map((p, i) => `<div class="plan">
      <h3>${i === 0 ? 'Best' : `Option ${i + 1}`}${isCurrent(p) ? ' <span class="tag green">Current</span>' : ''}</h3>
      <ul>${Object.entries(p.groups).map(([k, g]) => `<li>${esc(COURSES.find(c => c.id === k).shortName)}: <strong>${esc(g)}</strong></li>`).join('')}</ul>
      <span class="metrics">${planSummary(p.metrics)}</span>
      ${isCurrent(p) ? '' : `<button type="button" class="btn" data-plan="${i}">Use this plan</button>`}
    </div>`).join('') || '<p class="section-note">No conflict-free combination. Hide a course or unskip a class.</p>'}</div>
    <p class="section-note">Your current pick: ${current.conflict ? '<span class="tag red">Has a clash</span> · ' : ''}${planSummary(current)}</p>
  </section>`;
  UI.plans = plans;

  const courses = COURSES.filter(c => c.hasGroups && STATE.courseVisibility[c.id] !== false).map(course => {
    const groups = [...new Set(CLASSES.filter(x => x.courseId === course.id && x.group).map(x => x.group))];
    return `<section class="section" aria-label="${esc(course.name)}">
      <div class="section-label"><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:${colorOf(course.id)}"></span>${esc(course.name)}</span></div>
      <div class="list" style="--inset:42px">${groups.map(g => {
        const selected = STATE.selectedGroups[course.id] === g;
        const clash = !selected && scoreSchedule(scheduleFor({ ...STATE.selectedGroups, [course.id]: g }, { visibility: STATE.courseVisibility, skipped: STATE.skippedClasses })).conflict;
        return `<button type="button" class="row ${clash ? 'muted' : ''}" data-group="${esc(g)}" data-course="${course.id}" aria-pressed="${selected}">
          <span class="check">${selected ? icon('check') : ''}</span>
          <span class="grow">${esc(g)}<span class="sub">${esc(groupSummary(course.id, g))}</span></span>
          ${STATE.detectedGroups[course.id] === g ? '<span class="tag blue">TUMonline</span>' : ''}
          ${clash ? '<span class="tag red">Clashes</span>' : ''}
        </button>`;
      }).join('')}</div>
    </section>`;
  }).join('');

  $('view').innerHTML = `<div class="groups">${autopilot}${courses}</div>`;
}

// ================= SQUAD =================

function mySquadLink() {
  const code = encodeShare({ name: SETTINGS.name, groups: STATE.selectedGroups, skipped: STATE.skippedClasses });
  return `${location.origin}${location.pathname}#join=${code}`;
}

function handleJoinLink() {
  const m = location.hash.match(/^#join=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const friend = decodeShare(m[1]);
  if (!friend) return toast('That squad link is broken or out of date.');
  const name = friend.name || 'A classmate';
  if (!confirm(`Add ${name}'s schedule to your squad? You'll see shared classes and free time together.`)) return;
  SETTINGS.squad = SETTINGS.squad.filter(f => f.name !== friend.name).concat([{ name, groups: friend.groups, skipped: friend.skipped }]);
  saveSettings();
  STATE.view = 'squad';
  toast(`${name} joined your squad`);
}

function renderSquad() {
  setToolbar({ eyebrow: 'Friends', title: 'Squad', subtitle: 'Share your schedule, find shared classes and free time.' });
  const mine = templateClasses().filter(c => !STATE.skippedClasses.has(c.id));
  const friends = SETTINGS.squad.map(f => ({ ...f, schedule: friendSchedule(f) }));
  const together = friends.length ? DAYS.map((day, d) => ({ day, slots: freeTogether([mine, ...friends.map(f => f.schedule)], d) })).filter(x => x.slots.length) : [];
  const link = mySquadLink();

  $('view').innerHTML = `<div class="squad">
    <section class="section">
      <div class="section-label">Your link</div>
      <div class="list">
        <label class="row"><span class="grow">Your name</span><input class="field" id="squadName" style="max-width:220px" value="${esc(SETTINGS.name)}" placeholder="Shown to friends" maxlength="40"></label>
      </div>
      <div class="link-box"><input class="field" readonly value="${esc(link)}" aria-label="Your squad link"><button type="button" class="btn" data-copy="${esc(link)}">Copy link</button></div>
      <p class="section-note">The link holds only your name, groups and skipped classes. Friends who open it can add you.</p>
    </section>
    <section class="section">
      <div class="section-label">Friends</div>
      <div class="list" style="--inset:58px">${friends.map((f, i) => {
        const shared = f.schedule.filter(c => c.group && mine.some(m => m.id === c.id)).map(c => `${COURSES.find(x => x.id === c.courseId).shortName} ${c.group}`);
        return `<div class="row"><span class="avatar" aria-hidden="true">${esc(initials(f.name))}</span>
          <span class="grow">${esc(f.name)}<span class="sub">${shared.length ? `Same group: ${esc(shared.join(', '))}` : 'No shared exercise groups'}</span></span>
          <button type="button" class="btn danger" data-squad-remove="${i}">Remove</button></div>`;
      }).join('') || '<div class="row muted">No one yet. Send your link to classmates.</div>'}</div>
    </section>
    ${friends.length ? `<section class="section">
      <div class="section-label">Free together · 45 min or more</div>
      <div class="list">${together.map(x => `<div class="row"><span class="grow">${x.day}</span><span class="value num">${x.slots.map(s => `${minutesToTime(s.from)}–${minutesToTime(s.to)}`).join(', ')}</span></div>`).join('')
        || '<div class="row muted">No shared breaks on days you are all on campus.</div>'}</div>
    </section>` : ''}
  </div>`;
}

// ================= SHEETS: CLASS DETAIL & SETTINGS =================

function openSheet(kind, title, body) {
  UI.sheet = kind;
  $('sheetTitle').textContent = title;
  $('sheetBody').innerHTML = body;
  const sheet = $('sheet');
  if (!sheet.open) sheet.showModal();
}

function openClass(id, date) {
  const c = findSession(id, date);
  if (!c) return;
  if (c.custom) return openAppointment(c.id);
  const course = courseOf(c);
  const now = munichNow();
  const past = c.date === now.date && c.endMin <= now.minutes;
  const key = `${c.date}|${c.id}`;
  const mark = STATE.attendance[key];
  const url = moodleUrl(c.courseId, c.type);
  const skipped = STATE.skippedClasses.has(c.id);
  UI.sheetClass = { id, date };
  openSheet('class', course.name, `
    <div class="course-card" style="--c:${colorOf(c.courseId)}">
      <span class="when">${esc(weekdayName(c.date || dateFor(c.dayIndex, STATE.weekIdx)))} · ${c.startTime}–${c.endTime}</span>
      <span class="name">${esc(TYPE_SHORT[c.type] || c.typeName)}${c.group ? ` · ${esc(c.group)}` : ''}</span>
      <span class="meta">${statusTags(c)}</span>
    </div>
    <div class="list">
      <a class="row" href="${navLink(c.room)}" target="_blank" rel="noopener"><span class="grow">${esc(shortRoom(c.room))}<span class="sub">${esc(c.campus || '')} · open on NavigaTUM</span></span>${icon('open_in_new', 'chev sm')}</a>
      ${c.lecturer ? `<div class="row"><span class="grow">Lecturer</span><span class="value">${esc(c.lecturer)}</span></div>` : ''}
      ${c.changed && (c.changed.room || c.changed.time) ? `<div class="row"><span class="grow">Timetable PDF said</span><span class="value">${esc(c.pdfTime || '')} ${esc(shortRoom(c.pdfRoom || ''))}</span></div>` : ''}
      ${url ? `<a class="row" href="${url}" target="_blank" rel="noopener"><span class="grow">Open on Moodle</span>${icon('open_in_new', 'chev sm')}</a>` : ''}
    </div>
    ${past && !c.cancelled ? `<div class="section"><div class="section-label">Did you go?</div>
      <span class="seg" role="group" aria-label="Attendance">
        <button type="button" data-attend="${esc(key)}" data-value="went" aria-pressed="${mark === 'went'}">Went</button>
        <button type="button" data-attend="${esc(key)}" data-value="skipped" aria-pressed="${mark === 'skipped'}">Skipped</button>
      </span></div>` : ''}
    <div class="list">
      <button type="button" class="row" data-skip="${esc(c.id)}"><span class="grow" style="color:${skipped ? 'var(--md-primary)' : 'var(--md-error)'}">${skipped ? 'Attend this class again' : 'Skip this class every week'}</span></button>
      ${course.hasGroups && c.group ? `<button type="button" class="row" data-goto-groups><span class="grow" style="color:var(--md-primary)">Change group</span>${icon('chevron_right', 'chev')}</button>` : ''}
    </div>`);
}

// Material You: every colour role is derived from this seed (see style.css)
const SEEDS = [['#3070B3', 'TUM blue'], ['#006A6A', 'Teal'], ['#4C7A34', 'Green'], ['#9A6000', 'Amber'], ['#B4446E', 'Rose'], ['#6750A4', 'Violet']];
const SEED_KEY = 'fd_md_seed';

function currentSeed() {
  try { return localStorage.getItem(SEED_KEY) || SEEDS[0][0]; } catch (e) { return SEEDS[0][0]; }
}

function setSeed(hex) {
  document.documentElement.style.setProperty('--seed', hex);
  try { localStorage.setItem(SEED_KEY, hex); } catch (e) {}
}

function appearanceHtml() {
  const seed = currentSeed().toLowerCase();
  const preset = SEEDS.some(([hex]) => hex.toLowerCase() === seed);
  return `<div class="section-label">Colour</div>
    <div class="list"><div class="swatches" role="group" aria-label="App colour">
      ${SEEDS.map(([hex, name]) => `<button type="button" class="swatch" style="--sw:${hex}" data-seed="${hex}" aria-pressed="${hex.toLowerCase() === seed}" aria-label="${name}" title="${name}"></button>`).join('')}
      <label class="swatch custom" title="Pick your own" ${preset ? '' : `aria-pressed="true" style="--sw:${esc(seed)};background:${esc(seed)}"`}>
        <input type="color" id="seedCustom" value="${esc(seed)}" aria-label="Pick your own colour">
      </label>
    </div></div>
    <p class="section-note">The whole app is tinted from this colour, in light and dark mode.</p>`;
}

// ================= YOUR OWN APPOINTMENTS =================

// A sensible date for a new appointment: the week you're looking at, else today
function defaultApptDate() {
  const today = munichNow().date;
  if (STATE.view === 'week' && STATE.weekIdx !== currentWeekIndex()) return weekStart(STATE.weekIdx);
  return today;
}

function openAppointment(id) {
  const a = STATE.custom.find(x => x.id === id);
  const now = munichNow();
  const startMin = Math.min(Math.ceil((now.minutes + 1) / 60) * 60, 22 * 60);
  const v = a || { title: '', date: defaultApptDate(), start: minutesToTime(startMin), end: minutesToTime(startMin + 60), location: '', notes: '', repeat: 'none' };
  openSheet('appt', a ? 'Edit appointment' : 'New appointment', `
    <form data-appt-form data-id="${esc(a ? a.id : '')}" class="section">
      <div class="form-grid">
        <label class="tf span-2">Title<input class="field" name="title" required maxlength="80" value="${esc(v.title)}" placeholder="e.g. Study group, Dentist"></label>
        <label class="tf span-2">Date<input class="field" type="date" name="date" required value="${esc(v.date)}"></label>
        <label class="tf">Starts<input class="field" type="time" name="start" required value="${esc(v.start)}"></label>
        <label class="tf">Ends<input class="field" type="time" name="end" required value="${esc(v.end)}"></label>
        <label class="tf span-2">Location<input class="field" name="location" maxlength="120" value="${esc(v.location)}" placeholder="Optional"></label>
        <label class="tf span-2">Notes<textarea class="field" name="notes" maxlength="500" placeholder="Optional">${esc(v.notes)}</textarea></label>
        <label class="check-row"><input type="checkbox" name="weekly" ${v.repeat === 'weekly' ? 'checked' : ''}>Repeat every week until the semester ends</label>
      </div>
      <p class="err" id="apptError" hidden></p>
      <p class="section-note">Shown in your day plan and week. Weekends are not in the week view.</p>
      <div class="form-actions">
        ${a ? `<button type="button" class="btn danger" data-appt-delete="${esc(a.id)}">Delete</button>` : ''}
        <div class="right">
          <button type="button" class="btn plain" data-close-sheet>Cancel</button>
          <button type="submit" class="btn">${a ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </form>`);
  $('sheetBody').querySelector('[name="title"]').focus();
}

function saveAppointment(e) {
  e.preventDefault();
  const f = e.target.closest('[data-appt-form]');
  const err = $('apptError');
  const data = {
    title: f.elements.title.value.trim(),
    date: f.elements.date.value,
    start: f.elements.start.value,
    end: f.elements.end.value,
    location: f.elements.location.value.trim(),
    notes: f.elements.notes.value.trim(),
    repeat: f.elements.weekly.checked ? 'weekly' : 'none'
  };
  const problem = !data.title ? 'Give the appointment a title.'
    : !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ? 'Pick a date.'
    : !data.start || !data.end || timeToMinutes(data.end) <= timeToMinutes(data.start) ? 'The end time has to be after the start time.'
    : null;
  if (problem) {
    err.textContent = problem;
    err.hidden = false;
    return;
  }
  const id = f.dataset.id;
  if (id) Object.assign(STATE.custom.find(a => a.id === id), data);
  else STATE.custom.push({ id: `appt-${Date.now().toString(36)}`, ...data });
  saveCustom();
  $('sheet').close();
  toast(id ? 'Appointment saved' : `Added ${data.title} · ${formatDateShort(data.date)} ${data.start}`);
}

function openSettings() {
  openSheet('settings', 'Settings', `
    <section class="section" id="appearanceSection">${appearanceHtml()}</section>
    <section class="section">
      <div class="section-label">Home</div>
      <div class="list">
        <div class="row"><span class="grow">${SETTINGS.home ? esc(SETTINGS.home.name) : 'Not set'}<span class="sub">${SETTINGS.home ? esc(SETTINGS.home.place) : 'Used to plan your trips to campus and back'}</span></span></div>
        <div class="row"><label class="search-field"><span class="msr" aria-hidden="true">search</span><input class="field" id="homeSearch" type="search" placeholder="Search street and number, town" aria-label="Search home address" autocomplete="off"></label></div>
      </div>
      <div class="list results" id="homeResults" role="listbox" hidden></div>
    </section>
    <section class="section">
      <div class="section-label">Travel</div>
      <div class="list">
        ${[['mvg', 'MVG'], ['car', 'Car'], ['bike', 'Bike']].map(([k, label]) => `<div class="row"><span class="grow">${label}</span>
          <button type="button" class="switch" data-mode="${k}" aria-pressed="${!!SETTINGS.modes[k]}" aria-label="${label}"><span class="track" aria-hidden="true"></span></button></div>`).join('')}
        <label class="row"><span class="grow">Be in the room early</span><input class="field num" id="arriveEarly" type="number" min="0" max="30" value="${SETTINGS.arriveEarlyMin}" style="width:72px"> <span class="value">min</span></label>
      </div>
      <p class="section-note">Car and bike need the Worker below (TomTom live traffic).</p>
    </section>
    <section class="section" id="tumSection"></section>
    <section class="section">
      <div class="section-label">Mensa</div>
      <div class="list">
        <label class="row"><span class="grow">Diet</span><select class="field" id="dietSelect" style="width:auto">${[['all', 'Everything'], ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['nopork', 'No pork']].map(([k, l]) => `<option value="${k}" ${SETTINGS.diet === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="row"><span class="grow">Favourites<span class="sub">Comma-separated, e.g. curry, schnitzel</span></span><input class="field" id="favouritesInput" value="${esc(SETTINGS.favourites)}" style="max-width:200px"></label>
      </div>
    </section>
    <section class="section">
      <div class="section-label">Advanced</div>
      <div class="list">
        <label class="row"><span class="grow">Worker URL<span class="sub">Mensa Ottobrunn, car and bike times</span></span><input class="field" id="workerUrlInput" type="url" placeholder="https://…workers.dev" value="${esc(SETTINGS.workerUrl)}" style="max-width:220px"></label>
        <div class="row"><span class="grow">"Leave in 10 min" alerts<span class="sub">${!('Notification' in window) ? 'Not supported in this browser' : Notification.permission === 'granted' && SETTINGS.notify ? 'On while the app is open' : 'Off'}</span></span>
          ${'Notification' in window ? '<button type="button" class="btn gray" data-notify>Turn on</button>' : ''}</div>
        <button type="button" class="row" data-export><span class="grow" style="color:var(--md-primary)">Export classes and appointments (.ics)</span></button>
      </div>
    </section>
    <p class="section-note">Unofficial student tool, not affiliated with TUM. Always check TUMonline.</p>`);
  renderTumSection();
}

function renderTumSection() {
  const el = $('tumSection');
  if (!el) return;
  let body;
  if (TUM.status === 'connected') {
    body = `<div class="list">
      <div class="row"><span class="grow">Connected as ${esc(TUM.tumId)}<span class="sub">${TUM.syncing ? 'Syncing…' : TUM.syncedAt ? `Synced ${timeAgo(TUM.syncedAt)} · ${TUM.events.length} events` : 'Not synced yet'}</span></span>
        <button type="button" class="btn gray" data-tum="sync" ${TUM.syncing ? 'disabled' : ''}>Sync now</button></div>
      <button type="button" class="row" data-tum="disconnect"><span class="grow" style="color:var(--md-error)">Disconnect</span></button>
    </div>`;
  } else if (TUM.status === 'pending') {
    body = `<div class="card"><strong>Activate the token in TUMonline</strong>
      <span class="sub">Open TUMonline › Token-Management and activate <b>TUM Flight Deck</b>. TUMonline also emailed you. This page notices on its own.</span>
      <div><a class="btn" href="https://campus.tum.de/tumonline/" target="_blank" rel="noopener">Open TUMonline</a> <button type="button" class="btn gray" data-tum="disconnect">Cancel</button></div></div>`;
  } else {
    body = `<form class="list" data-tum-form>
      <label class="row"><span class="grow">TUM ID<span class="sub">Your calendar, rooms and groups, live</span></span><input class="field" name="tumId" placeholder="ab12cde" autocomplete="username" style="max-width:140px" value="${esc(TUM.tumId)}"></label>
      <div class="row"><button type="submit" class="btn wide">Request token</button></div>
    </form>`;
  }
  el.innerHTML = `<div class="section-label">TUMonline</div>${body}${TUM.error ? `<p class="err">${esc(TUM.error)}</p>` : ''}`;
}

// ================= WIRING =================

document.addEventListener('click', async e => {
  const t = e.target;
  const view = t.closest('[data-view]');
  if (view) return setView(view.dataset.view);
  if (t.closest('[data-open-settings]')) return openSettings();
  if (t.closest('[data-new-appt]')) return openAppointment(null);
  const del = t.closest('[data-appt-delete]');
  if (del) {
    STATE.custom = STATE.custom.filter(a => a.id !== del.dataset.apptDelete);
    saveCustom();
    $('sheet').close();
    return toast('Appointment deleted');
  }
  if (t.closest('[data-close-sheet]')) return $('sheet').close();
  if (t === $('sheet')) return $('sheet').close(); // backdrop

  const ev = t.closest('[data-class]');
  if (ev) return openClass(ev.dataset.class, ev.dataset.date);

  const course = t.closest('[data-toggle-course]');
  if (course) {
    const id = course.dataset.toggleCourse;
    STATE.courseVisibility[id] = STATE.courseVisibility[id] === false;
    saveState();
    return render();
  }
  const week = t.closest('[data-week]');
  if (week) {
    STATE.weekIdx = week.dataset.week === 'today' ? currentWeekIndex() : clampWeek(STATE.weekIdx + Number(week.dataset.week));
    return render();
  }
  if (t.closest('[data-export]')) return exportICS();

  const leave = t.closest('[data-leave-mode]');
  if (leave) {
    UI.leave.mode = leave.dataset.leaveMode;
    if (UI.leave.mode === 'custom' && !UI.leave.time) {
      UI.leave.time = minutesToTime(Math.min(Math.ceil((munichNow().minutes + 1) / 15) * 15, 23 * 60 + 45)); // next quarter hour
    }
    return render();
  }
  const sort = t.closest('[data-route-sort]');
  if (sort) { SETTINGS.routeSort = sort.dataset.routeSort; saveSettings(); return render(); }
  const diet = t.closest('[data-diet]');
  if (diet) { SETTINGS.diet = diet.dataset.diet; saveSettings(); return render(); }
  const follow = t.closest('[data-follow]');
  if (follow) {
    if (UI.moodleWin && !UI.moodleWin.closed) { UI.moodleWin = null; renderInspector(); } else startMoodleFollow();
    return;
  }

  const obj = t.closest('[data-objective]');
  if (obj) { STATE.autopilot = obj.dataset.objective; saveState(); return render(); }
  const plan = t.closest('[data-plan]');
  if (plan) {
    const p = UI.plans[Number(plan.dataset.plan)];
    Object.entries(p.groups).forEach(([k, g]) => selectGroup(k, g));
    toast('Switched to the Autopilot plan');
    return render();
  }
  const group = t.closest('[data-group]');
  if (group) {
    selectGroup(group.dataset.course, group.dataset.group);
    toast(`${COURSES.find(c => c.id === group.dataset.course).shortName}: ${group.dataset.group}`);
    return render();
  }

  const copy = t.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Link copied'); }
    catch (err) { toast('Copy failed. Select the link and copy it by hand.'); }
    return;
  }
  const remove = t.closest('[data-squad-remove]');
  if (remove) { SETTINGS.squad.splice(Number(remove.dataset.squadRemove), 1); saveSettings(); return render(); }

  const skip = t.closest('[data-skip]');
  if (skip) {
    const id = skip.dataset.skip;
    if (STATE.skippedClasses.has(id)) STATE.skippedClasses.delete(id); else STATE.skippedClasses.add(id);
    saveState();
    render();
    return openClass(UI.sheetClass.id, UI.sheetClass.date);
  }
  const attend = t.closest('[data-attend]');
  if (attend) {
    const { attend: key, value } = attend.dataset;
    if (STATE.attendance[key] === value) delete STATE.attendance[key]; else STATE.attendance[key] = value;
    saveState();
    return openClass(UI.sheetClass.id, UI.sheetClass.date);
  }
  if (t.closest('[data-goto-groups]')) { $('sheet').close(); return setView('groups'); }

  const seed = t.closest('[data-seed]');
  if (seed) {
    setSeed(seed.dataset.seed);
    $('appearanceSection').innerHTML = appearanceHtml();
    return;
  }
  const mode = t.closest('[data-mode]');
  if (mode) {
    SETTINGS.modes[mode.dataset.mode] = !SETTINGS.modes[mode.dataset.mode];
    saveSettings();
    mode.setAttribute('aria-pressed', SETTINGS.modes[mode.dataset.mode]);
    return;
  }
  const home = t.closest('[data-home-index]');
  if (home) {
    SETTINGS.home = UI.homeResults[Number(home.dataset.homeIndex)];
    SETTINGS.leadMinutes = {};
    saveSettings();
    toast(`Home set to ${SETTINGS.home.name}`);
    return openSettings();
  }
  const tum = t.closest('[data-tum]');
  if (tum) return tum.dataset.tum === 'sync' ? tumSync() : tumDisconnect();
  if (t.closest('[data-notify]')) {
    const perm = await Notification.requestPermission();
    SETTINGS.notify = perm === 'granted';
    saveSettings();
    return openSettings();
  }
});

document.addEventListener('submit', async e => {
  if (e.target.closest('[data-appt-form]')) return saveAppointment(e);
  const form = e.target.closest('[data-tum-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Requesting…';
  try {
    await tumConnect(form.tumId.value);
  } catch (err) {
    TUM.error = err.message;
  }
  renderTumSection();
  renderSidebar();
});

let homeTimer = null;
document.addEventListener('input', e => {
  if (e.target.id === 'seedCustom') return setSeed(e.target.value);
  if (e.target.id !== 'homeSearch') return;
  clearTimeout(homeTimer);
  const q = e.target.value.trim();
  const list = $('homeResults');
  if (q.length < 3) { list.hidden = true; return; }
  homeTimer = setTimeout(async () => {
    try {
      UI.homeResults = (await mvgSearch(q)).slice(0, 6);
      list.innerHTML = UI.homeResults.map((r, i) => `<button type="button" class="row" role="option" data-home-index="${i}">
        <span class="grow">${esc(r.name)}<span class="sub">${esc(r.place)}</span></span>${icon('chevron_right', 'chev')}</button>`).join('')
        || '<div class="row muted">No match. Try street and house number, then the town.</div>';
    } catch (err) {
      list.innerHTML = `<div class="row"><span class="err">${esc(err.message)}</span></div>`;
    }
    list.hidden = false;
  }, 300);
});

document.addEventListener('change', e => {
  const id = e.target.id;
  if (id === 'leaveAt') { if (e.target.value) { UI.leave.time = e.target.value; render(); } return; }
  if (id === 'seedCustom') { $('appearanceSection').innerHTML = appearanceHtml(); return; }
  if (id === 'arriveEarly') SETTINGS.arriveEarlyMin = Math.max(0, Math.min(30, Number(e.target.value) || 0));
  else if (id === 'dietSelect') SETTINGS.diet = e.target.value;
  else if (id === 'favouritesInput') SETTINGS.favourites = e.target.value;
  else if (id === 'squadName') { SETTINGS.name = e.target.value.trim().slice(0, 40); saveSettings(); return render(); }
  else if (id === 'workerUrlInput') {
    const v = e.target.value.trim();
    if (v && !/^https:\/\/[^\s/]+(\/.*)?$/.test(v)) return toast('The Worker URL must start with https://');
    SETTINGS.workerUrl = v;
  } else return;
  saveSettings();
});

$('sheet').addEventListener('close', () => {
  UI.sheet = null;
  render();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('sheet').open) return $('sheet').close();
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || $('sheet').open) return;
  const views = { 1: 'today', 2: 'week', 3: 'groups', 4: 'squad' };
  if (views[e.key]) setView(views[e.key]);
  else if (e.key === ',') openSettings();
  else if (STATE.view === 'week' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    STATE.weekIdx = clampWeek(STATE.weekIdx + (e.key === 'ArrowLeft' ? -1 : 1));
    render();
  } else if (e.key === 't' || e.key === 'T') {
    STATE.weekIdx = currentWeekIndex();
    render();
  }
});

// Countdowns and Moodle every 30 s, live transport every minute; only while you're looking
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  UI.tick++;
  if (STATE.view === 'today') {
    if (UI.tick % 2 === 0) UI.commute.at = 0;
    if (!$('sheet').open) renderToday();
    renderInspector();
  } else if (UI.moodleWin) {
    followMoodle(munichNow(), moodleTarget(munichNow(), focusDay()));
  }
}, 30e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && STATE.view === 'today') render();
});

// ================= START =================
loadState();
loadCustom();
loadSettings();
loadTum();
if (TUM.status === 'connected') STATE.detectedGroups = detectGroups(TUM.events);
STATE.weekIdx = currentWeekIndex();
handleJoinLink();
render();
if (TUM.status === 'pending') pollTumToken();
if (TUM.status === 'connected' && (!TUM.syncedAt || Date.now() - TUM.syncedAt > 3600e3)) tumSync({ quiet: true });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
