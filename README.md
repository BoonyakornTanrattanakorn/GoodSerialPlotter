# GoodSerialPlotter

A browser-based serial plotter that runs entirely as a static site (GitHub
Pages). It talks to your device directly via the **Web Serial API** — no
backend, no install, no local helper app.

Live: `https://<your-user>.github.io/GoodSerialPlotter/`

## Features

- **Direct USB/serial** in the browser (`navigator.serial`)
- **Configurable delimiter** — comma, tab, space, semicolon, or a custom regex
- **Auto-detecting format** per line:
  - delimited: `1.2,3.4,5.6`
  - labeled: `temp:25.1,rpm:1200` (series auto-named and column-stable)
- **High throughput** — handles a sustained **1000 Hz** stream by decoupling
  ingest from render (fixed ring buffer + min/max-per-pixel decimation, drawn
  on `requestAnimationFrame`)
- **Pause / resume**, drag **zoom** (x/y), reset zoom, Y autoscale toggle
- **Record + CSV export**
- **Send to device** (write commands back over serial)
- **Configurable** visible window (seconds) and max retained points
- **Dev mode** — synthetic 1 kHz, 3-channel source to try it without hardware

## Browser support

Web Serial is **Chromium-only** (Chrome, Edge, Opera) and requires a secure
context (HTTPS or `localhost`). GitHub Pages serves HTTPS, so the deployed
site works as-is. Firefox/Safari can still use **Dev mode**.

## Usage

1. Open the site, pick your **baud** rate.
2. Click **Connect** and choose the serial port in the browser prompt.
3. Set the **delimiter** to match your device output.
4. Plot updates live. Use **Pause**, drag to **zoom**, **Record** to capture,
   **Export CSV** to download.

To try without hardware, tick **Dev mode** before connecting.

## Run locally

Any static file server works (a secure context is required for Web Serial):

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## How the 1000 Hz path works

- The serial read loop streams bytes through `TextDecoderStream`, splitting on
  newlines and carrying partial lines across chunks.
- Each parsed sample is appended to a fixed-capacity `Float64Array` ring buffer
  — O(1), no per-sample allocation.
- Rendering is independent: ~60 fps, each frame copies just the visible time
  window and decimates it to roughly one min/max pair per horizontal pixel
  before handing it to [uPlot](https://github.com/leeoniya/uPlot). So the chart
  draws ~1–2k points no matter how fast data arrives.

## Project layout

```
index.html            layout + controls
styles.css
src/serial.js         Web Serial wrapper + dev-mode fake source
src/parser.js         configurable delimiter + auto-detect
src/ringbuffer.js     fixed-capacity typed-array buffers
src/decimate.js       min/max-per-pixel downsampling
src/plot.js           uPlot setup + updates
src/recorder.js       session capture + CSV export
src/app.js            ingest/render glue + UI wiring
vendor/               pinned uPlot
.github/workflows/    GitHub Pages deploy
```

## License

MIT
