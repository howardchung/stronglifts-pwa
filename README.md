# Stronglifts 5×5 PWA

A mobile-first, offline-capable Progressive Web App for tracking Stronglifts 5×5 workouts. Plain HTML/CSS/JS, no build step, no dependencies.

## Features
- **Today:** shows the next workout (A or B alternate automatically) with its suggested weights. You can switch A/B before you start.
- **Auto progression:** each exercise gets the weight from your last workout plus its increment (5 lb by default). By default the weight only goes up if you completed every set and rep. If you missed reps, the weight stays the same. You can turn this off in Settings.
- **Custom weights:** tap the weight on a workout to change it (shows ±increment and plates per side). You can also set the "next weight" for any exercise in Settings.
- **Edit A/B days:** add, edit, reorder or remove exercises, with custom sets, reps and increment for each.
- **Set tracking:** tap a set to mark it done (5). Tap again to count down the reps you actually got (4, 3, … 0), then tap once more to clear it.
- **Rest timer:** starts automatically when you log a set (90 s, configurable), with +30s and Skip buttons.
- **Timer notification:** a system notification updates every second with the time left, the next set and the end time. It has +30s and Skip buttons. When the rest ends you get a vibrating notification.
- **History:** a list of every recorded workout, with weights and reps per set (green = all reps done, red = missed reps).
- **Storage:** on first launch the app asks you where to save your data. **Create new data file…** opens the Android file picker so you can choose a folder and file name. **Open existing data file…** reuses a file you already have (e.g. after reinstalling, or one in a synced folder). Every change is written to that JSON file, and a copy is kept in localStorage.
  - Browsers without the File System Access API (Firefox, iOS Safari) use browser storage, and you can back up with Export/Import JSON.

## Run locally
```bash
npm start                    # http://localhost:8080
npm run start:https          # https://<your-lan-ip>:8443, self-signed cert auto-generated
```

All server options (environment variable equivalents: `HTTPS=1`, `PORT`, `HOST`, `SSL_CERT`, `SSL_KEY`):
```bash
node server.js [port]
node server.js --https [--port 8443] [--host 0.0.0.0] [--cert cert.pem --key key.pem]
```
- If you use `--https` without `--cert`/`--key`, the server creates a self-signed certificate in `.certs/` with `openssl`. The certificate covers `localhost`, your LAN IPs and your hostname. It is created again if your IP address changes.
- In HTTPS mode the server listens on `0.0.0.0`, so other devices on your network can reach it.
- The server never serves dotfiles (including `.certs/`), `scripts/`, `server.js`, `package.json` or `README.md`.

## Install on Android
Service workers, notifications and the File System Access API only work in a secure context, so the app must be served over **HTTPS** with a certificate the phone **trusts**. Chrome won't register a service worker on a page with a certificate error, even if you click through the warning. Without the service worker the app can't be installed, work offline or show notifications. Options:

1. **Static host (simplest):** upload this folder as-is to GitHub Pages, Netlify, Cloudflare Pages or Firebase Hosting.
2. **USB, no certificate needed:** connect the phone, run `adb reverse tcp:8080 tcp:8080` and `npm start`, then open `http://localhost:8080` on the phone. Chrome treats `localhost` as secure.
3. **Wi-Fi with the built-in self-signed certificate:**
   1. Run `npm run start:https` and note the `https://<lan-ip>:8443` URL it prints.
   2. Copy `.certs/cert.pem` to the phone.
   3. Install it via **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**. The exact menu names vary by phone.
   4. Open the LAN URL in Chrome.
4. **Wi-Fi with [mkcert](https://github.com/FiloSottile/mkcert):**
   1. Run `mkcert -install && mkcert <lan-ip> localhost`.
   2. Install the `rootCA.pem` from `mkcert -CAROOT` on the phone as a CA certificate (as in option 3).
   3. Run `node server.js --https --cert <lan-ip>+1.pem --key <lan-ip>+1-key.pem`.

> The private key in `.certs/` is only for development. It's listed in `.gitignore`, so don't commit or share it. Remove the CA certificate from your phone when you no longer need it.

Then in Chrome choose **⋮ → Add to Home screen / Install app**. Saving to a file you pick needs **Chrome for Android 132+**.

## Notes and limitations
- **File permission after restart:** Chrome remembers which file you picked, but Android may ask you to approve access again after the app restarts. The app then shows a one-tap **Allow access** prompt.
- **Background timer:** the service worker owns the rest-timer notification, not the page. While a timer is running it updates the notification every second, so the countdown keeps going when the app is in the background or closed. If you swipe the notification away while the timer is running, it comes back. The +30s and Skip buttons work without opening the app. When the rest ends, a separate vibrating "Rest over" notification replaces it.
  - Web notifications can't be marked as Android "ongoing" notifications, so the service worker shows the notification again whenever it's dismissed instead.
  - Chrome stops a single service-worker event after 5 minutes. Very long rests (well over 4½ minutes) may stop updating in the background, but they catch up as soon as you open the app. The notification always shows the end time ("Ends at 1:22:59 PM").
- Regenerate icons with `python3 scripts/make_icons.py` (needs Pillow).

## Files
| File | Purpose |
|---|---|
| `index.html`, `styles.css` | App shell and mobile UI |
| `js/app.js` | Data model, progression logic, views and actions |
| `js/storage.js` | Data file storage (File System Access API, file handle kept in IndexedDB) with localStorage fallback |
| `js/timer.js` | Rest timer shown in the app; keeps the service worker's timer in sync |
| `sw.js` | Offline caching and the rest-timer notification (countdown, re-show when dismissed, +30s/Skip buttons, "Rest over" alert) |
| `manifest.webmanifest`, `icons/` | PWA install metadata |
