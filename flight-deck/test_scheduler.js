/**
 * Ponytail test check: verifies data integrity, time calculation, 
 * conflict detection, and group filtering logic.
 * Run with: node test_scheduler.js
 */

const assert = require('assert');
const { COURSES, DAYS, CLASSES, timeToMinutes } = require('./data.js');

console.log('--- Running Scheduler Logic Tests ---');

// 1. Data integrity check
assert.strictEqual(CLASSES.length, 46, 'Expected exactly 46 class sessions from the PDF');
assert.strictEqual(COURSES.length, 7, 'Expected exactly 7 courses');

for (const c of CLASSES) {
  assert(c.id, `Class must have id: ${JSON.stringify(c)}`);
  assert(c.startTime && c.endTime, `Class must have times: ${c.id}`);
  assert(c.durationMin > 0, `Duration must be positive: ${c.id}`);
  assert(DAYS.includes(c.day), `Day must be valid: ${c.day}`);
  assert(c.room, `Room must be specified: ${c.id}`);
  assert.strictEqual(c.endMin - c.startMin, c.durationMin, `startMin/endMin must match duration: ${c.id}`);
}
console.log('✓ Data integrity passed: 46 classes verified with correct times and rooms.');

// 2. Scheduler state and calculation helpers
function getDraftClasses(selectedGroups, courseVisibility, skippedSet) {
  return CLASSES.filter(cls => {
    // Check course visibility
    if (courseVisibility && courseVisibility[cls.courseId] === false) {
      return false;
    }
    // Check group selection
    const course = COURSES.find(co => co.id === cls.courseId);
    if (course && course.hasGroups && cls.group) {
      const selected = selectedGroups[cls.courseId];
      if (selected && cls.group !== selected) {
        return false;
      }
    }
    return true;
  });
}

function calculateTimeStats(draftClasses, skippedSet) {
  let scheduledMin = 0;
  let attendedMin = 0;
  let skippedMin = 0;
  const dayStats = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0 };
  const courseStats = {};

  for (const c of COURSES) {
    courseStats[c.id] = { scheduledMin: 0, attendedMin: 0, skippedMin: 0 };
  }

  for (const cls of draftClasses) {
    scheduledMin += cls.durationMin;
    const isSkipped = skippedSet.has(cls.id);
    if (isSkipped) {
      skippedMin += cls.durationMin;
      if (courseStats[cls.courseId]) {
        courseStats[cls.courseId].skippedMin += cls.durationMin;
      }
    } else {
      attendedMin += cls.durationMin;
      dayStats[cls.day] += cls.durationMin;
      if (courseStats[cls.courseId]) {
        courseStats[cls.courseId].attendedMin += cls.durationMin;
      }
    }
    if (courseStats[cls.courseId]) {
      courseStats[cls.courseId].scheduledMin += cls.durationMin;
    }
  }

  return { scheduledMin, attendedMin, skippedMin, dayStats, courseStats };
}

function detectConflicts(draftClasses, skippedSet) {
  const active = draftClasses.filter(c => !skippedSet.has(c.id));
  const conflicts = {}; // id -> array of conflicting ids

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.dayIndex === b.dayIndex) {
        // Overlap condition: startA < endB && endA > startB
        if (a.startMin < b.endMin && a.endMin > b.startMin) {
          if (!conflicts[a.id]) conflicts[a.id] = [];
          if (!conflicts[b.id]) conflicts[b.id] = [];
          conflicts[a.id].push(b.id);
          conflicts[b.id].push(a.id);
        }
      }
    }
  }
  return conflicts;
}

// 3. Test standard student plan calculation
const defaultGroups = {
  math: 'Group 1',               // Tue 08:00-09:30
  mech: 'Room OTN 1',            // Wed 15:00-17:00
  cf: 'Group 2',                 // Wed 13:15-14:45
  cad: 'Group 3 & 4'             // Thu 13:15-14:45
};
const emptySkips = new Set();
const defaultDraft = getDraftClasses(defaultGroups, {}, emptySkips);

// Total required sessions:
// Math: 2 L + 1 CE + 1 E = 4
// Mech: 2 L + 1 CE + 1 E = 4
// CF: 1 L + 1 E = 2
// EE: 2 VI = 2
// CAD: 1 L + 1 E = 2
// Aero Mat: 1 L + 1 E = 2
// Intro Aero: 1 L = 1
// Total sessions = 4 + 4 + 2 + 2 + 2 + 2 + 1 = 17 sessions
assert.strictEqual(defaultDraft.length, 17, `Expected 17 sessions in a standard student schedule, got ${defaultDraft.length}`);

const stats = calculateTimeStats(defaultDraft, emptySkips);
// Total minutes:
// EE: 120 + 195 = 315
// Mech: 90 + 45 + 90 + 120 = 345
// CF: 90 + 90 = 180
// CAD: 90 + 90 = 180
// Math: 90 + 90 + 90 + 90 = 360
// Aero Mat: 90 + 90 = 180
// Intro Aero: 90
// Total = 315 + 345 + 180 + 180 + 360 + 180 + 90 = 1650 minutes = 27.5 hours
assert.strictEqual(stats.attendedMin, 1650, `Expected 1650 attended minutes, got ${stats.attendedMin}`);
assert.strictEqual(stats.scheduledMin, 1650, 'Scheduled should equal attended when nothing skipped');
assert.strictEqual(stats.skippedMin, 0, 'Skipped should be 0');
console.log(`✓ Standard plan time calculation verified: ${stats.attendedMin / 60} hrs/week`);

// 4. Test skipping classes
const skipOne = new Set(['ee-vi1']); // Skip Monday morning 2-hour Electrical Engineering
const statsAfterSkip = calculateTimeStats(defaultDraft, skipOne);
assert.strictEqual(statsAfterSkip.scheduledMin, 1650, 'Scheduled min remains 1650');
assert.strictEqual(statsAfterSkip.attendedMin, 1650 - 120, 'Attended min decreased by 120');
assert.strictEqual(statsAfterSkip.skippedMin, 120, 'Skipped min should be 120');
assert.strictEqual(statsAfterSkip.dayStats.Monday, 315 - 120, 'Monday attended time decreased by 120');
console.log('✓ Class skipping correctly recalculates time and day totals.');

// 5. Test conflict detection
// Intentional conflict: Math Group 1 (Tue 08:00-09:30) AND CF Group 0 (Tue 08:00-09:30)
const conflictingGroups = {
  math: 'Group 1',
  mech: 'Room OTN 1',
  cf: 'Group 0', // Conflicts with Math Group 1 on Tuesday morning!
  cad: 'Group 3 & 4'
};
const conflictingDraft = getDraftClasses(conflictingGroups, {}, emptySkips);
const conflicts = detectConflicts(conflictingDraft, emptySkips);
assert(conflicts['math-g1'], 'Math Group 1 should be flagged as conflicting');
assert(conflicts['cf-g0'], 'CF Group 0 should be flagged as conflicting');
assert(conflicts['math-g1'].includes('cf-g0'), 'Math Group 1 conflict should cite CF Group 0');
console.log('✓ Conflict detection correctly flags simultaneous sessions.');

// When one of conflicting classes is skipped, conflict is resolved
const resolveViaSkip = new Set(['cf-g0']);
const conflictsAfterSkip = detectConflicts(conflictingDraft, resolveViaSkip);
assert.strictEqual(conflictsAfterSkip['math-g1'], undefined, 'Conflict should be resolved when one session is skipped');
console.log('✓ Skipping conflicting class properly resolves the active conflict.');

// 6. Mobile layout verification check (ponytail check for responsive UI integrity)
const fs = require('fs');
const html = fs.readFileSync('./index.html', 'utf8');
const css = fs.readFileSync('./style.css', 'utf8');

assert(html.includes('viewport-fit=cover'), 'Viewport meta must support safe-area insets');
assert(html.includes('id="mobileBottomNav"'), 'Mobile bottom navigation bar must exist');
assert(html.includes('id="mobileDayBar"'), 'Mobile day selector bar must exist');
assert(html.includes('id="sidebarBackdrop"'), 'Sidebar backdrop overlay must exist');
assert(html.includes('id="closeSidebarBtn"'), 'Mobile drawer close button must exist');
assert(html.includes('modal-drag-handle'), 'Bottom sheet drag handle must exist');

assert(css.includes('.mobile-bottom-nav'), 'CSS must define mobile bottom nav');
assert(css.includes('.mobile-day-bar'), 'CSS must define mobile day bar');
assert(css.includes('@media (max-width: 700px)'), 'CSS must define mobile media query');
// JS decides single-day week / list agenda with the same breakpoint the CSS uses
const js = fs.readFileSync('./app.js', 'utf8');
assert(js.includes("matchMedia('(max-width: 700px)')"), 'JS mobile breakpoint must match the CSS phone query');
assert(css.includes('.day-column.is-mobile-active'), 'CSS must show only the selected day on phones');
console.log('✓ Mobile responsive architecture & component verification passed.');

console.log('--- ALL TESTS PASSED SUCCESSFULLY ---');
