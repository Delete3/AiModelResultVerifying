import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import Editor from '../Editor';
import { loadGeometry } from '../loader/loadGeometry';

// The "AI排牙" tab: an orthodontic case's two arch scans and what tooth_ssm (htyau/ssm_project)
// makes of them -- the segmented crowns, whole teeth with generated roots, and the same teeth
// after the alignment model has moved them.
//
// Like the model preview (layer 1) and AI分牙 (layer 2), it shares the one scene and camera
// with the other tabs but draws on a layer of its own, so the design tab's case is out of
// sight here and untouched, and each side keeps its own view across tab switches.
const TOOTHALIGN_LAYER = 3;

// Every file this tab shows is in the scanner's frame: the crowns keep the scan's vertices,
// the generated teeth are built where their crowns are, and the aligned teeth are those teeth
// moved by the model's per-tooth transform, mapped back to the scanner frame by 73_align.py.
// The one exception is an upper scan that faced the same way as the lower one: the service
// re-poses it into a bite (78_articulate.py) and everything downstream is in that pose, so
// the panel then shows the service's copy of the scan instead of the local file.

const RAW_COLOR = { upper: 0xdbe9f6, lower: 0xe9e1f7 };
const GUM_HEX = '#dcbcbc';
const GHOST_HEX = '#9aa3ad';
// viewer/colorize.py's two colours for a generated tooth: within 0.5 mm of the scanned crown,
// and everything else (the root the model made up). Restated here only for the legend; the
// coloured PLYs carry them as vertex colours.
const CROWN_HEX = '#1f6b78';
const ROOT_HEX = '#a33b62';

// What the 3D view shows; one at a time, except 'compare' (before as a ghost, after solid).
const STAGES = ['raw', 'seg', 'teeth', 'aligned', 'compare'];

const ZOOM = { min: 0.1, max: 40 };

const disposeObject = object => {
  object?.traverse(child => {
    child.geometry?.dispose();
    if (child.material) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  });
};

class ToothAlignScene {
  constructor() {
    this.active = false;
    /** @type {THREE.Group|null} */
    this.root = null;
    this.views = { other: null, mine: null };
    this.otherZoom = null;
    // jaw -> mesh
    this.raw = { upper: null, lower: null };
    // `${jaw}:${fdi}` -> mesh; fdi 0 is the gum
    this.crowns = new Map();
    this.teeth = new Map();
    this.aligned = new Map();
    this.stage = 'raw';
    this.show = { upper: true, lower: true, gum: true };
    this.ghostOpacity = 0.35;
    // 'source': crown vs generated root (viewer/colorize.py); 'fdi': the tooth's palette colour
    this.teethColor = 'source';
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
      crownCount: [...this.crowns.keys()].filter(key => !key.endsWith(':0')).length,
      teethCount: this.teeth.size,
      alignedCount: this.aligned.size,
      stage: this.stage,
      show: { ...this.show },
      ghostOpacity: this.ghostOpacity,
      teethColor: this.teethColor,
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
    this.root.name = 'tooth-align';
    Editor.scene.add(this.root);
    // Lights are culled by layer like everything else.
    Editor.scene.traverse(object => {
      if (object.isLight || object.type === 'AxesHelper') object.layers.enable(TOOTHALIGN_LAYER);
    });
  }

  /**
   * Switch the camera to this tab's layer, or back. Call setActive(false) on the tab being
   * left before setActive(true) on the one being entered: each saves the view it is handing back.
   */
  setActive(active) {
    const control = Editor.control;
    if (!this.root || !control || active === this.active) return;
    this.views[this.active ? 'mine' : 'other'] = this.saveView();
    this.active = active;
    control.camera.layers.set(active ? TOOTHALIGN_LAYER : 0);
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

  addMesh(geometry, material, userData = {}) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(TOOTHALIGN_LAYER);
    mesh.userData = userData;
    this.root.add(mesh);
    return mesh;
  }

  material(options) {
    return new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.04, side: THREE.DoubleSide, ...options });
  }

  setPalette(palette) {
    this.palette = palette ?? {};
    this.applyLook();
  }

  /** A local file (before a job) or the service's copy of the scan (an ArrayBuffer of STL). */
  async setRaw(jaw, source) {
    this.removeRaw(jaw);
    if (!source) return;
    const geometry = source instanceof ArrayBuffer ? new STLLoader().parse(source) : await loadGeometry(source);
    if (!geometry) throw new Error(`${source.name} 不是可讀的 STL / PLY / TRI`);
    geometry.computeVertexNormals();
    this.raw[jaw] = this.addMesh(geometry, this.material({ color: RAW_COLOR[jaw], roughness: 0.5 }), { jaw });
    this.applyLook();
  }

  removeRaw(jaw) {
    if (!this.raw[jaw]) return;
    disposeObject(this.raw[jaw]);
    this.root.remove(this.raw[jaw]);
    this.raw[jaw] = null;
  }

  /** One mesh of a step: kind is 'crowns' (fdi 0 = the gum), 'teeth' or 'aligned'. */
  addPart(kind, jaw, fdi, buffer) {
    const map = this[kind];
    const key = `${jaw}:${fdi}`;
    this.removePart(kind, key);
    const geometry = new PLYLoader().parse(buffer);
    // The segmented crowns carry no colours; the generated teeth carry colorize.py's.
    if (kind === 'crowns') geometry.deleteAttribute('color');
    geometry.computeVertexNormals();
    const mesh = this.addMesh(geometry, this.material({ color: 0xffffff }), {
      kind, jaw, fdi, hasColor: Boolean(geometry.getAttribute('color')),
    });
    map.set(key, mesh);
    this.applyLook();
  }

  removePart(kind, key) {
    const mesh = this[kind].get(key);
    if (!mesh) return;
    disposeObject(mesh);
    this.root.remove(mesh);
    this[kind].delete(key);
  }

  clearKind(kind) {
    for (const key of [...this[kind].keys()]) this.removePart(kind, key);
    this.applyLook();
  }

  /** Everything a job made; the raw scans stay. */
  clearResults() {
    for (const kind of ['crowns', 'teeth', 'aligned']) {
      for (const key of [...this[kind].keys()]) this.removePart(kind, key);
    }
    this.applyLook();
  }

  clearJaw(jaw) {
    this.removeRaw(jaw);
    for (const kind of ['crowns', 'teeth', 'aligned']) {
      for (const key of [...this[kind].keys()]) if (key.startsWith(`${jaw}:`)) this.removePart(kind, key);
    }
    this.applyLook();
  }

  clearAll() {
    this.clearResults();
    for (const jaw of ['upper', 'lower']) this.removeRaw(jaw);
    this.stage = 'raw';
    this.applyLook();
  }

  // --- look -------------------------------------------------------------------------------

  toothColor(mesh) {
    const { fdi, hasColor } = mesh.userData;
    const own = this.teethColor === 'source' && hasColor;
    return { vertexColors: own, color: own ? '#ffffff' : (this.palette[fdi] ?? '#cccccc') };
  }

  applyLook() {
    const stage = this.stage;
    const jawOn = jaw => this.show[jaw];
    for (const jaw of ['upper', 'lower']) {
      if (this.raw[jaw]) this.raw[jaw].visible = stage === 'raw' && jawOn(jaw);
    }
    for (const mesh of this.crowns.values()) {
      const { jaw, fdi } = mesh.userData;
      mesh.visible = stage === 'seg' && jawOn(jaw) && (fdi !== 0 || this.show.gum);
      mesh.material.color.set(fdi === 0 ? GUM_HEX : (this.palette[fdi] ?? '#cccccc'));
      mesh.material.needsUpdate = true;
    }
    const ghost = stage === 'compare';
    for (const mesh of this.teeth.values()) {
      const { jaw } = mesh.userData;
      mesh.visible = (stage === 'teeth' || ghost) && jawOn(jaw);
      const m = mesh.material;
      if (ghost) {
        m.vertexColors = false;
        m.color.set(GHOST_HEX);
      } else {
        const look = this.toothColor(mesh);
        m.vertexColors = look.vertexColors;
        m.color.set(look.color);
      }
      m.transparent = ghost;
      m.opacity = ghost ? this.ghostOpacity : 1;
      m.depthWrite = !ghost;
      m.needsUpdate = true;
    }
    for (const mesh of this.aligned.values()) {
      const { jaw } = mesh.userData;
      mesh.visible = (stage === 'aligned' || ghost) && jawOn(jaw);
      const look = this.toothColor(mesh);
      mesh.material.vertexColors = look.vertexColors;
      mesh.material.color.set(look.color);
      mesh.material.needsUpdate = true;
    }
    this.emit();
  }

  setStage(stage) {
    if (!STAGES.includes(stage)) return;
    this.stage = stage;
    this.applyLook();
  }

  setShow(key, value) {
    this.show[key] = value;
    this.applyLook();
  }

  setGhostOpacity(opacity) {
    this.ghostOpacity = opacity;
    this.applyLook();
  }

  setTeethColor(mode) {
    this.teethColor = mode;
    this.applyLook();
  }

  // --- view -------------------------------------------------------------------------------

  /** Frame what is visible. */
  fitView() {
    const control = Editor.control;
    if (!control || !this.active || !this.root) return;
    const box = new THREE.Box3();
    this.root.traverse(child => {
      if (child.isMesh && child.visible) box.expandByObject(child);
    });
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

export default new ToothAlignScene();
export { CROWN_HEX, ROOT_HEX };
