import * as THREE from 'three';

import Editor from '../Editor';
import { loadModel } from '../loader/loadModel';

// The model preview tab: any number of STL / PLY / OBJ / TRI files, each with its own
// colour, opacity and visibility, for looking at what a service produced or what a case
// arrived as.
//
// It shares the one scene and camera with the other tabs, but draws on its own layer.
// The camera looks at layer 0 (the case: scans, crown, margin, the old tools' meshes) or
// at this layer, never both. So the case is hidden while models are previewed -- not
// removed and not touched, and a crown from a job still running lands out of sight on
// layer 0 -- and each side keeps its own camera view across tab switches.
const PREVIEW_LAYER = 1;

// Picked to stay apart from each other when two or three models overlap, which is the
// situation this tab exists for.
const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d'];

// Zoom range while previewing. The case tab's 0.4-8 frames an arch; models dropped here
// run from a 3 mm abutment screw to a full-arch model in centimetres.
const PREVIEW_ZOOM = { min: 0.02, max: 60 };

const formatCount = value => value.toLocaleString('en-US');

/** What a loaded model is, in one line: format, counts, size. */
const describe = (detail, parts, size) => {
  const counts = [];
  const meshes = parts.filter(part => part.kind === 'mesh');
  if (meshes.length) {
    const faces = meshes.reduce((sum, { geometry }) => sum + (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3, 0);
    const indexed = meshes.every(({ geometry }) => geometry.index);
    // An STL repeats every corner of every triangle, so its vertex count says nothing.
    if (indexed) counts.push(`${formatCount(meshes.reduce((sum, { geometry }) => sum + geometry.getAttribute('position').count, 0))} 頂點`);
    counts.push(`${formatCount(faces)} 面`);
  }
  const points = parts.filter(part => part.kind === 'points');
  if (points.length) counts.push(`${formatCount(points.reduce((sum, { geometry }) => sum + geometry.getAttribute('position').count, 0))} 點`);
  if (parts.some(part => part.kind === 'lines')) counts.push('含線段');
  if (parts.length > 1) counts.push(`${parts.length} 個物件`);
  return [detail, ...counts, `${size.map(v => v.toFixed(1)).join(' × ')} mm`].join(' · ');
};

class PreviewScene {
  constructor() {
    this.items = [];
    this.errors = [];
    this.active = false;
    /** @type {THREE.Group|null} */
    this.root = null;
    this.views = { case: null, preview: null };
    this.caseZoom = null;
    this.nextId = 1;
    this.colorCursor = 0;
    // Files are parsed one after another: two 30 MB scans at once is every buffer twice
    // over, for no gain on one thread.
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.snapshot = this.makeSnapshot();
  }

  // --- React bridge (useSyncExternalStore) ------------------------------------------------

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  makeSnapshot() {
    return {
      active: this.active,
      loaded: this.items.filter(item => !item.loading).length,
      loading: this.items.filter(item => item.loading).length,
      items: this.items.map(item => ({
        id: item.id,
        name: item.name,
        bytes: item.bytes,
        loading: item.loading,
        summary: item.summary,
        color: item.color,
        opacity: item.opacity,
        visible: item.visible,
        wireframe: item.wireframe,
        vertexColors: item.vertexColors,
        hasVertexColors: item.hasVertexColors,
        hasMesh: item.hasMesh,
      })),
      errors: [...this.errors],
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
    this.root.name = 'model-preview';
    Editor.scene.add(this.root);
    // A light is culled by layer like everything else, and these ride on the camera.
    Editor.scene.traverse(object => {
      if (object.isLight || object.type === 'AxesHelper') object.layers.enable(PREVIEW_LAYER);
    });
  }

  /** Switch the camera between the case and the preview, each keeping its own view. */
  setActive(active) {
    const control = Editor.control;
    if (!this.root || !control || active === this.active) return;

    this.views[this.active ? 'preview' : 'case'] = this.saveView();
    this.active = active;
    control.camera.layers.set(active ? PREVIEW_LAYER : 0);
    if (active) {
      this.caseZoom = { min: control.minZoom, max: control.maxZoom };
      control.minZoom = PREVIEW_ZOOM.min;
      control.maxZoom = PREVIEW_ZOOM.max;
    } else if (this.caseZoom) {
      control.minZoom = this.caseZoom.min;
      control.maxZoom = this.caseZoom.max;
    }
    const view = this.views[active ? 'preview' : 'case'];
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

  // --- models -----------------------------------------------------------------------------

  /** @param {FileList|File[]} files */
  addFiles(files) {
    const pending = [...files].map(file => {
      const item = { id: this.nextId++, name: file.name, bytes: file.size, loading: true };
      this.items.push(item);
      return [item, file];
    });
    if (!pending.length) return this.queue;
    this.emit();

    this.queue = this.queue.then(async () => {
      // Frame the first models to arrive; after that the view is the user's, and a model
      // added later is one "置中" away.
      const frameAfter = !this.items.some(item => !item.loading);
      for (const [item, file] of pending) {
        if (!this.items.includes(item)) continue; // removed while it waited
        try {
          const model = await loadModel(file);
          if (this.items.includes(item)) this.build(item, model);
          else for (const part of model.parts) part.geometry.dispose();
        } catch (error) {
          this.items = this.items.filter(entry => entry !== item);
          this.errors.push({ id: item.id, name: item.name, message: error.message });
        }
        this.emit();
        // Let the page paint between files, so a batch shows up as it loads.
        await new Promise(resolve => setTimeout(resolve));
      }
      if (frameAfter) this.fitView();
    });
    return this.queue;
  }

  build(item, model) {
    const group = new THREE.Group();
    group.name = `preview-${item.id}`;
    const parts = model.parts.map(({ kind, geometry }) => {
      const material = kind === 'mesh'
        ? new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide })
        : kind === 'points'
          ? new THREE.PointsMaterial({ size: 2, sizeAttenuation: false })
          : new THREE.LineBasicMaterial();
      const object = kind === 'mesh' ? new THREE.Mesh(geometry, material)
        : kind === 'points' ? new THREE.Points(geometry, material)
          : new THREE.LineSegments(geometry, material);
      object.layers.set(PREVIEW_LAYER);
      group.add(object);
      return { kind, geometry, material, object, hasColor: Boolean(geometry.getAttribute('color')) };
    });
    group.layers.set(PREVIEW_LAYER);
    this.root.add(group);

    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3()).toArray();
    const hasVertexColors = parts.some(part => part.hasColor);
    Object.assign(item, {
      loading: false,
      object: group,
      parts,
      summary: describe(model.detail, parts, size),
      color: PALETTE[this.colorCursor++ % PALETTE.length],
      opacity: 1,
      visible: true,
      wireframe: false,
      hasMesh: parts.some(part => part.kind === 'mesh'),
      hasVertexColors,
      // Off to begin with even when the file has colours: the point of this tab is telling
      // overlapping models apart, and the swatch next to the name should be what the model
      // looks like. The file's own colours are one tick away.
      vertexColors: false,
    });
    this.applyLook(item);
  }

  applyLook(item) {
    if (!item.object) return;
    const translucent = item.opacity < 1;
    for (const part of item.parts) {
      const { material } = part;
      const ownColors = item.vertexColors && part.hasColor;
      material.color.set(ownColors ? '#ffffff' : item.color);
      material.vertexColors = ownColors;
      material.opacity = item.opacity;
      material.transparent = translucent;
      // A see-through model must not hide what is behind it from the depth buffer's point
      // of view either, or "transparent" would only show the clear colour.
      material.depthWrite = !translucent;
      if (part.kind === 'mesh') material.wireframe = item.wireframe;
      material.needsUpdate = true;
    }
    item.object.visible = item.visible;
  }

  update(id, changes) {
    const item = this.items.find(entry => entry.id === id);
    if (!item || item.loading) return;
    Object.assign(item, changes);
    this.applyLook(item);
    this.emit();
  }

  setOpacity = (id, opacity) => this.update(id, { opacity });

  setColor = (id, color) => this.update(id, { color, vertexColors: false });

  setVisible = (id, visible) => this.update(id, { visible });

  setWireframe = (id, wireframe) => this.update(id, { wireframe });

  setVertexColors = (id, vertexColors) => this.update(id, { vertexColors });

  /** Every model at once: visibility, or opacity. */
  setAll(changes) {
    for (const item of this.items) {
      if (item.loading) continue;
      Object.assign(item, changes);
      this.applyLook(item);
    }
    this.emit();
  }

  dispose(item) {
    if (!item.object) return;
    for (const part of item.parts) {
      part.geometry.dispose();
      part.material.dispose();
    }
    this.root.remove(item.object);
  }

  remove(id) {
    const item = this.items.find(entry => entry.id === id);
    if (!item) return;
    this.dispose(item);
    this.items = this.items.filter(entry => entry !== item);
    this.emit();
  }

  clear() {
    for (const item of this.items) this.dispose(item);
    this.items = [];
    this.errors = [];
    this.colorCursor = 0;
    this.emit();
  }

  dismissErrors() {
    this.errors = [];
    this.emit();
  }

  // --- view -------------------------------------------------------------------------------

  /** Frame the visible models, or just the one given. */
  fitView(id) {
    const control = Editor.control;
    if (!control || !this.active) return;
    const targets = this.items.filter(item => item.object && (id == null ? item.visible : item.id === id));
    if (!targets.length) return;

    const box = new THREE.Box3();
    for (const item of targets) box.expandByObject(item.object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const offset = control.camera.position.clone().sub(control.target);
    control.target.copy(center);
    control.camera.position.copy(center).add(offset);
    // 70 mm across fills most of the view at zoom 1, the same rule CaseScene.fitView uses.
    control.camera.zoom = THREE.MathUtils.clamp(70 / Math.max(size.x, size.y, size.z, 0.01), control.minZoom, control.maxZoom);
    control.camera.updateProjectionMatrix();
    control.update();
  }
}

export default new PreviewScene();
export { PALETTE };
