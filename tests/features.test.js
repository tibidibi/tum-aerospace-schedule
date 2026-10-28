/**
 * Checks for the live features: semester dates, TUMonline parsing and merge, .ics export,
 * MVG/TomTom ranking, the Ottobrunn menu parser and daily file, the optimizer and squad links.
 * Run with: node tests/features.test.js
 */

const assert = require('assert');
const fs = require('fs');

// The page loads these as plain scripts sharing globals; mirror that here
Object.assign(global, require('../js/timetable.js'));
Object.assign(global, require('../js/calendar.js'));
Object.assign(global, require('../js/services.js'));
Object.assign(global, require('../js/autopilot.js'));
Object.assign(global, require('../js/squad.js'));

const ok = msg => console.log(`✓ ${msg}`);
console.log('--- Running Feature Tests ---');

// ---------- Semester dates ----------
assert.strictEqual(semesterWeeks(), 17);
assert.strictEqual(dateFor(0, 0), '2026-10-12');
assert.strictEqual(dateFor(3, 1), '2026-10-22');
assert.strictEqual(weekIndexOf('2026-10-22'), 1);
assert.strictEqual(dateFor(3, 10), '2026-12-24');
assert.strictEqual(closureFor('2026-12-24'), 'Christmas break');
assert.strictEqual(closureFor('2027-01-06'), 'Christmas break');
assert.strictEqual(closureFor('2027-01-07'), null);
assert.strictEqual(closureFor('2026-12-03', 600, 690), 'Dies Academicus', 'Dies Academicus 10–13 overlaps a 10:00 class');
assert.strictEqual(closureFor('2026-12-03', 480, 570), null, 'an 08:00–09:30 class still runs on Dies Academicus');
assert.strictEqual(closureFor('2027-02-08'), 'Lecture-free period');
assert.strictEqual(munichDate('2026-10-22', 600).toISOString(), '2026-10-22T08:00:00.000Z', 'CEST is UTC+2');
assert.strictEqual(munichDate('2026-10-26', 600).toISOString(), '2026-10-26T09:00:00.000Z', 'CET is UTC+1 after the clocks change');
assert.deepStrictEqual(isoWeek('2026-10-22'), { year: 2026, week: 43 });
assert.deepStrictEqual(isoWeek('2027-01-01'), { year: 2026, week: 53 });
ok('Semester weeks, Christmas break, partial closures, Munich time and ISO weeks');

// ---------- TUMonline parsing (format from TUM-Dev/campus_flutter tests) ----------
const xml = `<?xml version="1.0" encoding="utf-8"?>
<rowset>
  <event><nr>1</nr><status>CONFIRMED</status>
    <url>https://campus.tum.de/tumonline/wbLv.wbShowLVDetail?pStpSpNr=1&amp;LvNr=950800001</url>
    <title>Engineering Mechanics I (MW0034) Vorlesung</title><description>Lecture</description>
    <dtstart>2026-10-20 09:45:00</dtstart><dtend>2026-10-20 11:15:00</dtend>
    <location>OTN Hörsaal 5 (9387.EG.012)</location></event>
  <event><nr>2</nr><status>CANCEL</status>
    <title>Computational Foundations I Vorlesung</title>
    <dtstart>2026-10-20 11:30:00</dtstart><dtend>2026-10-20 13:00:00</dtend></event>
  <event><nr>3</nr><status>CONFIRMED</status>
    <title>Advanced Mathematics for Engineers 1 Vorlesung</title>
    <dtstart>2026-10-21 09:45:00</dtstart><dtend>2026-10-21 11:15:00</dtend>
    <location>OTN Hörsaal 11 (9387.EG.021)</location></event>
  <event><nr>4</nr><status>CONFIRMED</status>
    <title>Computational Foundations I Übung</title>
    <dtstart>2026-10-21 13:15:00</dtstart><dtend>2026-10-21 14:45:00</dtend>
    <location>OTN Hörsaal 2 (9387.EG.009)</location></event>
  <event><nr>5</nr><status>CONFIRMED</status>
    <title>Advanced Mathematics for Engineers 1 Tutorübung</title>
    <dtstart>2026-10-22 13:15:00</dtstart><dtend>2026-10-22 14:45:00</dtend>
    <location>OTN Hörsaal 3 (9387.EG.010)</location></event>
  <event><nr>6</nr><status>CONFIRMED</status>
    <title>Aerospace Materials Midterm &amp; Q&amp;A</title><description>Prüfungstermin</description>
    <dtstart>2026-10-23 10:00:00</dtstart><dtend>2026-10-23 12:00:00</dtend>
    <location>OTN Hörsaal 1 (9387.EG.008)</location><location>OTN Hörsaal 2 (9387.EG.009)</location></event>
  <event><nr>7</nr><status>CONFIRMED</status>
    <title>Dies Academicus</title>
    <dtstart>2026-12-03 10:00:00</dtstart><dtend>2026-12-03 13:00:00</dtend></event>
</rowset>`;
const tum = parseTumCalendar(xml);
assert.strictEqual(tum.length, 7);
assert.strictEqual(tum[0].lvNr, '950800001');
assert.strictEqual(tum[0].startMin, 585);
assert.strictEqual(tum[1].cancelled, true);
assert.deepStrictEqual(tum[1].locations, []);
assert.strictEqual(tum[5].title, 'Aerospace Materials Midterm & Q&A');
assert.strictEqual(tum[5].locations.length, 2);
assert.strictEqual(tum[5].isExam, true);
assert.deepStrictEqual(parseTumCalendar('<rowset/>'), []);
assert.throws(() => parseTumCalendar('<error><message>Token ist ungültig!</message></error>'), /Token ist ungültig/);
assert.strictEqual(matchCourse('Dies Academicus'), null, "'cad' must not match inside 'Academicus'");
assert.strictEqual(matchCourse('CAD/TD Übung'), 'cad');
assert.strictEqual(matchCourse('Electrical Engineering'), 'ee');
assert.strictEqual(matchCourse('Engineering Mechanics I'), 'mech');
ok('TUMonline XML: cancellations, entities, multiple locations, errors, course matching');

// ---------- Merge rule: TUMonline wins, the PDF fills gaps ----------
const defaults = { math: 'Group 1', mech: 'Room OTN 1', cf: 'Group 2', cad: 'Group 3 & 4' };
const template = scheduleFor(defaults);
const coverage = tumCoverage(tum);
const week = mergeWeek({ template, tumEvents: tum, weekIdx: 1, coverage });
const byId = id => week.items.find(i => i.id === id);
assert.strictEqual(week.covered, true);
assert.strictEqual(byId('mech-l1').source, 'tum');
assert.strictEqual(byId('mech-l1').changed.room, false);
assert.strictEqual(byId('cf-l1').cancelled, true, 'cancelled in TUMonline → cancelled here');
assert.strictEqual(byId('math-l1').changed.room, true, 'room moved to Hörsaal 11');
assert.strictEqual(byId('math-l1').room, 'OTN Hörsaal 11 (9387.EG.021)');
assert.strictEqual(byId('cf-g2').source, 'tum', 'exercise matched to the group you picked');
assert.strictEqual(byId('math-g5').source, 'tum', 'TUMonline puts you in Math group 5');
assert.strictEqual(byId('ee-vi1').pdfOnly, true, 'Monday EE is not in TUMonline → PDF only');
assert.strictEqual(byId('math-g1').pdfOnly, true);
const exam = week.items.find(i => i.tumId === '6');
assert(exam && exam.extra && exam.isExam && exam.type === 'X' && exam.courseId === 'aero_mat', 'unmatched TUM event becomes an extra exam');
assert.deepStrictEqual(detectGroups(tum), { math: 'Group 5', cf: 'Group 2' });
// A week outside the synced range is not greyed out
const later = mergeWeek({ template, tumEvents: tum, weekIdx: 12, coverage: { from: '2026-10-20', to: '2026-10-23' } });
assert(later.items.every(i => !i.pdfOnly));
// Without TUMonline the PDF schedule is unchanged, minus the Christmas break
const xmas = mergeWeek({ template, weekIdx: 10 });
assert(xmas.items.every(i => i.dayIndex < 3), 'no classes on Thu 24 / Fri 25 Dec');
assert.deepStrictEqual(xmas.closures.map(c => c.dayIndex), [3, 4]);
assert(xmas.items.every(i => i.source === 'pdf' && !i.pdfOnly));
ok('Merge: TUM room/time/status win, PDF-only flagged, extras added, groups detected, holidays dropped');

// ---------- .ics export ----------
const ics = buildICS(template.filter(c => c.id === 'math-l2' || c.id === 'mech-l2'), { now: new Date('2026-10-22T10:00:00Z'), alarms: { 3: 45 } });
assert(ics.includes('RRULE:FREQ=WEEKLY;UNTIL=20270205T225959Z'), 'series ends 5 Feb 2027');
const unfolded = ics.replace(/\r\n /g, '');
assert(/EXDATE;TZID=Europe\/Berlin:20261203T094500,20261224T094500,20261231T094500\r\n/.test(unfolded), "Dies Academicus and Christmas Thursdays excluded, and only those");
assert.strictEqual((ics.match(/BEGIN:VALARM/g) || []).length, 1, 'one alarm, on the first Thursday class');
assert(ics.includes('TRIGGER:-PT45M'));
assert.strictEqual(icsEscape('a;b,c'), 'a\\;b\\,c');
assert(ics.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75), 'lines folded at 75 octets');
ok('.ics: lecture-period end, holiday EXDATEs, leave-now alarm, escaping, folding');

// ---------- MVG ranking (real response, Leopoldstraße 100 → Ottobrunn) ----------
const raw = JSON.parse(fs.readFileSync(__dirname + '/fixtures/mvg_routes.json', 'utf8'));
const routes = raw.map(normalizeMvgRoute);
assert.strictEqual(routes[0].legs[0].walk, true);
assert.strictEqual(routes[0].firstStop.line, '59');
assert(routes[0].depart.getTime() > new Date(raw[0].parts[0].from.plannedDeparture).getTime() - 1, 'walking leg starts on time');
assert.strictEqual(routes[3].maxDelayMin, 2, 'live delay read from departureDelayInMinutes');
const arriveBy = routes[2].arrive;
let ranked = rankRoutes(routes, 'latest', arriveBy);
assert(ranked[ranked.length - 1].late, 'connection arriving after the class starts is ranked last');
assert(ranked.filter(r => !r.unusable).every((r, i, a) => i === 0 || a[i - 1].depart >= r.depart));
const withCancel = routes.map((r, i) => (i === 2 ? { ...r, cancelled: true } : r));
ranked = rankRoutes(withCancel, 'latest', arriveBy);
assert(!ranked[0].cancelled && ranked.slice(-2).some(r => r.cancelled && r.unusable), 'cancelled connection drops to the bottom');
ranked = rankRoutes(routes, 'changes').filter(r => !r.unusable);
assert(ranked.every((r, i, a) => i === 0 || a[i - 1].changes <= r.changes));
ranked = rankRoutes(routes, 'walking').filter(r => !r.unusable);
assert(ranked.every((r, i, a) => i === 0 || a[i - 1].walkMin <= r.walkMin));
ok('MVG: legs, live delays, latest / fewest changes / least walking, cancelled and late last');

// ---------- Mode comparison ----------
const at = new Date('2026-10-27T07:00:00Z');
const mvg = { minutes: 59, depart: new Date(at - 59 * 60e3), maxDelayMin: 1 };
const tt = normalizeTomTom({ routes: [{ summary: { travelTimeInSeconds: 35 * 60, trafficDelayInSeconds: 8 * 60, lengthInMeters: 21400 } }] });
assert.deepStrictEqual([tt.minutes, tt.delayMin, tt.km], [35, 8, 21.4]);
let modes = compareModes({ mvg, car: tt, bike: { minutes: 70, km: 19 } }, { arriveBy: at, carBufferMin: 6 });
assert.strictEqual(modes.find(m => m.fastest).mode, 'car', 'car 35+6 min beats MVG 59');
assert.strictEqual(modes.find(m => m.mode === 'car').leaveBy.toISOString(), '2026-10-27T06:19:00.000Z');
modes = compareModes({ mvg, car: { minutes: 52, delayMin: 20 } }, { arriveBy: at, carBufferMin: 6 });
assert.strictEqual(modes.find(m => m.fastest).mode, 'mvg', 'within 2 min, MVG wins the tie');
modes = compareModes({ mvg: null, bike: { minutes: 40 } }, { arriveBy: at, bikeBufferMin: 3 });
assert.strictEqual(modes[0].fastest, true);
ok('Mode comparison: buffers applied, fastest picked, MVG wins near-ties');

// ---------- Mensa ----------
const menu = parseStwmMenu(fs.readFileSync(__dirname + '/fixtures/mensa_ottobrunn.html', 'utf8'));
assert.strictEqual(menu.days[0].date, '2026-10-22');
assert(menu.days.length >= 2);
const dishes = menu.days[0].dishes;
assert(dishes.length >= 5);
assert(dishes[0].name.startsWith('Gegrillte Maishähnchenbrust'));
assert.strictEqual(dishes[0].dish_type, 'Grill');
const curry = dishes.find(d => d.name.startsWith('Gemüsecurry'));
assert.deepStrictEqual(curry.labels, ['VEGAN', 'VEGETARIAN']);
assert(DIETS.vegan(curry) && !DIETS.vegan(dishes[0]));
assert.strictEqual(formatPrice({ students: { base_price: 1, price_per_unit: 0.9, unit: '100g' } }), '€1.00 + €0.90/100g');
assert.deepStrictEqual(priceTable([{ dishes: [{ dish_type: 'Grill', prices: { students: {} } }] }]), { Grill: { students: {} } });
assert.deepStrictEqual(lunchWindow([{ startMin: 690, endMin: 780 }, { startMin: 795, endMin: 885 }]), { from: 660, to: 690 });
assert.strictEqual(lunchWindow([{ startMin: 660, endMin: 840 }]), null, 'classes all through lunch');
assert.deepStrictEqual(lunchWindow([]), { from: 660, to: 840 });
ok('Mensa: Ottobrunn HTML → dishes with vegan/vegetarian labels, prices, lunch window');

const { mergeDays } = require('../scripts/fetch-mensa-ottobrunn.js');
const merged = mergeDays(
  [{ date: '2026-10-01', dishes: [] }, { date: '2026-10-26', dishes: ['old'] }, { date: '2026-10-28', dishes: ['old'] }],
  [{ date: '2026-10-28', dishes: ['new'] }, { date: '2026-10-29', dishes: ['new'] }], '2026-10-28');
assert.deepStrictEqual(merged.map(d => d.date), ['2026-10-26', '2026-10-28', '2026-10-29'], 'past days kept two weeks, sorted');
assert.deepStrictEqual(merged[1].dishes, ['new'], 'the fresh page wins');
ok('Mensa: daily Ottobrunn file keeps this week\'s past days');

// ---------- Rooms ----------
assert.strictEqual(roomIdFrom('MW 2001 Rudolf-Diesel-Hörsaal (5510.02.001)'), '5510.02.001');
assert.strictEqual(roomIdFrom('Otto-Lilienthal-Hörsaal (5506.EG.608M)'), '5506.EG.608M');
assert.strictEqual(navLink('OTN Hörsaal 1 (9387.EG.008)'), 'https://nav.tum.de/room/9387.EG.008');
assert.strictEqual(campusFromRoom('OTN Hörsaal 1 (9387.EG.008)'), 'Ottobrunn');
const w = walkMinutes({ lat: 48.265424, lon: 11.670841 }, { lat: 48.2661, lon: 11.668346 });
assert(w >= 2 && w <= 5, `MW → Otto-Lilienthal-Hörsaal is a short walk (${w} min)`);
ok('Rooms: NavigaTUM ids, links, campus, walking time');

// ---------- Optimizer ----------
assert.strictEqual(scoreSchedule(template).conflict, false, 'default groups are conflict-free');
const best = optimize('latestStart');
assert(best.length === 5 && best.every(r => !r.metrics.conflict));
assert(best.every((r, i, a) => i === 0 || a[i - 1].metrics.startSum >= r.metrics.startSum));
assert(best[0].metrics.startSum >= scoreSchedule(template).startSum);
const pinned = optimize('fewestGaps', { fixed: { math: 'Group 5' } });
assert(pinned.every(r => r.groups.math === 'Group 5'), 'TUM-confirmed groups stay fixed');
ok(`Optimizer: ${groupOptions().reduce((n, o) => n * o.groups.length, 1)} combinations, conflict-free, ranked, pins respected`);

// ---------- Squad ----------
const code = encodeShare({ name: 'Lena', groups: { math: 'Group 5', cf: 'Group 1' }, skipped: ['ee-vi2'], token: 'SECRET', home: { lat: 1 } });
assert(!fromBase64Url(code).includes('SECRET') && !fromBase64Url(code).includes('lat'), 'token and home never enter a link');
assert.deepStrictEqual(decodeShare(code), { name: 'Lena', groups: { math: 'Group 5', cf: 'Group 1' }, skipped: ['ee-vi2'], alarms: {} });
assert.deepStrictEqual(decodeShare(encodeShare({ groups: { math: 'Group 99', evil: 'x' }, skipped: ['nope'] })).groups, {}, 'unknown groups dropped');
assert.strictEqual(decodeShare('not base64 json'), null);
assert.strictEqual(decodeShare(toBase64Url(JSON.stringify({ v: 1, n: 'Ü', g: {}, k: [] }))).name, 'Ü', 'UTF-8 names survive');
const lena = friendSchedule(decodeShare(code));
const free = freeTogether([template, lena], 1);
assert(free.every(s => s.to - s.from >= 45));
// A: 08–10, 12–13; B: 09–10, 13:30–14 → both on campus 09–13, free together 10–12
assert.deepStrictEqual(freeTogether([[{ dayIndex: 0, startMin: 480, endMin: 600 }, { dayIndex: 0, startMin: 720, endMin: 780 }], [{ dayIndex: 0, startMin: 540, endMin: 600 }, { dayIndex: 0, startMin: 810, endMin: 840 }]], 0), [{ from: 600, to: 720 }]);
assert.deepStrictEqual(freeTogether([template, []], 1), [], 'no shared free time on a day one of you is home');
ok('Squad: link round-trip without secrets, sanitized input, free-together slots');

// ---------- Worker routes (run under Node; no edge cache, no TomTom key) ----------
(async () => {
  const { default: worker } = await import('../worker/index.js');
  const get = path => worker.fetch(new Request(`https://w.test${path}`), {});
  const feed = await get(`/feed.ics?s=${encodeShare({ name: 'Me', groups: defaults, alarms: { 1: 50 } })}`);
  assert.strictEqual(feed.status, 200);
  assert(feed.headers.get('content-type').startsWith('text/calendar'));
  const body = await feed.text();
  assert(body.includes('X-WR-CALNAME:Me · TUM Aerospace') && body.includes('TRIGGER:-PT50M'));
  assert.strictEqual((await get('/feed.ics?s=garbage')).status, 400);
  assert.strictEqual((await get('/route?mode=plane&from=1,2&to=3,4')).status, 400, 'only car/bicycle');
  assert.strictEqual((await get('/route?mode=car&from=48.1,11.5&to=https://evil')).status, 400, 'coordinates only, no open proxy');
  assert.strictEqual((await get('/route?mode=car&from=48.1,11.5&to=48.0,11.6')).status, 501, 'tells you the key is missing');
  assert.strictEqual((await get('/anything')).status, 404);
  const locked = { ALLOWED_ORIGIN: 'https://me.github.io' };
  const routeFrom = origin => worker.fetch(new Request('https://w.test/route?mode=car&from=48.1,11.5&to=48.0,11.6', origin ? { headers: { origin } } : {}), locked);
  assert.strictEqual((await routeFrom('https://evil.example')).status, 403, 'other sites are refused');
  assert.strictEqual((await routeFrom(null)).status, 403, 'Origin-less scripts are refused');
  assert.strictEqual((await routeFrom('https://me.github.io')).status, 501, 'your page gets through');
  ok('Worker: feed with alarms, strict /route validation, origin lock, missing-key message');
  console.log('--- ALL FEATURE TESTS PASSED ---');
})().catch(e => { console.error(e); process.exit(1); });
