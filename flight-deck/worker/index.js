/**
 * TUM Flight Deck Worker (Cloudflare). Optional: the page works without it, with MVG only.
 *   GET /route?mode=car|bicycle&from=lat,lon&to=lat,lon[&arriveAt=ISO]  TomTom with live traffic (key stays here)
 *   GET /mensa/ottobrunn                                                 Mensa Ottobrunn menu as Eat API JSON
 *   GET /feed.ics?s=<share code>                                         Subscribable calendar with "leave now" alarms
 * Deploy: npx wrangler deploy && npx wrangler secret put TOMTOM_KEY
 */
import data from '../data.js';
import calendar from '../calendar.js';
import services from '../services.js';
import optimizer from '../optimizer.js';
import squad from '../squad.js';

// The shared modules are plain browser scripts that read each other through globals
Object.assign(globalThis, data, calendar, services, optimizer, squad);

const MENU_URL = 'https://www.studierendenwerk-muenchen-oberbayern.de/gastronomie/speiseplan/speiseplan_433_-de.html';
const COORD = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;

function respond(body, { status = 200, type = 'application/json', origin = '*', maxAge = 0 } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': `${type}; charset=utf-8`,
      'access-control-allow-origin': origin,
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store'
    }
  });
}

// Edge cache (absent when running under Node in the tests)
async function cached(key, maxAge, produce) {
  const cache = globalThis.caches && globalThis.caches.default;
  const req = new Request(`https://cache.flight-deck/${key}`);
  const hit = cache && await cache.match(req);
  if (hit) return hit.json();
  const value = await produce();
  if (cache) await cache.put(req, respond(value, { maxAge }));
  return value;
}

async function road(url, env) {
  const mode = url.searchParams.get('mode');
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const arriveAt = url.searchParams.get('arriveAt');
  if (!['car', 'bicycle'].includes(mode) || !COORD.test(from) || !COORD.test(to) || (arriveAt && !ISO.test(arriveAt))) {
    return [{ error: 'Expected mode=car|bicycle, from=lat,lon, to=lat,lon and optionally arriveAt=ISO (UTC)' }, 400];
  }
  if (!env.TOMTOM_KEY) return [{ error: 'TOMTOM_KEY is not set on this Worker' }, 501];

  // ~100 m and 2-minute buckets, so a class full of students shares one TomTom call
  const round = s => s.split(',').map(n => Number(n).toFixed(3)).join(',');
  const bucket = arriveAt || new Date(Math.floor(Date.now() / 120e3) * 120e3).toISOString();
  const key = `route/${mode}/${round(from)}/${round(to)}/${bucket}`;
  const result = await cached(key, 120, async () => {
    const q = new URLSearchParams({ key: env.TOMTOM_KEY, travelMode: mode, traffic: 'true', routeType: 'fastest' });
    if (arriveAt) q.set('arriveAt', arriveAt);
    const res = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${round(from)}:${round(to)}/json?${q}`);
    if (!res.ok) throw new Error(`TomTom answered ${res.status}`);
    return normalizeTomTom(await res.json());
  });
  return [result, 200];
}

async function mensaOttobrunn() {
  return cached('mensa/ottobrunn', 3600, async () => {
    const res = await fetch(MENU_URL, { headers: { 'user-agent': 'TUM Flight Deck (student project)' } });
    if (!res.ok) throw new Error(`Studierendenwerk answered ${res.status}`);
    return { canteen: 'mensa-ottobrunn', source: MENU_URL, ...parseStwmMenu(await res.text()) };
  });
}

function feed(url) {
  const share = decodeShare(url.searchParams.get('s') || '');
  if (!share) return null;
  const classes = scheduleFor({ ...defaultGroups(), ...share.groups }, { skipped: new Set(share.skipped) });
  return buildICS(classes, { alarms: share.alarms, calName: share.name ? `${share.name} · TUM Aerospace` : undefined });
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET' } });
    }
    if (request.method !== 'GET') return respond({ error: 'GET only' }, { status: 405, origin });
    try {
      if (url.pathname === '/route') {
        const [body, status] = await road(url, env);
        return respond(body, { status, origin, maxAge: status === 200 ? 60 : 0 });
      }
      if (url.pathname === '/mensa/ottobrunn') return respond(await mensaOttobrunn(), { origin, maxAge: 1800 });
      if (url.pathname === '/feed.ics') {
        const ics = feed(url);
        return ics
          ? respond(ics, { type: 'text/calendar', origin, maxAge: 3600 })
          : respond({ error: 'Missing or invalid ?s= share code' }, { status: 400, origin });
      }
      if (url.pathname === '/') return respond('TUM Flight Deck worker: /route, /mensa/ottobrunn, /feed.ics', { type: 'text/plain', origin });
      return respond({ error: 'Not found' }, { status: 404, origin });
    } catch (e) {
      return respond({ error: e.message }, { status: 502, origin });
    }
  }
};
