// Single-pass min/max/avg/stddev/count over a logical [start, end) range of a
// RingBuffer, for a selected set of series. Computed from the raw samples (not
// the decimated draw data) so averages and stddev are accurate.
//
// Returns an array aligned to `seriesIdx`: each entry { count, min, max, avg, std }.
// Population standard deviation (N), via the sum/sumSq accumulator.

export function windowStats(rb, startLogical, endLogical, seriesIdx) {
  const out = seriesIdx.map(() => ({ count: 0, min: Infinity, max: -Infinity, sum: 0, sumSq: 0 }));

  for (let s = 0; s < seriesIdx.length; s++) {
    const col = seriesIdx[s];
    const acc = out[s];
    for (let l = startLogical; l < endLogical; l++) {
      const v = rb.valueAt(col, l);
      if (Number.isNaN(v)) continue;
      acc.count++;
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
      acc.sum += v;
      acc.sumSq += v * v;
    }
  }

  return out.map((a) => {
    if (a.count === 0) return { count: 0, min: NaN, max: NaN, avg: NaN, std: NaN };
    const avg = a.sum / a.count;
    // var = E[x^2] - E[x]^2, clamped at 0 to avoid tiny negative from rounding.
    const variance = Math.max(0, a.sumSq / a.count - avg * avg);
    return { count: a.count, min: a.min, max: a.max, avg, std: Math.sqrt(variance) };
  });
}
