/**
 * TUM Aerospace Draft Schedule Calendar - Application Logic
 * Implements interactive calendar, group selection, class skipping,
 * conflict detection, and live time calculations.
 */

// Global State
const STATE = {
  selectedGroups: {
    math: 'Group 1',
    mech: 'Room OTN 1',
    cf: 'Group 2',
    cad: 'Group 3 & 4'
  },
  courseVisibility: {
    math: true,
    mech: true,
    cf: true,
    ee: true,
    cad: true,
    aero_mat: true,
    intro_aero: true
  },
  skippedClasses: new Set(),
  showGhostGroups: true,
  currentView: 'today', // 'today' | 'week' | 'matrix' | 'agenda'
  weekIdx: 0, // semester week shown in week/agenda views (0 = week of 12 Oct)
  detectedGroups: {}, // groups TUMonline has you in
  manualGroups: new Set(), // courses whose group you picked yourself (TUMonline won't override)
  attendance: {}, // 'YYYY-MM-DD|classId' -> 'went' | 'skipped'
  autopilot: 'latestStart',
  activeModalClassId: null,
  agendaMode: 'columns', // 'columns' | 'list'
  selectedAgendaDay: 'all', // 'all' | 0 | 1 | 2 | 3 | 4
  // Day shown in the single-day mobile week view: today if it's a weekday, else Monday
  mobileDay: (() => { const d = new Date().getDay(); return d >= 1 && d <= 5 ? d - 1 : 0; })(),
  matrixOpen: null // Set of expanded course ids in the matrix; null = default (all open on desktop, none on mobile)
};

// Keep in sync with the CSS breakpoints: phone = single-day week, drawer = sidebar overlays content
const MOBILE_QUERY = window.matchMedia('(max-width: 700px)');
const DRAWER_QUERY = window.matchMedia('(max-width: 1100px)');
const COMPACT_QUERY = window.matchMedia('(max-width: 900px)'); // bottom tab bar, list-only agenda
const isMobile = () => MOBILE_QUERY.matches;

// While printing, the week grid uses a fixed hour height sized for one A4 landscape page and hides alternatives
let isPrinting = false;
const PRINT_HOUR_HEIGHT = 46;

// "Groups 2, 3" / "Rooms OTN 2, OTN 9" / "Group 1 & 2"
function groupsLabel(groups) {
  const parts = groups.map(g => g.match(/^(Group|Room) (.+)$/));
  if (parts.every(Boolean) && parts.every(p => p[1] === parts[0][1])) {
    return `${parts[0][1]}${groups.length > 1 ? 's' : ''} ${parts.map(p => p[2]).join(', ')}`;
  }
  return groups.join(', ');
}

function selectGroup(courseId, groupName, { manual = true } = {}) {
  const course = COURSES.find(c => c.id === courseId);
  STATE.selectedGroups[courseId] = groupName;
  if (manual) STATE.manualGroups.add(courseId);
  persistState();
  updateAll();
  showToast(`Switched ${course ? course.shortName : courseId} to ${groupName}`);
}

// Storage Key
const STORAGE_KEY = 'tum_aerospace_calendar_wise26_27';

// Load persisted state
function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.selectedGroups) STATE.selectedGroups = { ...STATE.selectedGroups, ...parsed.selectedGroups };
    if (parsed.courseVisibility) STATE.courseVisibility = { ...STATE.courseVisibility, ...parsed.courseVisibility };
    if (Array.isArray(parsed.skippedClasses)) STATE.skippedClasses = new Set(parsed.skippedClasses);
    if (typeof parsed.showGhostGroups === 'boolean') STATE.showGhostGroups = parsed.showGhostGroups;
    if (parsed.agendaMode === 'columns' || parsed.agendaMode === 'list') {
      STATE.agendaMode = parsed.agendaMode;
    }
    if (Array.isArray(parsed.manualGroups)) STATE.manualGroups = new Set(parsed.manualGroups);
    if (parsed.attendance && typeof parsed.attendance === 'object') STATE.attendance = parsed.attendance;
    if (parsed.autopilot in OBJECTIVES) STATE.autopilot = parsed.autopilot;
  } catch (e) {
    console.warn('Failed to load persisted state:', e);
  }
}

// Save state
function persistState() {
  try {
    const payload = {
      selectedGroups: STATE.selectedGroups,
      courseVisibility: STATE.courseVisibility,
      skippedClasses: Array.from(STATE.skippedClasses),
      showGhostGroups: STATE.showGhostGroups,
      agendaMode: STATE.agendaMode,
      manualGroups: Array.from(STATE.manualGroups),
      attendance: STATE.attendance,
      autopilot: STATE.autopilot
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Failed to persist state:', e);
  }
}

// Format minutes to "Xh Ym" or "X.Y hrs"
function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Your weekly PDF sessions (course visibility + group selection), before TUMonline is merged in
function getTemplateClasses() {
  return scheduleFor(STATE.selectedGroups, { visibility: STATE.courseVisibility });
}

// One semester week with TUMonline merged in: { items, closures, covered, days } (see mergeWeek)
const weekCache = new Map();
function getWeek(weekIdx = STATE.weekIdx) {
  const key = `${weekIdx}|${JSON.stringify(STATE.selectedGroups)}|${JSON.stringify(STATE.courseVisibility)}|${TUM.syncedAt}|${TUM.status}`;
  if (!weekCache.has(key)) {
    if (weekCache.size > 40) weekCache.clear();
    const connected = TUM.status === 'connected';
    const week = mergeWeek({
      template: getTemplateClasses(),
      tumEvents: connected ? TUM.events : [],
      weekIdx,
      coverage: connected ? TUM.coverage : null
    });
    week.items = week.items.filter(c => STATE.courseVisibility[c.courseId] !== false);
    weekCache.set(key, week);
  }
  return weekCache.get(key);
}

// Sessions of the shown week; cancelled ones stay in (shown struck through) but never count
function getDraftClasses() {
  return getWeek().items;
}

function findEvent(id) {
  return getDraftClasses().find(c => c.id === id) || CLASSES.find(c => c.id === id);
}

function currentWeekIndex() {
  return clampWeek(weekIndexOf(munichNow().date));
}

function setWeek(weekIdx) {
  const next = clampWeek(weekIdx);
  if (next === STATE.weekIdx) return;
  STATE.weekIdx = next;
  if (STATE.currentView === 'today') setView('week');
  else updateAll();
}

// Calculate comprehensive time statistics
function calculateTimeStats() {
  const draftClasses = getDraftClasses();
  let scheduledMin = 0;
  let attendedMin = 0;
  let skippedMin = 0;

  const dayStats = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0 };
  const campusStats = { Garching: 0, Ottobrunn: 0 };
  const courseStats = {};

  for (const c of COURSES) {
    courseStats[c.id] = { scheduledMin: 0, attendedMin: 0, skippedMin: 0 };
  }

  for (const cls of draftClasses) {
    if (cls.cancelled) continue;
    scheduledMin += cls.durationMin;
    const isSkipped = STATE.skippedClasses.has(cls.id);
    if (isSkipped) {
      skippedMin += cls.durationMin;
      if (courseStats[cls.courseId]) {
        courseStats[cls.courseId].skippedMin += cls.durationMin;
      }
    } else {
      attendedMin += cls.durationMin;
      dayStats[cls.day] += cls.durationMin;
      if (cls.campus in campusStats) campusStats[cls.campus] += cls.durationMin;
      if (courseStats[cls.courseId]) {
        courseStats[cls.courseId].attendedMin += cls.durationMin;
      }
    }
    if (courseStats[cls.courseId]) {
      courseStats[cls.courseId].scheduledMin += cls.durationMin;
    }
  }

  return { scheduledMin, attendedMin, skippedMin, dayStats, campusStats, courseStats, draftClasses };
}

// Detect time conflicts among active, non-skipped classes
function detectConflicts() {
  const draftClasses = getDraftClasses();
  const active = draftClasses.filter(c => !STATE.skippedClasses.has(c.id) && !c.cancelled);
  const conflicts = {}; // classId -> array of conflicting classes

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.dayIndex === b.dayIndex) {
        if (a.startMin < b.endMin && a.endMin > b.startMin) {
          if (!conflicts[a.id]) conflicts[a.id] = [];
          if (!conflicts[b.id]) conflicts[b.id] = [];
          conflicts[a.id].push(b);
          conflicts[b.id].push(a);
        }
      }
    }
  }
  return conflicts;
}

// Check if a potential group would introduce a conflict if selected
function evaluateGroupConflict(courseId, groupName) {
  const currentSelected = { ...STATE.selectedGroups, [courseId]: groupName };
  const hypotheticalClasses = CLASSES.filter(cls => {
    if (STATE.courseVisibility[cls.courseId] === false) return false;
    const course = COURSES.find(c => c.id === cls.courseId);
    if (course && course.hasGroups && cls.group) {
      const sel = currentSelected[cls.courseId];
      if (sel && cls.group !== sel) return false;
    }
    return !STATE.skippedClasses.has(cls.id);
  });

  const thisGroupClasses = hypotheticalClasses.filter(c => c.courseId === courseId && c.group === groupName);
  const otherClasses = hypotheticalClasses.filter(c => !(c.courseId === courseId && c.group === groupName));

  for (const tg of thisGroupClasses) {
    for (const oc of otherClasses) {
      if (tg.dayIndex === oc.dayIndex && tg.startMin < oc.endMin && tg.endMin > oc.startMin) {
        return oc; // Returns the first conflicting class found
      }
    }
  }
  return null;
}

// ================= UI RENDERING =================

// Update time summary headers & cards
function renderStats() {
  const stats = calculateTimeStats();
  const conflicts = detectConflicts();
  const conflictCount = Object.keys(conflicts).length / 2;

  // Header quick pill
  const headerTime = document.getElementById('headerTotalHours');
  if (headerTime) headerTime.textContent = formatMinutes(stats.attendedMin);

  document.getElementById('quickStatsPill')?.classList.toggle('has-conflict', conflictCount > 0);

  const headerSub = document.getElementById('headerSubStats');
  if (headerSub) {
    if (conflictCount > 0) {
      headerSub.innerHTML = `<span style="color:var(--md-error); font-weight:600; display:inline-flex; align-items:center; gap:3px;"><span class="material-symbols-outlined icon-xs">warning</span> ${conflictCount} Conflict${conflictCount > 1 ? 's' : ''}</span> • ${stats.draftClasses.length} classes`;
    } else {
      headerSub.textContent = `${stats.draftClasses.length} classes • ${formatMinutes(stats.skippedMin)} skipped`;
    }
  }

  // Sidebar big calculator
  const sideBigHours = document.getElementById('sideBigHours');
  if (sideBigHours) sideBigHours.textContent = formatMinutes(stats.attendedMin);

  const sideScheduled = document.getElementById('sideScheduledHours');
  if (sideScheduled) sideScheduled.textContent = `${formatMinutes(stats.scheduledMin)} scheduled`;

  const sideSkipped = document.getElementById('sideSkippedHours');
  if (sideSkipped) sideSkipped.textContent = `${formatMinutes(stats.skippedMin)} skipped`;

  // Stacked progress bar
  const stackedBar = document.getElementById('courseStackedBar');
  if (stackedBar) {
    stackedBar.innerHTML = '';
    const total = stats.attendedMin || 1;
    for (const c of COURSES) {
      const cMin = stats.courseStats[c.id]?.attendedMin || 0;
      if (cMin > 0) {
        const seg = document.createElement('div');
        seg.className = 'stacked-bar-segment';
        seg.style.width = `${(cMin / total) * 100}%`;
        seg.style.backgroundColor = c.color;
        seg.title = `${c.shortName}: ${formatMinutes(cMin)}`;
        stackedBar.appendChild(seg);
      }
    }
  }

  // Attendance you've logged on the Today view
  const att = document.getElementById('attendanceSummary');
  if (att) {
    const marks = Object.entries(STATE.attendance);
    const went = marks.filter(([, v]) => v === 'went').length;
    att.hidden = !marks.length;
    att.innerHTML = marks.length ? `<strong>${went}/${marks.length}</strong> logged sessions attended${marks.length - went ? ` · ${marks.length - went} skipped` : ''}` : '';
  }

  // Day hours grid
  for (const day of DAYS) {
    const el = document.getElementById(`dayHours_${day}`);
    if (el) el.textContent = formatMinutes(stats.dayStats[day]);
  }
}

// Render group chooser dropdowns in sidebar
function renderGroupChoosers() {
  const container = document.getElementById('groupChoosersList');
  if (!container) return;
  container.innerHTML = '';

  const coursesWithGroups = COURSES.filter(c => c.hasGroups);

  for (const course of coursesWithGroups) {
    // Collect all unique groups for this course
    const courseClasses = CLASSES.filter(c => c.courseId === course.id && c.group);
    const groups = [];
    const seen = new Set();
    for (const cls of courseClasses) {
      if (!seen.has(cls.group)) {
        seen.add(cls.group);
        groups.push({
          name: cls.group,
          day: cls.day,
          time: `${cls.startTime}-${cls.endTime}`,
          room: cls.room
        });
      }
    }

    const item = document.createElement('div');
    item.className = 'group-course-item';

    const currentSelected = STATE.selectedGroups[course.id];
    const currentConflict = evaluateGroupConflict(course.id, currentSelected);

    item.innerHTML = `
      <div class="group-course-header">
        <span class="group-course-title">
          <span class="course-color-indicator" style="background:var(--c-${course.id}-border, ${course.color})"></span>
          ${course.shortName}
        </span>
        ${currentConflict ? `<span class="conflict-warning-tag" title="Overlaps with ${currentConflict.course}"><span class="material-symbols-outlined icon-xs">warning</span> Overlap</span>` : ''}
        ${STATE.detectedGroups[course.id] === currentSelected ? '<span class="tag tag-ok" title="Your registration in TUMonline">TUMonline</span>' : ''}
      </div>
      <select class="group-select" data-course-id="${course.id}">
        ${groups.map(g => {
          const conflict = evaluateGroupConflict(course.id, g.name);
          const isSelected = g.name === currentSelected;
          const label = `${g.name} · ${g.day.slice(0,3)} ${g.time.split('-')[0]}${conflict ? ' · overlaps' : ''}`;
          return `<option value="${g.name}" ${isSelected ? 'selected' : ''}>${label}</option>`;
        }).join('')}
      </select>
    `;

    const select = item.querySelector('select');
    if (select) {
      select.addEventListener('change', (e) => selectGroup(course.id, e.target.value));
    }

    container.appendChild(item);
  }
}


// Render weekly time grid
function renderWeekGrid() {
  const daysGrid = document.getElementById('daysGrid');
  if (!daysGrid) return;
  daysGrid.innerHTML = '';

  const conflicts = detectConflicts();
  const draftClasses = getDraftClasses();

  // Stretch hour rows so 08:00–20:00 fills tall screens (tablets in portrait); never below the CSS minimum
  const weekContainer = document.getElementById('weekViewContainer');
  const scrollArea = document.getElementById('calendarScrollArea');
  weekContainer.style.removeProperty('--hour-height');
  const minHour = parseFloat(getComputedStyle(weekContainer).getPropertyValue('--hour-height')) || 56;
  const daysHeaderPx = scrollArea.querySelector('.calendar-days-header')?.offsetHeight || 0;
  const hourHeight = isPrinting
    ? PRINT_HOUR_HEIGHT
    : Math.min(96, Math.max(minHour, Math.floor((scrollArea.clientHeight - daysHeaderPx - 16) / 12)));
  weekContainer.style.setProperty('--hour-height', `${hourHeight}px`);

  const week = getWeek();
  renderWeekToolbar(week);
  renderDayHeaders(week);
  const closedDays = new Set(week.closures.filter(x => !SEMESTER.partial.some(p => p.date === x.date)).map(x => x.dayIndex));

  // Alternative groups ("ghosts"); groups of one course sharing a time slot merge into one card
  let visibleClasses = draftClasses.map(c => ({ ...c })); // copies: layout fields are written onto them
  if (STATE.showGhostGroups && !isPrinting) {
    const merged = new Map();
    for (const c of CLASSES) {
      if (!c.group || STATE.courseVisibility[c.courseId] === false || closedDays.has(c.dayIndex)) continue;
      const course = COURSES.find(co => co.id === c.courseId);
      if (!course?.hasGroups || c.group === STATE.selectedGroups[c.courseId]) continue;
      const key = `${c.courseId}|${c.dayIndex}|${c.startMin}|${c.endMin}`;
      if (merged.has(key)) merged.get(key).alternatives.push(c);
      else merged.set(key, { ...c, id: `ghost-${key}`, isGhost: true, alternatives: [c] });
    }
    visibleClasses = visibleClasses.concat([...merged.values()]);
  }

  // Create columns for Monday through Friday
  const columns = DAYS.map((day, dayIndex) => {
    const col = document.createElement('div');
    col.className = `day-column ${dayIndex === STATE.mobileDay ? 'is-mobile-active' : ''} ${closedDays.has(dayIndex) ? 'is-closed' : ''}`;
    col.dataset.dayIndex = dayIndex;
    const closure = week.closures.find(x => x.dayIndex === dayIndex);
    if (closure) {
      const note = document.createElement('div');
      note.className = 'closure-note';
      note.textContent = closure.label;
      col.appendChild(note);
    }
    return col;
  });

  // Calculate overlapping layout columns for Google Calendar aesthetic
  // Group events by day
  const dayGroups = [[], [], [], [], []];
  for (const cls of visibleClasses) {
    dayGroups[cls.dayIndex].push(cls);
  }

  // Position events for each day
  dayGroups.forEach((events, dayIdx) => {
    const col = columns[dayIdx];
    // Sort by start; your own classes before alternatives so they take the leftmost lane
    events.sort((a, b) => a.startMin - b.startMin || (a.isGhost ? 1 : 0) - (b.isGhost ? 1 : 0) || b.endMin - a.endMin);

    // Compute concurrent clusters for column widths
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = -1;

    for (const ev of events) {
      if (currentCluster.length === 0 || ev.startMin < clusterEnd) {
        currentCluster.push(ev);
        clusterEnd = Math.max(clusterEnd, ev.endMin);
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterEnd = ev.endMin;
      }
    }
    if (currentCluster.length > 0) clusters.push(currentCluster);

    // Lay out each cluster in lanes. If alternative lanes would be too thin to read,
    // merge alternatives that share a time slot (across courses) into one card first.
    const colPx = (isMobile() ? daysGrid.clientWidth : daysGrid.clientWidth / 5) || 200;
    clusters.forEach((cluster, ci) => {
      let lanes = assignLanes(cluster);
      if (ghostLanePx(lanes, colPx) < 72) {
        cluster = mergeGhostsByTime(cluster);
        clusters[ci] = cluster;
        lanes = assignLanes(cluster);
      }

      // Lanes holding your own classes get twice the width of alternative-only lanes
      const weights = lanes.map(lane => (lane.some(ev => !ev.isGhost) ? 2 : 1));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      cluster.forEach(ev => {
        ev.layoutLeft = (weights.slice(0, ev.layoutCol).reduce((a, b) => a + b, 0) / totalWeight) * 100;
        ev.layoutWidth = (weights[ev.layoutCol] / totalWeight) * 100;
      });
    });

    // Render cards
    clusters.flat().forEach(ev => {
      const course = COURSES.find(c => c.id === ev.courseId) || {};
      const isSkipped = STATE.skippedClasses.has(ev.id);
      const isConflict = !isSkipped && !ev.isGhost && !!conflicts[ev.id];

      // Calculate position
      // Grid starts at 08:00 (480 minutes)
      const topPx = ((ev.startMin - 480) / 60) * hourHeight;
      const heightPx = Math.max((ev.durationMin / 60) * hourHeight, 28);

      const colWidthPercent = ev.layoutWidth;
      const leftPercent = ev.layoutLeft;

      const isLecture = ev.type === 'L' || ev.type === 'VI';
      const narrow = colWidthPercent < 100;
      const title = narrow ? (course.shortName || ev.course) : ev.course;

      const card = document.createElement('div');
      card.className = `event-card ${isSkipped ? 'skipped' : ''} ${isConflict ? 'conflict' : ''} ${ev.isGhost ? 'ghost-group' : ''} ${ev.pdfOnly ? 'pdf-only' : ''} ${ev.cancelled ? 'cancelled' : ''} ${ev.extra ? 'tum-extra' : ''} ${ev.isExam ? 'exam' : ''}`;
      card.style.top = `${topPx}px`;
      card.style.height = `${heightPx}px`;
      card.style.left = `${leftPercent}%`;
      card.style.width = `calc(${colWidthPercent}% - 3px)`;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      if (ev.isGhost) {
        const n = ev.alternatives.length;
        let heading, label;
        if (ev.multiCourse) {
          const names = [...new Set(ev.alternatives.map(a => COURSES.find(c => c.id === a.courseId)?.shortName))];
          heading = `${n} other groups`;
          label = names.join(' · ');
          card.style.borderColor = 'var(--text-tertiary)';
          card.style.color = 'var(--text-secondary)';
        } else {
          heading = course.shortName;
          label = groupsLabel(ev.alternatives.map(a => a.group));
          card.style.borderColor = `var(--c-${ev.courseId}-border)`;
          card.style.color = `var(--c-${ev.courseId}-text)`;
        }
        // Type badge (E / CE / L) only when every merged alternative is the same kind
        const types = [...new Set(ev.alternatives.map(a => a.type))];
        const typeBadge = types.length === 1 ? `<span class="event-type-badge" title="${ev.alternatives[0].typeName}">${types[0]}</span>` : '';
        card.setAttribute('aria-label', `Other options: ${heading}${types.length === 1 ? ` ${ev.alternatives[0].typeName}` : ''}, ${label}, ${ev.day} ${ev.startTime}–${ev.endTime}`);
        card.title = `${heading}: ${label}`;
        card.innerHTML = `
          <div class="event-card-inner ghost-full">
            <div class="event-top-line">
              <span class="event-title">${heading}</span>
              ${typeBadge}
            </div>
            <span class="event-meta ghost-groups">${label}</span>
            <span class="event-time">${ev.startTime} – ${ev.endTime}</span>
          </div>
          <div class="ghost-compact" aria-hidden="true">
            <span class="ghost-compact-count">+${n}</span>
            <span class="material-symbols-outlined icon-xs">swap_horiz</span>
          </div>`;
        card.addEventListener('click', () => openGroupChoice(ev));
      } else {
        const muted = isSkipped || ev.pdfOnly || ev.cancelled;
        const hasCourse = COURSES.some(c => c.id === ev.courseId);
        card.style.backgroundColor = muted ? 'var(--card-skipped-bg)' : hasCourse ? `var(--c-${ev.courseId}-${isLecture ? 'lecture' : 'exercise'})` : 'var(--surface-high)';
        card.style.color = muted ? 'var(--text-tertiary)' : hasCourse ? `var(--c-${ev.courseId}-text)` : 'var(--text-primary)';
        card.style.setProperty('--band', hasCourse ? `var(--c-${ev.courseId}-border)` : 'var(--fd-amber)');
        const status = [ev.cancelled && 'cancelled', ev.pdfOnly && 'only in the timetable PDF', ev.changed?.room && 'room changed', ev.isExam && 'exam', isSkipped && 'skipped'].filter(Boolean);
        card.setAttribute('aria-label', `${ev.course}, ${ev.day} ${ev.startTime}–${ev.endTime}${status.length ? `, ${status.join(', ')}` : ''}`);
        const friends = ev.source && !ev.extra ? squadIn(ev.id) : [];
        card.innerHTML = `
          <div class="event-card-inner">
            <div class="event-top-line">
              <span class="event-time">${ev.startTime}</span>
              <span class="event-type-badge">${ev.type}</span>
              <span class="event-card-actions">
                <button class="quick-skip-btn" title="${isSkipped ? 'Mark as attending' : 'Skip this class'}">
                  ${isSkipped ? 'Undo skip' : 'Skip'}
                </button>
              </span>
            </div>
            <span class="event-title" title="${escapeHtml(ev.course)}">${escapeHtml(title)}</span>
            <div class="event-meta" title="${escapeHtml(ev.room)} • ${escapeHtml(ev.lecturer || '')}">
              ${ev.group ? `<strong>${ev.group}</strong> · ` : ''}${escapeHtml(ev.room.split('(')[0].trim())}
            </div>
            <div class="event-tags">${ev.pdfOnly ? '<span class="tag tag-pdf">PDF</span>' : ''}${ev.cancelled ? '<span class="tag tag-red">Cancelled</span>' : ''}${ev.changed?.room ? '<span class="tag tag-amber">Room</span>' : ''}${ev.changed?.time ? '<span class="tag tag-amber">Time</span>' : ''}${ev.isExam ? '<span class="tag tag-amber">Exam</span>' : ''}${friends.map(f => `<span class="avatar avatar-xs" title="${escapeHtml(f.name)} is in this class">${escapeHtml(initials(f.name))}</span>`).join('')}</div>
          </div>
          ${isConflict ? `
            <div class="conflict-pill-on-card" title="Overlaps with another class">
              <span class="material-symbols-outlined icon-xs">warning</span> Overlap
            </div>
          ` : ''}`;
        card.addEventListener('click', (e) => {
          if (e.target.closest('.quick-skip-btn')) return;
          openEventModal(ev.id);
        });
        card.querySelector('.quick-skip-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSkipClass(ev.id);
        });
      }
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
      });

      col.appendChild(card);
    });

    daysGrid.appendChild(col);
  });

  renderNowLine();
  renderMobileDayBar();
}

// ‹ Week 2 of 17 · 19–23 Oct › with "This week" and the TUMonline / PDF legend
function renderWeekToolbar(week) {
  for (const bar of document.querySelectorAll('[data-week-toolbar]')) {
    const isCurrent = STATE.weekIdx === currentWeekIndex();
    const connected = TUM.status === 'connected';
    bar.innerHTML = `
      <div class="week-nav">
        <button class="icon-btn" type="button" data-week-step="-1" aria-label="Previous week" ${STATE.weekIdx === 0 ? 'disabled' : ''}><span class="material-symbols-outlined">chevron_left</span></button>
        <div class="week-label">
          <strong>Week ${STATE.weekIdx + 1}<span> of ${semesterWeeks()}</span></strong>
          <span class="week-dates">${formatDateShort(week.days[0])} – ${formatDateShort(week.days[4])}</span>
        </div>
        <button class="icon-btn" type="button" data-week-step="1" aria-label="Next week" ${STATE.weekIdx === semesterWeeks() - 1 ? 'disabled' : ''}><span class="material-symbols-outlined">chevron_right</span></button>
        ${isCurrent ? '' : '<button class="btn btn-outline btn-sm" type="button" data-week-step="now">This week</button>'}
      </div>
      <div class="week-legend">
        ${connected ? `
          <span><span class="tag tag-ok">TUMonline</span> from your calendar</span>
          ${week.covered ? '<span><span class="tag tag-pdf">PDF</span> only in the timetable PDF: check TUMonline</span>' : '<span class="field-note">TUMonline has no data for this week yet</span>'}`
        : `<span class="field-note">From the timetable PDF (status ${SEMESTER.pdfStatus}).</span>
           <button class="link-btn" type="button" data-open-settings="set-tum">Connect TUMonline</button>`}
      </div>`;
  }
}

// Day headers get their date and campus for the shown week
function renderDayHeaders(week) {
  document.querySelectorAll('.calendar-days-header .day-header-cell').forEach((cell, i) => {
    const items = week.items.filter(c => c.dayIndex === i && !c.cancelled);
    const campus = items.some(c => c.campus === 'Garching') ? 'Garching' : items.length ? 'Ottobrunn' : null;
    const isToday = week.days[i] === munichNow().date;
    cell.classList.toggle('is-today', isToday);
    cell.innerHTML = `
      <span class="day-name">${DAYS[i].slice(0, 3)} <span class="day-date">${parseISODate(week.days[i]).getUTCDate()}</span></span>
      ${campus ? `<span class="day-campus-chip ${campus.toLowerCase()}"><span class="material-symbols-outlined icon-xs">${campus === 'Garching' ? 'directions_bus' : 'rocket_launch'}</span> ${campus}</span>`
        : `<span class="day-campus-chip off">${week.closures.find(x => x.dayIndex === i)?.label || 'No classes'}</span>`}`;
  });
}

// Current time in Munich, since all class times are local to campus
function getCampusNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  const dayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(get('weekday'));
  return { dayIndex, minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

// Red "now" line on today's column (Mon–Fri, within the 08:00–20:00 grid)
function renderNowLine() {
  document.querySelectorAll('.now-line').forEach(el => el.remove());
  const { dayIndex, minutes } = getCampusNow();
  if (dayIndex < 0 || minutes < 480 || minutes >= 1200 || STATE.weekIdx !== weekIndexOf(munichNow().date)) return;
  const col = document.querySelector(`#daysGrid .day-column[data-day-index="${dayIndex}"]`);
  if (!col) return;
  const line = document.createElement('div');
  line.className = 'now-line';
  line.style.top = `calc(var(--hour-height) * ${(minutes - 480) / 60})`;
  line.setAttribute('aria-hidden', 'true');
  col.appendChild(line);
}

// Greedy lane assignment: each event goes into the first lane that's free when it starts
function assignLanes(cluster) {
  const lanes = [];
  for (const ev of cluster) {
    const i = lanes.findIndex(lane => lane[lane.length - 1].endMin <= ev.startMin);
    if (i === -1) { lanes.push([ev]); ev.layoutCol = lanes.length - 1; }
    else { lanes[i].push(ev); ev.layoutCol = i; }
  }
  return lanes;
}

// Width in px of an alternative-only lane (Infinity if there is none)
function ghostLanePx(lanes, colPx) {
  const weights = lanes.map(lane => (lane.some(ev => !ev.isGhost) ? 2 : 1));
  if (!weights.includes(1)) return Infinity;
  return colPx / weights.reduce((a, b) => a + b, 0);
}

function mergeGhostsByTime(cluster) {
  const out = [];
  const byTime = new Map();
  for (const ev of cluster) {
    if (!ev.isGhost) { out.push(ev); continue; }
    const key = `${ev.startMin}|${ev.endMin}`;
    const existing = byTime.get(key);
    if (existing) {
      existing.alternatives = existing.alternatives.concat(ev.alternatives);
      existing.multiCourse = true;
    } else {
      const copy = { ...ev, id: `ghost-${ev.dayIndex}|${key}` };
      byTime.set(key, copy);
      out.push(copy);
    }
  }
  return out;
}

// Mobile: one-day-at-a-time switcher with per-day hours, plus a summary line for the shown day
function renderMobileDayBar() {
  const bar = document.getElementById('mobileDayBar');
  const summary = document.getElementById('mobileDaySummary');
  if (!bar) return;
  const draftClasses = getDraftClasses();
  const stats = calculateTimeStats();

  bar.innerHTML = DAYS.map((day, i) => {
    const active = i === STATE.mobileDay;
    const mins = stats.dayStats[day];
    return `
      <button class="mobile-day-chip ${active ? 'active' : ''}" data-day="${i}" role="tab" aria-selected="${active}" aria-label="${day}, ${formatMinutes(mins)} of classes">
        <span class="day-chip-name">${day.slice(0, 3)} ${parseISODate(dateFor(i, STATE.weekIdx)).getUTCDate()}</span>
        <span class="day-chip-hours">${mins ? formatMinutes(mins) : '—'}</span>
      </button>`;
  }).join('');

  bar.querySelectorAll('.mobile-day-chip').forEach(chip => {
    chip.addEventListener('click', () => setMobileDay(parseInt(chip.dataset.day, 10)));
  });

  if (summary) {
    const day = DAYS[STATE.mobileDay];
    const count = draftClasses.filter(c => c.dayIndex === STATE.mobileDay && !STATE.skippedClasses.has(c.id) && !c.cancelled).length;
    const garching = draftClasses.some(c => c.dayIndex === STATE.mobileDay && c.campus === 'Garching');
    summary.innerHTML = `
      <span class="day-campus-chip ${garching ? 'garching' : 'ottobrunn'}">
        <span class="material-symbols-outlined icon-xs">${garching ? 'directions_bus' : 'rocket_launch'}</span>
        ${garching ? 'Garching' : 'Ottobrunn'}
      </span>
      <span class="day-summary-text">${count} ${count === 1 ? 'class' : 'classes'} · ${formatMinutes(stats.dayStats[day])}</span>
      <button class="ghost-toggle-chip ${STATE.showGhostGroups ? 'active' : ''}" type="button" aria-pressed="${STATE.showGhostGroups}">
        <span class="material-symbols-outlined icon-sm">${STATE.showGhostGroups ? 'visibility' : 'visibility_off'}</span>
        Other groups
      </button>`;
    summary.querySelector('.ghost-toggle-chip').addEventListener('click', () => setShowGhostGroups(!STATE.showGhostGroups));
  }
}

function setShowGhostGroups(show) {
  STATE.showGhostGroups = show;
  const toggle = document.getElementById('ghostGroupsToggle');
  if (toggle) toggle.checked = show;
  persistState();
  updateAll();
}

function setMobileDay(dayIdx) {
  if (dayIdx < 0 || dayIdx > 4 || dayIdx === STATE.mobileDay) return;
  STATE.mobileDay = dayIdx;
  renderWeekGrid();
}

// Toggle skipping a class
function toggleSkipClass(classId) {
  const cls = findEvent(classId);
  if (!cls) return;

  if (STATE.skippedClasses.has(classId)) {
    STATE.skippedClasses.delete(classId);
    showToast(`Attending: ${cls.course} (${cls.day} ${cls.startTime})`);
  } else {
    STATE.skippedClasses.add(classId);
    showToast(`Skipped: ${cls.course} (-${formatMinutes(cls.durationMin)})`);
  }
  persistState();
  updateAll();
}

// Render Group Comparison Matrix
function renderGroupMatrix() {
  const container = document.getElementById('groupMatrixContainer');
  if (!container) return;
  container.querySelectorAll('.matrix-course-block').forEach(el => el.remove());

  renderAutopilot();
  const coursesWithGroups = COURSES.filter(c => c.hasGroups);
  if (!STATE.matrixOpen) {
    STATE.matrixOpen = new Set(isMobile() ? [] : coursesWithGroups.map(c => c.id));
  }

  for (const course of coursesWithGroups) {
    const courseClasses = CLASSES.filter(c => c.courseId === course.id && c.group);
    // group by group name
    const groupMap = new Map();
    for (const c of courseClasses) {
      if (!groupMap.has(c.group)) groupMap.set(c.group, []);
      groupMap.get(c.group).push(c);
    }

    const block = document.createElement('details');
    block.className = 'matrix-course-block';
    block.id = `matrix-${course.id}`;
    block.open = STATE.matrixOpen.has(course.id);
    block.addEventListener('toggle', () => {
      STATE.matrixOpen[block.open ? 'add' : 'delete'](course.id);
    });

    const currentSelected = STATE.selectedGroups[course.id];
    const currentSession = (groupMap.get(currentSelected) || [])[0];
    const currentConflict = evaluateGroupConflict(course.id, currentSelected);

    block.innerHTML = `
      <summary class="matrix-course-top">
        <div class="matrix-course-name">
          <span class="course-color-indicator" style="background:var(--c-${course.id}-border, ${course.color}); width:14px; height:14px;"></span>
          ${course.name}
        </div>
        <div class="matrix-current">
          <span><strong>${currentSelected}</strong>${currentSession ? ` · ${currentSession.day.slice(0, 3)} ${currentSession.startTime}` : ''}</span>
          ${currentConflict ? '<span class="conflict-warning-tag"><span class="material-symbols-outlined icon-xs">warning</span> Overlap</span>' : ''}
          <span class="material-symbols-outlined matrix-chevron" aria-hidden="true">expand_more</span>
        </div>
      </summary>
      <div class="matrix-table-wrapper">
      <table class="matrix-table">
        <thead>
          <tr>
            <th>Group</th>
            <th>Day & Time</th>
            <th>Location</th>
            <th>Lecturer</th>
            <th>Schedule Conflict</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from(groupMap.entries()).map(([gName, sessions]) => {
            const isSelected = gName === currentSelected;
            const s = sessions[0];
            const conflict = evaluateGroupConflict(course.id, gName);

            return `
              <tr class="${isSelected ? 'active' : ''}" data-course="${course.id}" data-group="${gName}">
                <td data-label="Group"><strong>${gName}</strong></td>
                <td data-label="Time">${s.day}, ${s.startTime} – ${s.endTime} <span class="matrix-duration">(${formatMinutes(s.durationMin)})</span></td>
                <td data-label="Location">${s.room}</td>
                <td data-label="Instructor">${s.lecturer || 'Faculty'}</td>
                <td data-label="Conflict" class="${conflict ? 'has-conflict' : 'no-conflict'}">
                  ${conflict ? `
                    <span class="conflict-warning-tag">
                      <span class="material-symbols-outlined icon-xs">warning</span> Overlaps with ${conflict.course} (${conflict.startTime})
                    </span>
                  ` : `
                    <span style="color:var(--md-success); font-weight:500; display:inline-flex; align-items:center; gap:4px;">
                      <span class="material-symbols-outlined icon-xs">check_circle</span> Available (No conflict)
                    </span>
                  `}
                </td>
                <td data-label="Action">
                  ${isSelected ? `
                    <span style="color:var(--md-primary); font-weight:600; display:inline-flex; align-items:center; gap:4px;">
                      <span class="material-symbols-outlined icon-xs">done</span> Selected
                    </span>
                  ` : `
                    <button class="btn btn-outline btn-sm select-matrix-btn" data-course="${course.id}" data-group="${gName}">
                      Select
                    </button>
                  `}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      </div>
    `;

    // Tapping anywhere on a group row selects it
    block.querySelectorAll('tbody tr:not(.active)').forEach(row => {
      row.addEventListener('click', () => selectGroup(row.dataset.course, row.dataset.group));
    });

    container.appendChild(block);
  }
}

// Autopilot: the best conflict-free group picks for what you care about
function renderAutopilot() {
  const box = document.getElementById('autopilotPanel');
  if (!box) return;
  const fixed = {};
  for (const [courseId, g] of Object.entries(STATE.detectedGroups)) if (!STATE.manualGroups.has(courseId)) fixed[courseId] = g;
  let results = optimize(STATE.autopilot, { fixed, visibility: STATE.courseVisibility, skipped: STATE.skippedClasses, limit: 3 });
  // Your TUMonline groups may themselves overlap: then suggest changing them
  const unpinned = !results.length && Object.keys(fixed).length > 0;
  if (unpinned) {
    results = optimize(STATE.autopilot, { visibility: STATE.courseVisibility, skipped: STATE.skippedClasses, limit: 3 });
    for (const k of Object.keys(fixed)) delete fixed[k];
  }
  const current = scoreSchedule(scheduleFor(STATE.selectedGroups, { visibility: STATE.courseVisibility, skipped: STATE.skippedClasses }));
  const describe = m => `${minutesToTime(Math.round(m.startSum / m.campusDays))} avg start · ${minutesToTime(Math.round(m.endSum / m.campusDays))} avg finish · ${formatMinutes(m.gapMin)} gaps · ${m.campusDays} days${m.noLunchDays ? ` · ${m.noLunchDays} without lunch` : ''}`;
  const groupNames = groups => Object.entries(groups).map(([id, g]) => `<span><strong>${COURSES.find(c => c.id === id).shortName}</strong> ${g}</span>`).join('');
  box.innerHTML = `
    <div class="autopilot-head">
      <h3><span class="material-symbols-outlined icon-sm" aria-hidden="true">auto_awesome</span> Autopilot</h3>
      <p>Tries all ${groupOptions().reduce((n, o) => n * o.groups.length, 1).toLocaleString('en-GB')} group combinations${Object.keys(fixed).length ? ', keeping the groups TUMonline has you in' : ''}.</p>
      ${unpinned ? '<p class="late">The groups TUMonline has you in overlap each other. These suggestions change some of them; you would need to switch your registration in TUMonline too.</p>' : ''}
    </div>
    <div class="segmented" role="group" aria-label="Optimize for">
      ${Object.entries(OBJECTIVES).map(([k, o]) => `<button type="button" data-objective="${k}" class="${STATE.autopilot === k ? 'on' : ''}" aria-pressed="${STATE.autopilot === k}" title="${o.hint}">${o.label}</button>`).join('')}
    </div>
    <p class="autopilot-now">Now: ${current.conflict ? '<strong class="late">has overlaps</strong>' : describe(current)}</p>
    <ol class="autopilot-results">${results.map((r, i) => {
      const same = Object.entries(r.groups).every(([id, g]) => STATE.selectedGroups[id] === g);
      return `<li>
        <div class="ap-groups">${groupNames(r.groups)}</div>
        <div class="ap-metrics">${describe(r.metrics)}</div>
        ${same ? '<span class="tag tag-ok">Your current pick</span>' : `<button class="btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-outline'}" type="button" data-apply-groups='${JSON.stringify(r.groups)}'>Apply</button>`}
      </li>`;
    }).join('') || '<li class="field-note">No conflict-free combination with these constraints.</li>'}</ol>`;
  box.querySelectorAll('[data-objective]').forEach(b => b.addEventListener('click', () => {
    STATE.autopilot = b.dataset.objective;
    persistState();
    renderAutopilot();
  }));
  box.querySelectorAll('[data-apply-groups]').forEach(b => b.addEventListener('click', () => applyGroups(JSON.parse(b.dataset.applyGroups))));
}

function applyGroups(groups) {
  for (const [courseId, g] of Object.entries(groups)) {
    if (STATE.selectedGroups[courseId] !== g) STATE.manualGroups.add(courseId);
    STATE.selectedGroups[courseId] = g;
  }
  persistState();
  updateAll();
  showToast(`Applied: ${Object.entries(groups).map(([id, g]) => `${COURSES.find(c => c.id === id).shortName} ${g}`).join(', ')}`);
}

function applyAutopilot(objective) {
  STATE.autopilot = objective;
  const best = optimize(objective, { visibility: STATE.courseVisibility, skipped: STATE.skippedClasses, limit: 1 })[0];
  if (best) applyGroups(best.groups);
}

// Render Agenda View
function renderAgendaView() {
  const container = document.getElementById('agendaContainer');
  if (!container) return;

  // Preserve scroll positions across re-renders
  const prevBoard = container.querySelector('.agenda-columns-board');
  const prevBoardScrollLeft = prevBoard ? prevBoard.scrollLeft : 0;
  const prevContainerScrollTop = container.scrollTop;
  const prevColScrolls = {};
  container.querySelectorAll('.agenda-day-column').forEach((col, idx) => {
    const body = col.querySelector('.agenda-col-scrollable-body');
    if (body) prevColScrolls[idx] = body.scrollTop;
  });

  container.innerHTML = '';
  // Phones and portrait tablets always get the vertical list; side-scrolling day columns don't fit
  const mode = COMPACT_QUERY.matches ? 'list' : STATE.agendaMode;
  container.className = `agenda-view mode-${mode}`;

  const draftClasses = getDraftClasses();

  // Create Header with title, layout toggle, and day navigation chips
  const header = document.createElement('div');
  header.className = 'agenda-header';

  const totalAttendedMin = draftClasses
    .filter(c => !STATE.skippedClasses.has(c.id) && !c.cancelled)
    .reduce((acc, c) => acc + c.durationMin, 0);

  header.innerHTML = `
    <div class="week-toolbar" data-week-toolbar></div>
    <div class="agenda-header-top">
      <div class="agenda-title-box">
        <h2 class="agenda-title">Agenda</h2>
        <p class="agenda-subtitle">${formatMinutes(totalAttendedMin)} of classes this week</p>
      </div>
      <div class="agenda-layout-toggle desktop-only" title="Switch layout format">
        <button class="agenda-toggle-btn ${STATE.agendaMode === 'columns' ? 'active' : ''}" data-mode="columns">
          <span class="material-symbols-outlined icon-sm">view_column</span> Day Columns
        </button>
        <button class="agenda-toggle-btn ${STATE.agendaMode === 'list' ? 'active' : ''}" data-mode="list">
          <span class="material-symbols-outlined icon-sm">view_agenda</span> List Feed
        </button>
      </div>
    </div>
    <div class="agenda-day-nav">
      <button class="agenda-nav-chip ${STATE.selectedAgendaDay === 'all' ? 'active' : ''}" data-day="all">
        <span class="material-symbols-outlined icon-xs">calendar_view_week</span> All Days
      </button>
      ${DAYS.map((day, dIdx) => {
        const shortName = day.slice(0, 3);
        const dayCount = draftClasses.filter(c => c.dayIndex === dIdx).length;
        const isActive = STATE.selectedAgendaDay === dIdx;
        return `
          <button class="agenda-nav-chip ${isActive ? 'active' : ''}" data-day="${dIdx}">
            <span>${shortName}</span>
            <span style="opacity:0.75; font-size:11px;">(${dayCount})</span>
          </button>
        `;
      }).join('')}
    </div>
  `;

  // Attach header toggle listeners
  header.querySelectorAll('.agenda-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode && mode !== STATE.agendaMode) {
        STATE.agendaMode = mode;
        persistState();
        renderAgendaView();
      }
    });
  });

  // Attach day jump listeners
  header.querySelectorAll('.agenda-nav-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const dayVal = chip.dataset.day;
      STATE.selectedAgendaDay = dayVal === 'all' ? 'all' : parseInt(dayVal, 10);

      header.querySelectorAll('.agenda-nav-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      if (mode === 'columns') {
        if (dayVal === 'all') {
          const board = container.querySelector('.agenda-columns-board');
          if (board) board.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          const col = document.getElementById(`agenda-col-${dayVal}`);
          if (col) {
            col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            col.classList.add('highlighted');
            setTimeout(() => col.classList.remove('highlighted'), 1200);
          }
        }
      } else {
        if (dayVal === 'all') {
          container.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          const card = document.getElementById(`agenda-day-${dayVal}`);
          // Offset by the sticky header so the day title isn't hidden under it
          if (card) {
            container.scrollTo({ top: card.offsetTop - header.offsetHeight - 8, behavior: 'smooth' });
          }
        }
      }
    });
  });

  container.appendChild(header);
  renderWeekToolbar(getWeek());

  // Render appropriate content view
  if (mode === 'columns') {
    renderColumnsBoard(container, draftClasses);
    // Restore column scrolls
    const newBoard = container.querySelector('.agenda-columns-board');
    if (newBoard && prevBoardScrollLeft) newBoard.scrollLeft = prevBoardScrollLeft;
    container.querySelectorAll('.agenda-day-column').forEach((col, idx) => {
      const body = col.querySelector('.agenda-col-scrollable-body');
      if (body && prevColScrolls[idx] !== undefined) body.scrollTop = prevColScrolls[idx];
    });
  } else {
    renderListFeed(container, draftClasses);
    if (prevContainerScrollTop) container.scrollTop = prevContainerScrollTop;
  }
}

// Campus of a day from its sessions, or why there are none
function campusChip(dayClasses, dayIndex) {
  const live = dayClasses.filter(c => !c.cancelled);
  if (!live.length) {
    const closure = getWeek().closures.find(x => x.dayIndex === dayIndex);
    return `<span class="day-campus-chip off">${closure ? closure.label : 'No classes'}</span>`;
  }
  const garching = live.some(c => c.campus === 'Garching');
  return `<span class="day-campus-chip ${garching ? 'garching' : 'ottobrunn'}"><span class="material-symbols-outlined icon-xs">${garching ? 'directions_bus' : 'rocket_launch'}</span> ${garching ? 'Garching' : 'Ottobrunn'}</span>`;
}

// Render Mode 1: Day Columns (Each day independently scrollable vertically)
function renderColumnsBoard(container, draftClasses) {
  const board = document.createElement('div');
  board.className = 'agenda-columns-board';

  DAYS.forEach((day, dayIndex) => {
    const dayClasses = draftClasses.filter(c => c.dayIndex === dayIndex);
    dayClasses.sort((a, b) => a.startMin - b.startMin);

    const dayAttendedMin = dayClasses
      .filter(c => !STATE.skippedClasses.has(c.id) && !c.cancelled)
      .reduce((acc, c) => acc + c.durationMin, 0);

    const col = document.createElement('div');
    col.className = 'agenda-day-column';
    col.id = `agenda-col-${dayIndex}`;

    col.innerHTML = `
      <div class="agenda-day-header">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
          <span style="font-weight:600; font-size:13.5px; color:var(--text-primary);">${day} <span class="day-date">${formatDateShort(dateFor(dayIndex, STATE.weekIdx))}</span></span>
          ${campusChip(dayClasses, dayIndex)}
        </div>
        <div style="font-size:11px; color:var(--text-secondary); margin-top:4px; display:flex; justify-content:space-between;">
          <span>${dayClasses.length} ${dayClasses.length === 1 ? 'class' : 'classes'}</span>
          <span style="font-weight:500; color:var(--md-primary);">${formatMinutes(dayAttendedMin)} attended</span>
        </div>
      </div>
      <div class="agenda-col-scrollable-body">
        ${dayClasses.length === 0 ? `
          <div class="agenda-col-empty">
            <span class="material-symbols-outlined" style="font-size:30px; color:var(--text-tertiary);">event_available</span>
            <span style="font-weight:500; font-size:12.5px; color:var(--text-secondary);">No classes scheduled</span>
            <span style="font-size:11px; color:var(--text-tertiary);">Enjoy your free day!</span>
          </div>
        ` : dayClasses.map(cls => {
          const course = COURSES.find(c => c.id === cls.courseId) || {};
          const isSkipped = STATE.skippedClasses.has(cls.id);
          const isLecture = cls.type === 'L' || cls.type === 'VI';
          const badgeBg = isLecture ? (course.lectureBg || course.bgColor) : (course.exerciseBg || course.bgColor);

          return `
            <div class="agenda-col-item ${isSkipped ? 'skipped' : ''} ${cls.pdfOnly ? 'pdf-only' : ''} ${cls.cancelled ? 'cancelled' : ''}" data-id="${cls.id}">
              <div class="agenda-col-top">
                <span class="agenda-col-time">
                  <span class="material-symbols-outlined icon-xs" style="vertical-align:middle; font-size:13px;">schedule</span>
                  ${cls.startTime} – ${cls.endTime}
                </span>
                <button class="btn btn-sm ${isSkipped ? 'btn-primary' : 'btn-outline'} agenda-col-skip-btn" data-skip-id="${cls.id}" title="${isSkipped ? 'Restore this class' : 'Skip this class'}">
                  ${isSkipped ? 'Restore' : 'Skip'}
                </button>
              </div>
              <div class="agenda-col-title">
                <span class="course-color-indicator" style="background:var(--c-${cls.courseId}-border, ${course.color}); width:10px; height:10px; flex-shrink:0;"></span>
                <span>${cls.course}</span>
              </div>
              <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
                <span class="event-type-badge" style="background:var(--c-${cls.courseId}-${isLecture ? 'lecture' : 'exercise'}); color:var(--c-${cls.courseId}-text); font-size:10.5px;">${cls.type}</span>
                ${cls.group ? `<span class="event-type-badge" style="background:var(--c-${cls.courseId}-exercise); color:var(--c-${cls.courseId}-text); font-weight:600; font-size:10.5px;">${cls.group}</span>` : ''}
                ${isSkipped ? '<span class="conflict-warning-tag" style="background:var(--card-skipped-bg); color:var(--text-tertiary); font-size:10px; padding:1px 6px;">Skipped</span>' : ''}
                ${statusTags(cls)}
              </div>
              <div class="agenda-col-meta">
                <span class="material-symbols-outlined icon-xs">location_on</span>
                <span>${cls.room}</span>
                <span style="opacity:0.4;">•</span>
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${cls.lecturer || 'Faculty'}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Click handler for skip buttons
    col.querySelectorAll('.agenda-col-skip-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSkipClass(btn.dataset.skipId);
      });
    });

    // Click handler on agenda-col-item to open modal
    col.querySelectorAll('.agenda-col-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.agenda-col-skip-btn')) return;
        openEventModal(item.dataset.id);
      });
    });

    board.appendChild(col);
  });

  container.appendChild(board);
}

// Render Mode 2: Stacked List Feed
function renderListFeed(container, draftClasses) {
  const feed = document.createElement('div');
  feed.className = 'agenda-feed-list';

  DAYS.forEach((day, dayIndex) => {
    const dayClasses = draftClasses.filter(c => c.dayIndex === dayIndex);
    dayClasses.sort((a, b) => a.startMin - b.startMin);

    const dayCard = document.createElement('div');
    dayCard.className = 'agenda-day-card';
    dayCard.id = `agenda-day-${dayIndex}`;

    const dayMinutes = dayClasses
      .filter(c => !STATE.skippedClasses.has(c.id) && !c.cancelled)
      .reduce((acc, c) => acc + c.durationMin, 0);

    dayCard.innerHTML = `
      <div class="agenda-day-header">
        <span class="agenda-day-title">
          ${day} <span class="day-date">${formatDateShort(dateFor(dayIndex, STATE.weekIdx))}</span>
          ${campusChip(dayClasses, dayIndex)}
        </span>
        <span class="stats-detail">${dayClasses.length} ${dayClasses.length === 1 ? 'class' : 'classes'} • ${formatMinutes(dayMinutes)} attended</span>
      </div>
      <div class="agenda-day-list">
        ${dayClasses.length === 0 ? `
          <div style="padding:20px; text-align:center; color:var(--text-tertiary); font-size:13px; display:flex; align-items:center; justify-content:center; gap:8px;">
            <span class="material-symbols-outlined icon-sm">event_available</span> No classes scheduled for this day
          </div>
        ` : dayClasses.map(cls => {
          const course = COURSES.find(c => c.id === cls.courseId) || {};
          const isSkipped = STATE.skippedClasses.has(cls.id);
          const isLecture = cls.type === 'L' || cls.type === 'VI';

          return `
            <div class="agenda-item ${isSkipped ? 'skipped' : ''} ${cls.pdfOnly ? 'pdf-only' : ''} ${cls.cancelled ? 'cancelled' : ''}" data-id="${cls.id}">
              <div class="agenda-item-left">
                <span class="agenda-time-pill">${cls.startTime} – ${cls.endTime}</span>
                <span class="course-color-indicator" style="background:var(--c-${cls.courseId}-border, ${course.color}); width:12px; height:12px;"></span>
                <div class="agenda-details">
                  <span class="agenda-item-title">
                    ${cls.course}
                    <span class="event-type-badge" style="background:var(--c-${cls.courseId}-${isLecture ? 'lecture' : 'exercise'}); color:var(--c-${cls.courseId}-text);">${cls.type}</span>
                    ${cls.group ? `<span class="event-type-badge" style="background:var(--c-${cls.courseId}-exercise); color:var(--c-${cls.courseId}-text); font-weight:600;">${cls.group}</span>` : ''}
                  </span>
                  <span class="agenda-item-sub">${escapeHtml(cls.room)} • ${escapeHtml(cls.lecturer || 'Faculty')}</span>
                  <span class="strip-tags">${statusTags(cls)}</span>
                </div>
              </div>
              <button class="btn btn-sm ${isSkipped ? 'btn-primary' : 'btn-outline'} agenda-skip-toggle" data-id="${cls.id}">
                ${isSkipped ? 'Restore' : 'Skip'}
              </button>
            </div>
          `;
        }).join('')}
      </div>
    `;

    dayCard.querySelectorAll('.agenda-skip-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSkipClass(btn.dataset.id);
      });
    });

    dayCard.querySelectorAll('.agenda-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.agenda-skip-toggle')) return;
        openEventModal(item.dataset.id);
      });
    });

    feed.appendChild(dayCard);
  });

  container.appendChild(feed);
}

// Modal handling
function openEventModal(classId) {
  const cls = findEvent(classId);
  if (!cls) return;

  STATE.activeModalClassId = classId;
  const course = COURSES.find(c => c.id === cls.courseId) || {};
  document.getElementById('eventModal').classList.remove('choice-mode', 'choice-multi');
  setGroupsLink(course);
  const isSkipped = STATE.skippedClasses.has(cls.id);
  const conflicts = detectConflicts();
  const classConflicts = conflicts[cls.id] || [];

  const modal = document.getElementById('eventModal');
  const bar = document.getElementById('modalHeaderBar');
  const title = document.getElementById('modalEventTitle');
  const typeBadge = document.getElementById('modalEventTypeBadge');
  const timeInfo = document.getElementById('modalTimeInfo');
  const roomEl = document.getElementById('modalRoomInfo');
  const lecturerInfo = document.getElementById('modalLecturerInfo');
  const campusInfo = document.getElementById('modalCampusInfo');
  const conflictRow = document.getElementById('modalConflictRow');
  const skipBtn = document.getElementById('modalSkipBtn');

  if (bar) bar.style.backgroundColor = course.color ? `var(--c-${cls.courseId}-border, ${course.color})` : 'var(--fd-amber)';
  if (title) title.textContent = cls.course;
  if (typeBadge) {
    typeBadge.textContent = `${cls.typeName} (${cls.type})${cls.group ? ` • ${cls.group}` : ''}`;
    const isLecture = cls.type === 'L' || cls.type === 'VI';
    typeBadge.style.backgroundColor = `var(--c-${cls.courseId}-${isLecture ? 'lecture' : 'exercise'})`;
    typeBadge.style.color = `var(--c-${cls.courseId}-text)`;
  }
  if (timeInfo) timeInfo.textContent = `${cls.date ? formatDateLong(cls.date) : cls.day}, ${cls.startTime} – ${cls.endTime} (${formatMinutes(cls.durationMin)})${cls.changed?.time ? ` · PDF said ${cls.pdfTime}` : ''}`;
  if (roomEl) {
    roomEl.innerHTML = `<a href="${navLink(cls.room)}" target="_blank" rel="noopener">${escapeHtml(cls.room)} <span class="material-symbols-outlined icon-xs" aria-hidden="true">map</span></a>${cls.changed?.room ? `<br><small class="was">PDF said ${escapeHtml(cls.pdfRoom)}</small>` : ''}`;
    roomInfo(cls.room).then(info => {
      if (info && STATE.activeModalClassId === cls.id && campusInfo) campusInfo.textContent = `${info.building}${info.floor ? ` · ${info.floor}` : ''}`;
    }).catch(() => {});
  }
  const note = document.getElementById('modalCheckNote');
  if (note) {
    note.className = `modal-check-note ${cls.pdfOnly ? 'pdf' : cls.cancelled ? 'bad' : cls.source === 'tum' ? 'ok' : ''}`;
    note.querySelector('span:last-child').textContent = cls.cancelled ? 'Cancelled in your TUMonline calendar.'
      : cls.pdfOnly ? `Not in your TUMonline calendar. Shown from the official timetable PDF (status ${SEMESTER.pdfStatus}); check TUMonline.`
      : cls.source === 'tum' ? `Confirmed by your TUMonline calendar${TUM.syncedAt ? ` (synced ${timeAgo(TUM.syncedAt)})` : ''}.`
      : 'From the timetable PDF. Connect TUMonline in settings to see cancellations and room changes.';
  }
  if (lecturerInfo) lecturerInfo.textContent = cls.lecturer || 'Aerospace Department Faculty';
  if (campusInfo) campusInfo.textContent = cls.campus === 'Garching' ? 'Garching Campus (MW Buildings)' : 'Ottobrunn Campus (OTN Buildings)';
  setMoodleLink(moodleUrl(cls.courseId, cls.type));

  if (conflictRow) {
    if (classConflicts.length > 0 && !isSkipped) {
      conflictRow.style.display = 'flex';
      conflictRow.innerHTML = `
        <span class="modal-info-icon" style="color:var(--md-error);"><span class="material-symbols-outlined">warning</span></span>
        <div class="modal-info-text">
          <span class="modal-info-label" style="color:var(--md-error);">Time Conflict Warning</span>
          <span style="color:var(--md-error); font-weight:500;">
            Simultaneous with: ${classConflicts.map(c => `${c.course} (${c.startTime})`).join(', ')}
          </span>
        </div>
      `;
    } else {
      conflictRow.style.display = 'none';
    }
  }

  if (skipBtn) {
    skipBtn.textContent = isSkipped ? 'Mark as attending' : 'Skip this class';
    skipBtn.className = isSkipped ? 'btn btn-primary' : 'btn btn-outline';
    if (!isSkipped) skipBtn.style.color = 'var(--md-error)';
    else skipBtn.style.color = '';
  }

  modal.classList.add('open');
}

// Moodle row in the event dialog; hidden when the course has no link
function setMoodleLink(url) {
  const row = document.getElementById('modalMoodleRow');
  if (!row) return;
  row.hidden = !url;
  if (url) document.getElementById('modalMoodleLink').href = url;
}

// "See all groups" jumps to that course in the Groups view
function setGroupsLink(course) {
  const link = document.getElementById('modalGroupsLink');
  if (!link) return;
  link.hidden = !course.hasGroups;
  link.onclick = () => {
    closeEventModal();
    if (!STATE.matrixOpen) STATE.matrixOpen = new Set();
    STATE.matrixOpen.add(course.id);
    setView('matrix');
    document.getElementById(`matrix-${course.id}`)?.scrollIntoView({ block: 'start' });
  };
}

// Picker for an alternative-group card: one row per group with room and overlap status
function openGroupChoice(ghost) {
  const course = COURSES.find(c => c.id === ghost.courseId) || {};
  const modal = document.getElementById('eventModal');
  STATE.activeModalClassId = null;
  modal.classList.add('choice-mode');
  setGroupsLink(course);

  const isLecture = ghost.type === 'L' || ghost.type === 'VI';
  const multi = !!ghost.multiCourse;
  modal.classList.toggle('choice-multi', multi);
  if (multi) setGroupsLink({ hasGroups: false });
  document.getElementById('modalHeaderBar').style.backgroundColor = multi ? 'var(--text-tertiary)' : `var(--c-${ghost.courseId}-border, ${course.color})`;
  document.getElementById('modalEventTitle').textContent = multi ? `Other groups at ${ghost.startTime}` : ghost.course;
  const badge = document.getElementById('modalEventTypeBadge');
  badge.textContent = multi ? `${ghost.alternatives.length} options` : `${ghost.alternatives.length > 1 ? 'Other groups' : 'Other group'} · ${ghost.typeName}`;
  badge.style.backgroundColor = multi ? 'var(--card-skipped-bg)' : `var(--c-${ghost.courseId}-${isLecture ? 'lecture' : 'exercise'})`;
  badge.style.color = multi ? 'var(--text-secondary)' : `var(--c-${ghost.courseId}-text)`;
  document.getElementById('modalTimeInfo').textContent = `${ghost.day}, ${ghost.startTime} – ${ghost.endTime} (${formatMinutes(ghost.durationMin)})`;
  document.getElementById('modalLecturerInfo').textContent = ghost.lecturer || 'Aerospace Department Faculty';
  setMoodleLink(multi ? null : moodleUrl(ghost.courseId, ghost.type));
  document.getElementById('modalConflictRow').style.display = 'none';

  const choices = document.getElementById('modalChoices');
  choices.innerHTML = ghost.alternatives.map(alt => {
      const altCourse = COURSES.find(c => c.id === alt.courseId) || {};
      const current = STATE.selectedGroups[alt.courseId];
      const currentSession = CLASSES.find(c => c.courseId === alt.courseId && c.group === current);
      const conflict = evaluateGroupConflict(alt.courseId, alt.group);
      return `
        <button class="choice-row" type="button" data-course="${alt.courseId}" data-group="${alt.group}">
          <span class="course-color-indicator" style="background:var(--c-${alt.courseId}-border); width:4px; height:auto; align-self:stretch;"></span>
          <span class="choice-text">
            <strong>${multi ? `${altCourse.shortName} · ` : ''}${alt.group}</strong>
            <span>${alt.room.split('(')[0].trim()} · instead of ${current}${currentSession ? ` (${currentSession.day.slice(0, 3)} ${currentSession.startTime})` : ''}</span>
            <span class="choice-status ${conflict ? 'bad' : 'ok'}">
              <span class="material-symbols-outlined icon-xs">${conflict ? 'warning' : 'check_circle'}</span>
              ${conflict ? `Overlaps ${conflict.course} (${conflict.startTime})` : 'Fits your schedule'}
            </span>
          </span>
          <span class="choice-cta">Switch</span>
        </button>`;
    }).join('');
  choices.querySelectorAll('.choice-row').forEach(row => {
    row.addEventListener('click', () => {
      closeEventModal();
      selectGroup(row.dataset.course, row.dataset.group);
    });
  });

  modal.classList.add('open');
}

function closeEventModal() {
  const modal = document.getElementById('eventModal');
  if (modal) modal.classList.remove('open');
  STATE.activeModalClassId = null;
}

// Preset application
// Theme Management (Light / Dark Mode)
const THEME_KEY = 'tum_calendar_theme';
const NOTICE_KEY = 'tum_calendar_notice_hidden'; // sessionStorage: notice returns on the next visit

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (e) {}
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeIcon');
  const btn = document.getElementById('themeToggleBtn');
  if (icon) {
    icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  }
  if (btn) {
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  }
  if (save) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
  }
}

function toggleTheme() {
  if (currentStyle().darkOnly) return;
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  setTheme(next, true);
}

// App style (look and feel), on top of light / dark. Each style's CSS is in themes/,
// scoped to html[data-style]; its fonts load only once it is picked. The same list and key
// are read by the inline script in index.html's <head>, so the page never flashes the old style.
const STYLE_KEY = 'tum_calendar_style';
const APP_STYLES = {
  flightdeck: { name: 'Flight Deck', blurb: 'Instrument panel, flight strips', fonts: null },
  olympia: { name: "Olympia '72", blurb: 'Munich pastels, colour bands', fonts: 'family=Hanken+Grotesk:wght@300;400;500;600;700;800' },
  orbit: { name: 'Orbit', blurb: 'Night sky, your day as an orbit', darkOnly: true, fonts: 'family=Syne:wght@500;600;700;800&family=Manrope:wght@400;500;600;700' },
  daylight: { name: 'Daylight', blurb: 'Calm and airy, phone first', fonts: 'family=Onest:wght@400;500;600;700;800' }
};

function currentStyle() {
  return APP_STYLES[document.documentElement.getAttribute('data-style')] || APP_STYLES.flightdeck;
}

function getPreferredStyle() {
  try {
    const saved = localStorage.getItem(STYLE_KEY);
    if (APP_STYLES[saved]) return saved;
  } catch (e) {}
  return 'flightdeck';
}

function loadStyleFonts(id) {
  const fonts = APP_STYLES[id]?.fonts;
  if (!fonts || document.querySelector(`link[data-style-fonts="${id}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${fonts}&display=swap`;
  link.dataset.styleFonts = id;
  document.head.appendChild(link);
}

function setStyle(id, save = true) {
  if (!APP_STYLES[id]) id = 'flightdeck';
  loadStyleFonts(id);
  document.documentElement.setAttribute('data-style', id);
  // A dark-only style overrides light mode without forgetting it
  setTheme(APP_STYLES[id].darkOnly ? 'dark' : getPreferredTheme(), false);
  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) themeBtn.hidden = !!APP_STYLES[id].darkOnly;
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  const chrome = getComputedStyle(document.documentElement).getPropertyValue('--bg-chrome').trim();
  if (chrome) meta.forEach(m => m.setAttribute('content', chrome));
  if (save) {
    try { localStorage.setItem(STYLE_KEY, id); } catch (e) {}
    if (STATE.currentView === 'week') renderWeekGrid(); // hour height can differ per style
  }
}

// Reset schedule to default settings
function resetSchedule() {
  STATE.selectedGroups = {
    math: 'Group 1',
    mech: 'Room OTN 1',
    cf: 'Group 2',
    cad: 'Group 3 & 4'
  };
  // Back to your TUMonline groups where it knows them
  STATE.manualGroups.clear();
  Object.assign(STATE.selectedGroups, STATE.detectedGroups);
  STATE.skippedClasses.clear();
  STATE.showGhostGroups = true;
  const ghostToggle = document.getElementById('ghostGroupsToggle');
  if (ghostToggle) ghostToggle.checked = true;
  for (const c of COURSES) STATE.courseVisibility[c.id] = true;
  persistState();
  updateAll();
  showToast('Reset Schedule to Default');
}

function applyPreset(name) {
  resetSchedule();
}

// .ics export: weekly series from the PDF slots you picked (buildICS lives in calendar.js)
function exportToICS() {
  const classes = getTemplateClasses().filter(c => !STATE.skippedClasses.has(c.id));
  if (!classes.length) {
    showToast('Nothing to export: every class is hidden or skipped.');
    return;
  }

  const blob = new Blob([buildICS(classes)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'TUM_Aerospace_Schedule_WiSe26_27.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showToast(`Exported ${classes.length} weekly classes (.ics), Christmas break excluded. For live updates, subscribe to the feed in settings.`);
}

// Print: always the week grid in light colours, with a summary header, whatever view is open
let themeBeforePrint = null;
let styleBeforePrint = null;

function preparePrint() {
  if (isPrinting) return;
  isPrinting = true;
  themeBeforePrint = document.documentElement.getAttribute('data-theme');
  styleBeforePrint = document.documentElement.getAttribute('data-style');
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.setAttribute('data-style', 'flightdeck'); // the print layout is tuned for it
  renderPrintHeader();
  renderWeekGrid();
}

function finishPrint() {
  if (!isPrinting) return;
  isPrinting = false;
  if (themeBeforePrint) document.documentElement.setAttribute('data-theme', themeBeforePrint);
  if (styleBeforePrint) document.documentElement.setAttribute('data-style', styleBeforePrint);
  updateAll();
}

function renderPrintHeader() {
  const header = document.getElementById('printHeader');
  if (!header) return;
  const stats = calculateTimeStats();
  const visible = COURSES.filter(c => STATE.courseVisibility[c.id] !== false);
  const groups = visible
    .filter(c => c.hasGroups && STATE.selectedGroups[c.id])
    .map(c => `<span><strong>${c.shortName}:</strong> ${STATE.selectedGroups[c.id]}</span>`);
  const hidden = COURSES.filter(c => STATE.courseVisibility[c.id] === false).map(c => c.shortName);
  const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  header.innerHTML = `
    <div class="print-title-row">
      <h1 class="print-title">TUM Aerospace · B.Sc. 1st semester · Week ${STATE.weekIdx + 1}, ${formatDateShort(dateFor(0, STATE.weekIdx))} – ${formatDateShort(dateFor(4, STATE.weekIdx))}</h1>
      <div class="print-hours">
        <strong>${formatMinutes(stats.attendedMin)}</strong> per week${stats.skippedMin ? ` · ${formatMinutes(stats.skippedMin)} skipped` : ''}
      </div>
    </div>
    <div class="print-groups">${groups.join('')}${hidden.length ? `<span><strong>Hidden:</strong> ${hidden.join(', ')}</span>` : ''}</div>
    <div class="print-footnote">
      L Lecture · VI Lecture with integrated exercise · CE Central exercise · E Exercise ·
      ${TUM.status === 'connected' ? 'Merged with your TUMonline calendar; "PDF" marks sessions only in the timetable PDF.' : 'From the timetable PDF: cancellations and room changes are not shown.'} Unofficial, always check TUMonline · Printed ${printed}
    </div>`;
}

// Toast notification helper
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// Master view update
function updateAll() {
  renderStats();
  renderGroupChoosers();
  renderSquad();
  renderTumPanel();

  if (STATE.currentView === 'today') {
    renderToday();
  } else if (STATE.currentView === 'week') {
    renderWeekGrid();
  } else if (STATE.currentView === 'matrix') {
    renderGroupMatrix();
  } else if (STATE.currentView === 'agenda') {
    renderAgendaView();
  }
}

// Switch main view
function setView(viewName) {
  STATE.currentView = viewName;
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  const weekContainer = document.getElementById('weekViewContainer');
  const matrixContainer = document.getElementById('groupMatrixContainer');
  const agendaContainer = document.getElementById('agendaContainer');
  const todayContainer = document.getElementById('todayContainer');

  if (todayContainer) todayContainer.style.display = viewName === 'today' ? 'grid' : 'none';
  if (weekContainer) weekContainer.style.display = viewName === 'week' ? 'flex' : 'none';
  if (matrixContainer) matrixContainer.style.display = viewName === 'matrix' ? 'flex' : 'none';
  if (agendaContainer) agendaContainer.style.display = viewName === 'agenda' ? 'flex' : 'none';
  // The generic-week notice only belongs above the PDF-based week views
  const notice = document.getElementById('scheduleNotice');
  if (notice) notice.classList.toggle('view-hidden', viewName === 'today' || TUM.status === 'connected');

  updateAll();
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  loadPersistedState();
  loadSettings();
  loadTum();
  pruneCache();
  STATE.weekIdx = currentWeekIndex();
  if (TUM.status === 'connected') STATE.detectedGroups = detectGroups(TUM.events);

  // Initialize style and theme (respects localStorage or system preference)
  setStyle(getPreferredStyle(), false);

  document.getElementById('styleBtn')?.addEventListener('click', () => openSettings('set-look'));

  // Generic-week notice: hidden for the rest of this visit once dismissed, shown again next time
  const notice = document.getElementById('scheduleNotice');
  if (notice) {
    try { if (sessionStorage.getItem(NOTICE_KEY) === '1') notice.hidden = true; } catch (e) {}
    document.getElementById('scheduleNoticeClose')?.addEventListener('click', () => {
      notice.hidden = true;
      try { sessionStorage.setItem(NOTICE_KEY, '1'); } catch (e) {}
      if (STATE.currentView === 'week') renderWeekGrid(); // hour rows can grow into the freed space
    });
  }

  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      try {
        if (!localStorage.getItem(THEME_KEY) && !currentStyle().darkOnly) {
          setTheme(e.matches ? 'dark' : 'light', false);
        }
      } catch (err) {}
    });
  }

  // Sidebar drawer & backdrop logic
  const menuBtn = document.getElementById('toggleSidebarBtn');
  const sidebar = document.getElementById('appSidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const closeSidebarBtn = document.getElementById('closeSidebarBtn');

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('collapsed');
    // Only the overlay drawer (tablet/phone) needs a backdrop; on desktop the sidebar pushes content
    if (sidebarBackdrop && DRAWER_QUERY.matches) sidebarBackdrop.classList.add('active');
  }

  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.add('collapsed');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
  }

  function toggleSidebar() {
    if (!sidebar) return;
    if (sidebar.classList.contains('collapsed')) {
      openSidebar();
    } else {
      closeSidebar();
    }
  }

  // On desktop the sidebar changes the week's column widths, so re-layout once it finishes sliding
  if (sidebar) {
    sidebar.addEventListener('transitionend', (e) => {
      if (e.target === sidebar && !DRAWER_QUERY.matches && STATE.currentView === 'week') renderWeekGrid();
    });
  }

  if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
  if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeSidebar);
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebar);

  // The hours pill opens the summary sidebar at every size
  const quickStatsPill = document.getElementById('quickStatsPill');
  if (quickStatsPill) quickStatsPill.addEventListener('click', toggleSidebar);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeEventModal();
    if (DRAWER_QUERY.matches) closeSidebar();
  });

  // Desktop view tabs
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      setView(tab.dataset.view);
    });
  });

  // Mobile bottom navigation bar
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      setView(item.dataset.view);
    });
  });

  // Mobile week view: swipe left/right to change day
  const calendarScrollArea = document.getElementById('calendarScrollArea');
  if (calendarScrollArea) {
    let touchStart = null;
    calendarScrollArea.addEventListener('touchstart', (e) => {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    calendarScrollArea.addEventListener('touchend', (e) => {
      if (!touchStart || !isMobile()) return;
      const dx = e.changedTouches[0].clientX - touchStart.x;
      const dy = e.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        setMobileDay(STATE.mobileDay + (dx < 0 ? 1 : -1));
      }
    }, { passive: true });
  }

  // Layout differs between phone and desktop, so re-render when crossing the breakpoint
  MOBILE_QUERY.addEventListener('change', updateAll);
  COMPACT_QUERY.addEventListener('change', updateAll);

  // Lane widths and hour height depend on the viewport, so re-layout the week after resizing
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (STATE.currentView === 'week') renderWeekGrid(); }, 150);
  });
  DRAWER_QUERY.addEventListener('change', closeSidebar);

  // Keep the current-time line moving
  setInterval(() => { if (STATE.currentView === 'week') renderNowLine(); }, 60 * 1000);

  // Reset Schedule
  const resetBtn = document.getElementById('resetScheduleBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetSchedule();
      if (DRAWER_QUERY.matches) closeSidebar();
    });
  }

  // Ghost groups toggle
  const ghostToggle = document.getElementById('ghostGroupsToggle');
  if (ghostToggle) {
    ghostToggle.checked = STATE.showGhostGroups;
    ghostToggle.addEventListener('change', (e) => setShowGhostGroups(e.target.checked));
  }

  // Export & Print
  const exportBtn = document.getElementById('exportIcsBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportToICS);

  const printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.addEventListener('click', () => window.print());
  // Also covers Ctrl+P and the browser menu
  window.addEventListener('beforeprint', preparePrint);
  window.addEventListener('afterprint', finishPrint);

  // Modal actions
  const modalClose = document.getElementById('modalCloseBtn');
  if (modalClose) modalClose.addEventListener('click', closeEventModal);

  const modalOverlay = document.getElementById('eventModal');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeEventModal();
    });
  }

  const modalSkipBtn = document.getElementById('modalSkipBtn');
  if (modalSkipBtn) {
    modalSkipBtn.addEventListener('click', () => {
      if (STATE.activeModalClassId) {
        toggleSkipClass(STATE.activeModalClassId);
        closeEventModal();
      }
    });
  }

  // Week navigation (week view toolbar and agenda header)
  document.addEventListener('click', (e) => {
    const step = e.target.closest('[data-week-step]');
    if (!step) return;
    setWeek(step.dataset.weekStep === 'now' ? currentWeekIndex() : STATE.weekIdx + Number(step.dataset.weekStep));
  });

  document.getElementById('settingsBtn')?.addEventListener('click', () => openSettings());
  wireSettings();
  wireToday();
  wirePalette();
  handleJoinLink();
  window.addEventListener('hashchange', handleJoinLink);

  // Render initial view, then refresh TUMonline in the background (at most every 15 min)
  setView('today');
  if (TUM.status === 'pending') pollTumToken();
  if (TUM.status === 'connected' && (!TUM.syncedAt || Date.now() - TUM.syncedAt > 15 * 60e3)) tumSync({ quiet: true });
  setInterval(() => { if (TUM.status === 'connected' && document.visibilityState === 'visible') tumSync({ quiet: true }); }, 30 * 60e3);

  // Offline support + installable app (needs http(s), not file://)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered:', err));
  }
});

// Expose on window for inline handlers & testing
if (typeof window !== 'undefined') {
  window.closeEventModal = closeEventModal;
  window.openEventModal = openEventModal;
  window.toggleSkipClass = toggleSkipClass;
  window.resetSchedule = resetSchedule;
  window.applyPreset = applyPreset;
  window.setTheme = setTheme;
  window.toggleTheme = toggleTheme;
  window.setStyle = setStyle;
  window.setView = setView;
  window.STATE = STATE;
}

