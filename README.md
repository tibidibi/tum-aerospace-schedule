# TUM Aerospace schedule · WiSe 2026/27

> **Unofficial.** A student-made tool, not affiliated with, endorsed by, or maintained by the Technical University of Munich (TUM). Always check TUMonline for the official schedule.

Your 1st-semester Aerospace timetable, plus what you need to get through the day: when to leave and how, the Mensa menu, and the Moodle course of the class you're in. Material You design, tinted from a colour you pick.

No build step, no dependencies: plain HTML, CSS and JavaScript.

## What it does

**Today**
- A narrow day plan with a "now" line, next to your commute: **leave by**, MVG vs car vs bike, the connections with live delays and disruptions, rain at leave time, and a live departure board from your first stop.
- **Lunch:** your free window while the Mensa is open (11:00–14:00) and today's menu, filtered by diet.
- **Moodle** on the right for the class you're in or the next one. *Follow along* opens Moodle on the right half of your screen and moves it to each course as it starts.

**Week**, with semester weeks (breaks left out) and `.ics` export. **Groups**: pick your exercise groups, or let **Autopilot** rank all 1,456 combinations. **Squad**: share your schedule as a link and see shared groups and free time together.

**Your own appointments**: one-off or weekly. They show in the day plan and the week and go into the `.ics` export.

**TUMonline sync** (Settings › TUMonline): enter your TUM ID, activate the token named **TUM Flight Deck** in TUMonline › Token-Management, and the app syncs on its own. Your TUMonline calendar then wins: its times, rooms and cancellations replace the PDF data, and your exercise groups are picked from your registrations. The token stays in your browser. When you activate it, grant it **only calendar access**: that's all the app reads, and it limits what a leaked token could see.

Keys: **1–4** switch views, **← →** change week, **T** this week, **,** settings.

## Files

| Path | What's in it |
|---|---|
| `index.html`, `css/style.css` | The page and the Material You styles (every colour derived from one seed) |
| `js/timetable.js` | Courses, sessions, semester dates and campuses from the official timetable PDF |
| `js/calendar.js` | Semester weeks, TUMonline parsing and merge, `.ics` |
| `js/services.js` | MVG, TomTom (via the Worker), Mensa, NavigaTUM, weather |
| `js/autopilot.js` | Ranks exercise-group combinations |
| `js/squad.js` | Share links and free time together |
| `js/state.js` | Your groups, settings, appointments and the TUMonline connection |
| `js/app.js` | Everything you see and click |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installing as an app |
| `data/mensa-ottobrunn.json`, `scripts/`, `.github/workflows/` | Mensa Ottobrunn's menu, refreshed daily (below) |
| `worker/` | Optional Cloudflare Worker (below) |
| `tests/` | `node tests/features.test.js` |

## Run it locally

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080. A real web server is needed (not `file://`) for offline support.

## Host it on GitHub Pages

1. The repository has to be public (or on a paid plan).
2. Settings › Pages › Build and deployment › Source: **Deploy from a branch**, branch **main**, folder **/ (root)**.
3. After a minute it's live at `https://<your-user>.github.io/tum-aerospace-schedule/`. Open it on your phone and use *Add to Home Screen* to install it.

Every push to `main` redeploys. The `.nojekyll` file makes Pages serve the files as they are.

**Security note:** every project page under `https://<your-user>.github.io/` shares one origin, so any of your other Pages projects can read this app's localStorage, TUMonline token included. Keep no untrusted code in your other Pages repos, or give this app an origin of its own: a custom domain, or the `<your-user>.github.io` repository itself.

## Mensa menus

Garching's canteens come straight from the [Eat API](https://tum-dev.github.io/eat-api/). Mensa Ottobrunn isn't in it, and the Studierendenwerk only publishes it as an HTML page that other sites can't read. So a GitHub Action ([`.github/workflows/mensa-ottobrunn.yml`](.github/workflows/mensa-ottobrunn.yml)) runs [`scripts/fetch-mensa-ottobrunn.js`](scripts/fetch-mensa-ottobrunn.js) once a day and commits the result to `data/mensa-ottobrunn.json`, which Pages serves with the app. Nobody has to set anything up.

- Run it now: Actions › *Mensa Ottobrunn menu* › *Run workflow*, or locally with `node scripts/fetch-mensa-ottobrunn.js`.
- If the Studierendenwerk changes its page and no dishes are found, the run fails (GitHub emails you) and the last good menu stays.
- GitHub pauses scheduled workflows after 60 days without activity in the repository; re-enable it in the Actions tab.

## Optional: the Worker

A free Cloudflare Worker in [`worker/`](worker/) adds what a static page can't do on its own. Paste its URL into Settings › Advanced.

| Route | What it adds |
|---|---|
| `/route` | Car and bike times with live traffic (TomTom), keeping your API key secret |
| `/feed.ics?s=…` | A calendar subscription with "leave now" alerts |

```bash
cd worker
npx wrangler deploy
npx wrangler secret put TOMTOM_KEY
```

Set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your Pages origin (e.g. `https://you.github.io`): `/route` then answers only requests from that page, so other sites can't use your TomTom quota.

The page's Content-Security-Policy (in `index.html`) allows Workers on `*.workers.dev`. If yours runs on your own domain, add it to `connect-src` there.
