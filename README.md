# Flight Deck · TUM Aerospace 1st Semester (WiSe 2026/27)

> **Unofficial.** A student-made tool, not affiliated with, endorsed by, or maintained by the Technical University of Munich (TUM). Always check TUMonline for the official schedule.

Your semester schedule plus what you need to get through the day: your real TUMonline calendar, when to leave and how (MVG, car or bike, with live traffic), the Mensa menu on the campus you're actually at, and the Moodle course of the class you're sitting in.

No build step, no dependencies: plain HTML, CSS and JavaScript.

---

## What it does

**Today** (the start screen)
- Countdown to your current and next class, with building, floor and a NavigaTUM map link. Warns when the walk between two rooms is longer than the break.
- **Leave by 07:25** on a split-flap display. Times come from MVG connections between your typed address and the actual lecture building, refreshed every minute with live delays and cancellations. You can sort by latest departure, fewest changes or least walking.
- **MVG vs car vs bike** side by side, with a "fastest right now" pick. Car uses live traffic plus parking time. Bike shows the rain forecast. Needs the Worker; see below.
- A live departure board for your first stop, disruptions on your lines, and rain at leave time.
- **Moodle panel** (right column) for the class you're in now or the next one. *Follow along* opens Moodle on the right half of your screen and switches it to the next course whenever a class starts.
- **Lunch:** your free window while the Mensa is open (11:00–14:00), and today's menu for Garching (Mensa, StuBistro, FMI Bistro) or **Mensa Ottobrunn**. Filter by diet, see student prices, and star favourite dishes to be told which day they're on.
- A "Went / Skipped" attendance log for today's finished classes.

**TUMonline sync** (Settings › TUMonline): the same access the TUM Campus app uses.
1. Enter your TUM ID and click *Request token*.
2. Activate the token named **TUM Flight Deck** under TUMonline › Token-Management (TUMonline also emails you about it).
3. The app notices on its own and syncs.

After that, **your TUMonline calendar wins**: its times, rooms and cancellations replace the PDF data, your exercise groups are picked from your registrations, and exams and extra sessions are added. Anything only the timetable PDF has is greyed out and marked **PDF**. The token stays in your browser and can be revoked in TUMonline at any time.

**Week, Groups, Agenda**
- Real semester weeks (‹ Week 2 of 17 ›). The Christmas break (24.12–06.01), Dies Academicus and Welcome@TUM are left out.
- **Autopilot** tries all 1,456 group combinations and ranks the conflict-free ones by latest start, earliest finish, fewest gaps, time for lunch or fewest campus days.
- Group matrix, alternative-group "ghost" cards, skipping, hour totals, print, and `.ics` export.

**Squad:** share your schedule as a link. Friends who open it can add you, and you them. You'll see shared groups, their initials on shared classes, and when you're all free together. Links contain only your name, groups and skipped classes.

**Also:** a command palette (**Ctrl/⌘ K**), shortcuts (**1–4** switch views, **← →** change week, **T** jumps to this week, **,** opens settings), dark mode, an installable app that works offline, and "leave in 10 min" notifications.

---

## Run it

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080. A real web server is needed (not `file://`) for offline support and installing the app. Phones need HTTPS, so for that host it on GitHub Pages: Settings › Pages › deploy from the `main` branch.

## Optional: the Worker

A free Cloudflare Worker in [`worker/`](worker/) adds three things that a static page can't do on its own:

| Route | What it adds |
|---|---|
| `/mensa/ottobrunn` | Mensa Ottobrunn's menu. It's only published as an HTML page with no CORS, and the Eat API doesn't cover Ottobrunn yet. |
| `/route` | Car and bike times with live traffic (TomTom), keeping your API key secret |
| `/feed.ics?s=…` | A calendar subscription with **"leave now" alerts** at your usual leave-by time, so your phone reminds you even when the app is closed |

```bash
cd worker
npx wrangler deploy
npx wrangler secret put TOMTOM_KEY   # free key from developer.tomtom.com; only needed for car/bike
```

Paste the Worker's URL into Settings › Worker. In `wrangler.toml`, set `ALLOWED_ORIGIN` to your Pages origin so other sites can't use your TomTom quota.

## Data sources

| What | Where |
|---|---|
| Your schedule | TUMonline web services (`campus.tum.de/tumonline/wbservicesbasic.*`), as used by the TUM Campus app |
| Fallback schedule | `Stundenplan_WiSe_26_27_-_1_FS_2026-09-22.pdf` (status 05.10.2026), in `data.js` |
| Semester dates | tum.de › Dates, periods and deadlines |
| Public transport | MVG (`mvg.de/api/bgw-pt/v3`) |
| Car / bike | TomTom Routing API (via the Worker) |
| Mensa | TUM-Dev Eat API; Studierendenwerk page for Ottobrunn (via the Worker) |
| Rooms | NavigaTUM (`nav.tum.de/api`) |
| Weather | Open-Meteo |

## Code map

| File | Role |
|---|---|
| `data.js` | Courses, PDF sessions, semester dates, campuses |
| `calendar.js` | Dates, TUMonline parsing and the merge rule, `.ics` builder |
| `services.js` | Offline fetch cache; MVG, TomTom, Mensa, NavigaTUM and weather clients and parsers |
| `optimizer.js`, `squad.js` | Autopilot; share-link codec and free-together finder |
| `settings.js`, `today.js`, `palette.js`, `app.js` | UI |
| `sw.js`, `manifest.webmanifest` | Offline support and installable app |
| `worker/` | The optional Cloudflare Worker |

The logic files are plain scripts that also run under Node and in the Worker.

## Tests

```bash
node test_scheduler.js
```

```bash
node test_features.js
```

`test_features.js` covers semester dates, TUMonline parsing and merging, `.ics` export, MVG ranking (on a saved real response), the mode comparison, the Ottobrunn menu parser (on a saved real page), the optimizer, squad links and the Worker routes.
