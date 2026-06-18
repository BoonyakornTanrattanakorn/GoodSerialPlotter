// Parses a single text line into { labels?, values } using a configurable
// delimiter, auto-detecting between two layouts per line:
//
//   delimited:  1.2,3.4,5.6          -> values [1.2,3.4,5.6]
//   labeled:    temp:25.1,rpm:1200   -> values [25.1,1200], labels ['temp','rpm']
//
// Mixed/garbage tokens are dropped (NaN) rather than aborting the line, so a
// stray prefix or trailing CR doesn't poison a whole channel.

const LABEL_RE = /^\s*([^:=\s][^:=]*?)\s*[:=]\s*(.+)$/;

export class Parser {
  // delimiter: a string. If `isRegex`, it is compiled as a RegExp; otherwise
  // it is treated literally (with \t expanded).
  constructor(delimiter = ',', isRegex = false) {
    this.setDelimiter(delimiter, isRegex);
    this.labelOrder = []; // discovered label -> column index, stable across lines
    this.labelIndex = new Map();
    this.decimals = [];   // per-channel max decimal places seen in the raw stream
  }

  setDelimiter(delimiter, isRegex = false) {
    if (isRegex) {
      this.splitter = new RegExp(delimiter);
    } else {
      const lit = delimiter.replace(/\\t/g, '\t');
      // Escape regex metachars so a literal '.' or '|' works as expected.
      this.splitter = new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }

  // Returns { values: number[], labels: string[]|null } or null if the line
  // yields no usable numbers (e.g. a header or log line).
  parse(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const tokens = trimmed.split(this.splitter);
    const values = [];
    const labels = [];
    let anyLabeled = false;
    let anyNumber = false;

    for (const tok of tokens) {
      const m = LABEL_RE.exec(tok);
      if (m) {
        const num = Number(m[2]);
        const idx = this.columnFor(m[1]);
        // Place labeled values at their stable column so series stay aligned
        // even when fields are reordered or intermittently missing.
        while (values.length <= idx) { values.push(NaN); labels.push(null); }
        values[idx] = num;
        labels[idx] = m[1];
        if (!Number.isNaN(num)) { anyNumber = true; this.noteDecimals(idx, m[2]); }
        anyLabeled = true;
      } else {
        const num = Number(tok);
        const idx = values.length;
        values.push(num);
        labels.push(null);
        if (!Number.isNaN(num)) { anyNumber = true; this.noteDecimals(idx, tok); }
      }
    }

    if (!anyNumber) return null;
    return { values, labels: anyLabeled ? labels : null };
  }

  columnFor(label) {
    let idx = this.labelIndex.get(label);
    if (idx === undefined) {
      idx = this.labelOrder.length;
      this.labelOrder.push(label);
      this.labelIndex.set(label, idx);
    }
    return idx;
  }

  // Best-known display name for a series column.
  seriesName(idx) {
    return this.labelOrder[idx] ?? `ch${idx + 1}`;
  }

  // Record the decimal precision of a raw numeric token for channel `idx`,
  // keeping the max seen so the Y axis resolution matches the data. Ignores
  // exponent notation (treated as 0 decimals, a sane default).
  noteDecimals(idx, raw) {
    const s = raw.trim();
    if (/[eE]/.test(s)) { this.decimals[idx] = Math.max(this.decimals[idx] ?? 0, 0); return; }
    const dot = s.indexOf('.');
    const d = dot === -1 ? 0 : s.length - dot - 1;
    const cur = this.decimals[idx] ?? 0;
    if (d > cur) this.decimals[idx] = d;
    else if (this.decimals[idx] === undefined) this.decimals[idx] = d;
  }

  // Max decimals across the given channel indices (for a plot showing several
  // traces, use the finest so no series loses precision). Defaults to 0.
  decimalsFor(indices) {
    let max = 0;
    for (const i of indices) max = Math.max(max, this.decimals[i] ?? 0);
    return max;
  }
}
