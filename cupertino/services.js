/**
 * Live data: MVG (public transport), TomTom (car/bike, through the Worker), Mensa menus,
 * NavigaTUM rooms and Open-Meteo weather. Network helpers at the top, pure parsers and
 * rankers below (those run in the Worker and the Node tests too).
 */

// ================= FETCH WITH OFFLINE FALLBACK =================
const CACHE_PREFIX = 'fd_cache:';

/**
 * fetch + localStorage cache. Fresh within `ttl` ms; on a network error the last stored
 * copy is returned whatever its age, so the app keeps working offline.
 * `key` stores live queries (whose URL changes every minute) under one stable slot.
 */
const notFound = new Map(); // url -> time of a 404, so e.g. an unpublished menu isn't re-requested every render

async function cachedFetch(url, { ttl = 3600e3, as = 'json', key = url, init } = {}) {
  const slot = CACHE_PREFIX + key;
  let hit = null;
  try { hit = JSON.parse(localStorage.getItem(slot)); } catch (e) {}
  if (hit && hit.url === url && Date.now() - hit.t < ttl) return hit.data;
  if (Date.now() - (notFound.get(url) || 0) < 30 * 60e3) throw new Error('404 Not Found');
  try {
    const res = await fetch(url, init);
    if (res.status === 404) notFound.set(url, Date.now());
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = as === 'json' ? await res.json() : await res.text();
    try { localStorage.setItem(slot, JSON.stringify({ t: Date.now(), url, data })); } catch (e) {} // full storage: still use the fresh data
    return data;
  } catch (e) {
    if (hit) return hit.data;
    throw e;
  }
}

// Drop cached responses older than two weeks
function pruneCache() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(CACHE_PREFIX)) continue;
      const t = JSON.parse(localStorage.getItem(k))?.t || 0;
      if (Date.now() - t > 14 * 864e5) localStorage.removeItem(k);
    }
  } catch (e) {}
}

// ================= MVG =================
const MVG_API = 'https://www.mvg.de/api/bgw-pt/v3/';
const MVG_TRANSPORT_TYPES = 'SCHIFF,RUFTAXI,BAHN,UBAHN,TRAM,SBAHN,BUS,REGIONAL_BUS';

async function mvgSearch(query) {
  const res = await fetch(`${MVG_API}locations?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`MVG search failed (${res.status})`);
  return (await res.json())
    .filter(l => l.latitude && l.longitude)
    .map(l => ({ name: l.name, place: l.place || '', type: l.type, lat: l.latitude, lon: l.longitude, globalId: l.globalId || null }));
}

// Connections from `from` to `to` ({lat, lon}) arriving by `when` (or leaving after it), normalized and unsorted
async function mvgRoutes(from, to, when, { arrive = true, cacheKey } = {}) {
  const url = `${MVG_API}routes?originLatitude=${from.lat}&originLongitude=${from.lon}` +
    `&destinationLatitude=${to.lat}&destinationLongitude=${to.lon}` +
    `&routingDateTime=${when.toISOString()}&routingDateTimeIsArrival=${arrive}&transportTypes=${MVG_TRANSPORT_TYPES}`;
  const raw = await cachedFetch(url, { ttl: 50e3, key: cacheKey || 'mvg:routes' });
  return raw.map(normalizeMvgRoute);
}

async function mvgDepartures(globalId, limit = 8) {
  const raw = await cachedFetch(`${MVG_API}departures?globalId=${encodeURIComponent(globalId)}&limit=${limit}`, { ttl: 30e3, key: `mvg:dep:${globalId}` });
  return raw.map(d => ({
    line: d.label, type: d.transportType, destination: d.destination,
    planned: new Date(d.plannedDepartureTime), time: new Date(d.realtimeDepartureTime),
    delayMin: Math.round((d.realtimeDepartureTime - d.plannedDepartureTime) / 60e3),
    realtime: d.realtime, cancelled: d.cancelled, platform: d.platform ?? null
  }));
}

async function mvgIncidents() {
  return cachedFetch(`${MVG_API}messages?messageType=INCIDENT`, { ttl: 5 * 60e3, key: 'mvg:incidents' });
}

const isWalk = part => !part.line || part.line.transportType === 'PEDESTRIAN' || part.line.label === 'Fussweg';

function normalizeMvgRoute(raw) {
  const legs = raw.parts.map(p => {
    const depart = new Date(new Date(p.from.plannedDeparture).getTime() + (p.from.departureDelayInMinutes || 0) * 60e3);
    const arrive = new Date(new Date(p.to.plannedDeparture).getTime() + (p.to.arrivalDelayInMinutes || 0) * 60e3);
    return {
      walk: isWalk(p),
      label: isWalk(p) ? 'Walk' : p.line.label,
      type: p.line ? p.line.transportType : 'PEDESTRIAN',
      destination: p.line ? p.line.destination : '',
      from: p.from.name, to: p.to.name,
      fromId: p.from.stationGlobalId || null,
      platform: p.from.platform ?? null,
      depart, arrive,
      minutes: Math.round((arrive - depart) / 60e3),
      delayMin: p.from.departureDelayInMinutes || 0,
      realtime: !!p.realTime,
      cancelled: !!p.isCancelled,
      messages: (p.messages || []).map(m => m.title || m.text || '').filter(Boolean)
    };
  });
  const rides = legs.filter(l => !l.walk);
  return {
    legs,
    depart: legs[0].depart,
    arrive: legs[legs.length - 1].arrive,
    minutes: Math.round((legs[legs.length - 1].arrive - legs[0].depart) / 60e3),
    changes: Math.max(rides.length - 1, 0),
    walkMin: legs.filter(l => l.walk).reduce((s, l) => s + l.minutes, 0),
    maxDelayMin: Math.max(0, ...rides.map(l => l.delayMin)),
    cancelled: legs.some(l => l.cancelled),
    firstStop: rides[0] ? { name: rides[0].from, id: rides[0].fromId, line: rides[0].label } : null,
    lines: rides.map(l => l.label)
  };
}

/**
 * Viable connections first (not cancelled, arriving by `arriveBy` with live delays), sorted by
 * 'latest' departure, fewest 'changes' or least 'walking'. Unusable ones follow, flagged.
 */
function rankRoutes(routes, sort = 'latest', arriveBy = null) {
  const marked = routes.map(r => ({ ...r, late: !!arriveBy && r.arrive > arriveBy, unusable: r.cancelled || (!!arriveBy && r.arrive > arriveBy) }));
  const byLatest = (a, b) => b.depart - a.depart;
  const cmp = {
    latest: byLatest,
    changes: (a, b) => a.changes - b.changes || byLatest(a, b),
    walking: (a, b) => a.walkMin - b.walkMin || byLatest(a, b)
  }[sort] || byLatest;
  return [...marked.filter(r => !r.unusable).sort(cmp), ...marked.filter(r => r.unusable).sort(byLatest)];
}

// ================= CAR & BIKE (TomTom via the Worker) =================

function normalizeTomTom(json) {
  const s = json.routes && json.routes[0] && json.routes[0].summary;
  if (!s) throw new Error('No route found');
  return {
    minutes: Math.round(s.travelTimeInSeconds / 60),
    delayMin: Math.round((s.trafficDelayInSeconds || 0) / 60),
    km: Math.round(s.lengthInMeters / 100) / 10,
    depart: s.departureTime, arrive: s.arrivalTime
  };
}

// mode: 'car' | 'bicycle'. Trips starting within 3 h use live traffic (depart now); later ones arrive-by.
async function roadRoute(workerUrl, mode, from, to, arriveBy) {
  const live = arriveBy - Date.now() < 3 * 3600e3;
  const params = new URLSearchParams({ mode, from: `${from.lat},${from.lon}`, to: `${to.lat},${to.lon}` });
  if (!live) params.set('arriveAt', arriveBy.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const url = `${workerUrl.replace(/\/$/, '')}/route?${params}`;
  return { ...(await cachedFetch(url, { ttl: 90e3, key: `road:${mode}` })), live };
}

/**
 * Door-to-door comparison for one trip. Each mode: { mode, minutes (incl. parking/walk buffer),
 * leaveBy (Date), delayMin }. The fastest gets `fastest: true`; within 2 min MVG wins
 * (no parking, and the semester ticket is already paid).
 */
function compareModes({ mvg, car, bike }, { arriveBy, carBufferMin = 0, bikeBufferMin = 0 }) {
  const modes = [];
  if (mvg) modes.push({ mode: 'mvg', minutes: mvg.minutes, leaveBy: mvg.depart, delayMin: mvg.maxDelayMin });
  if (car) {
    const minutes = car.minutes + carBufferMin;
    modes.push({ mode: 'car', minutes, leaveBy: new Date(arriveBy - minutes * 60e3), delayMin: car.delayMin, km: car.km });
  }
  if (bike) {
    const minutes = bike.minutes + bikeBufferMin;
    modes.push({ mode: 'bike', minutes, leaveBy: new Date(arriveBy - minutes * 60e3), delayMin: 0, km: bike.km });
  }
  if (!modes.length) return modes;
  const best = Math.min(...modes.map(m => m.minutes));
  const mvgMode = modes.find(m => m.mode === 'mvg');
  const winner = mvgMode && mvgMode.minutes - best <= 2 ? mvgMode : modes.find(m => m.minutes === best);
  winner.fastest = true;
  return modes;
}

// ================= MENSA =================
const EAT_API = 'https://tum-dev.github.io/eat-api/';

// ISO 8601 week of a 'YYYY-MM-DD' date
function isoWeek(dateStr) {
  const thursday = addDays(dateStr, 3 - weekdayIndex(dateStr)); // the week belongs to the year of its Thursday
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`; // always in week 1
  const week1Thursday = addDays(jan4, 3 - weekdayIndex(jan4));
  return { year, week: 1 + daysBetween(week1Thursday, thursday) / 7 };
}

// Menu days [{ date, dishes: [{ name, dish_type, labels, prices }] }] around a date, or null without a source
async function canteenWeek(canteen, dateStr, workerUrl) {
  if (canteen.viaWorker) {
    if (!workerUrl) return null;
    return (await cachedFetch(`${workerUrl.replace(/\/$/, '')}/mensa/ottobrunn`, { ttl: 3 * 3600e3 })).days || [];
  }
  const { year, week } = isoWeek(dateStr);
  const res = await cachedFetch(`${EAT_API}${canteen.id}/${year}/${String(week).padStart(2, '0')}.json`, { ttl: 6 * 3600e3 });
  return res.days || [];
}

// Studierendenwerk prices go by dish type (Grill, Pasta, …), so a Garching price fills in Ottobrunn's
function priceTable(days) {
  const table = {};
  for (const d of days || []) for (const dish of d.dishes || []) {
    if (dish.prices && dish.dish_type && !table[dish.dish_type]) table[dish.dish_type] = dish.prices;
  }
  return table;
}

function formatPrice(prices) {
  const p = prices && prices.students;
  if (!p) return '';
  const eur = n => `€${n.toFixed(2)}`;
  const perUnit = p.price_per_unit ? `${eur(p.price_per_unit)}/${p.unit}` : '';
  if (p.base_price && perUnit) return `${eur(p.base_price)} + ${perUnit}`;
  return p.base_price ? eur(p.base_price) : perUnit;
}

const DIETS = {
  all: () => true,
  vegetarian: d => d.labels.includes('VEGETARIAN') || d.labels.includes('VEGAN'),
  vegan: d => d.labels.includes('VEGAN'),
  nopork: d => !d.labels.includes('PORK')
};

/**
 * The Studierendenwerk's menu page (HTML only, no CORS) → Eat API JSON shape.
 * Used by the Worker for Mensa Ottobrunn, which the Eat API doesn't cover yet.
 * data-essen-fleischlos: 0 meat, 1 vegetarian, 2 vegan; data-essen-typ: R beef, S pork.
 */
function parseStwmMenu(html) {
  const days = [];
  const sections = html.split(/c-schedule__header\s+heute_/).slice(1);
  for (const section of sections) {
    const date = section.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const dishes = [];
    for (const [li] of section.matchAll(/<li class="c-menu-dish-list__item[\s\S]*?<\/li>/g)) {
      const attr = name => (li.match(new RegExp(`data-essen-${name}="([^"]*)"`)) || [])[1] || '';
      const name = (li.match(/c-menu-dish__title">([\s\S]*?)<\/p>/) || [])[1];
      if (!name) continue;
      const labels = [];
      const meatless = attr('fleischlos');
      if (meatless === '2') labels.push('VEGAN', 'VEGETARIAN');
      if (meatless === '1') labels.push('VEGETARIAN');
      const kind = attr('typ').split(',');
      if (kind.includes('S')) labels.push('PORK');
      if (kind.includes('R')) labels.push('BEEF');
      if (attr('allergene').split(',').includes('Fi')) labels.push('FISH');
      dishes.push({
        name: decodeXml(name.replace(/<[^>]+>/g, '').trim()),
        dish_type: decodeXml(((li.match(/stwm-artname">([^<]*)</) || [])[1] || '').trim()),
        labels,
        prices: null
      });
    }
    days.push({ date, dishes });
  }
  return { days };
}

/**
 * Longest free stretch inside canteen hours on a day, at least 30 min: { from, to } in minutes,
 * or null when classes fill lunchtime. `classes` = that day's sessions you attend.
 */
function lunchWindow(classes, hours = LUNCH_HOURS, minMinutes = 30) {
  const busy = classes.map(c => [c.startMin, c.endMin]).sort((a, b) => a[0] - b[0]);
  let best = null;
  let cursor = hours.from;
  for (const [s, e] of [...busy, [hours.to, hours.to]]) {
    const gapEnd = Math.min(s, hours.to);
    if (gapEnd - cursor >= minMinutes && (!best || gapEnd - cursor > best.to - best.from)) best = { from: cursor, to: gapEnd };
    cursor = Math.max(cursor, e);
    if (cursor >= hours.to) break;
  }
  return best;
}

// ================= NAVIGATUM =================
const NAV_API = 'https://nav.tum.de/api/';

function navLink(room) {
  const id = roomIdFrom(room);
  return id ? `https://nav.tum.de/room/${id}` : `https://nav.tum.de/search?q=${encodeURIComponent(String(room).split('(')[0].trim())}`;
}

// { id, name, lat, lon, building, floor, address } for a room string, or null
async function roomInfo(room) {
  let id = roomIdFrom(room);
  if (!id) {
    const q = String(room).split(/[·,(]/)[0].trim();
    if (!q) return null;
    const res = await cachedFetch(`${NAV_API}search?q=${encodeURIComponent(q)}&limit_all=3`, { ttl: 30 * 864e5 });
    const hit = (res.sections || []).flatMap(s => s.entries || []).find(e => e.type === 'room' || e.type === 'building');
    if (!hit) return null;
    id = hit.id;
  }
  const d = await cachedFetch(`${NAV_API}locations/${encodeURIComponent(id)}`, { ttl: 30 * 864e5 });
  const props = Object.fromEntries(((d.props && d.props.computed) || []).map(p => [p.name, p.text]));
  const parents = d.parent_names || [];
  return {
    id, name: d.name,
    lat: d.coords && d.coords.lat, lon: d.coords && d.coords.lon,
    building: parents[parents.length - 1] || '',
    floor: props.Stockwerk || props.Floor || '',
    address: props.Adresse || props.Address || '',
    link: `https://nav.tum.de/room/${id}`
  };
}

function distanceMeters(a, b) {
  const R = 6371e3, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ponytail: straight-line distance × 1.3 detour at 80 m/min; NavigaTUM has no walking router
function walkMinutes(a, b) {
  return Math.ceil(distanceMeters(a, b) * 1.3 / 80);
}

// ================= WEATHER (Open-Meteo) =================

async function weatherAt(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&hourly=precipitation_probability,precipitation,temperature_2m,weather_code&timezone=Europe%2FBerlin&forecast_days=7';
  const d = await cachedFetch(url, { ttl: 30 * 60e3 });
  return d.hourly.time.map((t, i) => ({
    date: t.slice(0, 10), hour: Number(t.slice(11, 13)),
    rainChance: d.hourly.precipitation_probability[i], rainMm: d.hourly.precipitation[i],
    tempC: d.hourly.temperature_2m[i], code: d.hourly.weather_code[i]
  }));
}

function hourForecast(hours, dateStr, minutes) {
  return hours.find(h => h.date === dateStr && h.hour === Math.floor(minutes / 60)) || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cachedFetch, normalizeMvgRoute, rankRoutes, normalizeTomTom, compareModes, isoWeek, priceTable, formatPrice, DIETS,
    parseStwmMenu, lunchWindow, navLink, distanceMeters, walkMinutes, hourForecast
  };
}
