import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

import Editor from '../Editor';
import { loadGeometry } from '../loader/loadGeometry';

// The "AI分牙" tab: an orthodontic case's two arch scans, the AI's per-tooth segmentation of
// them (ToothRoot on the Chiayi box), and the teeth with the roots it generated.
//
// Like the model preview, it shares the one scene and camera with the other tabs but draws
// on a layer of its own, so the design tab's case is out of sight here and untouched, and
// each side keeps its own view across tab switches. Layer 1 is the preview's.
const TOOTHSEG_LAYER = 2;

// Every file this tab shows is in the scanner's frame: segmentation keeps the scan's own
// vertices, and the generated teeth are mapped back to scanner millimetres by ToothRoot.
// So nothing here carries a matrix.

const RAW_COLOR = { upper: 0xdbe9f6, lower: 0xe9e1f7 };
// seg.ply paints gum (FDI 0) black -- the CLI zero-fills the colour array. A soft pink reads
// as gum and keeps the teeth's palette colours the thing that stands out.
const GUM_COLOR = [0.86, 0.74, 0.74];
// ToothRoot's own two colours for a generated tooth: what the scanner saw, and what the model
// made up. Restated here only for the legend; the PLY carries them as vertex colours.
const OBSERVED_HEX = '#1f6b78';
const GENERATED_HEX = '#a33b62';

const ZOOM = { min: 0.1, max: 40 };

const makeLabel = text => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20, 24, 31, 0.78)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 112, 48, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 33);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Always readable: a label sits at the crown's centroid, which is inside the tooth.
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(5, 2.5, 1);
  sprite.renderOrder = 20;
  sprite.layers.set(TOOTHSEG_LAYER);
  return sprite;
};

const disposeObject = object => {
  object?.traverse(child => {
    child.geometry?.dispose();
    if (child.material) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  });
};

class ToothSegScene {
  constructor() {
    this.active = false;
    /** @type {THREE.Group|null} */
    this.root = null;
    this.views = { other: null, mine: null };
    this.otherZoom = null;
    // jaw -> mesh
    this.raw = { upper: null, lower: null };
    this.seg = { upper: null, lower: null };
    // `${jaw}:${fdi}` -> { mesh, jaw, fdi }
    this.teeth = new Map();
    this.labels = new Map();
    this.show = { raw: true, seg: true, teeth: true, labels: true, upper: true, lower: true };
    this.archOpacity = 1;
    // 'source': ToothRoot's own scanned-vs-generated colours; 'fdi': the tooth's palette colour
    this.teethColor = 'source';
    this.hiddenTeeth = new Set();
    this.palette = {};
    this.listeners = new Set();
    this.snapshot = this.makeSnapshot();
  }

  // --- React bridge -----------------------------------------------------------------------

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  makeSnapshot() {
    return {
      active: this.active,
      hasRaw: Boolean(this.raw.upper || this.raw.lower),
      hasSeg: Boolean(this.seg.upper || this.seg.lower),
      teethCount: this.teeth.size,
      hasLabels: this.labels.size > 0,
      show: { ...this.show },
      archOpacity: this.archOpacity,
      teethColor: this.teethColor,
      hiddenTeeth: [...this.hiddenTeeth],
    };
  }

  emit() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  // --- lifecycle --------------------------------------------------------------------------

  /** Once, after the editor exists and its lights and axes are in the scene. */
  init() {
    if (this.root || !Editor.scene) return;
    this.root = new THREE.Group();
    this.root.name = 'tooth-seg';
    Editor.scene.add(this.root);
    // Lights are culled by layer like everything else.
    Editor.scene.traverse(object => {
      if (object.isLight || object.type === 'AxesHelper') object.layers.enable(TOOTHSEG_LAYER);
    });
  }

  /**
   * Switch the camera to this tab's layer, or back to the case. Call setActive(false) on the
   * tab being left before setActive(true) on the one being entered: each saves the view it
   * is handing back.
   */
  setActive(active) {
    const control = Editor.control;
    if (!this.root || !control || active === this.active) return;
    this.views[this.active ? 'mine' : 'other'] = this.saveView();
    this.active = active;
    control.camera.layers.set(active ? TOOTHSEG_LAYER : 0);
    if (active) {
      this.otherZoom = { min: control.minZoom, max: control.maxZoom };
      control.minZoom = ZOOM.min;
      control.maxZoom = ZOOM.max;
    } else if (this.otherZoom) {
      control.minZoom = this.otherZoom.min;
      control.maxZoom = this.otherZoom.max;
    }
    const view = this.views[active ? 'mine' : 'other'];
    if (view) this.restoreView(view);
    this.emit();
  }

  saveView() {
    const { camera, target } = Editor.control;
    return { position: camera.position.clone(), up: camera.up.clone(), zoom: camera.zoom, target: target.clone() };
  }

  restoreView(view) {
    const control = Editor.control;
    control.camera.position.copy(view.position);
    control.camera.up.copy(view.up);
    control.camera.zoom = view.zoom;
    control.camera.updateProjectionMatrix();
    control.target.copy(view.target);
    control.update();
  }

  // --- content ----------------------------------------------------------------------------

  addMesh(geometry, material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(TOOTHSEG_LAYER);
    this.root.add(mesh);
    return mesh;
  }

  archMaterial(options) {
    return new THREE.MeshStandardMaterial({
      roughness: 0.5,
      metalness: 0.03,
      side: THREE.DoubleSide,
      // Behind the generated teeth where the two coincide (the crown part of a tooth is the
      // scan's own surface), so the tooth wins the depth fight.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      ...options,
    });
  }

  /** The uploaded scans, as they are, before anything has been segmented. */
  async setRaw(jaw, file) {
    this.removeRaw(jaw);
    if (!file) return;
    const geometry = await loadGeometry(file);
    if (!geometry) throw new Error(`${file.name} 不是可讀的 STL / PLY / TRI`);
    this.raw[jaw] = this.addMesh(geometry, this.archMaterial({ color: RAW_COLOR[jaw] }));
    this.applyLook();
  }

  removeRaw(jaw) {
    if (!this.raw[jaw]) return;
    disposeObject(this.raw[jaw]);
    this.root.remove(this.raw[jaw]);
    this.raw[jaw] = null;
  }

  /** `<jaw>_seg.ply`: the whole arch painted by FDI. */
  setSegmentation(jaw, buffer) {
    this.removeSeg(jaw);
    const geometry = new PLYLoader().parse(buffer);
    const color = geometry.getAttribute('color');
    if (color) {
      for (let i = 0; i < color.count; i++) {
        if (color.getX(i) + color.getY(i) + color.getZ(i) === 0) color.setXYZ(i, ...GUM_COLOR);
      }
    }
    geometry.computeVertexNormals();
    this.seg[jaw] = this.addMesh(geometry, this.archMaterial({ vertexColors: Boolean(color), color: 0xffffff }));
    this.applyLook();
  }

  removeSeg(jaw) {
    if (!this.seg[jaw]) return;
    disposeObject(this.seg[jaw]);
    this.root.remove(this.seg[jaw]);
    this.seg[jaw] = null;
  }

  /** FDI numbers floating over each segmented crown. */
  setLabels(crowns) {
    this.clearLabels();
    for (const jaw of ['upper', 'lower']) {
      for (const crown of crowns?.[jaw] ?? []) {
        const sprite = makeLabel(String(crown.fdi));
        sprite.position.fromArray(crown.centroid);
        sprite.userData = { jaw, fdi: crown.fdi };
        this.root.add(sprite);
        this.labels.set(`${jaw}:${crown.fdi}`, sprite);
      }
    }
    this.applyLook();
  }

  clearLabels() {
    for (const sprite of this.labels.values()) {
      disposeObject(sprite);
      this.root.remove(sprite);
    }
    this.labels.clear();
  }

  setPalette(palette) {
    this.palette = palette ?? {};
  }

  /** One generated tooth (`roots/<jaw>/tooth_<FDI>.ply`): scanned crown + generated root. */
  addTooth(jaw, fdi, buffer) {
    const key = `${jaw}:${fdi}`;
    this.removeTooth(key);
    const geometry = new PLYLoader().parse(buffer);
    geometry.computeVertexNormals();
    const mesh = this.addMesh(geometry, new THREE.MeshStandardMaterial({
      roughness: 0.4, metalness: 0.05, side: THREE.DoubleSide, color: 0xffffff,
    }));
    mesh.userData = { jaw, fdi, hasColor: Boolean(geometry.getAttribute('color')) };
    this.teeth.set(key, mesh);
    this.applyLook();
  }

  removeTooth(key) {
    const mesh = this.teeth.get(key);
    if (!mesh) return;
    disposeObject(mesh);
    this.root.remove(mesh);
    this.teeth.delete(key);
  }

  clearTeeth() {
    for (const key of [...this.teeth.keys()]) this.removeTooth(key);
    this.hiddenTeeth.clear();
    this.applyLook();
  }

  /** Everything but the raw scans: a new job is about to replace it. */
  clearResults() {
    for (const jaw of ['upper', 'lower']) this.removeSeg(jaw);
    this.clearLabels();
    this.clearTeeth();
  }

  clearAll() {
    this.clearResults();
    for (const jaw of ['upper', 'lower']) this.removeRaw(jaw);
    this.applyLook();
  }

  // --- look -------------------------------------------------------------------------------

  applyLook() {
    const translucent = this.archOpacity < 1;
    for (const jaw of ['upper', 'lower']) {
      const jawOn = this.show[jaw];
      // The raw scan is what the segmentation repaints; with both present, show the painted one.
      const raw = this.raw[jaw];
      if (raw) raw.visible = jawOn && this.show.raw && !(this.seg[jaw] && this.show.seg);
      const seg = this.seg[jaw];
      if (seg) seg.visible = jawOn && this.show.seg;
      for (const mesh of [raw, seg]) {
        if (!mesh) continue;
        mesh.material.opacity = this.archOpacity;
        mesh.material.transparent = translucent;
        mesh.material.depthWrite = !translucent;
        mesh.material.needsUpdate = true;
      }
    }
    for (const mesh of this.teeth.values()) {
      const { jaw, fdi, hasColor } = mesh.userData;
      mesh.visible = this.show.teeth && this.show[jaw] && !this.hiddenTeeth.has(`${jaw}:${fdi}`);
      const own = this.teethColor === 'source' && hasColor;
      mesh.material.vertexColors = own;
      mesh.material.color.set(own ? '#ffffff' : (this.palette[fdi] ?? '#cccccc'));
      mesh.material.needsUpdate = true;
    }
    for (const sprite of this.labels.values()) {
      sprite.visible = this.show.labels && this.show[sprite.userData.jaw];
    }
    this.emit();
  }

  setShow(key, value) {
    this.show[key] = value;
    this.applyLook();
  }

  setArchOpacity(opacity) {
    this.archOpacity = opacity;
    this.applyLook();
  }

  setTeethColor(mode) {
    this.teethColor = mode;
    this.applyLook();
  }

  setToothVisible(jaw, fdi, visible) {
    const key = `${jaw}:${fdi}`;
    if (visible) this.hiddenTeeth.delete(key);
    else this.hiddenTeeth.add(key);
    this.applyLook();
  }

  // --- view -------------------------------------------------------------------------------

  /** Frame what is visible, or one tooth. */
  fitView(only) {
    const control = Editor.control;
    if (!control || !this.active || !this.root) return;
    const box = new THREE.Box3();
    if (only) {
      const mesh = this.teeth.get(`${only.jaw}:${only.fdi}`);
      if (mesh) box.expandByObject(mesh);
    } else {
      this.root.traverse(child => {
        if (child.isMesh && child.visible) box.expandByObject(child);
      });
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const offset = control.camera.position.clone().sub(control.target);
    control.target.copy(center);
    control.camera.position.copy(center).add(offset);
    // 70 mm across fills most of the view at zoom 1, the rule CaseScene.fitView uses.
    control.camera.zoom = THREE.MathUtils.clamp(70 / Math.max(size.x, size.y, size.z, 0.01), control.minZoom, control.maxZoom);
    control.camera.updateProjectionMatrix();
    control.update();
  }
}

export default new ToothSegScene();
export { OBSERVED_HEX, GENERATED_HEX };
