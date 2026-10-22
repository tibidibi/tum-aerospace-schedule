/**
 * Today: what's next, when to leave and how (MVG vs car vs bike, live), the departure board,
 * the Moodle page of the class you're in (right column), lunch, and the day's timeline.
 */

const TODAY = {
  sort: null,          // route sort, defaults to SETTINGS.routeSort
  leaveBy: {},         // date -> last shown leave-by (ms), to flag when it moves earlier
  notified: {},        // date -> true once the "leave in 10 min" notification fired
  board: {},           // row key -> text last shown, so only changed flaps flip
  moodleWin: null,     // the follow-along window
  moodleUrl: null,
  tick: 0,
  timer: null
};

const LINE_COLORS = { UBAHN: '#0065AE', SBAHN: '#408335', TRAM: '#D82020', BUS: '#00586A', REGIONAL_BUS: '#00586A', BAHN: '#6B6B6B' };

// Your sessions on a date (TUMonline merged in), sorted by time
function sessionsOn(date) {
  const w = weekIndexOf(date);
  if (w < 0 || w >= semesterWeeks()) return [];
  return getWeek(w).items.filter(c => c.date === date).sort((a, b) => a.startMin - b.startMin);
}

const attending = c => !c.cancelled && !STATE.skippedClasses.has(c.id);

// Today while classes remain, otherwise the next day with classes (up to three weeks ahead)
function focusDay(now = munichNow()) {
  for (let i = 0; i < 21; i++) {
    const date = addDays(now.date, i);
    const sessions = sessionsOn(date);
    const live = sessions.filter(attending);
    if (!live.length || (i === 0 && live[live.length - 1].endMin <= now.minutes)) continue;
    return { date, isToday: i === 0, sessions, live };
  }
  return null;
}

function fmtDuration(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

const hhmm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

function courseOf(c) {
  return COURSES.find(x => x.id === c.courseId) || { shortName: c.course, name: c.course, color: 'var(--text-tertiary)' };
}

// Status tags shared by strips everywhere: TUMonline confirmed, PDF only, changed, cancelled, exam
function statusTags(c) {
  const tags = [];
  if (c.cancelled) tags.push('<span class="tag tag-red">Cancelled</span>');
  if (c.isExam) tags.push('<span class="tag tag-amber">Exam</span>');
  if (c.changed && c.changed.room) tags.push('<span class="tag tag-amber">Room changed</span>');
  if (c.changed && c.changed.time) tags.push('<span class="tag tag-amber">Time changed</span>');
  if (c.pdfOnly) tags.push('<span class="tag tag-pdf" title="Not in your TUMonline calendar">PDF only</span>');
  else if (c.source === 'tum' && !c.cancelled) tags.push('<span class="tag tag-ok" title="Confirmed by your TUMonline calendar">TUMonline</span>');
  return tags.join('');
}

function stripHtml(c, { big = false } = {}) {
  const course = courseOf(c);
  return `
    <button type="button" class="strip ${big ? 'strip-big' : ''} ${c.pdfOnly ? 'is-pdf' : ''} ${c.cancelled ? 'is-cancelled' : ''}"
      style="--band: var(--c-${c.courseId}-border, ${course.color})" data-open-class="${c.id}">
      <span class="strip-time">${c.startTime}<span>${c.endTime}</span></span>
      <span class="strip-body">
        <span class="strip-title">${escapeHtml(c.course)}</span>
        <span class="strip-meta">${escapeHtml(c.typeName)}${c.group ? ` · ${escapeHtml(c.group)}` : ''}</span>
        <span class="strip-meta strip-room"><span class="material-symbols-outlined icon-xs" aria-hidden="true">location_on</span>${escapeHtml(c.room.split('(')[0].trim())}</span>
        <span class="strip-tags">${statusTags(c)}</span>
      </span>
    </button>`;
}

// ================= RENDER =================

function renderToday() {
  const root = document.getElementById('todayContainer');
  if (!root) return;
  const now = munichNow();
  const focus = focusDay(now);
  renderTodayHead(now, focus);
  renderTodayAlerts(focus);
  renderTodayNext(now, focus);
  renderTimeline(now, focus);
  renderMoodle(now, focus);
  if (!focus) {
    ['todayLeave', 'todayBoard', 'todayLunch'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
    return;
  }
  renderCommute(now, focus);
  renderLunch(focus);
}

function renderTodayHead(now, focus) {
  const el = document.getElementById('todayHead');
  if (!el) return;
  const total = daysBetween(SEMESTER.start, SEMESTER.end) + 1;
  const done = Math.max(0, Math.min(total, daysBetween(SEMESTER.start, now.date) + 1));
  const week = weekIndexOf(now.date);
  const inSemester = week >= 0 && week < semesterWeeks();
  const nextExam = TUM.events.filter(e => e.isExam && !e.cancelled && e.date >= now.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  el.innerHTML = `
    <div class="today-date">
      <h1>${formatDateLong(now.date)}</h1>
      <span class="today-week">${inSemester ? `Week ${week + 1} of ${semesterWeeks()}` : 'Lecture-free'}${closureFor(now.date) && inSemester ? ` · ${closureFor(now.date)}` : ''}</span>
    </div>
    <div class="semester-progress" role="img" aria-label="Lecture period ${Math.round(done / total * 100)}% done">
      <div class="semester-progress-bar"><span style="width:${done / total * 100}%"></span></div>
      <span>${Math.max(0, total - done)} days of lectures left${nextExam ? ` · <strong>${escapeHtml(nextExam.title)}</strong> in ${daysBetween(now.date, nextExam.date)} d` : ''}</span>
    </div>
    ${focus && !focus.isToday ? `<p class="today-focus-note">No more classes today. Showing <strong>${formatDateLong(focus.date)}</strong>.</p>` : ''}`;
}

function renderTodayAlerts(focus) {
  const el = document.getElementById('todayAlerts');
  if (!el) return;
  const items = [];
  if (focus) {
    for (const c of focus.sessions) {
      const name = escapeHtml(courseOf(c).shortName);
      if (c.cancelled) items.push(`<li class="alert-red"><strong>${name} ${c.startTime}</strong> is cancelled in TUMonline.</li>`);
      else if (c.changed?.room) items.push(`<li><strong>${name} ${c.startTime}</strong> moved to ${escapeHtml(c.room)} (PDF: ${escapeHtml(c.pdfRoom.split('(')[0].trim())}).</li>`);
      else if (c.changed?.time) items.push(`<li><strong>${name}</strong> is at ${c.startTime}–${c.endTime} (PDF: ${c.pdfTime}).</li>`);
      else if (c.extra && c.isExam) items.push(`<li class="alert-amber"><strong>Exam:</strong> ${escapeHtml(c.tumTitle)} at ${c.startTime}, ${escapeHtml(c.room)}.</li>`);
      else if (c.extra) items.push(`<li>Extra in TUMonline: <strong>${escapeHtml(c.tumTitle)}</strong> at ${c.startTime}.</li>`);
    }
    const closure = getWeek(weekIndexOf(focus.date)).closures.find(x => x.date === focus.date);
    if (closure) items.push(`<li class="alert-amber"><strong>${escapeHtml(closure.label)}:</strong> classes during it are left out.</li>`);
  }
  el.hidden = !items.length;
  el.innerHTML = items.length ? `<ul class="alert-list">${items.join('')}</ul>` : '';
}

function renderTodayNext(now, focus) {
  const el = document.getElementById('todayNext');
  if (!el) return;
  if (!focus) {
    el.innerHTML = `<div class="empty-state"><span class="material-symbols-outlined" aria-hidden="true">beach_access</span>
      <p><strong>No classes coming up.</strong> The lecture period ends ${formatDateLong(SEMESTER.end)}.</p></div>`;
    return;
  }
  const current = focus.isToday ? focus.live.find(c => c.startMin <= now.minutes && c.endMin > now.minutes) : null;
  const next = focus.live.find(c => !focus.isToday || c.startMin > now.minutes);
  const label = c => focus.isToday
    ? `in <span class="countdown">${fmtDuration(c.startMin - now.minutes)}</span>`
    : `${formatDateLong(focus.date)}`;
  el.innerHTML = `
    ${current ? `<div class="next-block">
      <div class="eyebrow">Now · ends in <span class="countdown">${fmtDuration(current.endMin - now.minutes)}</span></div>
      ${stripHtml(current, { big: true })}
      <div class="room-detail" data-room-for="${current.id}"></div>
    </div>` : ''}
    ${next ? `<div class="next-block">
      <div class="eyebrow">${current ? 'After that' : 'Next'} · ${label(next)}</div>
      ${stripHtml(next, { big: !current })}
      <div class="room-detail" data-room-for="${next.id}"></div>
      ${current ? walkWarning(current, next) : ''}
    </div>` : ''}
    ${(current || next).pdfOnly ? `<p class="pdf-note"><span class="material-symbols-outlined icon-sm" aria-hidden="true">info</span>
      Not in your TUMonline calendar. Shown from the official timetable PDF (status ${SEMESTER.pdfStatus}); check TUMonline.</p>` : ''}`;
  for (const c of [current, next].filter(Boolean)) fillRoomDetail(c);
}

function walkWarning(a, b) {
  return `<div class="walk-warning" data-walk="${a.id}|${b.id}" hidden></div>`;
}

// Building, floor and map link from NavigaTUM; walking time between consecutive rooms
async function fillRoomDetail(c) {
  try {
    const info = await roomInfo(c.room);
    const el = document.querySelector(`[data-room-for="${c.id}"]`);
    if (el && info) el.innerHTML = `
      <a href="${info.link}" target="_blank" rel="noopener" class="room-link">
        <span class="material-symbols-outlined icon-sm" aria-hidden="true">map</span>
        <span>${escapeHtml(info.building)}${info.floor ? ` · ${escapeHtml(info.floor)}` : ''}</span>
        <span class="material-symbols-outlined icon-xs" aria-hidden="true">open_in_new</span>
      </a>`;
    const warn = document.querySelector(`[data-walk$="|${c.id}"]`);
    if (warn) {
      const prevId = warn.dataset.walk.split('|')[0];
      const prev = getDraftClasses().find(x => x.id === prevId) || CLASSES.find(x => x.id === prevId);
      const a = prev && await roomInfo(prev.room);
      if (a && info && a.lat && info.lat) {
        const walk = walkMinutes(a, info);
        const gap = c.startMin - prev.endMin;
        if (walk > 2) {
          warn.hidden = false;
          warn.className = `walk-warning ${walk > gap ? 'tight' : ''}`;
          warn.textContent = walk > gap
            ? `About ${walk} min walk from ${a.building} with only ${gap} min between classes.`
            : `About ${walk} min walk from ${a.building}.`;
        }
      }
    }
  } catch (e) { /* offline: the room name is enough */ }
}

function renderTimeline(now, focus) {
  const el = document.getElementById('todayTimeline');
  if (!el) return;
  if (!focus) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <h2 class="card-heading">${focus.isToday ? 'Today' : formatDateLong(focus.date).split(' ')[0]}'s classes</h2>
    <ol class="timeline">${focus.sessions.map(c => {
      const past = focus.isToday && c.endMin <= now.minutes;
      const key = `${focus.date}|${c.id}`;
      const mark = STATE.attendance[key];
      return `<li class="${past ? 'is-past' : ''} ${STATE.skippedClasses.has(c.id) ? 'is-skipped' : ''}">
        ${stripHtml(c)}
        ${past && !c.cancelled ? `<span class="attend" role="group" aria-label="Did you go?">
          <button type="button" class="${mark === 'went' ? 'on' : ''}" data-attend="${key}" data-value="went">Went</button>
          <button type="button" class="${mark === 'skipped' ? 'on' : ''}" data-attend="${key}" data-value="skipped">Skipped</button>
        </span>` : ''}
      </li>`;
    }).join('')}</ol>`;
}

// ================= MOODLE (right column) =================

// The class whose Moodle you want: the one running, else the next one today
function moodleTarget(now, focus) {
  if (!focus) return null;
  const withMoodle = focus.live.filter(c => moodleUrl(c.courseId, c.type));
  if (!focus.isToday) return { cls: withMoodle[0], when: 'next' };
  const current = withMoodle.find(c => c.startMin <= now.minutes && c.endMin > now.minutes);
  if (current) return { cls: current, when: 'now' };
  const next = withMoodle.find(c => c.startMin > now.minutes);
  return next ? { cls: next, when: 'next' } : null;
}

function renderMoodle(now, focus) {
  const el = document.getElementById('todayMoodle');
  if (!el) return;
  const target = moodleTarget(now, focus);
  followMoodle(now, target);
  if (!target || !target.cls) {
    el.innerHTML = `<h2 class="card-heading">Moodle</h2><p class="field-note">No class with a Moodle page coming up.</p>`;
    return;
  }
  const c = target.cls;
  const course = courseOf(c);
  const url = moodleUrl(c.courseId, c.type);
  const other = [course.moodle, course.moodleExercise].filter(u => u && u !== url);
  const following = TODAY.moodleWin && !TODAY.moodleWin.closed;
  el.style.setProperty('--band', `var(--c-${c.courseId}-border, ${course.color})`);
  el.innerHTML = `
    <div class="eyebrow">${target.when === 'now' ? 'In class now' : `Next · ${c.startTime}`}</div>
    <h2 class="moodle-title">${escapeHtml(course.name)}</h2>
    <p class="moodle-sub">${escapeHtml(c.typeName)}${c.group ? ` · ${escapeHtml(c.group)}` : ''}</p>
    <a class="btn btn-primary moodle-open" href="${url}" target="_blank" rel="noopener">
      <span class="material-symbols-outlined icon-sm" aria-hidden="true">school</span> Open ${c.type === 'L' || c.type === 'VI' ? 'course' : 'exercise'} on Moodle
    </a>
    ${other.map(u => `<a class="moodle-alt" href="${u}" target="_blank" rel="noopener">${u === course.moodleExercise ? 'Exercise course page' : 'Lecture course page'} ↗</a>`).join('')}
    <div class="moodle-follow ${following ? 'on' : ''}">
      ${following ? `
        <p><span class="live-dot" aria-hidden="true"></span><strong>Following along.</strong> The Moodle window switches to each class's course when it starts.</p>
        <button type="button" class="btn btn-outline btn-sm" data-moodle="stop">Stop following</button>` : `
        <p>Open Moodle in a window on the right half of your screen. It moves to the right course by itself as your day goes on.</p>
        <button type="button" class="btn btn-outline btn-sm" data-moodle="follow">
          <span class="material-symbols-outlined icon-sm" aria-hidden="true">splitscreen_right</span> Follow along
        </button>`}
    </div>`;
}

// Moodle forbids iframes (X-Frame-Options: SAMEORIGIN), so we steer a window we opened instead:
// pages may navigate a window they opened, even cross-origin and without a click.
function startMoodleFollow() {
  const focus = focusDay();
  const target = moodleTarget(munichNow(), focus);
  const url = (target && target.cls && moodleUrl(target.cls.courseId, target.cls.type)) || 'https://www.moodle.tum.de/my/';
  const w = Math.round(screen.availWidth / 2);
  const left = (screen.availLeft || 0) + screen.availWidth - w;
  // No noopener: we need the handle to switch courses later (moodle.tum.de is trusted)
  TODAY.moodleWin = window.open(url, 'tum-moodle', `popup,width=${w},height=${screen.availHeight},left=${left},top=${screen.availTop || 0}`);
  TODAY.moodleUrl = url;
  if (!TODAY.moodleWin) showToast('Your browser blocked the window. Allow pop-ups for this site, then try again.');
  renderToday();
}

function followMoodle(now, target) {
  const win = TODAY.moodleWin;
  if (!win || win.closed || !target || !target.cls) return;
  // Switch when a class starts, or 10 min before the next one
  if (target.when !== 'now' && (target.cls.date !== now.date || target.cls.startMin - now.minutes > 10)) return;
  const url = moodleUrl(target.cls.courseId, target.cls.type);
  if (url && url !== TODAY.moodleUrl) {
    try { win.location.href = url; TODAY.moodleUrl = url; } catch (e) { TODAY.moodleWin = null; }
  }
}

// ================= COMMUTE =================

async function renderCommute(now, focus) {
  const el = document.getElementById('todayLeave');
  const board = document.getElementById('todayBoard');
  if (!el) return;
  el.hidden = false;
  if (!SETTINGS.home) {
    board.hidden = true;
    el.innerHTML = `
      <h2 class="card-heading">Commute</h2>
      <p>Type in your address once and the app works out when to leave and the best way in: MVG, car or bike, with live delays.</p>
      <button class="btn btn-primary" type="button" data-open-settings="set-commute">Set home address</button>`;
    return;
  }
  const first = focus.live[0];
  const last = focus.live[focus.live.length - 1];
  const toCampus = !focus.isToday || now.minutes < first.startMin;
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
  const when = toCampus ? munichDate(focus.date, first.startMin - SETTINGS.arriveEarlyMin) : munichDate(focus.date, last.endMin);
  const sort = TODAY.sort || SETTINGS.routeSort;

  const [mvg, car, bike] = await Promise.all([
    SETTINGS.modes.mvg ? mvgRoutes(from, to, when, { arrive: toCampus, cacheKey: `routes:${toCampus}` }).then(r => rankRoutes(r, sort, toCampus ? when : null)).catch(e => ({ error: e.message })) : null,
    SETTINGS.modes.car && workerUrl() ? roadRoute(workerUrl(), 'car', from, to, when).catch(e => ({ error: e.message })) : null,
    SETTINGS.modes.bike && workerUrl() ? roadRoute(workerUrl(), 'bicycle', from, to, when).catch(e => ({ error: e.message })) : null
  ]);
  const mvgList = Array.isArray(mvg) ? mvg : [];
  const bestMvg = rankRoutes(mvgList, 'latest', toCampus ? when : null).find(r => !r.unusable) || null;
  const ok = x => (x && !x.error ? x : null);
  const modes = toCampus
    ? compareModes({ mvg: bestMvg, car: ok(car), bike: ok(bike) }, { arriveBy: when, carBufferMin: campus.carBufferMin, bikeBufferMin: campus.bikeBufferMin })
    : [];
  const pick = modes.find(m => m.fastest);

  // Leave-by moved earlier since last time? Flash it and say why
  let movedNote = '';
  if (pick) {
    const prev = TODAY.leaveBy[focus.date];
    if (prev && pick.leaveBy.getTime() < prev - 90e3) {
      const delayed = bestMvg ? bestMvg.legs.filter(l => !l.walk && l.delayMin > 0).map(l => `${l.label} +${l.delayMin} min`).join(', ') : '';
      movedNote = `${delayed ? `${delayed}: ` : ''}leave ${Math.round((prev - pick.leaveBy) / 60e3)} min earlier`;
    }
    TODAY.leaveBy[focus.date] = pick.leaveBy.getTime();
    // Remember the usual lead time per weekday for the calendar feed's "leave now" alarms
    const lead = first.startMin - (munichNow(pick.leaveBy).minutes);
    if (lead > 0 && lead < 300) {
      SETTINGS.leadMinutes[first.dayIndex] = lead;
      saveSettings();
    }
    maybeNotify(focus, first, pick, bestMvg);
  }

  const modeName = { mvg: 'MVG', car: 'Car', bike: 'Bike' };
  const modeIcon = { mvg: 'directions_transit', car: 'directions_car', bike: 'directions_bike' };
  const modeCards = modes.length > 1 ? `<div class="mode-compare">${modes.map(m => `
      <div class="mode ${m.fastest ? 'fastest' : ''}">
        <span class="material-symbols-outlined" aria-hidden="true">${modeIcon[m.mode]}</span>
        <span class="mode-name">${modeName[m.mode]}${m.fastest ? ' <em>Fastest now</em>' : ''}</span>
        <span class="mode-time">${fmtDuration(m.minutes)}</span>
        <span class="mode-leave">leave ${hhmm(m.leaveBy)}${m.delayMin > 0 ? ` · <span class="late">+${m.delayMin} min ${m.mode === 'car' ? 'traffic' : 'delay'}</span>` : ''}</span>
      </div>`).join('')}</div>` : '';
  const roadNotes = [car, bike].filter(x => x && x.error).map(x => `<p class="field-note">${escapeHtml(x.error)}</p>`).join('')
    + ((SETTINGS.modes.car || SETTINGS.modes.bike) && !workerUrl() ? '<p class="field-note">Add a Worker URL with a TomTom key in settings to compare car and bike.</p>' : '');

  el.innerHTML = `
    <div class="leave-head ${movedNote ? 'moved' : ''}">
      <div>
        <div class="eyebrow">${toCampus ? `To ${escapeHtml(place.building || campus.name)} for ${first.startTime}` : `Home after ${last.endTime}`}</div>
        ${pick ? `<div class="leave-by"><span>Leave by</span> ${flapHtml(hhmm(pick.leaveBy), 'leave')}</div>
          <div class="leave-sub">${modeName[pick.mode]} · ${fmtDuration(pick.minutes)}${focus.isToday ? ` · in ${fmtDuration((pick.leaveBy - Date.now()) / 60e3)}` : ''}</div>`
          : toCampus ? '<div class="leave-by"><span>No connection found</span></div>' : ''}
        ${movedNote ? `<p class="moved-note"><span class="material-symbols-outlined icon-sm" aria-hidden="true">warning</span>${escapeHtml(movedNote)}</p>` : ''}
      </div>
      <span class="weather" id="leaveWeather"></span>
    </div>
    ${modeCards}
    ${SETTINGS.modes.mvg ? `
      <div class="route-head">
        <h3>${toCampus ? 'Connections' : 'Trips home'}</h3>
        <div class="segmented" role="group" aria-label="Sort connections">
          ${[['latest', 'Latest'], ['changes', 'Fewest changes'], ['walking', 'Least walking']].map(([k, label]) =>
            `<button type="button" data-route-sort="${k}" class="${sort === k ? 'on' : ''}" aria-pressed="${sort === k}">${label}</button>`).join('')}
        </div>
      </div>
      ${mvg && mvg.error ? `<p class="tum-error">MVG: ${escapeHtml(mvg.error)}</p>` : ''}
      <ol class="routes">${mvgList.slice(0, 4).map(routeHtml).join('') || '<li class="field-note">No connections found.</li>'}</ol>
      <div id="disruptions"></div>` : ''}
    ${roadNotes}`;

  renderBoard(bestMvg || mvgList[0], toCampus && focus.isToday);
  renderDisruptions(mvgList.slice(0, 4));
  renderWeather(from, focus.date, pick ? munichNow(pick.leaveBy).minutes : (toCampus ? first.startMin : last.endMin), modes);
}

function routeHtml(r) {
  return `<li class="route ${r.unusable ? 'unusable' : ''}">
    <span class="route-times"><strong>${hhmm(r.depart)}</strong> → ${hhmm(r.arrive)}</span>
    <span class="route-legs">${r.legs.map(l => l.walk
      ? `<span class="leg walk" title="Walk ${l.minutes} min"><span class="material-symbols-outlined icon-xs" aria-hidden="true">directions_walk</span>${l.minutes}</span>`
      : `<span class="leg line ${l.cancelled ? 'cancelled' : ''}" style="--line:${LINE_COLORS[l.type] || '#555'}" title="${escapeHtml(`${l.label} → ${l.destination}, from ${l.from}${l.platform != null ? ` (platform ${l.platform})` : ''}`)}">${escapeHtml(l.label)}${l.delayMin > 0 ? `<sup>+${l.delayMin}</sup>` : ''}</span>`
    ).join('<span class="leg-sep" aria-hidden="true">›</span>')}</span>
    <span class="route-info">${fmtDuration(r.minutes)} · ${r.changes} change${r.changes === 1 ? '' : 's'} · ${r.walkMin} min walk
      ${r.cancelled ? '<span class="tag tag-red">Cancelled</span>' : r.late ? '<span class="tag tag-amber">Too late</span>' : ''}</span>
  </li>`;
}

async function renderDisruptions(routes) {
  const el = document.getElementById('disruptions');
  if (!el) return;
  const lines = new Set(routes.flatMap(r => r.lines));
  if (!lines.size) return;
  try {
    const incidents = (await mvgIncidents()).filter(m => (m.lines || []).some(l => lines.has(l.label)));
    el.innerHTML = incidents.length ? `<ul class="alert-list">${incidents.slice(0, 3).map(m =>
      `<li class="alert-amber"><strong>${escapeHtml([...new Set(m.lines.filter(l => lines.has(l.label)).map(l => l.label))].join(', '))}:</strong> ${escapeHtml(m.title)}</li>`).join('')}</ul>` : '';
  } catch (e) {}
}

async function renderWeather(place, date, minutes, modes) {
  const el = document.getElementById('leaveWeather');
  if (!el) return;
  try {
    const h = hourForecast(await weatherAt(place.lat, place.lon), date, minutes);
    if (!h) return;
    const wet = h.rainChance >= 50;
    el.className = `weather ${wet ? 'wet' : ''}`;
    el.innerHTML = `<span class="material-symbols-outlined icon-sm" aria-hidden="true">${wet ? 'rainy' : h.tempC < 3 ? 'ac_unit' : 'partly_cloudy_day'}</span>
      ${Math.round(h.tempC)}° · ${h.rainChance}% rain${wet && modes.some(m => m.mode === 'bike') ? '<small>Bad day for the bike</small>' : wet ? '<small>Take an umbrella</small>' : ''}`;
  } catch (e) {}
}

// "Leave in 10 min", once per day, while the app is open
function maybeNotify(focus, first, pick, route) {
  if (!SETTINGS.notify || !focus.isToday || TODAY.notified[focus.date] || !('Notification' in window) || Notification.permission !== 'granted') return;
  const minsLeft = (pick.leaveBy - Date.now()) / 60e3;
  if (minsLeft > 10 || minsLeft < 0) return;
  TODAY.notified[focus.date] = true;
  const via = pick.mode === 'mvg' && route && route.firstStop ? ` · ${route.firstStop.line} from ${route.firstStop.name}` : '';
  const body = `${courseOf(first).shortName} at ${first.startTime}. Leave at ${hhmm(pick.leaveBy)}${via}.`;
  navigator.serviceWorker?.getRegistration().then(reg => reg
    ? reg.showNotification(`Leave in ${Math.max(1, Math.round(minsLeft))} min`, { body, tag: 'leave', icon: 'icon.svg' })
    : new Notification(`Leave in ${Math.max(1, Math.round(minsLeft))} min`, { body })).catch(() => {});
}

// ================= DEPARTURE BOARD (split-flap) =================

function flapHtml(text, key, width = text.length) {
  const prev = TODAY.board[key] || '';
  TODAY.board[key] = text;
  const chars = text.padEnd(width).slice(0, width).split('');
  return `<span class="flap" aria-label="${escapeHtml(text)}">${chars.map((ch, i) =>
    `<span class="flap-c ${prev && prev[i] !== ch ? 'flip' : ''}" style="--i:${i}" aria-hidden="true">${ch === ' ' ? '&nbsp;' : escapeHtml(ch)}</span>`).join('')}</span>`;
}

async function renderBoard(route, live) {
  const el = document.getElementById('todayBoard');
  if (!el) return;
  const stop = route && route.firstStop;
  if (!stop || !stop.id || !live) { el.hidden = true; return; }
  el.hidden = false;
  try {
    const deps = (await mvgDepartures(stop.id, 8)).filter(d => d.time > Date.now() - 60e3).slice(0, 6);
    el.innerHTML = `
      <div class="board-head"><h2>Departures</h2><span>${escapeHtml(stop.name)}</span></div>
      <table class="board">
        <thead><tr><th>Time</th><th>Line</th><th>Destination</th><th>Pl.</th></tr></thead>
        <tbody>${deps.map((d, i) => `<tr class="${d.line === stop.line ? 'yours' : ''} ${d.cancelled ? 'cancelled' : ''}">
          <td>${flapHtml(hhmm(d.time), `t${i}`, 5)}${d.delayMin > 0 ? `<span class="late">+${d.delayMin}</span>` : ''}</td>
          <td><span class="leg line" style="--line:${LINE_COLORS[d.type] || '#555'}">${escapeHtml(d.line)}</span></td>
          <td>${flapHtml(d.cancelled ? 'Cancelled' : d.destination.slice(0, 22), `d${i}`, 22)}</td>
          <td>${d.platform ?? ''}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="board-foot">${deps.some(d => d.realtime) ? '<span class="live-dot" aria-hidden="true"></span>Live' : 'Timetable'} · your line highlighted</p>`;
  } catch (e) {
    el.hidden = true;
  }
}

// ================= LUNCH =================

async function renderLunch(focus) {
  const el = document.getElementById('todayLunch');
  if (!el) return;
  el.hidden = false;
  const campusName = (focus.live.find(c => c.campus) || {}).campus || 'Ottobrunn';
  const campus = CAMPUSES[campusName];
  const window_ = lunchWindow(focus.live);
  const favs = SETTINGS.favourites.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const diet = DIETS[SETTINGS.diet] || DIETS.all;
  el.innerHTML = `
    <h2 class="card-heading">Lunch · ${escapeHtml(campusName)}</h2>
    <p class="lunch-window ${window_ ? '' : 'none'}">${window_
      ? `<span class="material-symbols-outlined icon-sm" aria-hidden="true">restaurant</span> Free ${minutesToTime(window_.from)}–${minutesToTime(window_.to)}`
      : '<span class="material-symbols-outlined icon-sm" aria-hidden="true">no_meals</span> No break while the Mensa is open (11:00–14:00). Pack a snack.'}</p>
    <div id="lunchMenus"><p class="field-note">Loading menus…</p></div>`;

  let prices = {};
  try { prices = priceTable(await canteenWeek(CAMPUSES.Garching.canteens[0], focus.date)); } catch (e) {}
  const blocks = await Promise.all(campus.canteens.map(async (canteen, i) => {
    let days;
    try { days = await canteenWeek(canteen, focus.date, workerUrl()); } catch (e) {
      return `<p class="field-note canteen">${escapeHtml(canteen.name)}: ${/404/.test(e.message) ? 'no menu published for this week yet' : `menu unavailable (${escapeHtml(e.message)})`}.</p>`;
    }
    if (!days) return `<p class="field-note">${escapeHtml(canteen.name)}: <a href="${canteen.page}" target="_blank" rel="noopener">see today's menu</a>. Add a Worker URL in settings to show it here.</p>`;
    const today = (days.find(d => d.date === focus.date) || { dishes: [] }).dishes.filter(diet);
    const isFav = d => favs.some(f => d.name.toLowerCase().includes(f));
    const upcoming = favs.length ? days.filter(d => d.date > focus.date).flatMap(d => d.dishes.filter(isFav).map(x => ({ ...x, date: d.date }))).slice(0, 3) : [];
    return `<details class="canteen" ${i === 0 ? 'open' : ''}>
      <summary>${escapeHtml(canteen.name)} <span>${today.length} dishes</span></summary>
      <ul class="dishes">${today.map(d => `<li class="${isFav(d) ? 'fav' : ''}">
        <span class="dish-name">${isFav(d) ? '★ ' : ''}${escapeHtml(d.name)}</span>
        <span class="dish-meta">${escapeHtml(d.dish_type || '')}${d.labels.includes('VEGAN') ? ' · <span class="diet">Vegan</span>' : d.labels.includes('VEGETARIAN') ? ' · <span class="diet">Veggie</span>' : ''}
          <span class="price">${formatPrice(d.prices || prices[d.dish_type])}</span></span>
      </li>`).join('') || '<li class="field-note">Nothing on the menu for your diet filter.</li>'}</ul>
      ${upcoming.length ? `<p class="fav-upcoming">${upcoming.map(d => `★ ${escapeHtml(d.name.split('(')[0].trim())} · ${formatDateShort(d.date)}`).join('<br>')}</p>` : ''}
    </details>`;
  }));
  const menus = document.getElementById('lunchMenus');
  if (menus) menus.innerHTML = blocks.join('');
}

// ================= WIRING & LIVE REFRESH =================

function wireToday() {
  const root = document.getElementById('todayContainer');
  if (!root) return;
  root.addEventListener('click', e => {
    const open = e.target.closest('[data-open-class]');
    if (open) return openEventModal(open.dataset.openClass);
    const sort = e.target.closest('[data-route-sort]');
    if (sort) {
      TODAY.sort = SETTINGS.routeSort = sort.dataset.routeSort;
      saveSettings();
      return renderToday();
    }
    const attend = e.target.closest('[data-attend]');
    if (attend) {
      const { attend: key, value } = attend.dataset;
      if (STATE.attendance[key] === value) delete STATE.attendance[key];
      else STATE.attendance[key] = value;
      persistState();
      renderStats();
      return renderToday();
    }
    const moodle = e.target.closest('[data-moodle]');
    if (moodle && moodle.dataset.moodle === 'follow') startMoodleFollow();
    if (moodle && moodle.dataset.moodle === 'stop') {
      TODAY.moodleWin = null;
      renderToday();
    }
  });

  // Countdowns and Moodle every 30 s; live transport every minute; only while you're looking
  clearInterval(TODAY.timer);
  TODAY.timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    TODAY.tick++;
    if (STATE.currentView === 'today') {
      const now = munichNow();
      const focus = focusDay(now);
      renderTodayNext(now, focus);
      renderMoodle(now, focus);
      if (TODAY.tick % 2 === 0 && focus) renderCommute(now, focus);
    } else if (TODAY.moodleWin) {
      followMoodle(munichNow(), moodleTarget(munichNow(), focusDay()));
    }
  }, 30e3);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && STATE.currentView === 'today') renderToday();
  });
}
