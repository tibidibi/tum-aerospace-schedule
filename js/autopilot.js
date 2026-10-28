/**
 * Autopilot: tries every combination of exercise groups and ranks the conflict-free ones.
 * Math 14 × Comp. Foundations 13 × Mechanics 4 × CAD 2 ≈ 1.5k schedules, scored in a few ms.
 */

const OBJECTIVES = {
  latestStart: { label: 'Latest start', hint: 'Sleep in: first class of each day as late as possible', key: m => -m.startSum },
  earliestFinish: { label: 'Earliest finish', hint: 'Home early: last class of each day ends soonest', key: m => m.endSum },
  fewestGaps: { label: 'Fewest gaps', hint: 'Least waiting around between classes', key: m => m.gapMin },
  lunch: { label: 'Time for lunch', hint: 'A 30-min window while the Mensa is open (11:00–14:00), every day', key: m => m.noLunchDays },
  fewestDays: { label: 'Fewest campus days', hint: 'Fewer days on campus means fewer commutes', key: m => m.campusDays }
};

function groupOptions() {
  return COURSES.filter(c => c.hasGroups).map(c => ({
    courseId: c.id,
    groups: [...new Set(CLASSES.filter(x => x.courseId === c.id && x.group).map(x => x.group))]
  }));
}

// Your weekly PDF sessions for a group selection (same rules as the planner)
function scheduleFor(selected, { visibility = {}, skipped = new Set() } = {}) {
  return CLASSES.filter(c => {
    if (visibility[c.courseId] === false || skipped.has(c.id)) return false;
    const course = COURSES.find(x => x.id === c.courseId);
    return !(course && course.hasGroups && c.group && selected[c.courseId] && c.group !== selected[c.courseId]);
  });
}

function scoreSchedule(classes) {
  const m = { conflict: false, startSum: 0, endSum: 0, gapMin: 0, campusDays: 0, noLunchDays: 0 };
  for (let d = 0; d < DAYS.length; d++) {
    const day = classes.filter(c => c.dayIndex === d).sort((a, b) => a.startMin - b.startMin);
    if (!day.length) continue;
    m.campusDays++;
    m.startSum += day[0].startMin;
    let end = day[0].endMin;
    for (const c of day.slice(1)) {
      if (c.startMin < end) m.conflict = true;
      m.gapMin += Math.max(0, c.startMin - end);
      end = Math.max(end, c.endMin);
    }
    m.endSum += end;
    if (!lunchWindow(day)) m.noLunchDays++;
  }
  return m;
}

/**
 * Best `limit` conflict-free selections for an objective. `fixed` pins groups (e.g. ones
 * TUMonline confirmed). Ties go to fewer gaps, then a later start.
 */
function optimize(objective, { fixed = {}, visibility = {}, skipped = new Set(), limit = 5 } = {}) {
  const key = (OBJECTIVES[objective] || OBJECTIVES.latestStart).key;
  const options = groupOptions().map(o => fixed[o.courseId] ? { ...o, groups: [fixed[o.courseId]] } : o);
  const results = [];
  const pick = (i, selected) => {
    if (i === options.length) {
      const metrics = scoreSchedule(scheduleFor(selected, { visibility, skipped }));
      if (!metrics.conflict) results.push({ groups: { ...selected }, metrics });
      return;
    }
    for (const g of options[i].groups) pick(i + 1, { ...selected, [options[i].courseId]: g });
  };
  pick(0, {});
  results.sort((a, b) => key(a.metrics) - key(b.metrics) || a.metrics.gapMin - b.metrics.gapMin || b.metrics.startSum - a.metrics.startSum);
  return results.slice(0, limit);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OBJECTIVES, groupOptions, scheduleFor, scoreSchedule, optimize };
}
