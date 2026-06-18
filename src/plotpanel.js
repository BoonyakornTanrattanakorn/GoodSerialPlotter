// A single draggable/resizable plot window: titlebar, a "traces" dropdown to
// pick which channels it shows, and a uPlot instance fed only those channels
// off the shared ring buffer.

import { Plot, colorForChannel } from './plot.js';
import { DraggablePanel } from './layout.js';

let nextId = 1;

export class PlotPanel {
  // host: { getChannels(): [{idx,name}], onChange(): void } — channel registry
  // + a persist/notify callback. saved: optional restored state.
  constructor(workspace, host, saved = null) {
    this.id = saved?.id ?? `plot${nextId++}`;
    if (saved?.id) {
      const n = parseInt(saved.id.replace('plot', ''), 10);
      if (n >= nextId) nextId = n + 1;
    }
    this.host = host;
    this.title = saved?.title ?? this.id;
    this.traces = new Set(saved?.traces ?? []); // channel indices
    this.built = ''; // signature of currently-built trace set
    this.userClosed = false;
    this.showStats = saved?.showStats ?? true;
    this.statsCols = 0; // rows currently in the stats table

    this._buildDOM(workspace);
    this.plot = new Plot(this.body, () => this._plotSize());

    this.dp = new DraggablePanel(this.el, this.titlebar, {
      onChange: (phase) => {
        this.plot.resize();
        if (phase === 'save') this.host.onChange();
      },
    });
    this.dp.apply(saved?.layout ?? this._defaultLayout());
    this.plot.resize();
  }

  _defaultLayout() {
    // Cascade new panels so they don't stack exactly.
    const n = (nextId - 1) % 6;
    return { left: 16 + n * 28, top: 16 + n * 28, width: 760, height: 420 };
  }

  _buildDOM(workspace) {
    const el = document.createElement('section');
    el.className = 'panel';
    el.dataset.id = this.id;
    el.innerHTML = `
      <div class="panel-titlebar">
        <span class="panel-grip-dots">⠿</span>
        <input class="panel-title-input" value="${this.title}" />
        <div class="trace-picker">
          <button class="trace-toggle" type="button">Traces ▾</button>
          <div class="trace-menu hidden"></div>
        </div>
        <button class="panel-stats-toggle" type="button" title="Show/hide statistics">Σ</button>
        <button class="panel-close" title="Close plot" type="button">✕</button>
      </div>
      <div class="panel-body">
        <div class="panel-empty">
          <div class="panel-empty-title">No traces selected</div>
          <div class="panel-empty-hint">Click <b>Traces ▾</b> above to add channels to this plot.</div>
          <button class="panel-empty-add" type="button">＋ Add traces</button>
        </div>
      </div>
      <div class="panel-stats"><table><thead><tr>
        <th class="s-name">Trace</th><th>Min</th><th>Max</th><th>Avg</th><th>Std</th><th>Count</th>
      </tr></thead><tbody></tbody></table></div>`;
    workspace.appendChild(el);

    this.el = el;
    this.titlebar = el.querySelector('.panel-titlebar');
    this.body = el.querySelector('.panel-body');
    this.emptyEl = el.querySelector('.panel-empty');
    this.titleInput = el.querySelector('.panel-title-input');
    this.menu = el.querySelector('.trace-menu');
    this.toggleBtn = el.querySelector('.trace-toggle');
    this.statsEl = el.querySelector('.panel-stats');
    this.statsBody = el.querySelector('.panel-stats tbody');
    if (!this.showStats) this.statsEl.classList.add('hidden');

    this.titleInput.addEventListener('change', () => {
      this.title = this.titleInput.value || this.id;
      this.host.onChange();
    });

    el.querySelector('.panel-stats-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      this.showStats = !this.showStats;
      this.statsEl.classList.toggle('hidden', !this.showStats);
      this.plot.resize();
      this.host.onChange();
    });

    this.toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const showing = !this.menu.classList.contains('hidden');
      this._closeAllMenus();
      if (!showing) { this.refreshTracePicker(); this.menu.classList.remove('hidden'); }
    });
    document.addEventListener('click', () => this.menu.classList.add('hidden'));
    this.menu.addEventListener('click', (e) => e.stopPropagation());

    el.querySelector('.panel-close').addEventListener('click', () => {
      this.userClosed = true;
      this.destroy();
      this.host.onClose(this);
    });

    // The empty-state button opens the same trace picker.
    el.querySelector('.panel-empty-add').addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeAllMenus();
      this.refreshTracePicker();
      this.menu.classList.remove('hidden');
    });
  }

  _closeAllMenus() {
    document.querySelectorAll('.trace-menu').forEach((m) => m.classList.add('hidden'));
  }

  // Rebuild the checkbox list of all known channels.
  refreshTracePicker() {
    const channels = this.host.getChannels();
    this.menu.innerHTML = channels.length
      ? ''
      : '<div class="trace-empty">No channels yet — connect a source.</div>';
    for (const ch of channels) {
      const row = document.createElement('label');
      row.className = 'trace-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.traces.has(ch.idx);
      cb.addEventListener('change', () => {
        if (cb.checked) this.traces.add(ch.idx); else this.traces.delete(ch.idx);
        this.host.onChange();
      });
      const swatch = document.createElement('span');
      swatch.className = 'trace-swatch';
      swatch.style.background = colorForChannel(ch.idx);
      const name = document.createElement('span');
      name.textContent = ch.name;
      row.append(cb, swatch, name);
      this.menu.appendChild(row);
    }
  }

  // Ordered list of channel indices this panel shows.
  traceList() {
    return [...this.traces].sort((a, b) => a - b);
  }

  // Rebuild the uPlot instance if the selected trace set OR the data's decimal
  // precision changed. Shows an empty-state placeholder (and tears down the
  // chart) when no traces are selected, so the panel is never just blank.
  syncSeries(nameFn, decimalsFn) {
    const list = this.traceList();
    const yDecimals = decimalsFn ? decimalsFn(list) : 0;
    const names = list.map((idx) => nameFn(idx));
    // Rebuild when the trace set, their resolved names, or precision changes,
    // so labels update once a labeled stream replaces the chN placeholders.
    const sig = list.join(',') + '|' + yDecimals + '|' + names.join(',');
    if (sig === this.built) return false;
    this.built = sig;

    if (list.length === 0) {
      this.plot.destroy();
      this.emptyEl.classList.remove('hidden');
      this.statsBody.innerHTML = '';
      this.statsCols = 0;
      return true;
    }

    this.emptyEl.classList.add('hidden');
    const traces = list.map((idx, k) => ({ name: names[k], color: colorForChannel(idx) }));
    this.plot.build(traces, yDecimals);
    this._buildStatsRows(list, names);
    return true;
  }

  // Recreate the stats table rows to match the current traces.
  _buildStatsRows(list, names) {
    this.statsBody.innerHTML = '';
    for (let k = 0; k < list.length; k++) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="s-name"><span class="trace-swatch" style="background:${colorForChannel(list[k])}"></span>${names[k]}</td>` +
        '<td class="s-min">–</td><td class="s-max">–</td><td class="s-avg">–</td><td class="s-std">–</td><td class="s-cnt">–</td>';
      this.statsBody.appendChild(tr);
    }
    this.statsCols = list.length;
  }

  // statsArr: aligned to traceList(); each { count, min, max, avg, std }.
  // decimals: how many decimals to show for value columns.
  updateStats(statsArr, decimals) {
    if (!this.showStats || this.statsCols !== statsArr.length) return;
    const dp = Math.min(6, Math.max(0, decimals));
    const fmt = (v) => Number.isNaN(v) ? '–'
      : v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
    const rows = this.statsBody.children;
    for (let k = 0; k < statsArr.length; k++) {
      const s = statsArr[k];
      const cells = rows[k].children;
      cells[1].textContent = fmt(s.min);
      cells[2].textContent = fmt(s.max);
      cells[3].textContent = fmt(s.avg);
      cells[4].textContent = fmt(s.std);
      cells[5].textContent = s.count.toLocaleString();
    }
  }

  _plotSize() {
    const w = this.body.clientWidth;
    const h = this.body.clientHeight;
    // Reserve room below the canvas for the HTML legend (it can wrap to a
    // second row when several traces are shown).
    const legendH = 44;
    return { width: Math.max(220, w), height: Math.max(140, h - legendH) };
  }

  serialize() {
    return {
      id: this.id,
      title: this.title,
      traces: this.traceList(),
      showStats: this.showStats,
      layout: this.dp.getLayout(),
    };
  }

  destroy() {
    this.plot.destroy();
    this.el.remove();
  }
}
