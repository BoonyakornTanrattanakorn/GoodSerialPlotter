// Fixed-capacity ring buffer holding a timestamp axis plus N parallel series,
// all as Float64Array. Appending is O(1) and never allocates after construction,
// which is what keeps ingest cheap at 1000Hz.

export class RingBuffer {
  constructor(capacity, seriesCount) {
    this.capacity = capacity;
    this.seriesCount = seriesCount;
    this.time = new Float64Array(capacity);
    this.data = Array.from({ length: seriesCount }, () => new Float64Array(capacity));
    this.head = 0;     // next write index
    this.count = 0;    // number of valid samples (<= capacity)
  }

  // Grow the number of series without losing existing data (called when the
  // parser discovers more channels than we started with). New series are
  // back-filled with NaN so uPlot draws gaps rather than spurious zeros.
  ensureSeries(n) {
    while (this.data.length < n) {
      const arr = new Float64Array(this.capacity).fill(NaN);
      this.data.push(arr);
    }
    this.seriesCount = this.data.length;
  }

  // values: array aligned to series index; shorter arrays leave the rest NaN.
  push(t, values) {
    if (values.length > this.seriesCount) this.ensureSeries(values.length);
    const i = this.head;
    this.time[i] = t;
    for (let s = 0; s < this.seriesCount; s++) {
      this.data[s][i] = s < values.length ? values[s] : NaN;
    }
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  // Index in storage of the oldest valid sample.
  get tail() {
    return this.count < this.capacity ? 0 : this.head;
  }

  // Logical index (0 = oldest) -> storage index.
  storageIndex(logical) {
    return (this.tail + logical) % this.capacity;
  }

  // Binary search for the first logical index whose time >= t.
  // Times are monotonically increasing in logical order.
  lowerBound(t) {
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.time[this.storageIndex(mid)] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  timeAt(logical) {
    return this.time[this.storageIndex(logical)];
  }

  valueAt(series, logical) {
    return this.data[series][this.storageIndex(logical)];
  }

  clear() {
    this.head = 0;
    this.count = 0;
  }
}
