// Serial monitor: shows raw incoming (RX) and sent (TX) lines with optional
// timestamps, autoscroll (scroll-stop), filtering, clear, and save.
//
// At 1000Hz, one DOM node per line would lock up the browser, so lines are
// pushed into a capped in-memory ring and the visible text is rebuilt at most
// once per animation frame (and only while the monitor tab is visible).

function pad(n, w) { return String(n).padStart(w, '0'); }

function stamp(t) {
  const d = new Date(t);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

export class SerialMonitor {
  constructor(els) {
    this.out = els.out;
    this.stats = els.stats;
    this.cfg = els; // the checkbox/input elements
    this.lines = [];        // ring of { t, dir: 'rx'|'tx', text }
    this.maxLines = 5000;
    this.dirty = false;
    this.visible = false;
    this.totalRx = 0;
    this.totalTx = 0;
  }

  setMaxLines(n) {
    this.maxLines = Math.max(100, n | 0);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    this.dirty = true;
  }

  // Hot-path adds: cheap push only; rendering happens in flush().
  pushRx(text) { this._push('rx', text); this.totalRx++; }
  pushTx(text) { this._push('tx', text); this.totalTx++; }

  _push(dir, text) {
    this.lines.push({ t: Date.now(), dir, text });
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.dirty = true;
  }

  clear() {
    this.lines.length = 0;
    this.totalRx = this.totalTx = 0;
    this.dirty = true;
  }

  setVisible(on) {
    this.visible = on;
    if (on) this.dirty = true; // force a redraw when the tab is shown
  }

  // Called once per rAF from the app loop.
  flush() {
    if (!this.visible || !this.dirty) return;
    this.dirty = false;

    const showTs = this.cfg.timestamp.checked;
    const showTx = this.cfg.showTx.checked;
    const filter = this.cfg.filter.value.trim().toLowerCase();

    const parts = [];
    for (const ln of this.lines) {
      if (ln.dir === 'tx' && !showTx) continue;
      if (filter && !ln.text.toLowerCase().includes(filter)) continue;
      const ts = showTs ? `[${stamp(ln.t)}] ` : '';
      const arrow = ln.dir === 'tx' ? '» ' : '';
      parts.push(ts + arrow + ln.text);
    }

    // Keep the user's scroll position unless autoscroll is on (scroll-stop).
    const auto = this.cfg.autoscroll.checked;
    const out = this.out;
    const wasAtBottom = out.scrollHeight - out.clientHeight - out.scrollTop < 4;

    out.textContent = parts.join('\n');

    if (auto || wasAtBottom) out.scrollTop = out.scrollHeight;

    this.stats.textContent =
      `${this.lines.length} shown · ${this.totalRx} RX · ${this.totalTx} TX`;
  }

  save() {
    const showTs = this.cfg.timestamp.checked;
    const text = this.lines
      .map((ln) => (showTs ? `[${stamp(ln.t)}] ` : '') +
                   (ln.dir === 'tx' ? '» ' : '') + ln.text)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serial-monitor-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
