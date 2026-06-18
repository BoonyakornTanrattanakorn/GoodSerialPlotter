// Bootstrap + glue. Decouples ingest (as fast as data arrives) from render
// (requestAnimationFrame). One shared ring buffer holds every channel; each
// PlotPanel decimates only the traces it shows, off that buffer.

import { isSupported, SerialSource, FakeSource } from './serial.js';
import { Parser } from './parser.js';
import { RingBuffer } from './ringbuffer.js';
import { decimate } from './decimate.js';
import { Recorder } from './recorder.js';
import { PlotPanel } from './plotpanel.js';
import { SerialMonitor } from './monitor.js';
import { windowStats } from './stats.js';

const $ = (id) => document.getElementById(id);

const state = {
  source: null,
  parser: new Parser(','),
  rb: null,
  recorder: new Recorder(),
  panels: [],
  maxPoints: 200000,
  windowSec: 10,
  paused: false,
  connected: false,
  t0: 0,
  channelCount: 0, // highest channel index discovered + 1
  lineCount: 0,
  lastStatsAt: 0,
  lastStatsCompAt: 0, // last per-trace window-stats computation
  rateEma: 0,
  monitor: null,
};

function freshBuffer() {
  state.rb = new RingBuffer(state.maxPoints, 1);
}

// ---- channel registry ------------------------------------------------------

function channels() {
  const out = [];
  for (let i = 0; i < state.channelCount; i++) {
    out.push({ idx: i, name: state.parser.seriesName(i) });
  }
  return out;
}

// ---- ingest (hot path) -----------------------------------------------------

function onLine(line) {
  // Feed the monitor every raw line, including ones that don't parse as data
  // (headers, log messages), before any early return.
  state.monitor.pushRx(line);

  const parsed = state.parser.parse(line);
  if (!parsed) return;
  const t = (performance.now() - state.t0) / 1000;
  state.rb.push(t, parsed.values);
  state.recorder.sample(t, parsed.values);
  state.lineCount++;
  if (state.rb.seriesCount > state.channelCount) {
    state.channelCount = state.rb.seriesCount;
  }
}

// ---- render (rAF) ----------------------------------------------------------

function frame() {
  requestAnimationFrame(frame);
  state.monitor.flush(); // cheap no-op unless the monitor tab is visible & dirty

  const rb = state.rb;
  const nameFn = (i) => state.parser.seriesName(i);
  const decimalsFn = (cols) => state.parser.decimalsFor(cols);

  // Always sync each panel's chart/empty-state, even before any data arrives,
  // so panels restored from cache show their (empty) chart immediately rather
  // than the "No traces selected" placeholder.
  for (const panel of state.panels) panel.syncSeries(nameFn, decimalsFn);

  const haveData = rb && rb.count > 0;
  if (haveData && !state.paused) {
    const latest = rb.timeAt(rb.count - 1);
    const from = latest - state.windowSec;
    const startLogical = rb.lowerBound(from);

    // Stats are a full pass over the window, so compute them at ~4Hz rather
    // than every frame (the plot itself still updates at full rAF rate).
    const now = performance.now();
    const doStats = now - state.lastStatsCompAt >= 250;
    if (doStats) state.lastStatsCompAt = now;

    for (const panel of state.panels) {
      const cols = panel.traceList();
      if (cols.length === 0) continue;
      const targetPixels = panel.plot.size().width;
      const f = decimate(rb, startLogical, rb.count, targetPixels, cols);
      panel.plot.setData(f, state.windowSec);

      if (doStats && panel.showStats) {
        const st = windowStats(rb, startLogical, rb.count, cols);
        panel.updateStats(st, state.parser.decimalsFor(cols));
      }
    }
  }
  updateStats();
}

function updateStats() {
  const now = performance.now();
  if (now - state.lastStatsAt < 250) return;
  const dt = (now - state.lastStatsAt) / 1000;
  const rate = state.lineCount / dt;
  state.rateEma = state.rateEma ? state.rateEma * 0.7 + rate * 0.3 : rate;
  state.lineCount = 0;
  state.lastStatsAt = now;

  const rec = state.recorder.recording ? ` · REC ${state.recorder.count}` : '';
  const pausedTxt = state.paused ? ' · PAUSED' : '';
  $('status').textContent =
    `${state.connected ? 'Connected' : 'Disconnected'} · ` +
    `${Math.round(state.rateEma)} Hz · ${state.rb?.count ?? 0} pts · ` +
    `${state.channelCount} ch · ${state.panels.length} plot${state.panels.length === 1 ? '' : 's'}${rec}${pausedTxt}`;
}

// ---- connection ------------------------------------------------------------

async function connect() {
  freshBuffer();
  state.channelCount = 0;
  state.parser.decimals = []; // re-learn precision for the new stream
  state.t0 = performance.now();
  state.lastStatsAt = state.t0;
  state.lineCount = 0;

  const handlers = { onLine, onStatus: (s) => ($('status').textContent = s) };
  state.source = $('devMode').checked ? new FakeSource(handlers) : new SerialSource(handlers);

  try {
    const baud = Number($('baud').value);
    await state.source.connect(baud);
    state.connected = true;
    setConnectedUI(true);
  } catch (err) {
    $('status').textContent = `Connect failed: ${err.message}`;
    state.source = null;
  }
}

async function disconnect() {
  await state.source?.disconnect();
  state.source = null;
  state.connected = false;
  setConnectedUI(false);
}

function setConnectedUI(on) {
  $('connect').disabled = on;
  $('disconnect').disabled = !on;
  $('pause').disabled = !on;
  $('record').disabled = !on;
  $('devMode').disabled = on;
  const canSend = on && !$('devMode').checked;
  $('send').disabled = !canSend;
  $('sendText').disabled = !canSend;
}

// ---- multi-plot management -------------------------------------------------

const plotHost = {
  getChannels: channels,
  onChange: () => savePlots(),
  onClose: (panel) => {
    state.panels = state.panels.filter((p) => p !== panel);
    savePlots();
  },
};

function addPlot(saved = null) {
  const panel = new PlotPanel($('workspace'), plotHost, saved);
  state.panels.push(panel);
  if (!saved) savePlots();
  return panel;
}

// ---- persistence: plots + traces + layouts ---------------------------------

const PLOTS_KEY = 'gsp.plots.v1';

function savePlots() {
  try {
    const data = state.panels.map((p) => p.serialize());
    localStorage.setItem(PLOTS_KEY, JSON.stringify(data));
  } catch {}
}

function restorePlots() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PLOTS_KEY) || 'null'); } catch {}
  if (saved && saved.length) {
    for (const s of saved) addPlot(s);
  } else {
    // First run: one empty plot to start from.
    addPlot();
  }
}

// ---- settings persistence --------------------------------------------------

const SETTINGS_KEY = 'gsp.settings.v1';
const SETTING_IDS = ['baud', 'delimiter', 'delimiterCustom', 'window', 'maxPoints', 'autoscale', 'devMode'];

function saveSettings() {
  const s = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    s[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function currentSettings() {
  const s = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    s[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return s;
}

// Apply a settings object to the controls + runtime state.
function applySettings(s) {
  if (!s) return;
  for (const id of SETTING_IDS) {
    if (s[id] === undefined) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = s[id];
    else el.value = s[id];
  }
  state.windowSec = parseFloat($('window').value) || state.windowSec;
  const mp = parseInt($('maxPoints').value, 10);
  if (mp >= 1000) state.maxPoints = mp;
  const delim = $('delimiter').value;
  if (delim === 'custom') { $('delimiterCustom').classList.remove('hidden'); applyDelimiter(); }
  else { $('delimiterCustom').classList.add('hidden'); state.parser.setDelimiter(delim, false); }
}

function restoreSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { s = null; }
  applySettings(s);
}

// ---- reset data + layout file save/load ------------------------------------

// Clears all captured data (ring buffer, monitor log, recording) and restarts
// the time axis, but keeps plots, traces, layout, and settings.
function resetData() {
  freshBuffer();
  state.channelCount = 0;
  state.parser.decimals = [];
  state.t0 = performance.now();
  state.lastStatsAt = state.t0;
  state.lineCount = 0;
  state.rateEma = 0;
  state.monitor.clear();
  if (state.recorder.recording) state.recorder.start(); // restart capture buffer
  else state.recorder.stop();
  // Force each plot to redraw empty on the next frame.
  for (const p of state.panels) p.built = '';
  $('status').textContent = 'Data reset';
}

const LAYOUT_FILE_VERSION = 1;

function saveLayoutFile() {
  const doc = {
    app: 'GoodSerialPlotter',
    version: LAYOUT_FILE_VERSION,
    savedAt: new Date().toISOString(),
    settings: currentSettings(),
    plots: state.panels.map((p) => p.serialize()),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gsp-layout-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadLayoutFile(file) {
  let doc;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    $('status').textContent = 'Load failed: not valid JSON';
    return;
  }
  if (doc.app !== 'GoodSerialPlotter' || !Array.isArray(doc.plots)) {
    $('status').textContent = 'Load failed: not a GoodSerialPlotter layout';
    return;
  }

  // Apply settings, then rebuild all panels from the file.
  if (doc.settings) { applySettings(doc.settings); saveSettings(); }
  for (const p of state.panels) p.destroy();
  state.panels = [];
  for (const s of doc.plots) addPlot(s);
  savePlots();
  $('status').textContent = `Loaded layout (${doc.plots.length} plot${doc.plots.length === 1 ? '' : 's'})`;
}

// ---- UI wiring -------------------------------------------------------------

function wire() {
  if (!isSupported()) $('unsupported').classList.remove('hidden');

  $('connect').onclick = connect;
  $('disconnect').onclick = disconnect;

  $('pause').onclick = () => {
    state.paused = !state.paused;
    $('pause').textContent = state.paused ? 'Resume' : 'Pause';
  };

  $('resetZoom').onclick = () => state.panels.forEach((p) => p.plot.resetZoom());
  $('autoscale').onchange = (e) => state.panels.forEach((p) => p.plot.setAutoscale(e.target.checked));

  $('addPlot').onclick = () => addPlot();
  $('resetData').onclick = resetData;

  $('saveLayout').onclick = saveLayoutFile;
  $('loadLayout').onclick = () => $('loadLayoutFile').click();
  $('loadLayoutFile').onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) loadLayoutFile(file);
    e.target.value = ''; // allow re-loading the same file
  };

  $('delimiter').onchange = (e) => {
    const v = e.target.value;
    const custom = $('delimiterCustom');
    if (v === 'custom') { custom.classList.remove('hidden'); applyDelimiter(); }
    else { custom.classList.add('hidden'); state.parser.setDelimiter(v, false); }
  };
  $('delimiterCustom').oninput = applyDelimiter;

  $('window').oninput = (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) state.windowSec = v;
  };

  $('maxPoints').onchange = (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1000) {
      state.maxPoints = v;
      if (!state.connected) freshBuffer();
      else $('status').textContent = 'Max pts applies on next connect';
    }
  };

  $('record').onclick = () => {
    if (state.recorder.recording) {
      state.recorder.stop();
      $('record').textContent = '● Record';
      $('export').disabled = state.recorder.count === 0;
    } else {
      state.recorder.start();
      $('record').textContent = '■ Stop';
      $('export').disabled = true;
    }
  };

  $('export').onclick = () => state.recorder.download((i) => state.parser.seriesName(i));

  $('send').onclick = sendLine;
  $('sendText').onkeydown = (e) => { if (e.key === 'Enter') sendLine(); };
}

function applyDelimiter() {
  const raw = $('delimiterCustom').value || ',';
  try { state.parser.setDelimiter(raw, true); }
  catch { state.parser.setDelimiter(',', false); }
}

async function sendLine() {
  const text = $('sendText').value;
  if (!text) return;
  state.monitor.pushTx(text); // echo sent line into the monitor
  await state.source?.write(text + '\n');
  $('sendText').value = '';
}

function wirePersistence() {
  for (const id of SETTING_IDS) $(id).addEventListener('change', saveSettings);
  window.addEventListener('resize', () => state.panels.forEach((p) => p.plot.resize()));
}

// ---- serial monitor + tabs -------------------------------------------------

function setupMonitor() {
  state.monitor = new SerialMonitor({
    out: $('monitorOut'),
    stats: $('monStats'),
    timestamp: $('monTimestamp'),
    autoscroll: $('monAutoscroll'),
    showTx: $('monShowTx'),
    filter: $('monFilter'),
  });
  state.monitor.setMaxLines(parseInt($('monMaxLines').value, 10) || 5000);

  $('monClear').onclick = () => state.monitor.clear();
  $('monSave').onclick = () => state.monitor.save();
  $('monMaxLines').onchange = (e) =>
    state.monitor.setMaxLines(parseInt(e.target.value, 10) || 5000);
  // Re-render immediately when a display toggle/filter changes.
  for (const id of ['monTimestamp', 'monAutoscroll', 'monShowTx', 'monFilter']) {
    $(id).addEventListener('input', () => { state.monitor.dirty = true; });
  }
}

function setupTabs() {
  const select = (tab) => {
    const isMon = tab === 'monitor';
    $('tabPlots').classList.toggle('active', !isMon);
    $('tabMonitor').classList.toggle('active', isMon);
    $('workspace').classList.toggle('active', !isMon);
    $('monitorPage').classList.toggle('active', isMon);
    state.monitor.setVisible(isMon);
    // Plots need a resize when their tab becomes visible (was display:none).
    if (!isMon) state.panels.forEach((p) => p.plot.resize());
  };
  $('tabPlots').onclick = () => select('plots');
  $('tabMonitor').onclick = () => select('monitor');
}

// ---- bootstrap -------------------------------------------------------------

wire();
wirePersistence();
restoreSettings();
freshBuffer();
setupMonitor();
setupTabs();
restorePlots();
requestAnimationFrame(frame);
