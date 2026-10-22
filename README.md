# TUM Aerospace 1st Semester — Draft Schedule Calendar (WiSe 2026/2027)

> **Unofficial.** This is a student-made tool. It is not affiliated with, endorsed by, or maintained by the Technical University of Munich (TUM). Schedule data is transcribed from the published timetable PDF and may be outdated or contain errors — always check TUMonline for the official schedule.

An unofficial, lightweight web application built specifically to help B.Sc. Aerospace 1st-semester students pick their exercise groups, toggle skipped classes, and calculate total time spent in classes.

Styled faithfully in the **Google Calendar / Material Design 3** visual language (clean surfaces, non-neon Google colors, Google-style event cards, and time grid).

---

## Features

1. **All 46 Sessions Verified from the Updated PDF Plan (Status: 05.10.2026)**:
   - `Electrical Engineering` (Prof. Herzog, Garching Campus)
   - `Advanced Mathematics for Engineers 1` (Renger, OTN, 14 tutorial groups updated with new slots)
   - `Engineering Mechanics I` (Prof. Ryll, OTN, 4 parallel tutorial rooms)
   - `Computational Foundations I` (Prof. Werner, OTN & Garching, 13 tutorial groups)
   - `CAD/TD` (Radeck, OTN, Groups 1&2 and Groups 3&4)
   - `Aerospace Materials` (Prof. Drechsler, OTN)
   - `Introduction to Aerospace` (OTN)

2. **Group Selection & Comparison Matrix**:
   - **Sidebar Group Pickers**: Switch between groups with live warning indicators (`⚠️ Overlap`) if an option conflicts with other classes.
   - **Group Comparison Matrix View**: A dedicated view comparing all groups side-by-side with days, hours, rooms, and professors.
   - **Show All Options (Ghost Slots)**: Checkbox on the calendar view to display alternative group slots as translucent ghost cards with 1-click "Choose" buttons.

3. **Skipping Classes**:
   - Skip or un-skip any class directly from the calendar cards, the Agenda view, or the event detail dialog.
   - Skipped classes are visually muted with dashed borders and strikethroughs.
   - Skipped hours are automatically deducted from your weekly total.

4. **Live Time Calculation**:
   - **Total Weekly Hours**: Formatted clearly in Google style (e.g., `27h 30m`).
   - **Scheduled vs. Attended vs. Skipped**: Immediate visual accounting.
   - **Daily Distribution**: Hours per day (Monday to Friday).
   - **Course Breakdown**: Stacked color-coded progress bar showing time distribution across subjects.
   - **Campus Location Tracker**: Notes travel requirements (Monday in Garching MW, Tuesday–Friday in Ottobrunn OTN).

5. **Dark Mode & Google Styling**:
   - Toggle seamlessly between Light and Dark Google Calendar themes (Material Design 3 dark palette).
   - Automatically adapts or saves your preference in `localStorage`.
   - Single-click **Reset Schedule** button to restore default conflict-free choices and unskip all classes.

6. **Google Calendar Export (.ics)**:
   - One-click export to download a `.ics` file ready to import directly into Google Calendar, Apple Calendar, or Outlook.

7. **Zero Dependencies**:
   - Pure HTML, CSS, and vanilla JavaScript. Runs offline and fast without npm builds or external libraries.

---

## How to Run

### Option 1: Open Directly in Browser
Double-click `index.html` or open it with your favorite browser:
```bash
# On Linux
xdg-open index.html
```

### Option 2: Local HTTP Server
Run Python's built-in web server:
```bash
python3 -m http.server 8080
```
Then visit `http://localhost:8080` in your browser.

---

## Automated Verification
Run the ponytail logic test suite:
```bash
node test_scheduler.js
```
