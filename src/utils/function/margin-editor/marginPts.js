/**
 * Reading and writing margin rings as text.
 *
 * The .pts form is the one the ground-truth case folders and ezai-pipeline both use:
 * BEGIN_<fdi>, one "x y z" per line, END_<fdi>. The pipeline's margin_override also takes
 * a bare [[x,y,z],...] JSON array or a whole margin.json from an earlier job, so those are
 * read here too -- a ring pulled out of a result archive can be loaded straight back in.
 */

/**
 * @param {string} text
 * @returns {number[][]} N x 3, in file order
 */
const parseMarginText = text => {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let payload = JSON.parse(trimmed);
    if (!Array.isArray(payload)) {
      // Same precedence as the pipeline: the original-frame ring is the one that belongs
      // next to the scans the user uploaded.
      payload = ['points_original_mm', 'points', 'margin_points_mm', 'points_canonical_mm']
        .map(key => payload[key])
        .find(value => Array.isArray(value) && value.length);
      if (!payload) throw new Error('JSON 裡找不到 margin 點（points_original_mm / points）');
    }
    return payload.map(point => point.slice(0, 3).map(Number));
  }

  const points = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || /^(BEGIN|END)/i.test(stripped)) continue;
    const parts = stripped.split(/[\s,]+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) points.push(parts.slice(0, 3));
  }
  return points;
};

/**
 * @param {{x: number, y: number, z: number}[]} points
 * @param {number|string} fdi
 * @param {boolean} repeatFirst close the ring explicitly, as the ground-truth files do
 */
const formatMarginPts = (points, fdi, repeatFirst = true) => {
  const rows = points.map(p => `${p.x.toFixed(7)} ${p.y.toFixed(7)} ${p.z.toFixed(7)}`);
  if (repeatFirst && rows.length) rows.push(rows[0]);
  return [`BEGIN_${fdi}`, ...rows, `END_${fdi}`, ''].join('\n');
};

export { parseMarginText, formatMarginPts };
