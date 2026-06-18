// Min/max-per-pixel decimation of a logical [startLogical, endLogical) range
// of a RingBuffer into ~2*targetPixels points. Drawing min and max of each
// pixel column preserves spikes that plain stride-sampling would drop, while
// keeping the point count bounded regardless of incoming sample rate.
//
// Returns { time, series } where time is Float64Array and series is an array
// of Float64Array, ready to hand straight to uPlot as [time, ...series].

// `seriesIdx`: optional array of series indices to include (in output order).
// When omitted, all series are decimated. This lets each plot panel decimate
// only the channels (traces) it displays, off the one shared ring buffer.
export function decimate(rb, startLogical, endLogical, targetPixels, seriesIdx) {
  const total = Math.max(0, endLogical - startLogical);
  const cols = seriesIdx ?? Array.from({ length: rb.seriesCount }, (_, i) => i);
  const seriesCount = cols.length;

  // Few enough points that decimation buys nothing: copy verbatim.
  if (total <= targetPixels * 2) {
    const time = new Float64Array(total);
    const series = Array.from({ length: seriesCount }, () => new Float64Array(total));
    for (let k = 0; k < total; k++) {
      const l = startLogical + k;
      time[k] = rb.timeAt(l);
      for (let s = 0; s < seriesCount; s++) series[s][k] = rb.valueAt(cols[s], l);
    }
    return { time, series };
  }

  const buckets = targetPixels;
  const perBucket = total / buckets;
  // Two output samples per bucket (the min then the max, in time order).
  const outLen = buckets * 2;
  const time = new Float64Array(outLen);
  const series = Array.from({ length: seriesCount }, () => new Float64Array(outLen));

  for (let b = 0; b < buckets; b++) {
    const from = startLogical + Math.floor(b * perBucket);
    const to = startLogical + Math.floor((b + 1) * perBucket);
    const o0 = b * 2;
    const o1 = o0 + 1;

    // Time column: use bucket edge timestamps so the x-axis stays honest.
    time[o0] = rb.timeAt(from);
    time[o1] = rb.timeAt(Math.min(to - 1, endLogical - 1));

    for (let s = 0; s < seriesCount; s++) {
      let min = Infinity, max = -Infinity, minSeen = false;
      for (let l = from; l < to; l++) {
        const v = rb.valueAt(cols[s], l);
        if (Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        minSeen = true;
      }
      if (!minSeen) { min = NaN; max = NaN; }
      // Preserve visual order: earlier edge gets min, later edge gets max.
      // (Direction is cosmetic; both points land in the same pixel column.)
      series[s][o0] = min;
      series[s][o1] = max;
    }
  }

  return { time, series };
}
