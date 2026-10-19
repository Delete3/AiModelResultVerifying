import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

import { buildPeekLower, preparePeekCrown, thinnestWall } from '../../utils/function/peek/buildPeekLower';
import { measureSite, placeImplant } from '../../utils/function/peek/implantPlacement';
import { genericInterface, genericTibase, loadLibraryBase } from '../../utils/function/peek/peekBase';

// Ti-base vertices this far above the top of the 2-piece interface are the chimney.
const CHIMNEY_ABOVE_MM = 0.05;

/**
 * How much abutment is left around a 2-piece Ti-base's chimney, negative where it pokes out.
 * The library's 2-piece interface -- the hole bonded to the Ti-base -- ends where the chimney
 * starts (3.08 mm above the platform on Straumann BL RC; the chimney goes on to 8.48); in the
 * abutment the chimney's hole is the screw channel's, which is not made here, so the wall
 * check of the interface does not see the chimney. A crown on the peek tab covers it; a stump,
 * narrower and on an implant estimated off centre, often does not.
 * @returns {number|null} mm; null if the Ti-base has nothing above the interface
 */
const chimneyWall = (abutment, interfaceGeometry, tibaseGeometry, implant) => {
  const iface = interfaceGeometry.getAttribute('position');
  let top = -Infinity;
  for (let i = 0; i < iface.count; i++) top = Math.max(top, iface.getZ(i));
  const tibase = tibaseGeometry.getAttribute('position');
  const point = new THREE.Vector3();
  const chimney = [];
  for (let i = 0; i < tibase.count; i++) {
    if (tibase.getZ(i) <= top + CHIMNEY_ABOVE_MM) continue;
    point.fromBufferAttribute(tibase, i).applyMatrix4(implant.matrix);
    chimney.push(point.x, point.y, point.z);
  }
  if (!chimney.length) return null;
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(chimney, 3));
  const wall = thinnestWall(abutment, geometry, [], implant);
  geometry.dispose();
  return wall;
};

/**
 * A custom abutment on one 「產生支台齒」 job, rebuilt as the parameters change -- EZCAD's
 * abutment design (DentDesignAbutment::BuildAbutment_Solid) in the order it builds one:
 *
 *   upper part   the job's stump (the library stump, or the crown cut back): EZCAD's cap,
 *                taper, fillet and shoulder down to the abutment margin;
 *   emergence    lofted from that margin down to the implant interface (EZCAD's
 *                LoftSur_AbutmentTissue; here airdental's AbutmentLoft.js, as the peek tab's
 *                PEEK lower part), with its overall flare and bone avoidance;
 *   interface    the library part (or a generic placeholder), stitched to the emergence.
 *
 * No scan body: the implant stands on the stump's insertion axis (the one the job was built
 * along -- the camera's, a caller's, or the natural lean), its platform below the margin ring
 * at the depth of the scan's soft-tissue tunnel; every value can be overridden, and the tilts
 * lean the implant away from the insertion axis (an implant not coaxial with the abutment).
 *
 * The loft leaves the margin straight down the implant axis: the stump's own surface at its
 * edge is the shoulder (nearly flat), and following it would flare the emergence out past the
 * margin before turning down. The crown shells of the peek tab end on their axial wall and
 * keep AbutmentLoft's own tangent.
 */
class AbutmentBuilder {
  constructor() {
    this.job = null;
  }

  /**
   * @param {object} job
   * @param {Blob} job.stumpBlob the job's stump.ply
   * @param {number[][]} job.marginOriginal the ring the job used, uploaded frame
   * @param {number[][]} job.rotation alignment.json's rotation_matrix
   * @param {number} job.fdi
   * @param {ArrayLike<number>} job.prepPositions the arch's vertex positions (the scan as uploaded)
   * @param {number[]} job.axis the stump's insertion axis, uploaded frame (manifest
   *   stump.insertion_axis_original)
   */
  async setJob({ stumpBlob, marginOriginal, rotation, fdi, prepPositions, axis }) {
    this.dispose();
    if (!rotation) throw new Error('結果裡沒有 alignment.json（擺正的旋轉），無法估計植體位置');
    if (!axis) throw new Error('結果裡沒有支台齒的插入方向');
    const stump = new PLYLoader().parse(await stumpBlob.arrayBuffer());
    const marginPoints = marginOriginal.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const startedAt = performance.now();
    const site = measureSite({ prepPositions, ring: marginPoints, rotation, fdi });
    this.job = {
      stump, marginPoints, site, axis: new THREE.Vector3(...axis).normalize(),
      siteMs: performance.now() - startedAt, ready: null, readyKey: null,
    };
  }

  get hasJob() {
    return Boolean(this.job);
  }

  /**
   * @param {object} params peekParams.js's PEEK_DEFAULTS with the user's changes
   * @param {{ system: string, type: string, subtype: string }|null} library a library part,
   *   or null for the generic base
   * @returns {Promise<object>} buildPeekLower's result plus placement and timings; or { error, ... }
   */
  async build(params, library) {
    const job = this.job;
    if (!job) throw new Error('還沒有支台齒');
    const implant = placeImplant(job.site, params, job.axis);
    const key = implant.matrix.elements.map(value => value.toFixed(6)).join(',');
    let prepareMs = 0;
    if (job.readyKey !== key) {
      job.ready?.prepared?.crown.dispose();
      job.ready = preparePeekCrown({ crownGeometry: job.stump, marginPoints: job.marginPoints, implant });
      job.readyKey = key;
      prepareMs = job.ready.ms ?? 0;
      const prepared = job.ready.prepared;
      if (prepared) prepared.topTangents = prepared.topPoints.map(() => implant.axis.clone().negate());
    }
    const common = { placement: implant.record, siteMs: job.siteMs, prepareMs };
    if (job.ready.error) return { ...common, error: job.ready.error.replace(/外壁/g, '支台齒') };

    const generic = !library;
    const base = generic
      ? { interface: genericInterface(params), tibase: genericTibase(params), label: '通用（佔位尺寸）' }
      : await loadLibraryBase(library);
    const wallInterfaceGeometry = generic && !params.cavity ? genericInterface({ ...params, cavity: true }) : null;
    const out = buildPeekLower({
      prepared: job.ready.prepared,
      implant,
      interfaceGeometry: base.interface,
      tibaseGeometry: base.tibase,
      tissue: { radial_mm: params.radial_mm, bone_avoid_mm: params.bone_avoid_mm },
      wallInterfaceGeometry,
    });
    if (generic) {
      base.interface.dispose();
      base.tibase.dispose();
    }
    wallInterfaceGeometry?.dispose();
    if (out.error) return { ...common, error: out.error.replace(/外壁/g, '支台齒') };
    const chimney = generic || !base.tibase ? null : chimneyWall(out.peek, base.interface, base.tibase, implant);
    out.peek.dispose();
    out.base.dispose();
    return {
      ...common,
      solid: out.solid,
      tibase: out.tibase,
      record: { ...out.record, chimney_wall_mm: chimney },
      baseLabel: base.label,
      cavity: generic ? params.cavity : true,
      generic,
    };
  }

  dispose() {
    this.job?.stump.dispose();
    this.job?.ready?.prepared?.crown.dispose();
    this.job = null;
  }
}

export default AbutmentBuilder;
