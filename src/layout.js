// Draggable + resizable floating panel, with layout persisted to localStorage.
// The panel is moved/sized by writing inline left/top/width/height; on any
// change we debounce a save and notify the host (so the plot can re-fit).

const STORE_KEY = 'gsp.layout.v1';

export function loadLayout() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(layout));
  } catch { /* storage may be unavailable (private mode, quota) */ }
}

export function clearLayout() {
  try { localStorage.removeItem(STORE_KEY); } catch {}
}

// Makes `panel` draggable by `handle` and resizable by a corner grip.
// onChange() fires (debounced) after move/resize so the host can persist +
// re-fit; getLayout() returns the current geometry for saving.
export class DraggablePanel {
  constructor(panel, handle, { onChange, minWidth = 320, minHeight = 240 } = {}) {
    this.panel = panel;
    this.handle = handle;
    this.onChange = onChange;
    this.minWidth = minWidth;
    this.minHeight = minHeight;
    this._saveTimer = null;

    this._addGrip();
    this._wireDrag();
    this._wireResize();
  }

  apply(layout) {
    if (!layout) return;
    const { left, top, width, height } = layout;
    if (width != null) this.panel.style.width = `${width}px`;
    if (height != null) this.panel.style.height = `${height}px`;
    if (left != null) this.panel.style.left = `${this._clampX(left, width)}px`;
    if (top != null) this.panel.style.top = `${this._clampY(top)}px`;
  }

  getLayout() {
    const r = this.panel.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top),
             width: Math.round(r.width), height: Math.round(r.height) };
  }

  _clampX(x, w) {
    const width = w ?? this.panel.getBoundingClientRect().width;
    return Math.max(0, Math.min(x, window.innerWidth - Math.min(width, window.innerWidth)));
  }
  _clampY(y) {
    return Math.max(0, Math.min(y, Math.max(0, window.innerHeight - 80)));
  }

  _notify() {
    this.onChange?.();
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.onChange?.('save'), 300);
  }

  _addGrip() {
    const grip = document.createElement('div');
    grip.className = 'panel-resize-grip';
    grip.setAttribute('aria-label', 'Resize');
    this.panel.appendChild(grip);
    this.grip = grip;
  }

  _wireDrag() {
    let startX, startY, origX, origY, dragging = false;
    const onDown = (e) => {
      // Ignore drags that start on a button/input inside the handle.
      if (e.target.closest('button, input, select, label, .panel-resize-grip')) return;
      dragging = true;
      const r = this.panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; origX = r.left; origY = r.top;
      this.panel.classList.add('dragging');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const nx = this._clampX(origX + (e.clientX - startX));
      const ny = this._clampY(origY + (e.clientY - startY));
      this.panel.style.left = `${nx}px`;
      this.panel.style.top = `${ny}px`;
      this._notify();
    };
    const onUp = () => {
      dragging = false;
      this.panel.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this._notify();
    };
    this.handle.addEventListener('pointerdown', onDown);
  }

  _wireResize() {
    let startX, startY, origW, origH, resizing = false;
    const onDown = (e) => {
      resizing = true;
      const r = this.panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; origW = r.width; origH = r.height;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e) => {
      if (!resizing) return;
      const w = Math.max(this.minWidth, origW + (e.clientX - startX));
      const h = Math.max(this.minHeight, origH + (e.clientY - startY));
      this.panel.style.width = `${w}px`;
      this.panel.style.height = `${h}px`;
      this._notify();
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this._notify();
    };
    this.grip.addEventListener('pointerdown', onDown);
  }
}
