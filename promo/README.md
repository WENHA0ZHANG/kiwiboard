# kiwiboard promo video

`kiwiboard-promo-4x3.mp4`: 1440 × 1080 (4:3), 60 fps, 56.7 s, H.264, with a light synthesised music track (AAC).

| Time | Scene |
|---|---|
| 0–2 s | The kiwi springs in, the letters hop in, then the slogan |
| 2–4 s | 11 indicators: a name and a year of history on each tile |
| 4–10 s | Four of them score (Nov 20: VIX +3.0, S&P 500 PE +1.2, Fear & Greed +3.0, RSI +1.4). The points line up, then drop one at a time into one Market Regime score, Buy +8.6, then the 7 bands |
| 10–28 s | Replay: Nasdaq Composite daily candles, Jan 28 → Nov 25, with the daily regime score, push toasts and both bottom calls |
| 28–31 s | The chart and its regime card fade out; the phone appears: "Now on your phone" |
| 31–38 s | Turning on regime alerts, then a push notification (shown large on the right) |
| 38–46 s | Market, then Watchlist (spotlight on Special Focus), Global, News (BTC → its chart → Bitcoin headlines) |
| 46–53 s | The same News page in Safari (its toolbar slides up) → Share → Add to Home Screen → Home Screen → open the app |
| 53–57 s | Dark end card |

## Data

- Candles: `^IXIC` daily OHLC from Yahoo Finance.
- Regime score: rebuilt for each trading day from `/api/indicator-history`, using the formula in `cloudflare/worker/src/lib/regime.ts`. On Mar 30 and Nov 20 the video shows the logged calls from the README track record (+6.4 and +8.6). The end-of-day rebuild gives +6.7 and +7.6 on those days, because the stored Fear & Greed close differs from the intraday reading at call time.
- In 2026 the score peaked at Buy (+8.6) and bottomed at Caution (−4.4, Jun 15). It never reached Strong Buy or Risk.
- Phone screens are light-mode captures of poortrader.com from 2026-11-27, 4 PM SGT. In those captures the Sign in button and the install icon are hidden. The alert dialog, iOS prompts, Safari and the Home Screen are redrawn in HTML.
- The Home Screen wallpaper is one solid colour from the kiwi logo: its skin brown, `#95683d`.

## Edit and re-render

The whole video is `kiwiboard-promo.html`. Every frame is a pure function of time. Scene timings live in `TL` and `TOUR` near the top of the script, and the replay's pacing lives in `KF`. To preview, serve the folder (for example `python3 -m http.server`) and open the page: Space plays, ← and → step through frames, and the bar scrubs.

```bash
node render.mjs frames /tmp/kb-frames 60 8                      # about 1 min, headless Chrome
swift encode.swift /tmp/kb-frames /tmp/kb-video.mp4 60 16000000
python3 music.py /tmp/kb-music.wav                             # 120 BPM, C major, cues follow TL
afconvert -f m4af -d aac -b 192000 /tmp/kb-music.wav assets/music.m4a
swift mux.swift /tmp/kb-video.mp4 assets/music.m4a kiwiboard-promo-4x3.mp4
node render.mjs snap /tmp/kb-snaps 12.5,24.0,45.4               # single PNG frames to check
```

`encode.swift` uses AVFoundation, so ffmpeg isn't needed.
