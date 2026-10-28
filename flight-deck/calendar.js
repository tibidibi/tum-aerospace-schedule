/**
 * Semester dates, TUMonline sync and .ics export.
 * Pure functions over the globals from data.js (COURSES, CLASSES, DAYS, SEMESTER, ...),
 * shared by the page, the Cloudflare Worker and the Node tests.
 */

// ================= DATES =================
// Dates are 'YYYY-MM-DD' strings in Munich local time. Arithmetic goes through UTC so DST never shifts a day.

function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(s, n) {
  const d = parseISODate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function daysBetween(a, b) {
  return Math.round((parseISODate(b) - parseISODate(a)) / 864e5);
}

// Monday = 0 … Sunday = 6
function weekdayIndex(s) {
  return (parseISODate(s).getUTCDay() + 6) % 7;
}

function semesterWeeks() {
  return Math.floor(daysBetween(SEMESTER.start, SEMESTER.end) / 7) + 1;
}

function weekStart(weekIdx) {
  return addDays(SEMESTER.start, 7 * weekIdx);
}

function dateFor(dayIndex, weekIdx) {
  return addDays(SEMESTER.start, 7 * weekIdx + dayIndex);
}

function weekIndexOf(dateStr) {
  return Math.floor(daysBetween(SEMESTER.start, dateStr) / 7);
}

// Clamp a week index into the lecture period
function clampWeek(weekIdx) {
  return Math.max(0, Math.min(semesterWeeks() - 1, weekIdx));
}

// Wall-clock time in Munich: { date: 'YYYY-MM-DD', minutes, dayIndex (Mon=0) }
function munichNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, minutes: Number(parts.hour) * 60 + Number(parts.minute), dayIndex: weekdayIndex(date) };
}

// The Date for a Munich wall-clock time ('YYYY-MM-DD', minutes after midnight)
function munichDate(dateStr, minutes) {
  // Guess with the UTC offset at that instant, then correct once (handles DST changes)
  const naive = parseISODate(dateStr).getTime() + minutes * 60e3;
  const offsetAt = t => {
    const m = munichNow(new Date(t));
    return (parseISODate(m.date).getTime() + m.minutes * 60e3) - t;
  };
  let t = naive - offsetAt(naive);
  t = naive - offsetAt(t);
  return new Date(t);
}

function minutesToTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// Why there are no lectures on this date/time, or null.
// Partial closures only count when they overlap the given time range.
function closureFor(dateStr, startMin = 0, endMin = 24 * 60) {
  if (dateStr < SEMESTER.start || dateStr > SEMESTER.end) return 'Lecture-free period';
  const br = SEMESTER.breaks.find(b => dateStr >= b.from && dateStr <= b.to);
  if (br) return br.label;
  const part = SEMESTER.partial.find(p => p.date === dateStr &&
    startMin < timeToMinutes(p.to) && endMin > timeToMinutes(p.from));
  return part ? part.label : null;
}

function formatDateShort(dateStr) {
  return parseISODate(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function formatDateLong(dateStr) {
  return parseISODate(dateStr).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// ================= TUMONLINE =================
// The TUM Campus app's API: campus.tum.de/tumonline/wbservicesbasic.* (XML, CORS-enabled).
// Event format follows TUM-Dev/campus_flutter (calendar_event.dart and its tests).

const TUMONLINE_BASE = 'https://campus.tum.de/tumonline/';

function tumUrl(endpoint, params) {
  return `${TUMONLINE_BASE}wbservicesbasic.${endpoint}?${new URLSearchParams(params)}`;
}

function decodeXml(s) {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlValues(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => decodeXml(m[1].trim()));
}

// TUMonline answers errors with <error><message>…</message></error>, HTTP 200
function tumError(xml) {
  return /<error>/.test(xml) ? (xmlValues(xml, 'message')[0] || 'TUMonline returned an error') : null;
}

// ponytail: regex over the flat <event> rowset instead of a DOM parser, so Node and the Worker can run it too
function parseTumCalendar(xml) {
  const err = tumError(xml);
  if (err) throw new Error(err);
  return [...xml.matchAll(/<event>([\s\S]*?)<\/event>/g)].map(([, body]) => {
    const one = tag => xmlValues(body, tag)[0] ?? null;
    const start = one('dtstart') || '';
    const end = one('dtend') || start;
    const title = one('title') || '';
    const description = one('description') || '';
    const url = one('url');
    return {
      id: one('nr'),
      status: one('status'),
      cancelled: one('status') === 'CANCEL',
      title,
      description,
      url,
      lvNr: url && url.includes('LvNr=') ? url.split('LvNr=').pop() : null,
      date: start.slice(0, 10),
      endDate: end.slice(0, 10),
      startMin: timeToMinutes(start.slice(11, 16) || '00:00'),
      endMin: timeToMinutes(end.slice(11, 16) || '00:00'),
      locations: xmlValues(body, 'location'),
      isExam: /prüfung|exam/i.test(`${title} ${description}`)
    };
  }).filter(ev => ev.date);
}

// Whole-word, case-insensitive keyword match (so 'cad' doesn't hit "Dies Academicus")
function titleHas(title, keyword) {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zäöüß])${esc}($|[^a-zäöüß])`, 'i').test(title);
}

function matchCourse(title) {
  const course = COURSES.find(c => (c.tumTitles || [c.name.toLowerCase()]).some(k => titleHas(title, k)));
  return course ? course.id : null;
}

function typeFromTitle(text) {
  if (/zentralübung|central exercise/i.test(text)) return 'CE';
  if (/übung|exercise|tutorial|tutor/i.test(text)) return 'E';
  if (/vorlesung|lecture/i.test(text)) return 'L';
  return null;
}

const TYPE_NAMES = { L: 'Lecture', VI: 'Lecture with Integrated Exercise', CE: 'Central Exercise', E: 'Exercise', X: 'Exam', T: 'TUMonline event' };

// NavigaTUM room id like 5510.02.001 inside a room string
function roomIdFrom(room) {
  const m = String(room || '').match(/\b(\d{4}\.[A-Z0-9]{1,3}\.[A-Z0-9]+)\b/i);
  return m ? m[1] : null;
}

function campusFromRoom(room) {
  const id = roomIdFrom(room);
  if (id) return id.startsWith('93') ? 'Ottobrunn' : 'Garching';
  return /otn|ottobrunn|taufkirchen/i.test(room) ? 'Ottobrunn' : /garching|\bmw\b|\bmi\b/i.test(room) ? 'Garching' : null;
}

// The PDF session a TUMonline event stands for: same course and weekday, start within 15 min.
// Several groups can share a slot, so prefer the one you picked, then matching type, then matching room.
function findPdfMatch(ev, courseId, candidates, preferredIds) {
  const dayIndex = weekdayIndex(ev.date);
  const options = candidates.filter(c => c.courseId === courseId && c.dayIndex === dayIndex && Math.abs(c.startMin - ev.startMin) <= 15);
  if (options.length <= 1) return options[0] || null;
  const type = typeFromTitle(`${ev.title} ${ev.description}`);
  const evRoom = roomIdFrom(ev.locations.join(' '));
  const score = c => (preferredIds.has(c.id) ? 4 : 0) + (type && (c.type === type || (type === 'L' && c.type === 'VI')) ? 2 : 0) + (evRoom && roomIdFrom(c.room) === evRoom ? 1 : 0);
  return options.slice().sort((a, b) => score(b) - score(a))[0];
}

// Which group TUMonline has you in, per course, by majority vote over all synced events
function detectGroups(tumEvents) {
  const votes = {};
  for (const ev of tumEvents) {
    const courseId = matchCourse(ev.title);
    const course = COURSES.find(c => c.id === courseId);
    if (!course || !course.hasGroups) continue;
    const match = findPdfMatch(ev, courseId, CLASSES.filter(c => c.group), new Set());
    if (!match) continue;
    votes[courseId] = votes[courseId] || {};
    votes[courseId][match.group] = (votes[courseId][match.group] || 0) + 1;
  }
  const out = {};
  for (const [courseId, groups] of Object.entries(votes)) {
    out[courseId] = Object.entries(groups).sort((a, b) => b[1] - a[1])[0][0];
  }
  return out;
}

/**
 * One week of your schedule: TUMonline wins, the PDF fills the gaps.
 * - TUM event matching a PDF session → that session with TUM's date, time, room and status (source 'tum')
 * - TUM event matching nothing → extra event (exam, Zentralübung, other course)
 * - PDF session with no TUM event → shown with pdfOnly: true when TUM data covers that week
 * - PDF sessions on lecture-free days are dropped and listed in `closures`
 */
function mergeWeek({ template, tumEvents = [], weekIdx, coverage = null }) {
  const days = DAYS.map((_, i) => dateFor(i, weekIdx));
  const covered = !!coverage && coverage.from <= days[4] && coverage.to >= days[0];
  const templateIds = new Set(template.map(c => c.id));
  const used = new Set();
  const items = [];

  for (const ev of tumEvents) {
    const dayIndex = days.indexOf(ev.date);
    if (dayIndex < 0) continue;
    const courseId = matchCourse(ev.title);
    // Match against every group, not just the picked one: TUMonline knows better
    const pdf = courseId ? findPdfMatch(ev, courseId, CLASSES, templateIds) : null;
    const timing = {
      date: ev.date, day: DAYS[dayIndex], dayIndex,
      startMin: ev.startMin, endMin: ev.endMin, durationMin: Math.max(ev.endMin - ev.startMin, 15),
      startTime: minutesToTime(ev.startMin), endTime: minutesToTime(ev.endMin)
    };
    const tumRoom = ev.locations.join(' · ');
    if (pdf && !used.has(pdf.id)) {
      used.add(pdf.id);
      const pdfRoomId = roomIdFrom(pdf.room);
      const tumRoomId = roomIdFrom(tumRoom);
      items.push({
        ...pdf, ...timing,
        room: tumRoom || pdf.room,
        source: 'tum', tumId: ev.id, cancelled: ev.cancelled, isExam: ev.isExam, tumTitle: ev.title,
        changed: {
          room: !!(pdfRoomId && tumRoomId && pdfRoomId !== tumRoomId),
          time: ev.startMin !== pdf.startMin || ev.endMin !== pdf.endMin
        },
        pdfRoom: pdf.room, pdfTime: `${pdf.startTime} – ${pdf.endTime}`
      });
    } else {
      const course = COURSES.find(c => c.id === courseId);
      const type = ev.isExam ? 'X' : (typeFromTitle(`${ev.title} ${ev.description}`) || 'T');
      items.push({
        id: `tum-${ev.id}`,
        courseId: courseId || 'tum',
        course: course ? course.name : ev.title,
        type, typeName: TYPE_NAMES[type], group: null,
        ...timing,
        room: tumRoom || 'Room not given',
        lecturer: course ? course.lecturer : '',
        campus: campusFromRoom(tumRoom) || (dayIndex === 0 ? 'Garching' : 'Ottobrunn'),
        source: 'tum', extra: true, tumId: ev.id, cancelled: ev.cancelled, isExam: ev.isExam, tumTitle: ev.title,
        changed: { room: false, time: false }
      });
    }
  }

  const closures = [];
  for (const c of template) {
    if (used.has(c.id)) continue;
    const date = days[c.dayIndex];
    const closure = closureFor(date, c.startMin, c.endMin);
    if (closure) {
      if (!closures.some(x => x.dayIndex === c.dayIndex && x.label === closure)) closures.push({ dayIndex: c.dayIndex, date, label: closure });
      continue;
    }
    items.push({ ...c, date, source: 'pdf', pdfOnly: covered, cancelled: false, changed: { room: false, time: false } });
  }

  // Whole days off with no classes of yours still get a label
  days.forEach((date, dayIndex) => {
    const closure = closureFor(date);
    if (closure && !closures.some(x => x.dayIndex === dayIndex)) closures.push({ dayIndex, date, label: closure });
  });

  items.sort((a, b) => a.dayIndex - b.dayIndex || a.startMin - b.startMin);
  return { items, closures, covered, days };
}

// First and last date in the synced data: weeks outside it aren't greyed as "PDF only"
function tumCoverage(tumEvents) {
  if (!tumEvents.length) return null;
  const dates = tumEvents.map(e => e.date).sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

// ================= .ICS EXPORT =================
// RFC 5545. Weekly series run through the lecture period, skipping the Christmas break.

// Escape TEXT values (backslash, semicolon, comma, newline)
function icsEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold lines longer than 75 octets (UTF-8), continuing with CRLF + space
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * classes: weekly PDF sessions. options.alarms: { [dayIndex]: minutesBefore } adds a
 * "leave now" reminder to the first class of that weekday (used by the subscribable feed).
 */
function buildICS(classes, { now = new Date(), alarms = {}, calName = 'TUM Aerospace 1st Semester (unofficial)' } = {}) {
  const compact = s => s.replace(/-/g, '');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const until = `${compact(SEMESTER.end)}T225959Z`; // end of the last lecture day, Munich time
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Unofficial Student Tool//TUM Aerospace Flight Deck//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  const firstOfDay = {};
  for (const c of classes) {
    if (firstOfDay[c.dayIndex] === undefined || c.startMin < firstOfDay[c.dayIndex].startMin) firstOfDay[c.dayIndex] = c;
  }

  for (const cls of classes) {
    const course = COURSES.find(c => c.id === cls.courseId) || {};
    const date = compact(dateFor(cls.dayIndex, 0));
    const time = t => t.replace(':', '') + '00';
    // Every date of this weekday that has no lectures at this time
    const exdates = [];
    for (let w = 0; w < semesterWeeks(); w++) {
      const d = dateFor(cls.dayIndex, w);
      if (closureFor(d, cls.startMin, cls.endMin)) exdates.push(`${compact(d)}T${time(cls.startTime)}`);
    }
    const moodle = moodleUrl(cls.courseId, cls.type);
    const description = [
      `${cls.course} – ${cls.typeName}${cls.group ? ` (${cls.group})` : ''}`,
      `Lecturer: ${cls.lecturer || 'Faculty'}`,
      `Campus: ${cls.campus}`,
      ...(moodle ? [`Moodle: ${moodle}`] : []),
      '',
      `From the timetable PDF (status ${SEMESTER.pdfStatus}). Christmas break and holidays are excluded;`,
      'cancellations and room changes are not. Unofficial – always check TUMonline before you go.'
    ].join('\n');
    const alarm = alarms[cls.dayIndex];

    lines.push(
      'BEGIN:VEVENT',
      `UID:tum-aero-wise2627-${cls.id}@unofficial-draft-planner`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Berlin:${date}T${time(cls.startTime)}`,
      `DTEND;TZID=Europe/Berlin:${date}T${time(cls.endTime)}`,
      `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
      ...(exdates.length ? [`EXDATE;TZID=Europe/Berlin:${exdates.join(',')}`] : []),
      `SUMMARY:${icsEscape(`${course.shortName || cls.course} · ${cls.typeName}${cls.group ? ` (${cls.group})` : ''}`)}`,
      `LOCATION:${icsEscape(cls.room)}`,
      ...(moodle ? [`URL:${moodle}`] : []),
      `DESCRIPTION:${icsEscape(description)}`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      ...(alarm > 0 && firstOfDay[cls.dayIndex] === cls ? [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape(`Leave now for ${course.shortName || cls.course} at ${cls.startTime}`)}`,
        `TRIGGER:-PT${Math.round(alarm)}M`,
        'END:VALARM'
      ] : []),
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseISODate, isoDate, addDays, daysBetween, weekdayIndex, semesterWeeks, weekStart, dateFor, weekIndexOf, clampWeek,
    munichNow, munichDate, minutesToTime, closureFor, formatDateShort, formatDateLong,
    tumUrl, decodeXml, xmlValues, tumError, parseTumCalendar, matchCourse, typeFromTitle, roomIdFrom, campusFromRoom,
    detectGroups, mergeWeek, tumCoverage, TYPE_NAMES, buildICS, icsEscape, icsFold
  };
}
