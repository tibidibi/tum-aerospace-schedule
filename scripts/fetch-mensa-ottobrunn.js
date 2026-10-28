/**
 * Mensa Ottobrunn's menu → data/mensa-ottobrunn.json, in the Eat API's shape.
 * The Studierendenwerk only publishes it as an HTML page without CORS, so the page can't
 * read it itself; a daily GitHub Action (.github/workflows/mensa-ottobrunn.yml) runs this
 * and commits the file, which Pages then serves next to the app.
 * Run with: node scripts/fetch-mensa-ottobrunn.js
 */

const fs = require('fs');
const path = require('path');

Object.assign(global, require('../js/calendar.js')); // decodeXml, used by the parser
const { parseStwmMenu } = require('../js/services.js');

const MENU_URL = 'https://www.studierendenwerk-muenchen-oberbayern.de/gastronomie/speiseplan/speiseplan_433_-de.html';
const OUT = path.join(__dirname, '..', 'data', 'mensa-ottobrunn.json');
const KEEP_DAYS = 14; // the page drops past days; keep them a while so earlier days this week still show

// New days win; old ones the page no longer lists stay until they're KEEP_DAYS old
function mergeDays(oldDays, newDays, today) {
  const cutoff = new Date(Date.parse(today) - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const byDate = new Map((oldDays || []).filter(d => d.date >= cutoff).map(d => [d.date, d]));
  for (const d of newDays) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  const res = await fetch(MENU_URL, { headers: { 'user-agent': 'TUM Aerospace schedule (student project)' } });
  if (!res.ok) throw new Error(`Studierendenwerk answered ${res.status}`);
  const { days } = parseStwmMenu(await res.text());
  // An empty parse means the page changed: fail loudly instead of wiping the menu
  if (!days.length || !days.some(d => d.dishes.length)) throw new Error('No dishes found: did the menu page change?');

  let old = [];
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')).days; } catch (e) {}
  const today = new Date().toISOString().slice(0, 10);
  const out = { canteen: 'mensa-ottobrunn', source: MENU_URL, days: mergeDays(old, days, today) };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`${out.days.length} days, ${out.days[0].date} – ${out.days[out.days.length - 1].date}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { mergeDays };
