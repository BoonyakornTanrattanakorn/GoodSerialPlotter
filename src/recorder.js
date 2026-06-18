// Captures the live session into its own growing arrays (independent of the
// ring buffer's fixed cap) and exports CSV. Recording the parsed numeric
// stream — not raw text — so the CSV has clean aligned columns.

export class Recorder {
  constructor() {
    this.recording = false;
    this.time = [];
    this.rows = []; // each row: number[] aligned to series index
    this.maxCols = 0;
  }

  start() {
    this.recording = true;
    this.time = [];
    this.rows = [];
    this.maxCols = 0;
  }

  stop() {
    this.recording = false;
  }

  sample(t, values) {
    if (!this.recording) return;
    this.time.push(t);
    this.rows.push(values.slice());
    if (values.length > this.maxCols) this.maxCols = values.length;
  }

  get count() { return this.rows.length; }

  toCSV(nameFn) {
    const header = ['t'];
    for (let i = 0; i < this.maxCols; i++) header.push(nameFn(i));
    const lines = [header.join(',')];
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const cols = [this.time[r]];
      for (let i = 0; i < this.maxCols; i++) {
        const v = row[i];
        cols.push(v === undefined || Number.isNaN(v) ? '' : v);
      }
      lines.push(cols.join(','));
    }
    return lines.join('\n');
  }

  download(nameFn) {
    const csv = this.toCSV(nameFn);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `serial-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
