import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

import { buildPeekLower, preparePeekCrown } from '../../utils/function/peek/buildPeekLower';
import { measureSite, placeImplant } from '../../utils/function/peek/implantPlacement';
import { genericInterface, genericTibase, loadLibraryBase } from '../../utils/function/peek/peekBase';

/**
 * One job's PEEK lower part, rebuilt as the parameters change. Holds what does not change
 * between rebuilds -- the shell, the margin, the site measurement -- and the prepared crown
 * for the current implant position, which is the slow part (see preparePeekCrown).
 */
class PeekBuilder {
  constructor() {
    this.job = null;
  }

  /**
   * @param {object} job
   * @param {Blob} job.crownBlob the job's crown.ply
   * @param {number[][]} job.marginOriginal the ring the job used, uploaded frame
   * @param {number[][]} job.rotation alignment.json's rotation_matrix
   * @param {number} job.fdi
   * @param {ArrayLike<number>} job.prepPositions the preparation arch's vertex positions
   */
  async setJob({ crownBlob, marginOriginal, rotation, fdi, prepPositions }) {
    this.dispose();
    if (!rotation) throw new Error('結果裡沒有 alignment.json（擺正的旋轉），無法估計植體位置');
    const crown = new PLYLoader().parse(await crownBlob.arrayBuffer());
    const marginPoints = marginOriginal.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const startedAt = performance.now();
    const site = measureSite({ prepPositions, ring: marginPoints, rotation, fdi });
    this.job = { crown, marginPoints, site, siteMs: performance.now() - startedAt, ready: null, readyKey: null };
  }

  get hasJob() {
    return Boolean(this.job);
  }

  /**
   * @param {object} params peekParams.js's PEEK_DEFAULTS with the user's changes
   * @param {{ system: string, type: string, subtype: string }|null} library a library part,
   *   or null for the generic base
   * @returns {Promise<object>} buildPeekLower's result plus placement, shell and timings;
   *   or { error, ... }
   */
  async build(params, library) {
    const job = this.job;
    if (!job) throw new Error('還沒有外壁');
    const implant = placeImplant(job.site, params);
    const key = implant.matrix.elements.map(value => value.toFixed(6)).join(',');
    let prepareMs = 0;
    if (job.readyKey !== key) {
      job.ready?.prepared?.crown.dispose();
      job.ready = preparePeekCrown({ crownGeometry: job.crown, marginPoints: job.marginPoints, implant });
      job.readyKey = key;
      prepareMs = job.ready.ms ?? 0;
    }
    const common = { placement: implant.record, shell: job.ready.shell, siteMs: job.siteMs, prepareMs };
    if (job.ready.error) return { ...common, error: job.ready.error };

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
    // Library parts are cached for the next build; the generic ones are made per build.
    if (generic) {
      base.interface.dispose();
      base.tibase.dispose();
    }
    wallInterfaceGeometry?.dispose();
    if (out.error) return { ...common, error: out.error };
    out.peek.dispose();
    out.base.dispose();
    return {
      ...common,
      solid: out.solid,
      tibase: out.tibase,
      record: out.record,
      baseLabel: base.label,
      // What the result was built with, for the panel to describe it rather than the form.
      cavity: generic ? params.cavity : true,
      generic,
    };
  }

  dispose() {
    this.job?.crown.dispose();
    this.job?.ready?.prepared?.crown.dispose();
    this.job = null;
  }
}

export default PeekBuilder;
