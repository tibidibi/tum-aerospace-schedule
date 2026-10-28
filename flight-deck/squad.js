/**
 * Squad mode: share your schedule as a link (everything lives in the URL hash, no server),
 * overlay friends, find shared classes and time you're all free.
 * The same codec carries the settings for the Worker's subscribable feed.
 */

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
  const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
}

// Only your name, group picks and skipped sessions go in a link. Never the TUM token or home address.
function encodeShare({ name = '', groups = {}, skipped = [], alarms }) {
  const payload = { v: 1, n: String(name).slice(0, 40), g: groups, k: [...skipped] };
  if (alarms) payload.a = alarms;
  return toBase64Url(JSON.stringify(payload));
}

// Links come from other people: keep only known courses, groups and session ids
function decodeShare(code) {
  try {
    const raw = JSON.parse(fromBase64Url(String(code)));
    if (!raw || raw.v !== 1) return null;
    const groups = {};
    for (const c of COURSES.filter(c => c.hasGroups)) {
      const g = raw.g && raw.g[c.id];
      if (typeof g === 'string' && CLASSES.some(x => x.courseId === c.id && x.group === g)) groups[c.id] = g;
    }
    const ids = new Set(CLASSES.map(c => c.id));
    const skipped = Array.isArray(raw.k) ? raw.k.filter(id => ids.has(id)) : [];
    const alarms = {};
    for (const [d, m] of Object.entries(raw.a || {})) {
      if (/^[0-4]$/.test(d) && Number.isFinite(m) && m > 0 && m < 300) alarms[d] = Math.round(m);
    }
    return { name: typeof raw.n === 'string' ? raw.n.slice(0, 40) : '', groups, skipped, alarms };
  } catch (e) {
    return null;
  }
}

function friendSchedule(friend) {
  return scheduleFor({ ...defaultGroups(), ...friend.groups }, { skipped: new Set(friend.skipped) });
}

function defaultGroups() {
  return Object.fromEntries(COURSES.filter(c => c.hasGroups).map(c => [c.id, c.defaultGroup]));
}

/**
 * Free stretches (≥ minMinutes, between from and to) on a weekday when nobody has class,
 * only on days everyone is on campus anyway. schedules: array of class arrays.
 */
function freeTogether(schedules, dayIndex, { from = 8 * 60, to = 18 * 60, minMinutes = 45 } = {}) {
  const days = schedules.map(s => s.filter(c => c.dayIndex === dayIndex));
  if (days.some(d => !d.length)) return [];
  const busy = days.flat().map(c => [c.startMin, c.endMin]).sort((a, b) => a[0] - b[0]);
  // Only between the latest arrival and the earliest departure: when you're all there
  const start = Math.max(from, ...days.map(d => Math.min(...d.map(c => c.startMin))));
  const end = Math.min(to, ...days.map(d => Math.max(...d.map(c => c.endMin))));
  const out = [];
  let cursor = start;
  for (const [s, e] of [...busy, [end, end]]) {
    if (Math.min(s, end) - cursor >= minMinutes) out.push({ from: cursor, to: Math.min(s, end) });
    cursor = Math.max(cursor, e);
    if (cursor >= end) break;
  }
  return out;
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { encodeShare, decodeShare, friendSchedule, defaultGroups, freeTogether, initials, toBase64Url, fromBase64Url };
}
