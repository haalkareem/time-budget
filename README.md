# Time Budget

A personal weekly time-budget tracker that installs to the iPhone home screen.
Plain HTML, CSS and JavaScript: no backend, no accounts, no build step.
All data stays in the browser's `localStorage` on your device.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, iPhone meta tags, tab bar |
| `styles.css` | Layout, light and dark themes, safe-area padding |
| `app.js` | Data model, timer, week maths, all three screens |
| `sw.js` | Service worker that caches the app for offline use |
| `manifest.webmanifest` | Name, icons, standalone display mode |
| `icons/` | 180, 192 and 512 px PNG icons |

## Test locally

Service workers need `http://localhost` or HTTPS, so opening `index.html`
straight from Finder runs the app but without offline support. Serve the
folder instead:

```bash
cd "/Users/kareemhaal/Desktop/TIme tracker"
```

```bash
python3 -m http.server 8123
```

Then open <http://localhost:8123> in Safari or Chrome. For a phone-sized view,
use the browser's responsive design mode (Safari: Develop > Enter Responsive
Design Mode).

To try it on your iPhone before deploying, put the phone on the same Wi-Fi and
open `http://<your-mac-ip>:8123`. The app works there, but offline caching and
a proper home-screen install need HTTPS, so use GitHub Pages for the real thing.

Things worth trying:

- Tap a card to start, tap another to switch, close the tab and reopen: the timer is still running.
- Offline: load the page once, stop the server, reload. It still opens.
- Forgotten timer: start a timer, set "Warn about timers longer than" to `0.01` hours in Settings, wait a minute, reload.
- Settings > Add manual session: try an end before the start, or a time that overlaps another session.

## Deploy on GitHub Pages

1. Create a new repository on GitHub (public, or private with a plan that allows Pages).
2. Push this folder to it:

   ```bash
   git init -b main
   ```

   ```bash
   git add index.html styles.css app.js sw.js manifest.webmanifest icons README.md
   ```

   ```bash
   git commit -m "Time Budget"
   ```

   ```bash
   git remote add origin https://github.com/<your-user>/<your-repo>.git
   ```

   ```bash
   git push -u origin main
   ```

3. On GitHub: **Settings > Pages > Build and deployment**. Set Source to
   **Deploy from a branch**, branch **main**, folder **/ (root)**, and save.
4. After a minute the app is live at `https://<your-user>.github.io/<your-repo>/`.

Every path in the app is relative, so it works from that sub-path as is.

### Shipping an update

Push the changed files. The service worker serves the cached copy first and
refreshes it in the background, so an installed app shows the new version on
the **second** launch after the update. To force every copy to drop its old
cache at once, bump `CACHE` in `sw.js` (for example to `time-budget-v2`).

## Add to the iPhone home screen

1. Open the GitHub Pages URL in **Safari** on the iPhone.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Launch it from the new icon. It opens full screen, without Safari's bars, and works offline.

Two things to know about iOS:

- The home-screen app has its **own storage**, separate from the Safari tab.
  Data entered in Safari before installing does not carry over. Use
  Settings > Export in one and Import in the other to move it.
- Storage belongs to the URL. If you change the repository name or domain, export first.

## How it behaves

- **Timer.** Only the start time is stored. Elapsed time is always computed
  from the clock, so it stays right when iOS suspends the app, and the timer
  survives closing the app. One timer at a time: starting another stops and
  saves the current one. A timer stopped in under 10 seconds is treated as an
  accidental tap and not saved.
- **Midnight and week boundaries.** A session is stored once; totals clip it
  to each day and week, so each gets only its own share.
- **Forgotten timer.** If the running timer is longer than the warning
  threshold (4 hours by default) when you open the app, it asks whether to
  keep it, stop it now, or set the real end time.
- **Sessions.** A manual or edited session is rejected, with the reason, if it
  ends before it starts, has zero length, ends in the future, or overlaps
  another session or the running timer.
- **Areas.** Deleting an area that has tracked time archives it instead, so
  history is kept. Archived areas can be restored. A budget of 0 shows tracked
  time with no progress bar.
- **Pace.** On the Week tab the mark on each bar is where an even pace would
  be at this point in the week; the hint says how far ahead or behind you are.
- **Bad data.** If the saved data cannot be read, the app starts from the
  default areas and keeps the unreadable text under the `timeBudget.corruptBackup`
  key (Settings shows an "Export unreadable backup" button).
- **Import.** The file's structure and `schemaVersion` are checked, and you
  confirm before anything is overwritten.
- **Clock changes.** If the device clock moves backwards, elapsed time is clamped to zero.

## Data format

Stored under the `localStorage` key `timeBudget.data`; the export is the same object.

```json
{
  "schemaVersion": 1,
  "areas": [{ "id": "…", "name": "Writing", "color": "#C08552", "weeklyBudgetMinutes": 360, "archived": false }],
  "sessions": [{ "id": "…", "areaId": "…", "startTs": 1791576000000, "endTs": 1791579600000, "note": "" }],
  "activeTimer": { "areaId": "…", "startTs": 1791580000000 },
  "settings": { "weekStartsOn": 1, "longSessionWarnHours": 4 }
}
```

Timestamps are milliseconds since the Unix epoch (UTC). `weekStartsOn` uses
0 for Sunday through 6 for Saturday. `activeTimer` is `null` when nothing is running.
