import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import {
  buildAbutmentGeometry,
  createDefaultAbutmentDesignParam,
  extractBoundaryLoops,
  orientBaseForStitching,
  prepareAbutmentCrown,
  toIndexedPositionGeometry,
} from './AbutmentLoft';
import { cleanShell } from './cleanShell';

/**
 * The PEEK crown's lower part, built in this browser the way AIrDesign builds it: the outer
 * shell from ezai-pipeline has its rim fitted to the margin, then is lofted down onto the
 * interface at the implant (AbutmentLoft.js, copied from airdental).
 *
 * Inputs are in the frame of the uploaded scans; so are the outputs.
 */

// AbutmentLoft.js's errors, for the panel.
const ERROR_TEXT = {
  'crown has no open boundary': '外壁沒有開口（服務回傳的是封閉牙冠，外壁未分離），無法接到鈦基座。',
  'margin does not surround the crown': '外壁下緣和 margin 對不上：兩者之一沒有繞成一圈（外壁可能破損，或下緣偏離 margin），無法把外壁下緣對到 margin。',
  'margin does not surround the implant': '植體不在外壁下緣的範圍內（偏移太大？），無法放樣。',
  'abutment base has no open boundary': '鈦基座介面沒有開口邊界，無法縫合。',
  'abutment base does not surround the implant': '鈦基座介面沒有繞著植體軸，無法縫合。',
};

/**
 * The interface's vertices this close to its stitched rim are left out of the wall check:
 * at the rim the PEEK thins to nothing by design, and on the ledge beside it the wall is
 * the ledge's width (0.3 mm on Straumann BL RC), on every case. What the check is for is
 * the chimney higher up, poking out through the emergence or the crown.
 */
const WALL_RIM_EXCLUSION_MM = 1.0;
/**
 * And only the interface above the rim: below it is what goes into the implant on a
 * 1-piece part (down to 4.65 mm below the platform on Straumann BL RC), which is the outside
 * of the PEEK there, not something it has to cover.
 */
const WALL_ABOVE_RIM_MM = 0.3;

/**
 * How much PEEK is left around the interface: for each interface vertex above the rim and
 * away from it, the distance to the outer surface (shell + lower part), negative where it
 * pokes out.
 * @returns {number|null} the smallest, mm
 */
const thinnestWall = (outer, base, rimPoints, implant) => {
  const outerIndexed = outer.index ? outer : mergeVertices(outer);
  const bvh = new MeshBVH(outerIndexed);
  const positions = base.getAttribute('position');
  const index = outerIndexed.index.array;
  const outerPositions = outerIndexed.getAttribute('position');
  const point = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const hit = {};
  const rimSq = WALL_RIM_EXCLUSION_MM ** 2;
  const heightOf = p => p.clone().sub(implant.center).dot(implant.axis);
  const lowest = rimPoints.reduce((sum, p) => sum + heightOf(p), 0) / Math.max(1, rimPoints.length) + WALL_ABOVE_RIM_MM;
  let thinnest = null;
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i);
    if (heightOf(point) < lowest || rimPoints.some(rim => rim.distanceToSquared(point) < rimSq)) continue;
    if (!bvh.closestPointToPoint(point, hit)) continue;
    a.fromBufferAttribute(outerPositions, index[hit.faceIndex * 3]);
    b.fromBufferAttribute(outerPositions, index[hit.faceIndex * 3 + 1]);
    c.fromBufferAttribute(outerPositions, index[hit.faceIndex * 3 + 2]);
    normal.subVectors(c, b).cross(a.sub(b));
    // The outer surface's normals point out of the PEEK: a vertex on their side is outside.
    const outside = normal.dot(point.clone().sub(hit.point)) > 0;
    const wall = outside ? -hit.distance : hit.distance;
    if (thinnest == null || wall < thinnest) thinnest = wall;
  }
  return thinnest;
};

/**
 * The part that depends only on the shell, the margin and the implant: clean the shell
 * (cleanShell.js), then AbutmentLoft's prepareAbutmentCrown -- fit the shell's rim to the
 * margin. Most of the time goes here (0.5-0.7 s on the first cases), so, as in AIrDesign's
 * own abutment step, changing only the emergence or the base reuses it.
 * @param {object} options
 * @param {THREE.BufferGeometry} options.crownGeometry the job's crown.ply (the outer shell)
 * @param {THREE.Vector3[]} options.marginPoints the ring the job used
 * @param {{ center: THREE.Vector3, axis: THREE.Vector3 }} options.implant
 * @returns {{ error: string, shell: object } | { prepared: object, shell: object, ms: number }}
 */
const preparePeekCrown = ({ crownGeometry, marginPoints, implant }) => {
  const startedAt = performance.now();
  const marginCentre = marginPoints.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(marginPoints.length);
  const cleaned = cleanShell(crownGeometry, { center: marginCentre, axis: implant.axis });
  const shell = {
    merged: cleaned.merged,
    dropped: cleaned.dropped,
    peeled: cleaned.peeled,
    non_manifold_edges: cleaned.nonManifoldEdges,
    pinched_vertices: cleaned.pinchedVertices,
    rim_backtracks: cleaned.rimBacktracks,
    rim_moved: cleaned.rimMoved,
    rim_max_move_mm: cleaned.rimMaxMoveMm,
  };
  const prepared = prepareAbutmentCrown({
    crownGeometry: cleaned.geometry,
    marginPoints,
    // As in AIrDesign: the margin fit's height direction is the implant axis too.
    occlusalAxis: implant.axis,
    implantAxis: implant.axis,
    implantCenter: implant.center,
  });
  cleaned.geometry.dispose();
  if (prepared.error) return { error: ERROR_TEXT[prepared.error] ?? prepared.error, shell };
  return { prepared, shell, ms: performance.now() - startedAt };
};

/**
 * The lower part on a prepared crown (preparePeekCrown, for the same implant).
 * @param {object} options
 * @param {object} options.prepared preparePeekCrown(...).prepared
 * @param {{ center: THREE.Vector3, axis: THREE.Vector3, matrix: THREE.Matrix4 }} options.implant
 * @param {THREE.BufferGeometry} options.interfaceGeometry library coordinates
 * @param {THREE.BufferGeometry|null} options.tibaseGeometry library coordinates, for show
 * @param {{ radial_mm: number, bone_avoid_mm: number }} options.tissue
 * @param {THREE.BufferGeometry|null} [options.wallInterfaceGeometry] measure the wall
 *   against this interface instead (library coordinates): the cavity a later cut would
 *   make, when the one stitched on is a flat bottom
 * @returns {{ error: string } | { peek: THREE.BufferGeometry, base: THREE.BufferGeometry,
 *   tibase: THREE.BufferGeometry|null, solid: THREE.BufferGeometry, record: object }}
 *   peek = shell + lower part, base = the interface placed and oriented, solid = the two as
 *   one mesh (the download).
 */
const buildPeekLower = ({ prepared, implant, interfaceGeometry, tibaseGeometry, tissue, wallInterfaceGeometry = null }) => {
  const startedAt = performance.now();
  const base = interfaceGeometry.clone().applyMatrix4(implant.matrix);
  orientBaseForStitching(base, implant.axis, implant.center);

  const param = createDefaultAbutmentDesignParam();
  param.tissueOffsets.forEach(offset => { offset.radial = tissue.radial_mm; });
  param.boneAvoid = tissue.bone_avoid_mm;

  const { geometry, error } = buildAbutmentGeometry({
    prepared,
    baseGeometry: base,
    implantAxis: implant.axis,
    implantCenter: implant.center,
    param,
  });
  if (!geometry) return { error: ERROR_TEXT[error] ?? error };
  const loftMs = performance.now() - startedAt;

  // One mesh for the download and for counting what is still open.
  const baseIndexed = toIndexedPositionGeometry(base);
  base.dispose();
  baseIndexed.computeVertexNormals();
  const solid = mergeVertices(mergeGeometries([
    new THREE.BufferGeometry().setAttribute('position', geometry.getAttribute('position')).setIndex(geometry.index),
    new THREE.BufferGeometry().setAttribute('position', baseIndexed.getAttribute('position')).setIndex(baseIndexed.index),
  ]), 1e-4);
  const openLoops = extractBoundaryLoops(solid);

  // The rim the lower part was stitched to: the interface's outermost open boundary.
  const radiusOf = p => p.clone().sub(implant.center).projectOnPlane(implant.axis).length();
  const outerRim = surface => {
    const positions = surface.getAttribute('position');
    return extractBoundaryLoops(surface)
      .map(loop => loop.map(i => new THREE.Vector3().fromBufferAttribute(positions, i)))
      .reduce((best, loop) => {
        const r = loop.reduce((sum, p) => sum + radiusOf(p), 0) / loop.length;
        return !best || r > best.r ? { loop, r } : best;
      }, null)?.loop ?? [];
  };
  const rim = outerRim(baseIndexed);
  let wall;
  if (wallInterfaceGeometry) {
    const wallSurface = toIndexedPositionGeometry(wallInterfaceGeometry, implant.matrix);
    wall = thinnestWall(geometry, wallSurface, outerRim(wallSurface), implant);
    wallSurface.dispose();
  } else {
    wall = thinnestWall(geometry, baseIndexed, rim, implant);
  }

  solid.computeVertexNormals();
  const tibase = tibaseGeometry ? tibaseGeometry.clone().applyMatrix4(implant.matrix) : null;
  tibase?.computeVertexNormals();

  return {
    peek: geometry,
    base: baseIndexed,
    tibase,
    solid,
    record: {
      loft_ms: loftMs,
      build_ms: performance.now() - startedAt,
      min_wall_mm: wall,
      open_loops: openLoops.length,
      stitched_rim_mm: 2 * (rim.reduce((sum, p) => sum + radiusOf(p), 0) / Math.max(1, rim.length)),
    },
  };
};

export { buildPeekLower, preparePeekCrown };
