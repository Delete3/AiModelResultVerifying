import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import Editor from '../Editor';
import { loadGeometry } from '../loader/loadGeometry';
import { disposeMesh } from '../tool/SceneTool';

const SCAN_COLOR = { upper: 0xdbe9f6, lower: 0xe9e1f7 };
const CROWN_COLOR = 0xff8a3d;
// Its own slot and its own colour rather than reusing the crown's: an abutment is generated
// FROM a crown, so the two are shown together and telling them apart matters.
const ABUTMENT_COLOR = 0x4dabf7;
const TRANSLUCENT_OPACITY = 0.35;

const UPPER_FDI = new Set([11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28]);

/** Which arch holds a tooth, by FDI numbering. null for anything that is not an FDI. */
const jawOfFdi = fdi => {
  const value = Number(fdi);
  if (!/^[1-4][1-8]$/.test(String(value))) return null;
  return UPPER_FDI.has(value) ? 'upper' : 'lower';
};

/**
 * The case on screen: the two arch scans, the crown, and a read-only reference ring (the
 * margin a pipeline job actually used). One owner for these, so that uploading a scan,
 * receiving a crown and toggling what is visible cannot leave duplicate meshes behind --
 * which is what the old per-result reload did.
 *
 * Scans are shown exactly as uploaded: no centring, no matrix. Their local frame is the
 * frame every margin and every pipeline crown is expressed in.
 */
class CaseScene {
  constructor() {
    this.meshes = { upper: null, lower: null, crown: null, abutment: null };
    this.files = { upper: null, lower: null };
    this.visible = { upper: true, lower: true, crown: true, abutment: true, reference: true };
    this.translucent = false;
    /** @type {Line2|null} */
    this.referenceRing = null;
    // Bumped whenever a scan mesh is replaced, so anything holding on to a mesh (the margin
    // editor) can tell a re-upload of the same file name from no change at all.
    this.revision = 0;
    this.listeners = new Set();
    this.snapshot = this.makeSnapshot();
    this.frame = null;
  }

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  makeSnapshot() {
    return {
      hasUpper: Boolean(this.meshes.upper),
      hasLower: Boolean(this.meshes.lower),
      hasCrown: Boolean(this.meshes.crown),
      hasAbutment: Boolean(this.meshes.abutment),
      hasReference: Boolean(this.referenceRing),
      revision: this.revision,
      upperName: this.files.upper?.name ?? null,
      lowerName: this.files.lower?.name ?? null,
      visible: { ...this.visible },
      translucent: this.translucent,
    };
  }

  emit() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  ensureLoop() {
    if (this.frame) return;
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      if (this.referenceRing && Editor.container) {
        this.referenceRing.material.resolution.set(Editor.container.clientWidth, Editor.container.clientHeight);
      }
    };
    loop();
  }

  // --- scans ------------------------------------------------------------------------------

  /**
   * @param {'upper'|'lower'} jaw
   * @param {File} file
   */
  async setScan(jaw, file) {
    const geometry = await loadGeometry(file);
    if (!geometry) throw new Error(`${file.name} 不是可讀的 STL / PLY / TRI`);
    const firstScan = !this.meshes.upper && !this.meshes.lower;

    this.removeScan(jaw, { silent: true });
    const material = new THREE.MeshStandardMaterial({
      color: SCAN_COLOR[jaw],
      roughness: 0.45,
      metalness: 0.05,
      side: THREE.DoubleSide,
      // Pushed back a little so a margin line lying exactly on the surface draws over it.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `scan-${jaw}`;
    Editor.scene.add(mesh);

    this.meshes[jaw] = mesh;
    this.files[jaw] = file;
    this.revision += 1;
    this.applyScanLook(jaw);
    if (firstScan) this.fitView();
    this.emit();
    return mesh;
  }

  removeScan(jaw, { silent = false } = {}) {
    const mesh = this.meshes[jaw];
    if (!mesh) return;
    if (this.referenceRing?.parent === mesh) this.clearReferenceRing({ silent: true });
    disposeMesh(mesh);
    mesh.geometry.disposeBoundsTree?.();
    this.meshes[jaw] = null;
    this.files[jaw] = null;
    this.revision += 1;
    if (!silent) this.emit();
  }

  applyScanLook(jaw) {
    const mesh = this.meshes[jaw];
    if (!mesh) return;
    mesh.visible = this.visible[jaw];
    mesh.material.transparent = this.translucent;
    mesh.material.opacity = this.translucent ? TRANSLUCENT_OPACITY : 1;
    mesh.material.depthWrite = !this.translucent;
    mesh.material.needsUpdate = true;
  }

  /**
   * Preview-only transform, for the direct FlowToothSDF path whose crowns come back in the
   * frame of the jaw matrices the user supplied. Pass null to return to the uploaded frame.
   * @param {'upper'|'lower'} jaw
   * @param {THREE.Matrix4|null} matrix
   */
  setScanMatrix(jaw, matrix) {
    const mesh = this.meshes[jaw];
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix ?? new THREE.Matrix4());
    mesh.matrixWorldNeedsUpdate = true;
    mesh.updateMatrixWorld(true);
  }

  resetScanMatrices() {
    this.setScanMatrix('upper', null);
    this.setScanMatrix('lower', null);
  }

  // --- crown ------------------------------------------------------------------------------

  /** @param {Blob} blob a PLY */
  async setCrown(blob, fileName = 'crown.ply') {
    const geometry = await loadGeometry(new File([blob], fileName, { type: 'model/ply' }));
    if (!geometry) throw new Error('無法解析回傳的牙冠模型');
    this.clearCrown({ silent: true });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: CROWN_COLOR,
      roughness: 0.4,
      metalness: 0.05,
      side: THREE.DoubleSide,
    }));
    mesh.name = 'crown';
    mesh.renderOrder = 2;
    mesh.visible = this.visible.crown;
    Editor.scene.add(mesh);
    this.meshes.crown = mesh;
    this.emit();
    return mesh;
  }

  clearCrown({ silent = false } = {}) {
    if (!this.meshes.crown) return;
    disposeMesh(this.meshes.crown);
    this.meshes.crown = null;
    if (!silent) this.emit();
  }

  // --- abutment ---------------------------------------------------------------------------

  /**
   * FSAbutment's result. Like the crown it arrives in the frame of the scans it was made
   * from, so it is added as uploaded -- no matrix, no centring.
   * @param {Blob} blob a PLY
   */
  async setAbutment(blob, fileName = 'abutment.ply') {
    const geometry = await loadGeometry(new File([blob], fileName, { type: 'model/ply' }));
    if (!geometry) throw new Error('無法解析回傳的 abutment 模型');
    this.clearAbutment({ silent: true });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: ABUTMENT_COLOR,
      roughness: 0.35,
      metalness: 0.15,
      side: THREE.DoubleSide,
    }));
    mesh.name = 'abutment';
    // Above the crown, which is 2: the abutment sits inside it and would otherwise be
    // hidden by the crown's own surface the moment both are shown.
    mesh.renderOrder = 3;
    mesh.visible = this.visible.abutment;
    Editor.scene.add(mesh);
    this.meshes.abutment = mesh;
    this.emit();
    return mesh;
  }

  clearAbutment({ silent = false } = {}) {
    if (!this.meshes.abutment) return;
    disposeMesh(this.meshes.abutment);
    this.meshes.abutment = null;
    if (!silent) this.emit();
  }

  // --- reference ring ---------------------------------------------------------------------

  /**
   * A read-only ring drawn on a scan: the margin a job actually used, in the uploaded frame.
   * @param {'upper'|'lower'} jaw
   * @param {number[][]} points
   */
  setReferenceRing(jaw, points) {
    this.clearReferenceRing({ silent: true });
    const mesh = this.meshes[jaw];
    if (!mesh || points.length < 2) {
      this.emit();
      return;
    }
    const flat = [];
    for (const [x, y, z] of [...points, points[0]]) flat.push(x, y, z);
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    const material = new LineMaterial({ color: 0x1098ad, linewidth: 2, worldUnits: false, dashed: false });
    material.polygonOffset = true;
    material.polygonOffsetFactor = -4;
    material.polygonOffsetUnits = -4;
    this.referenceRing = new Line2(geometry, material);
    this.referenceRing.name = 'reference-margin';
    this.referenceRing.renderOrder = 3;
    this.referenceRing.visible = this.visible.reference;
    this.referenceRing.userData.points = points;
    mesh.add(this.referenceRing);
    this.ensureLoop();
    this.emit();
  }

  clearReferenceRing({ silent = false } = {}) {
    if (!this.referenceRing) return;
    this.referenceRing.parent?.remove(this.referenceRing);
    this.referenceRing.geometry.dispose();
    this.referenceRing.material.dispose();
    this.referenceRing = null;
    if (!silent) this.emit();
  }

  // --- display ----------------------------------------------------------------------------

  /** @param {'upper'|'lower'|'crown'|'abutment'|'reference'} key */
  setVisible(key, visible) {
    this.visible[key] = visible;
    if (key === 'upper' || key === 'lower') this.applyScanLook(key);
    else if (key === 'crown' && this.meshes.crown) this.meshes.crown.visible = visible;
    else if (key === 'abutment' && this.meshes.abutment) this.meshes.abutment.visible = visible;
    else if (key === 'reference' && this.referenceRing) this.referenceRing.visible = visible;
    this.emit();
  }

  setTranslucent(translucent) {
    this.translucent = translucent;
    this.applyScanLook('upper');
    this.applyScanLook('lower');
    this.emit();
  }

  /** Frame everything visible, or the given objects. */
  fitView(objects) {
    const control = Editor.control;
    if (!control) return;
    const targets = objects ?? [this.meshes.upper, this.meshes.lower, this.meshes.crown]
      .filter(mesh => mesh?.visible);
    if (!targets.length) return;

    const box = new THREE.Box3();
    for (const object of targets) box.expandByObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const offset = control.camera.position.clone().sub(control.target);
    control.target.copy(center);
    control.camera.position.copy(center).add(offset);
    control.camera.zoom = THREE.MathUtils.clamp(70 / Math.max(size.x, size.y, size.z, 1), 0.4, 8);
    control.camera.updateProjectionMatrix();
    control.update();
  }

  /** Frame a ring on a scan, close enough to work on it. */
  focusRing(jaw, points) {
    const mesh = this.meshes[jaw];
    const control = Editor.control;
    if (!mesh || !control || !points?.length) return;
    const box = new THREE.Box3().setFromPoints(points.map(p => (
      Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : p.clone()
    )));
    box.applyMatrix4(mesh.matrixWorld);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const offset = control.camera.position.clone().sub(control.target);
    control.target.copy(center);
    control.camera.position.copy(center).add(offset);
    control.camera.zoom = THREE.MathUtils.clamp(25 / Math.max(size.x, size.y, size.z, 1), 0.4, 8);
    control.camera.updateProjectionMatrix();
    control.update();
  }
}

export default new CaseScene();
export { jawOfFdi };
