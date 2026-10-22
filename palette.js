/**
 * Command palette (Ctrl/⌘K) and keyboard shortcuts:
 * 1–4 switch views, ←/→ change week, T jumps to this week, , opens settings.
 */

function paletteCommands() {
  const cmds = [
    { label: 'Today', hint: 'View · 1', icon: 'flight_takeoff', run: () => setView('today') },
    { label: 'Week', hint: 'View · 2', icon: 'calendar_view_week', run: () => setView('week') },
    { label: 'Groups', hint: 'View · 3', icon: 'grid_view', run: () => setView('matrix') },
    { label: 'Agenda', hint: 'View · 4', icon: 'view_agenda', run: () => setView('agenda') },
    { label: 'This week', hint: 'T', icon: 'today', run: () => setWeek(currentWeekIndex()) },
    { label: 'Settings', hint: ',', icon: 'settings', run: () => openSettings() },
    { label: TUM.status === 'connected' ? 'Sync TUMonline now' : 'Connect TUMonline', icon: 'sync', run: () => (TUM.status === 'connected' ? tumSync() : openSettings('set-tum')) },
    { label: 'Set home address', icon: 'home_pin', run: () => openSettings('set-commute') },
    { label: 'Export .ics', icon: 'download', run: exportToICS },
    { label: 'Copy my squad link', icon: 'group', run: () => navigator.clipboard.writeText(mySquadLink()).then(() => showToast('Link copied')) },
    { label: 'Toggle dark mode', icon: 'contrast', run: toggleTheme },
    { label: 'Print week', icon: 'print', run: () => window.print() }
  ];
  for (const [id, o] of Object.entries(OBJECTIVES)) {
    cmds.push({ label: `Autopilot: ${o.label}`, hint: 'Apply best groups', icon: 'auto_awesome', run: () => applyAutopilot(id) });
  }
  for (const c of COURSES) {
    const next = upcomingSession(c.id);
    if (next) cmds.push({ label: `${c.name}`, hint: `Next: ${formatDateShort(next.date)} ${next.startTime}`, icon: 'event', run: () => openEventModal(next.id) });
    if (c.moodle) cmds.push({ label: `Moodle: ${c.shortName}`, hint: 'Opens in a new tab', icon: 'school', run: () => window.open(c.moodle, '_blank', 'noopener') });
  }
  for (const course of COURSES.filter(c => c.hasGroups)) {
    for (const g of [...new Set(CLASSES.filter(x => x.courseId === course.id && x.group).map(x => x.group))]) {
      if (g !== STATE.selectedGroups[course.id]) cmds.push({ label: `${course.shortName} → ${g}`, hint: 'Switch group', icon: 'swap_horiz', run: () => selectGroup(course.id, g, { manual: true }) });
    }
  }
  for (const room of [...new Set(getDraftClasses().map(c => c.room))]) {
    cmds.push({ label: room.split('(')[0].trim(), hint: 'Room · map', icon: 'map', run: () => window.open(navLink(room), '_blank', 'noopener') });
  }
  return cmds;
}

// Next session of a course from now, in your merged schedule
function upcomingSession(courseId) {
  const now = munichNow();
  for (let w = Math.max(0, weekIndexOf(now.date)); w < semesterWeeks(); w++) {
    const hit = getWeek(w).items.find(c => c.courseId === courseId && !c.cancelled &&
      (c.date > now.date || (c.date === now.date && c.endMin > now.minutes)));
    if (hit) return hit;
  }
  return null;
}

let paletteItems = [];
let paletteIndex = 0;

function openPalette() {
  const dialog = document.getElementById('paletteDialog');
  if (!dialog || dialog.open) return;
  const input = dialog.querySelector('input');
  input.value = '';
  filterPalette('');
  dialog.showModal();
  input.focus();
}

function filterPalette(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  paletteItems = paletteCommands().filter(c => words.every(w => `${c.label} ${c.hint || ''}`.toLowerCase().includes(w))).slice(0, 12);
  paletteIndex = 0;
  renderPalette();
}

function renderPalette() {
  const list = document.getElementById('paletteList');
  list.innerHTML = paletteItems.map((c, i) => `
    <li role="option" id="pal-${i}" aria-selected="${i === paletteIndex}" class="${i === paletteIndex ? 'on' : ''}" data-index="${i}">
      <span class="material-symbols-outlined icon-sm" aria-hidden="true">${c.icon}</span>
      <span class="pal-label">${escapeHtml(c.label)}</span>
      ${c.hint ? `<span class="pal-hint">${escapeHtml(c.hint)}</span>` : ''}
    </li>`).join('') || '<li class="pal-empty">No matching command</li>';
  document.querySelector('#paletteDialog input').setAttribute('aria-activedescendant', `pal-${paletteIndex}`);
  document.getElementById(`pal-${paletteIndex}`)?.scrollIntoView({ block: 'nearest' });
}

function runPalette(i) {
  const cmd = paletteItems[i];
  if (!cmd) return;
  document.getElementById('paletteDialog').close();
  cmd.run();
}

function wirePalette() {
  const dialog = document.getElementById('paletteDialog');
  if (!dialog) return;
  const input = dialog.querySelector('input');
  input.addEventListener('input', () => filterPalette(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % Math.max(paletteItems.length, 1);
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runPalette(paletteIndex);
    }
  });
  dialog.addEventListener('click', e => {
    if (e.target === dialog) return dialog.close();
    const row = e.target.closest('[data-index]');
    if (row) runPalette(Number(row.dataset.index));
  });
  document.getElementById('paletteBtn')?.addEventListener('click', openPalette);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return openPalette();
    }
    // Single-key shortcuts only when you're not typing and no dialog is open
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open], .modal-overlay.open')) return;
    const views = { 1: 'today', 2: 'week', 3: 'matrix', 4: 'agenda' };
    if (views[e.key]) setView(views[e.key]);
    else if (e.key === 'ArrowLeft' && STATE.currentView !== 'today') setWeek(STATE.weekIdx - 1);
    else if (e.key === 'ArrowRight' && STATE.currentView !== 'today') setWeek(STATE.weekIdx + 1);
    else if (e.key.toLowerCase() === 't') setWeek(currentWeekIndex());
    else if (e.key === ',') openSettings();
    else return;
    e.preventDefault();
  });
}
