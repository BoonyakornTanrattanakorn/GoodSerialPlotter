// Thin wrapper over uPlot. Owns chart construction, dynamic series, per-frame
// data updates, and a relative "T+" time axis. uPlot is a global
// (vendor/uPlot.iife.min.js).

export const PALETTE = [
  '#4ea1ff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8',
  '#ff922b', '#22b8cf', '#f06595', '#94d82d', '#a78bfa',
];

export function colorForChannel(i) {
  return PALETTE[i % PALETTE.length];
}

// Dark-theme colors for the canvas-drawn axes/grid (can't be styled via CSS).
const AXIS_STROKE = '#cfcfcf';
const GRID_COLOR = 'rgba(255,255,255,0.08)';
const TICK_COLOR = 'rgba(255,255,255,0.20)';

// Format seconds as a compact "T+" label, e.g. T+0, T-1.5s, T-1:05.
// Time is plotted relative to "now" (newest sample = 0), so values are <= 0.
function fmtRel(s) {
  if (!isFinite(s)) return '';
  if (Math.abs(s) < 1e-9) return 'now';
  const prefix = s < 0 ? 'T-' : 'T+';
  s = Math.abs(s);
  if (s < 60) {
    const str = s % 1 === 0 ? s.toFixed(0) : s.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${prefix}${str}s`;
  }
  const m = Math.floor(s / 60);
  const rem = (s - m * 60);
  return `${prefix}${m}:${rem.toFixed(0).padStart(2, '0')}`;
}

// Format Y-tick values with a fixed number of decimals matching the incoming
// data's precision (e.g. a device sending "25.13" gets 2-decimal labels;
// integer data gets integer labels). `dataDecimals` comes from the parser.
function makeYFormatter(dataDecimals) {
  const dp = Math.min(6, Math.max(0, dataDecimals));
  return (u, splits) =>
    splits.map((v) =>
      v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }));
}

// Allowed Y tick increments (1/2/5 × 10^n), floored at the data's smallest
// step (10^-decimals) so the axis never subdivides finer than the data does.
function yIncrs(dataDecimals) {
  const min = Math.pow(10, -Math.min(6, Math.max(0, dataDecimals)));
  const out = [];
  for (let exp = -6; exp <= 12; exp++) {
    const base = Math.pow(10, exp);
    for (const m of [1, 2, 5]) {
      const v = m * base;
      if (v >= min - 1e-12) out.push(Number(v.toPrecision(12)));
    }
  }
  return out;
}

export class Plot {
  // sizeFn: () => ({ width, height }). traces: [{ name, color }].
  constructor(mountEl, sizeFn) {
    this.mountEl = mountEl;
    this.sizeFn = sizeFn;
    this.u = null;
    this.traceCount = 0;
    this.autoscale = true;
    this.windowSec = 10;     // current visible width; drives the fixed x-range
    this.userZoomed = false; // user dragged an x-zoom -> release the pin
  }

  size() { return this.sizeFn(); }

  build(traces, yDecimals = 0) {
    if (this.u) { this.u.destroy(); this.u = null; }
    this.traceCount = traces.length;
    this.yDecimals = yDecimals;

    const baseAxis = {
      stroke: AXIS_STROKE,
      grid: { stroke: GRID_COLOR, width: 1 },
      ticks: { stroke: TICK_COLOR, width: 1 },
      font: '13px system-ui, sans-serif',
      labelFont: '600 13px system-ui, sans-serif',
      labelSize: 22,
    };

    const series = [{ label: 'time' }];
    for (const tr of traces) {
      series.push({
        label: tr.name,
        stroke: tr.color,
        width: 1.5,
        spanGaps: false,
        points: { show: false },
      });
    }

    const opts = {
      ...this.size(),
      series,
      axes: [
        { ...baseAxis, label: 'Time (relative to now)', size: 44, space: 80,
          values: (u, splits) => splits.map(fmtRel) },
        // Wider y gutter so multi-digit value labels never clip out of the box.
        // incrs caps tick spacing at the data's smallest meaningful step.
        { ...baseAxis, size: 64, space: 36,
          values: makeYFormatter(yDecimals),
          incrs: yIncrs(yDecimals) },
      ],
      scales: {
        // x is plotted relative to now; pin it to a fixed [-window, 0] range so
        // the axis and gridlines stay stationary and only the data scrolls.
        // Once the user drag-zooms x, release the pin and let uPlot manage it.
        x: { time: false, range: (u, min, max) => this.userZoomed ? [min, max] : [-this.windowSec, 0] },
        y: { auto: () => this.autoscale },
      },
      cursor: {
        drag: { x: true, y: true, uni: 10 },
        // Show "T+" in the cursor legend too.
        focus: { prox: 16 },
      },
      legend: { live: true },
      hooks: {
        // Remember when the user manually zooms x so we stop following the live edge.
        setSelect: [(u) => {
          if (u.select.width > 0) this.userZoomed = true;
        }],
      },
    };

    const data = [[], ...traces.map(() => [])];
    this.u = new uPlot(opts, data, this.mountEl);
  }

  resize() { if (this.u) this.u.setSize(this.size()); }

  // frame: { time, series }. The time column is shifted so the newest sample
  // sits at x=0 ("now") and older samples are negative. Combined with the fixed
  // [-windowSec, 0] x-range, the axis & gridlines stay completely stationary
  // and only the data scrolls leftward.
  setData(frame, windowSec) {
    if (!this.u) return;
    this.windowSec = windowSec; // read by the x range fn (re-run each frame)

    let time = frame.time;
    if (time.length) {
      const latest = time[time.length - 1];
      // Shift into "relative to now" coordinates (cheap; one pass).
      const rel = new Float64Array(time.length);
      for (let i = 0; i < time.length; i++) rel[i] = time[i] - latest;
      time = rel;
    }

    // Pass resetScales=true so uPlot re-runs the scale range fns and repaints
    // every frame. Our x range fn returns the fixed [-window, 0] (stationary
    // axis) and y autoscales, so this gives a live-scrolling redraw. With
    // resetScales=false uPlot skips the repaint when the pinned range is
    // unchanged, which froze the graph.
    this.u.setData([time, ...frame.series], true);
  }

  setAutoscale(on) {
    this.autoscale = on;
    if (this.u) this.u.redraw();
  }

  resetZoom() {
    if (!this.u) return;
    this.userZoomed = false; // resume the stationary live window
    // Re-pin x to [-window, 0] and let y autoscale again.
    this.u.setScale('x', { min: -this.windowSec, max: 0 });
    this.u.setScale('y', { min: null, max: null });
  }

  destroy() { if (this.u) { this.u.destroy(); this.u = null; } }
}
