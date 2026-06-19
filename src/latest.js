// "Latest" view: a live snapshot of the most recent serial line.
//
// Channels whose value is present in the latest parsed line float to the top,
// highlighted green; channels absent from that line sink to the bottom with a
// dimmed/disabled look, showing their last-known value and how stale it is.
//
// "Present" means the latest sample in the ring buffer has a non-NaN value for
// that channel — the parser back-fills missing columns with NaN, so a field
// dropping out of a line shows up here immediately.

export class LatestView {
  constructor(root) {
    this.root = root;
    this.visible = false;
    this.dirty = false;
    this.rows = new Map(); // channel idx -> { el, valueEl, metaEl, present }
    this.empty = null;
  }

  setVisible(on) {
    this.visible = on;
    if (on) this.dirty = true;
  }

  // Called once per rAF from the app loop. Cheap no-op unless visible.
  // rb: RingBuffer (or null). nameFn(idx) -> display name.
  // decimalsFn([idx]) -> decimal places for that channel.
  render(rb, channelCount, nameFn, decimalsFn) {
    if (!this.visible) return;

    if (!rb || rb.count === 0 || channelCount === 0) {
      this._showEmpty();
      return;
    }
    this._hideEmpty();

    const last = rb.count - 1;
    const tNow = rb.timeAt(last);

    // Build per-channel snapshot for the latest sample.
    const items = [];
    for (let i = 0; i < channelCount; i++) {
      const v = rb.valueAt(i, last);
      const present = !Number.isNaN(v);
      items.push({ idx: i, value: v, present });
    }

    // Present channels first (in channel order), then absent ones.
    items.sort((a, b) => (a.present === b.present ? a.idx - b.idx : a.present ? -1 : 1));

    for (const it of items) {
      const row = this._ensureRow(it.idx);
      const dec = decimalsFn([it.idx]);

      row.nameEl.textContent = nameFn(it.idx);

      if (it.present) {
        row.valueEl.textContent = it.value.toFixed(dec);
        row.metaEl.textContent = '';
      } else {
        // Find the channel's last non-NaN value, walking back from the newest.
        const lastSeen = this._lastKnown(rb, it.idx, last);
        if (lastSeen) {
          row.valueEl.textContent = lastSeen.value.toFixed(dec);
          const age = (tNow - lastSeen.t).toFixed(1);
          row.metaEl.textContent = `last seen ${age}s ago`;
        } else {
          row.valueEl.textContent = '—';
          row.metaEl.textContent = 'no data';
        }
      }

      row.el.classList.toggle('present', it.present);
      row.el.classList.toggle('absent', !it.present);
      // Re-append in sorted order; appendChild on an existing child just moves it.
      this.root.appendChild(row.el);
    }

    // Drop rows for channels that no longer exist (e.g. after a data reset).
    for (const [idx, row] of this.rows) {
      if (idx >= channelCount) {
        row.el.remove();
        this.rows.delete(idx);
      }
    }
  }

  // Walk backwards from `from` to find the most recent non-NaN sample for a
  // channel. Capped so a channel that's been silent for a long time doesn't
  // cost a full buffer scan every frame.
  _lastKnown(rb, series, from) {
    const MAX_SCAN = 50000;
    const lo = Math.max(0, from - MAX_SCAN);
    for (let i = from; i >= lo; i--) {
      const v = rb.valueAt(series, i);
      if (!Number.isNaN(v)) return { value: v, t: rb.timeAt(i) };
    }
    return null;
  }

  _ensureRow(idx) {
    let row = this.rows.get(idx);
    if (row) return row;

    const el = document.createElement('div');
    el.className = 'latest-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'latest-name';

    const valueEl = document.createElement('span');
    valueEl.className = 'latest-value';

    const metaEl = document.createElement('span');
    metaEl.className = 'latest-meta';

    el.append(nameEl, valueEl, metaEl);
    row = { el, nameEl, valueEl, metaEl };
    this.rows.set(idx, row);
    return row;
  }

  _showEmpty() {
    if (!this.empty) {
      this.empty = document.createElement('div');
      this.empty.className = 'latest-empty';
      this.empty.textContent = 'Waiting for data…';
    }
    if (!this.empty.isConnected) {
      // Clear any stale rows so the placeholder stands alone.
      for (const [idx, row] of this.rows) { row.el.remove(); this.rows.delete(idx); }
      this.root.appendChild(this.empty);
    }
  }

  _hideEmpty() {
    if (this.empty && this.empty.isConnected) this.empty.remove();
  }
}
