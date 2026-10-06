import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/**
 * What the PEEK crown's lower part is stitched onto: the "interface" -- the surface of the
 * PEEK that sits on the titanium base (or on the implant itself, 1-piece) -- and, for show,
 * the titanium base. Both in LIBRARY coordinates: the implant platform at the origin, the
 * occlusal direction +Z (implantPlacement.js supplies the matrix to the scans' frame).
 *
 * Two sources:
 *  - generic: a placeholder made from four numbers, available everywhere;
 *  - library: the implant library AIrDesign uses (EZCAD's ImplantAbutment), when this
 *    instance has a copy under public/implant-library/ -- see that folder's index.json and
 *    the README. public/ is not in git, so a fresh checkout has only the generic base.
 *
 * As in AIrDesign, the lower part is stitched to the interface's OUTERMOST open boundary;
 * a library interface also has an inner one (the screw channel), which stays open -- the
 * screw channel through the crown is not built here or there yet.
 */

const GENERIC_DEFAULTS = {
  // Roughly a 2-piece Ti-base interface (Straumann BL RC's is 3.98 / 3.38 / 2.6 / 0.48).
  interface_diameter_mm: 4.0, // where the PEEK sits on the titanium
  chimney_diameter_mm: 3.4, // the post that goes up inside the PEEK
  chimney_height_mm: 2.6,
  collar_height_mm: 0.5, // titanium between the implant platform and the interface
  cavity: true, // cut the base's cavity into the PEEK; false: a flat bottom
};
const GENERIC_RANGES = {
  interface_diameter_mm: [3.0, 6.5],
  chimney_diameter_mm: [2.0, 5.0],
  chimney_height_mm: [1.0, 8.0],
  collar_height_mm: [0.0, 4.0],
};
const SEGMENTS = 128;
const CEMENT_GAP_MM = 0.05;

/**
 * A surface of revolution about +Z from a profile [[r, z], ...] (r = 0 closes it on the
 * axis). Faces wind so that the normals point to the left of the profile's direction of
 * travel, i.e. outward for a profile that goes up the outside.
 */
const revolve = (profile, segments = SEGMENTS) => {
  const positions = [];
  const rows = profile.map(([r, z]) => {
    const start = positions.length / 3;
    const count = r > 1e-9 ? segments : 1;
    for (let k = 0; k < count; k++) {
      const angle = (2 * Math.PI * k) / segments;
      positions.push(r * Math.cos(angle), r * Math.sin(angle), z);
    }
    return { start, count };
  });
  const index = [];
  const at = (row, k) => row.start + (row.count === 1 ? 0 : k % segments);
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    for (let k = 0; k < segments; k++) {
      const a0 = at(a, k), a1 = at(a, k + 1), b0 = at(b, k), b1 = at(b, k + 1);
      if (a.count > 1) index.push(a0, a1, b1);
      if (b.count > 1) index.push(a0, b1, b0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
};

/**
 * The generic interface: from the outer ring at the interface height across the ledge, up
 * the chimney and over its top -- closed, since the screw channel is not modelled -- or,
 * with cavity off, a flat disc across the outer ring. Open only at the outer ring.
 */
const genericInterface = params => {
  const ri = params.interface_diameter_mm / 2;
  const rc = Math.min(params.chimney_diameter_mm / 2, ri - 0.05);
  const z0 = params.collar_height_mm;
  const z1 = z0 + params.chimney_height_mm;
  const profile = params.cavity
    ? [[ri, z0], [rc, z0], [rc, z1], [0, z1]]
    : [[ri, z0], [0, z0]];
  return revolve(profile);
};

/** A closed placeholder titanium base, for show: collar, then the chimney inside the PEEK. */
const genericTibase = params => {
  const ri = params.interface_diameter_mm / 2;
  const rc = Math.min(params.chimney_diameter_mm / 2, ri - 0.05) - CEMENT_GAP_MM;
  const z0 = params.collar_height_mm;
  const z1 = z0 + params.chimney_height_mm - CEMENT_GAP_MM;
  // Up the outside: the normals point outward. The ledge and the chimney's top follow.
  return revolve([[0, 0], [ri, 0], [ri, z0], [rc, z0], [rc, z1], [0, z1]]);
};

// --- the library -----------------------------------------------------------------------------

const LIBRARY_URL = '/implant-library';
let indexPromise = null;
const geometryCache = new Map();

/**
 * The library's index, or null when this instance has none. Cached; a failed load is
 * retried on the next call.
 * @returns {Promise<null|{ systems: { name: string, folder: string, types: { name: string,
 *   subtypes: { name: string, interface: string, tibase?: string }[] }[] }[] }>}
 */
const loadLibraryIndex = () => {
  if (!indexPromise) {
    indexPromise = fetch(`${LIBRARY_URL}/index.json`)
      .then(response => (response.ok ? response.json() : null))
      .then(index => (index?.systems?.length ? index : null))
      .catch(() => null)
      .then(index => {
        if (!index) indexPromise = null;
        return index;
      });
  }
  return indexPromise;
};

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

/** @returns {Promise<THREE.BufferGeometry>} a part as stored (library coordinates) */
const loadLibraryPart = async (folder, fileName) => {
  const url = `${LIBRARY_URL}/${encodePath(`${folder}/${fileName}`)}`;
  if (!geometryCache.has(url)) {
    const promise = fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`讀不到模型庫零件 ${fileName}（${response.status}）`);
        return response.arrayBuffer();
      })
      .then(buffer => new STLLoader().parse(buffer));
    geometryCache.set(url, promise);
    promise.catch(() => geometryCache.delete(url));
  }
  return geometryCache.get(url);
};

/**
 * @param {{ system: string, type: string, subtype: string }} selection
 * @returns {Promise<{ interface: THREE.BufferGeometry, tibase: THREE.BufferGeometry|null, label: string }>}
 */
const loadLibraryBase = async selection => {
  const index = await loadLibraryIndex();
  const system = index?.systems.find(item => item.name === selection.system);
  const type = system?.types.find(item => item.name === selection.type);
  const subtype = type?.subtypes.find(item => item.name === selection.subtype);
  if (!subtype) throw new Error('模型庫裡找不到選定的鈦基座');
  const [iface, tibase] = await Promise.all([
    loadLibraryPart(system.folder, subtype.interface),
    subtype.tibase ? loadLibraryPart(system.folder, subtype.tibase) : null,
  ]);
  return { interface: iface, tibase, label: `${type.name} ${subtype.name}` };
};

export {
  GENERIC_DEFAULTS, GENERIC_RANGES, genericInterface, genericTibase, loadLibraryIndex, loadLibraryBase,
};
