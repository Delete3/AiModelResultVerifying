import * as THREE from 'three';

/**
 * Where the implant is, for a case that has no scan body: an ESTIMATE, or what the user sets.
 *
 * The AIrDesign caller gets the implant from its scan-body registration and builds the PEEK
 * crown's lower part on it. This viewer has no scan body, so it stands one in: the platform
 * below the margin ring, along the job's occlusal axis, at the bottom of the soft-tissue
 * tunnel when the scan shows one. Every value can be overridden.
 *
 * Ported from ezai-pipeline app/peek_lower.py (site_axes, tunnel, placement), which did this
 * on the server until 2026-10-06. Two things changed with the move: the depth is now the
 * implant PLATFORM's (the origin of a library part), not the PEEK interface's, and the
 * default axis is the canonical occlusal axis (the one the virtual stump stands on since
 * 2026-10-02), not the ring's best-fit normal.
 *
 * Everything is worked out in the job's canonical frame -- +Z occlusal for a lower arch, +Y
 * anterior, +X the patient's right -- and handed back in the frame of the uploaded scans.
 */

const PLACEMENT_DEFAULTS = {
  depth_mm: null, // platform below the ring centroid; null = from the tunnel
  offset_md_mm: null, // platform centre, mesial +; null = from the tunnel
  offset_bl_mm: null, // buccal +
  tilt_md_deg: 0, // implant axis leaning mesially (+) / distally (-)
  tilt_bl_deg: 0, // buccally (+) / lingually (-)
};
const PLACEMENT_RANGES = {
  depth_mm: [0.5, 8.0],
  offset_md_mm: [-4.0, 4.0],
  offset_bl_mm: [-4.0, 4.0],
  tilt_md_deg: [-30, 30],
  tilt_bl_deg: [-30, 30],
};
// Auto placement is held to these whatever the tunnel says: a scanner rarely sees the true
// bottom of a narrow tunnel, and a wildly off-centre estimate is more likely noise.
const AUTO_DEPTH_RANGE = [1.5, 6.0];
// A bone-level platform about 3 mm below the gingival margin.
const AUTO_DEPTH_FALLBACK = 3.0;
const AUTO_OFFSET_LIMIT = 2.0;
// The neighbour band for the arch tangent ends here; nothing further out is looked at.
const BAND_OUTER_MM = 16;
const RING_SAMPLES = 256;

const UPPER_FDI = new Set([11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28]);

/** manifest.rotation_matrix (p_canonical = R p_original, row-major) as a Matrix3. */
const canonicalRotation = rows => new THREE.Matrix3().set(
  rows[0][0], rows[0][1], rows[0][2],
  rows[1][0], rows[1][1], rows[1][2],
  rows[2][0], rows[2][1], rows[2][2],
);

/** The closed ring resampled to `count` points evenly spaced by arc length. */
const resampleRing = (ring, count = RING_SAMPLES) => {
  const loop = [...ring, ring[0]];
  const arc = [0];
  for (let i = 1; i < loop.length; i++) arc.push(arc[i - 1] + loop[i].distanceTo(loop[i - 1]));
  const total = arc[arc.length - 1];
  const out = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    const s = (total * i) / count;
    while (k < arc.length - 2 && arc[k + 1] < s) k++;
    const t = arc[k + 1] > arc[k] ? (s - arc[k]) / (arc[k + 1] - arc[k]) : 0;
    out.push(loop[k].clone().lerp(loop[k + 1], t));
  }
  return out;
};

/** Even-odd test in the XY plane (the canonical frame's occlusal plane). */
const insidePolygon = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
  }
  return inside;
};

/** Principal axis of a symmetric 2x2 [[a, b], [b, c]]. */
const principal2 = (a, b, c) => {
  const angle = 0.5 * Math.atan2(2 * b, a - c);
  return new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
};

/**
 * Mesio-distal is the arch tangent at the site (radius-weighted PCA over the neighbour
 * band), or the ring's own long axis when the neighbours are missing.
 * @param {Float64Array} near (dx, dy, height) per arch point, canonical, from the ring centre
 */
const mesioDistal = (near, ringC, centre, ringRadius) => {
  let sxx = 0, sxy = 0, syy = 0, count = 0;
  for (let i = 0; i < near.length; i += 3) {
    const dx = near[i];
    const dy = near[i + 1];
    const radial = Math.hypot(dx, dy);
    if (radial <= ringRadius + 0.8 || radial >= BAND_OUTER_MM || near[i + 2] <= -1) continue;
    sxx += radial * dx * dx;
    sxy += radial * dx * dy;
    syy += radial * dy * dy;
    count++;
  }
  if (count >= 50) return { md: principal2(sxx, sxy, syy), how: 'arch tangent' };
  sxx = sxy = syy = 0;
  for (const p of ringC) {
    const dx = p.x - centre.x;
    const dy = p.y - centre.y;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  return { md: principal2(sxx, sxy, syy), how: 'ring long axis' };
};

/**
 * What placement needs from the case, measured once per job (the arch scan is large; the
 * placement itself is then instant). All of it in the canonical frame.
 *
 * Which way is mesial and which way is buccal comes from the FDI quadrant and the canonical
 * frame, not from the arch's shape, because many scans are partial arches.
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.prepPositions the preparation arch's vertex positions,
 *   uploaded frame (x, y, z, x, y, z, ...)
 * @param {THREE.Vector3[]} options.ring the margin ring the job used, uploaded frame
 * @param {number[][]} options.rotation alignment.json's rotation_matrix
 * @param {number} options.fdi
 */
const measureSite = ({ prepPositions, ring, rotation, fdi }) => {
  const R = canonicalRotation(rotation);
  const back = R.clone().transpose();
  const up = new THREE.Vector3(0, 0, UPPER_FDI.has(fdi) ? -1 : 1);

  const ringC = resampleRing(ring.map(p => p.clone().applyMatrix3(R)));
  const centre = ringC.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(ringC.length);
  const ringRadius = Math.max(...ringC.map(p => Math.hypot(p.x - centre.x, p.y - centre.y)));

  // Only the arch near the site, as (dx, dy, height) from the ring centre in the canonical
  // frame, height toward the antagonist. Rotated without allocating: arch scans run to a
  // million vertices.
  const e = R.elements; // column-major: e[0], e[3], e[6] is row 0 of R
  const c0 = centre.clone().applyMatrix3(back);
  const near = [];
  for (let i = 0; i < prepPositions.length; i += 3) {
    const x = prepPositions[i] - c0.x;
    const y = prepPositions[i + 1] - c0.y;
    const z = prepPositions[i + 2] - c0.z;
    const dx = e[0] * x + e[3] * y + e[6] * z;
    const dy = e[1] * x + e[4] * y + e[7] * z;
    if (dx * dx + dy * dy >= BAND_OUTER_MM * BAND_OUTER_MM) continue;
    near.push(dx, dy, (e[2] * x + e[5] * y + e[8] * z) * up.z);
  }
  const arch = Float64Array.from(near);

  const { md, how } = mesioDistal(arch, ringC, centre, ringRadius);
  const toMidline = [1, 4].includes(Math.floor(fdi / 10)) ? -1 : 1; // +X is the patient's right
  if (md.x * toMidline + md.y < 0) md.negate();
  const bl = new THREE.Vector3().crossVectors(up, md).normalize();
  if (bl.x * -toMidline + bl.y < 0) bl.negate();

  // The soft-tissue tunnel inside the ring: how deep the scan goes, and where its bottom is.
  const poly = ringC.map(p => [p.x - centre.x, p.y - centre.y]);
  const inside = [];
  for (let i = 0; i < arch.length; i += 3) {
    if (Math.hypot(arch[i], arch[i + 1]) <= ringRadius && insidePolygon(arch[i], arch[i + 1], poly)) inside.push(i);
  }
  let tunnel = null;
  if (inside.length >= 30) {
    const heights = inside.map(i => arch[i + 2]).sort((a, b) => a - b);
    const floor = heights[Math.floor(0.05 * (heights.length - 1))];
    if (floor <= -0.3) {
      const lateral = new THREE.Vector3();
      let n = 0;
      for (const i of inside) {
        if (arch[i + 2] >= floor + 0.5) continue;
        lateral.x += arch[i];
        lateral.y += arch[i + 1];
        n++;
      }
      lateral.divideScalar(n);
      tunnel = { depth_mm: -floor, offset_md_mm: lateral.dot(md), offset_bl_mm: lateral.dot(bl), points: inside.length };
    }
  }
  return { back, up, centre, md, bl, tunnel, axesFrom: how };
};

/**
 * @param {ReturnType<typeof measureSite>} site
 * @param {object} params PLACEMENT_DEFAULTS with the user's overrides
 * @returns {{ center: THREE.Vector3, axis: THREE.Vector3, matrix: THREE.Matrix4, record: object }}
 *   center = the implant platform, axis = toward the occlusal side, matrix = library part
 *   frame (platform at the origin, occlusal +Z) to the uploaded frame.
 */
const placeImplant = (site, params) => {
  const { back, up, centre, md, bl, tunnel } = site;
  const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));
  let depth, depthSource;
  if (params.depth_mm != null) [depth, depthSource] = [params.depth_mm, 'caller'];
  else if (tunnel) [depth, depthSource] = [clamp(tunnel.depth_mm, AUTO_DEPTH_RANGE), 'tunnel'];
  else [depth, depthSource] = [AUTO_DEPTH_FALLBACK, 'default'];
  const offsets = {};
  const sources = {};
  for (const key of ['offset_md_mm', 'offset_bl_mm']) {
    if (params[key] != null) [offsets[key], sources[key]] = [params[key], 'caller'];
    else if (tunnel) [offsets[key], sources[key]] = [clamp(tunnel[key], [-AUTO_OFFSET_LIMIT, AUTO_OFFSET_LIMIT]), 'tunnel'];
    else [offsets[key], sources[key]] = [0, 'default'];
  }

  const rad = THREE.MathUtils.degToRad;
  const axisC = up.clone()
    .addScaledVector(md, Math.tan(rad(params.tilt_md_deg)))
    .addScaledVector(bl, Math.tan(rad(params.tilt_bl_deg)))
    .normalize();
  const centerC = centre.clone()
    .addScaledVector(up, -depth)
    .addScaledVector(md, offsets.offset_md_mm)
    .addScaledVector(bl, offsets.offset_bl_mm);

  // Library frame -> canonical: +Z along the implant axis, +X toward mesial.
  const xC = md.clone().projectOnPlane(axisC).normalize();
  const yC = new THREE.Vector3().crossVectors(axisC, xC);
  const toCanonical = new THREE.Matrix4().makeBasis(xC, yC, axisC).setPosition(centerC);
  const toOriginal = new THREE.Matrix4().setFromMatrix3(back);

  return {
    center: centerC.clone().applyMatrix3(back),
    axis: axisC.clone().applyMatrix3(back).normalize(),
    matrix: toOriginal.multiply(toCanonical),
    record: {
      depth_mm: depth,
      depth_source: depthSource,
      ...offsets,
      offset_sources: sources,
      tilt_md_deg: params.tilt_md_deg,
      tilt_bl_deg: params.tilt_bl_deg,
      axis_tilt_deg: THREE.MathUtils.radToDeg(axisC.angleTo(up)),
      axes_from: site.axesFrom,
      tunnel,
    },
  };
};

export { PLACEMENT_DEFAULTS, PLACEMENT_RANGES, measureSite, placeImplant };
