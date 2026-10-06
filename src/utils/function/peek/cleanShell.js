import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Make the pipeline's outer shell survive AbutmentLoft.js.
 *
 * crown.ply is a manifold with one open rim, as stored. But AbutmentLoft welds at
 * 0.0001 mm (toIndexedPositionGeometry → mergeVertices) and two things in the shell do not
 * survive that, seen on the first five no-abutment cases (2026-10-06):
 *  - 32-37 edges shorter than 0.0001 mm per shell (marching-cubes slivers). The weld
 *    collapses them by grid cell, not along the mesh, leaving degenerate triangles;
 *  - on 2 of the 5 the rim touches itself: two rim vertices at the very same spot, not
 *    joined by an edge. Welded, that is a pinch -- four rim edges at one vertex.
 * Either breaks AbutmentLoft's walk around the rim into pieces, and the loft then fails with
 * "margin does not surround the crown" (2/5 before this) or leaves the solid with holes.
 * And a third thing that survives the weld but not the loft:
 *  - the rim zig-zags at the scale of a triangle: 2-13 places per rim where it runs
 *    backwards around the axis for a step (up to 7 degrees in all). The margin fit moves
 *    every rim vertex to the margin AT ITS OWN ANGLE, so each zig-zag becomes a fold, and
 *    the lacing to the lower part, which orders the rim by angle, leaves a little hole or a
 *    non-manifold edge at each one.
 * AIrDesign will meet the same shells, so the real fix belongs in the pipeline; until then
 * this does the weld first, along the mesh's own edges and between coincident vertices,
 * drops what that flattens, peels the triangles off any vertex left pinched, and then turns
 * the zig-zagging rim vertices round the axis, each by the least that makes the rim run one
 * way round (a fraction of a millimetre; the margin fit moves them all onto the margin
 * afterwards anyway). Peeling the zig-zags off instead does not settle: each peel exposes
 * new ones (tried; 27 left on one case after 600 faces).
 */

/** Edges shorter than this are collapsed. */
const MIN_EDGE_MM = 1e-3;
/**
 * Vertices closer than this are merged even without an edge between them: the downstream
 * weld's 0.0001 mm grid cells can put points up to 0.000173 mm apart together.
 */
const COINCIDENT_MM = 2e-4;
const MAX_PEEL_PASSES = 5;

/** A union-find over vertex indices. */
const unionFind = count => {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = i => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) return false;
    parent[ri] = rj;
    return true;
  };
  return { find, union };
};

/** Undirected edge → how many faces use it, and the faces around each vertex. */
const topology = (faces, vertexCount) => {
  const edgeUse = new Map();
  const boundaryDegree = new Map();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const i = f[k];
      const j = f[(k + 1) % 3];
      const key = i < j ? i * vertexCount + j : j * vertexCount + i;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const bad = new Set();
  for (const [key, uses] of edgeUse) {
    const i = Math.floor(key / vertexCount);
    const j = key % vertexCount;
    if (uses > 2) {
      bad.add(i);
      bad.add(j);
    }
    if (uses !== 1) continue;
    boundaryDegree.set(i, (boundaryDegree.get(i) ?? 0) + 1);
    boundaryDegree.set(j, (boundaryDegree.get(j) ?? 0) + 1);
  }
  let nonManifoldEdges = 0;
  for (const uses of edgeUse.values()) if (uses > 2) nonManifoldEdges++;
  let pinchedVertices = 0;
  for (const [vertex, degree] of boundaryDegree) {
    if (degree <= 2) continue;
    bad.add(vertex);
    pinchedVertices++;
  }
  return { bad, nonManifoldEdges, pinchedVertices };
};

/**
 * The longest open boundary loop, as vertices in order, or [] when there is none. Only used
 * once the mesh has no pinches, so each boundary vertex has one way on.
 */
const rimLoop = (faces, vertexCount) => {
  const directed = new Set();
  for (const f of faces) for (let k = 0; k < 3; k++) directed.add(f[k] * vertexCount + f[(k + 1) % 3]);
  const next = new Map();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const i = f[k];
      const j = f[(k + 1) % 3];
      if (!directed.has(j * vertexCount + i)) next.set(i, j);
    }
  }
  const visited = new Set();
  let longest = [];
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    for (let v = start; v !== undefined && !visited.has(v); v = next.get(v)) {
      visited.add(v);
      loop.push(v);
    }
    if (loop.length > longest.length) longest = loop;
  }
  return longest;
};

/**
 * Turn rim vertices round `axis` (through `center`) so that the rim's angle only ever goes
 * one way. Along the loop, starting just after its biggest forward step, every vertex that
 * is not ahead of all the ones before it is out of order; each run of those is spread
 * evenly between the in-order vertices either side of it. (Pushing each up to its
 * predecessor's angle instead bunches them at one angle, and after the margin fit their
 * order round the implant can come out either way -- one hole left on FDI 16.) Moves
 * vertices in place (they are the Vector3s positionOf hands out).
 * @returns {{ moved: number, maxMoveMm: number, backtracks: number }} backtracks = steps
 *   that ran the wrong way before
 */
const straightenRim = (loop, positionOf, center, axis) => {
  if (loop.length < 3) return { moved: 0, maxMoveMm: 0, backtracks: 0 };
  const u = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.projectOnPlane(axis).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u);
  const offset = new THREE.Vector3();
  const angles = loop.map(vertex => {
    offset.subVectors(positionOf(vertex), center);
    return Math.atan2(offset.dot(v), offset.dot(u));
  });
  const steps = angles.map((angle, i) => {
    let step = angles[(i + 1) % angles.length] - angle;
    if (step > Math.PI) step -= 2 * Math.PI;
    if (step < -Math.PI) step += 2 * Math.PI;
    return step;
  });
  const way = Math.sign(steps.reduce((sum, step) => sum + step, 0)) || 1;
  const backtracks = steps.filter(step => step * way <= 0).length;
  if (backtracks === 0) return { moved: 0, maxMoveMm: 0, backtracks };

  // Unwrap forward from just after the biggest forward step; theta[n] closes the loop.
  const n = loop.length;
  const first = (steps.reduce((best, step, i) => (step * way > steps[best] * way ? i : best), 0) + 1) % n;
  const order = Array.from({ length: n }, (_, k) => (first + k) % n);
  const theta = [0];
  for (let k = 1; k <= n; k++) theta.push(theta[k - 1] + steps[order[k - 1]] * way);
  // In order = ahead of every vertex before it (and behind the loop's closing angle).
  const inOrder = new Array(n + 1).fill(false);
  inOrder[0] = inOrder[n] = true;
  let best = theta[0];
  for (let k = 1; k < n; k++) {
    if (theta[k] > best && theta[k] < theta[n]) {
      inOrder[k] = true;
      best = theta[k];
    }
  }
  // A vertex ahead of everything before it but behind something it should come after (a
  // later in-order vertex is lower) cannot happen: in-order angles only rise.
  const target = theta.slice();
  for (let k = 1; k < n; k++) {
    if (inOrder[k]) continue;
    let end = k;
    while (!inOrder[end]) end++;
    const low = target[k - 1];
    const high = theta[end];
    for (let j = k; j < end; j++) target[j] = low + ((high - low) * (j - k + 1)) / (end - k + 1);
    k = end;
  }

  let moved = 0;
  let maxMoveMm = 0;
  const turn = new THREE.Quaternion();
  for (let k = 1; k < n; k++) {
    const delta = target[k] - theta[k];
    if (delta === 0) continue;
    const p = positionOf(loop[order[k]]);
    const before = p.clone();
    offset.subVectors(p, center).applyQuaternion(turn.setFromAxisAngle(axis, delta * way));
    p.copy(center).add(offset);
    moved++;
    maxMoveMm = Math.max(maxMoveMm, before.distanceTo(p));
  }
  return { moved, maxMoveMm, backtracks };
};

/** Faces of the largest edge-connected piece. */
const largestPiece = (faces, vertexCount) => {
  const { find, union } = unionFind(vertexCount);
  for (const f of faces) {
    union(f[0], f[1]);
    union(f[0], f[2]);
  }
  const sizes = new Map();
  for (const f of faces) sizes.set(find(f[0]), (sizes.get(find(f[0])) ?? 0) + 1);
  let best = null;
  for (const [root, size] of sizes) if (best == null || size > sizes.get(best)) best = root;
  return faces.filter(f => find(f[0]) === best);
};

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {{ center: THREE.Vector3, axis: THREE.Vector3 }} around the rim must run one way
 *   round this axis through this point (the margin's centroid and the implant axis: what
 *   the margin fit measures its angles about)
 * @returns {{ geometry: THREE.BufferGeometry, merged: number, dropped: number, peeled: number,
 *   nonManifoldEdges: number, pinchedVertices: number, rimBacktracks: number,
 *   rimMoved: number, rimMaxMoveMm: number }} merged = vertices merged into another,
 *   dropped = faces flattened or doubled by that, peeled = faces taken off pinches (the two
 *   after it should then be 0), rimBacktracks = the rim's steps that ran the wrong way,
 *   rimMoved / rimMaxMoveMm = how many rim vertices were turned to fix them, and how far.
 */
const cleanShell = (geometry, around) => {
  const source = geometry.index ? geometry : mergeVertices(geometry, 1e-6);
  const positions = source.getAttribute('position');
  const index = source.index.array;
  const count = positions.count;
  const { find, union } = unionFind(count);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  // 1. Short edges, along the mesh.
  let merged = 0;
  const minSq = MIN_EDGE_MM * MIN_EDGE_MM;
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i = index[t + k];
      const j = index[t + (k + 1) % 3];
      if (a.fromBufferAttribute(positions, i).distanceToSquared(b.fromBufferAttribute(positions, j)) < minSq && union(i, j)) merged++;
    }
  }
  // 2. Coincident vertices with no edge between them: a sweep along x.
  const xs = Float64Array.from({ length: count }, (_, i) => positions.getX(i));
  const byX = Uint32Array.from({ length: count }, (_, i) => i).sort((i, j) => xs[i] - xs[j]);
  const coincidentSq = COINCIDENT_MM * COINCIDENT_MM;
  for (let s = 0; s < count; s++) {
    const i = byX[s];
    a.fromBufferAttribute(positions, i);
    for (let t = s + 1; t < count && xs[byX[t]] - xs[i] < COINCIDENT_MM; t++) {
      const j = byX[t];
      if (a.distanceToSquared(b.fromBufferAttribute(positions, j)) < coincidentSq && union(i, j)) merged++;
    }
  }

  // 3. Faces on the merged vertices. One that lost a corner goes, and so do both of a pair
  //    that came to share all three corners (a zero-volume fin).
  const byKey = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const f = [find(index[t]), find(index[t + 1]), find(index[t + 2])];
    if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
    const key = [...f].sort((x, y) => x - y).join(',');
    byKey.set(key, byKey.has(key) ? null : f);
  }
  let faces = [...byKey.values()].filter(Boolean);
  const dropped = index.length / 3 - faces.length;

  // Each merged vertex sits at its group's mean.
  const sums = new Map();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!sums.has(root)) sums.set(root, { sum: new THREE.Vector3(), n: 0 });
    const slot = sums.get(root);
    slot.sum.add(a.fromBufferAttribute(positions, i));
    slot.n++;
  }
  const mergedAt = new Map([...sums].map(([root, { sum, n }]) => [root, sum.divideScalar(n)]));
  const positionOf = vertex => mergedAt.get(vertex);

  // 4. Peel the triangles off every pinched vertex (and both ends of every edge with more
  //    than two faces) until there are none, keeping the largest piece each time.
  let peeled = 0;
  let check = topology(faces, count);
  for (let pass = 0; pass < MAX_PEEL_PASSES && check.bad.size > 0; pass++) {
    const before = faces.length;
    faces = largestPiece(faces.filter(f => !f.some(vertex => check.bad.has(vertex))), count);
    peeled += before - faces.length;
    check = topology(faces, count);
  }

  // 5. The rim one way round.
  const rim = check.bad.size === 0 ? rimLoop(faces, count) : [];
  const straightened = straightenRim(rim, positionOf, around.center, around.axis);

  // 6. Compact.
  const slotOf = new Map();
  const out = [];
  const newIndex = [];
  for (const f of faces) {
    for (const vertex of f) {
      if (!slotOf.has(vertex)) {
        slotOf.set(vertex, out.length / 3);
        const p = positionOf(vertex);
        out.push(p.x, p.y, p.z);
      }
      newIndex.push(slotOf.get(vertex));
    }
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  result.setIndex(newIndex);
  return {
    geometry: result,
    merged,
    dropped,
    peeled,
    nonManifoldEdges: check.nonManifoldEdges,
    pinchedVertices: check.pinchedVertices,
    rimBacktracks: straightened.backtracks,
    rimMoved: straightened.moved,
    rimMaxMoveMm: straightened.maxMoveMm,
  };
};

export { cleanShell };
