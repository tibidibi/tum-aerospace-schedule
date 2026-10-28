# TUM Aerospace schedule · WiSe 2026/27

> **Unofficial.** A student-made tool, not affiliated with, endorsed by, or maintained by the Technical University of Munich (TUM). Always check TUMonline for the official schedule.

Two front ends for the same schedule:

| Folder | What it is |
|---|---|
| [`cupertino/`](cupertino/) | The new Material You app, tinted from a colour you pick in Settings: navigation drawer, a narrow day plan next to your commute (leave-by, MVG/car/bike, live departures) and lunch, Moodle on the right. Week, Groups (with Autopilot) and Squad views. |
| [`flight-deck/`](flight-deck/) | The original Flight Deck app with its four styles, tests, the Cloudflare Worker and the timetable PDF. See its [README](flight-deck/README.md). |

Both apps use the same browser storage, so your groups, home address and TUMonline token carry over between them.

## Run it

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080/cupertino/ (or `/flight-deck/`).

`cupertino/` has its own copies of the schedule logic from `flight-deck/` (`data.js`, `calendar.js`, `services.js`, `optimizer.js`, `squad.js`). If you fix one, fix the other.
