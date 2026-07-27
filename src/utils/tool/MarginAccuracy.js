/**
 * Computes the minimum distance from a 3D point to a closed polyline (treated as segments).
 * @param {{x,y,z}} pt
 * @param {{x,y,z}[]} polyline  closed curve points
 * @returns {number} minimum distance
 */
function pointToPolylineMinDist(pt, polyline) {
  let minDist = Infinity;
  const n = polyline.length;
  for (let i = 0; i < n; i++) {
    const a = polyline[i];
    const b = polyline[(i + 1) % n];
    const dist = pointToSegmentDist(pt, a, b);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function pointToSegmentDist(pt, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = pt.x - a.x, apy = pt.y - a.y, apz = pt.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (ab2 === 0) {
    // degenerate segment
    return Math.sqrt(apx * apx + apy * apy + apz * apz);
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2));
  const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Resamples a closed polyline into `count` points spaced equally along arc length.
 * This removes density bias: two curves with different point counts / spacing become
 * directly comparable because samples no longer cluster wherever the source was dense.
 * @param {{x,y,z}[]} points  closed curve points
 * @param {number} count  number of output samples
 * @returns {{x,y,z}[]} uniformly (by arc length) spaced points
 */
function resampleClosedByArcLength(points, count) {
  const n = points.length;
  if (n < 2) return points.slice();

  // Segment lengths over the closed loop (n segments, including the wrap last→first).
  const segLen = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    segLen[i] = len;
    total += len;
  }
  if (total === 0) return points.slice();

  const result = [];
  let seg = 0;
  let accum = 0; // arc length at the start of the current segment
  for (let k = 0; k < count; k++) {
    const target = (k * total) / count;
    while (seg < n - 1 && accum + segLen[seg] < target) {
      accum += segLen[seg];
      seg++;
    }
    const a = points[seg];
    const b = points[(seg + 1) % n];
    const t = segLen[seg] > 0 ? (target - accum) / segLen[seg] : 0;
    result.push({
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
      z: a.z + t * (b.z - a.z),
    });
  }
  return result;
}

/** Min distance from every query point to the target polyline. */
function directedDistances(queryPoints, targetPolyline) {
  const dists = new Array(queryPoints.length);
  for (let i = 0; i < queryPoints.length; i++) {
    dists[i] = pointToPolylineMinDist(queryPoints[i], targetPolyline);
  }
  return dists;
}

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
const maxOf = (arr) => arr.reduce((m, v) => (v > m ? v : m), 0);

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Computes margin accuracy metrics comparing a predicted margin against ground truth.
 *
 * Both curves are first resampled to a uniform spacing along arc length, so the result
 * is independent of each curve's starting point AND point density. Distances are then
 * measured against the full-resolution source polylines (faithful distance field), in
 * BOTH directions, so coverage gaps are penalised as well as positional error.
 *
 * @param {{x,y,z}[]} predicted  predicted margin point array (closed loop)
 * @param {{x,y,z}[]} groundTruth  ground truth margin point array (closed loop)
 * @param {number} [sampleCount=400]  uniform samples per curve used for the statistics
 * @returns {{ meanDist, rmsDist, hausdorffDist, p95Dist, maxDistFromGT } | null}
 *   - meanDist: symmetric mean of per-point min distances (both directions), density-independent
 *   - rmsDist: symmetric RMS of per-point min distances (both directions)
 *   - hausdorffDist: symmetric Hausdorff distance (worst single point, either direction)
 *   - p95Dist: 95th-percentile distance — a robust, outlier-tolerant alternative to Hausdorff
 *   - maxDistFromGT: directed Hausdorff GT → predicted (largest GT region not covered)
 */
function computeMarginAccuracy(predicted, groundTruth, sampleCount = 400) {
  if (!predicted?.length || !groundTruth?.length) return null;

  // Uniform arc-length resampling removes start-point and density bias from each curve.
  const predSamples = resampleClosedByArcLength(predicted, sampleCount);
  const gtSamples = resampleClosedByArcLength(groundTruth, sampleCount);

  // Directed distances: uniform query points measured against the full-resolution polylines.
  const predToGT = directedDistances(predSamples, groundTruth);
  const gtToPred = directedDistances(gtSamples, predicted);

  // Symmetric (bidirectional) statistics over all distances.
  const all = predToGT.concat(gtToPred);
  const meanDist = mean(all);
  const rmsDist = rms(all);

  const maxGTToPred = maxOf(gtToPred);
  const hausdorffDist = Math.max(maxOf(predToGT), maxGTToPred);
  const p95Dist = percentile(all, 0.95);

  return { meanDist, rmsDist, hausdorffDist, p95Dist, maxDistFromGT: maxGTToPred };
}

export { computeMarginAccuracy };
