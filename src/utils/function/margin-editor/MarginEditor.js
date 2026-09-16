import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import Editor from '../../Editor';
import { getMouseCartesianPosition } from '../../tool/ThreejsMathTool';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// Spacing of the ring that is exported. 0.1 mm is what airdesign's DrawMargin writes and
// what the ground-truth .pts files look like (~350 points on a molar).
const DENSE_SPACING_MM = 0.1;
// Spacing of the handles a loaded ring is given. Tight enough to follow a margin around a
// premolar, loose enough that dragging one handle moves a stretch of line rather than a
// single bump.
const HANDLE_SPACING_MM = 1.2;
const HANDLE_RADIUS_PX = 5;
const PICK_RADIUS_PX = 10;
// A handle within this much of the surface under the cursor counts as visible. The cursor
// and the handle are up to PICK_RADIUS_PX apart, and on the steep wall of a stump that can
// be most of a millimetre of depth.
const OCCLUSION_TOLERANCE_MM = 1.0;
const MIN_POINTS = 3;
const HISTORY_LIMIT = 50;

const handleGeometry = new THREE.SphereGeometry(1, 16, 12);
const handleMaterial = new THREE.MeshBasicMaterial({ color: 0x2f9e44 });
const handleFirstMaterial = new THREE.MeshBasicMaterial({ color: 0xf59f00 });
const handleActiveMaterial = new THREE.MeshBasicMaterial({ color: 0xd6336c });

const cloneAll = points => points.map(p => p.clone());

/** Drop repeated points, including a closing point that repeats the first. */
const dedupe = (points, epsilon = 1e-4) => {
  const out = [];
  for (const point of points) {
    if (!out.length || out[out.length - 1].distanceTo(point) > epsilon) out.push(point);
  }
  while (out.length > 1 && out[0].distanceTo(out[out.length - 1]) <= epsilon) out.pop();
  return out;
};

/**
 * Draws and edits one closed margin ring on one scan.
 *
 * Every coordinate this class stores is in the scan mesh's LOCAL frame, which is the frame
 * the file was uploaded in, and its visuals are children of that mesh. That is the whole
 * contract with ezai-pipeline's margin_override: the ring must be in the frame of the scans
 * uploaded with it. Anything the scene does to the mesh afterwards (a preview matrix, say)
 * moves the ring along with it and changes nothing that is exported.
 *
 * Modelled on airdesign's DrawMargin (ManualMode + MovePoint), reduced to what a test
 * viewer needs: click to place, click the first point to close, drag to adjust, click the
 * line to insert, Shift+click to delete.
 */
class MarginEditor {
  constructor() {
    /** @type {THREE.Mesh|null} */
    this.jawMesh = null;
    /** @type {THREE.Group|null} */
    this.group = null;
    /** @type {THREE.Vector3[]} */
    this.controlPoints = [];
    /** @type {THREE.Vector3[]} the exported ring, projected onto the scan */
    this.densePoints = [];
    this.closed = false;
    /** @type {'idle'|'draw'|'edit'} */
    this.mode = 'idle';
    /** @type {'drawn'|'file'|'ai'|null} what the ring started from */
    this.source = null;
    this.edited = false;
    this.history = [];
    this.drawStart = null;

    this.handles = [];
    this.line = null;
    this.hoverIndex = -1;
    this.dragIndex = -1;
    this.dragMoved = false;
    this.rebuildPending = false;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.listeners = new Set();
    this.listening = false;
    this.frame = null;
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
      mode: this.mode,
      closed: this.closed,
      controlCount: this.controlPoints.length,
      pointCount: this.densePoints.length,
      perimeter: this.perimeter(),
      hasRing: this.closed && this.densePoints.length >= MIN_POINTS,
      jawName: this.jawMesh?.name ?? null,
      source: this.source,
      edited: this.edited,
      canUndo: this.history.length > 0,
    };
  }

  emit() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  // --- lifecycle --------------------------------------------------------------------------

  /**
   * Point the editor at a scan. A ring belongs to the scan it was drawn on, so changing the
   * scan discards it rather than carrying coordinates over to a mesh they do not describe.
   * @param {THREE.Mesh|null} jawMesh
   */
  attach(jawMesh) {
    if (this.jawMesh === jawMesh) return;
    this.resetRing();
    this.history = [];
    if (this.group) {
      this.group.parent?.remove(this.group);
      this.group = null;
      this.line?.geometry.dispose();
      this.line?.material.dispose();
      this.line = null;
      this.handles = [];
    }
    this.jawMesh = jawMesh;
    if (jawMesh) {
      if (!jawMesh.geometry.boundsTree) jawMesh.geometry.computeBoundsTree();
      this.group = new THREE.Group();
      this.group.name = 'margin-editor';
      jawMesh.add(this.group);
      this.ensureListeners();
    }
    this.setCursor('');
    this.emit();
  }

  ensureListeners() {
    if (this.listening || !Editor.container) return;
    Editor.container.addEventListener('pointerdown', this.onPointerDown);
    Editor.container.addEventListener('pointermove', this.onPointerMove);
    Editor.container.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    this.listening = true;
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.updateScreenSizes();
    };
    loop();
  }

  resetRing() {
    this.controlPoints = [];
    this.densePoints = [];
    this.closed = false;
    this.mode = 'idle';
    this.source = null;
    this.edited = false;
    this.dragIndex = -1;
    this.hoverIndex = -1;
    this.drawStart = null;
    if (this.group) this.rebuild();
  }

  // --- history ----------------------------------------------------------------------------

  capture() {
    return {
      controlPoints: cloneAll(this.controlPoints),
      densePoints: cloneAll(this.densePoints),
      closed: this.closed,
      mode: this.mode,
      source: this.source,
      edited: this.edited,
    };
  }

  restore(state) {
    this.controlPoints = cloneAll(state.controlPoints);
    this.densePoints = cloneAll(state.densePoints);
    this.closed = state.closed;
    this.mode = state.mode;
    this.source = state.source;
    this.edited = state.edited;
    this.rebuild({ keepDense: true });
  }

  pushHistory() {
    this.history.push(this.capture());
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  undo() {
    if (this.mode === 'draw') {
      if (this.controlPoints.length) {
        this.controlPoints.pop();
        this.rebuild();
      } else {
        this.cancelDrawing();
      }
      this.emit();
      return;
    }
    const state = this.history.pop();
    if (!state) return;
    this.restore(state);
    this.emit();
  }

  // --- operations -------------------------------------------------------------------------

  startDrawing() {
    if (!this.jawMesh) throw new Error('請先上傳備牙所在的那一顎');
    this.drawStart = this.capture();
    this.controlPoints = [];
    this.densePoints = [];
    this.closed = false;
    this.mode = 'draw';
    this.source = 'drawn';
    this.edited = true;
    this.rebuild();
    this.emit();
  }

  finishDrawing() {
    if (this.mode !== 'draw' || this.controlPoints.length < MIN_POINTS) return false;
    // One undo step for the whole drawing: back to whatever was there before it started.
    if (this.drawStart) {
      this.history.push(this.drawStart);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
    this.drawStart = null;
    this.closed = true;
    this.mode = 'edit';
    this.rebuild();
    this.emit();
    return true;
  }

  cancelDrawing() {
    if (this.mode !== 'draw') return;
    if (this.drawStart) this.restore(this.drawStart);
    else this.resetRing();
    this.drawStart = null;
    this.emit();
  }

  /** Show or hide the handles of a finished ring. */
  setEditing(editing) {
    if (this.mode === 'draw' || !this.closed) return;
    this.mode = editing ? 'edit' : 'idle';
    this.hoverIndex = -1;
    this.rebuild({ keepDense: true });
    this.setCursor('');
    this.emit();
  }

  /**
   * Load a ring from a file or from the margin model. The given points are kept exactly
   * as they are until the first edit -- a ring loaded and sent straight back must be the
   * ring that was loaded, not a resampled approximation of it.
   * @param {(number[]|THREE.Vector3)[]} points in the scan's own frame
   * @param {'file'|'ai'} source
   */
  setRing(points, source = 'file') {
    if (!this.jawMesh) throw new Error('請先上傳備牙所在的那一顎');
    const vectors = dedupe(points.map(p => (Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : p.clone())));
    if (vectors.length < MIN_POINTS) throw new Error(`margin 只有 ${vectors.length} 個點，至少需要 ${MIN_POINTS} 個`);

    if (this.controlPoints.length) this.pushHistory();
    const curve = new THREE.CatmullRomCurve3(vectors, true, 'centripetal');
    const handleCount = Math.max(6, Math.round(curve.getLength() / HANDLE_SPACING_MM));
    const handles = curve.getSpacedPoints(handleCount);
    handles.pop();

    this.controlPoints = handles;
    this.densePoints = vectors;
    this.closed = true;
    this.mode = 'edit';
    this.source = source;
    this.edited = false;
    this.drawStart = null;
    this.rebuild({ keepDense: true });
    this.emit();
  }

  clear() {
    if (this.controlPoints.length) this.pushHistory();
    this.resetRing();
    this.setCursor('');
    this.emit();
  }

  deleteControlPoint(index) {
    if (this.controlPoints.length <= MIN_POINTS) return false;
    this.pushHistory();
    this.controlPoints.splice(index, 1);
    this.hoverIndex = -1;
    this.markEdited();
    return true;
  }

  insertControlPoint(localPoint) {
    const count = this.controlPoints.length;
    const segment = new THREE.Line3();
    const closest = new THREE.Vector3();
    let bestIndex = count - 1;
    let bestDistance = Infinity;
    const segments = this.closed ? count : count - 1;
    for (let i = 0; i < segments; i += 1) {
      segment.set(this.controlPoints[i], this.controlPoints[(i + 1) % count]);
      segment.closestPointToPoint(localPoint, true, closest);
      const distance = closest.distanceTo(localPoint);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    this.pushHistory();
    this.controlPoints.splice(bestIndex + 1, 0, localPoint.clone());
    this.markEdited();
  }

  markEdited() {
    this.edited = true;
    if (this.source === 'file' || this.source === 'ai') this.source = `${this.source}-edited`;
    this.rebuild();
    this.emit();
  }

  // --- queries ----------------------------------------------------------------------------

  perimeter() {
    const points = this.densePoints;
    if (points.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += points[i].distanceTo(points[i - 1]);
    if (this.closed) total += points[points.length - 1].distanceTo(points[0]);
    return total;
  }

  /**
   * Median distance from the ring to the scan surface, in mm. A ring drawn here is on the
   * surface by construction; a loaded one that is not (>0.3 mm, the pipeline's own warning
   * threshold) was most likely written in another frame -- margin_canonical.pts, say.
   */
  surfaceDistance() {
    const tree = this.jawMesh?.geometry.boundsTree;
    if (!tree || !this.densePoints.length) return null;
    const step = Math.max(1, Math.floor(this.densePoints.length / 200));
    const distances = [];
    for (let i = 0; i < this.densePoints.length; i += step) {
      const hit = tree.closestPointToPoint(this.densePoints[i], {});
      if (hit) distances.push(hit.distance);
    }
    distances.sort((a, b) => a - b);
    return distances.length ? distances[Math.floor(distances.length / 2)] : null;
  }

  /** The ring in the scan's uploaded frame, or null if there is no closed ring. */
  getRing() {
    if (!this.closed || this.densePoints.length < MIN_POINTS) return null;
    return cloneAll(this.densePoints);
  }

  // --- geometry ---------------------------------------------------------------------------

  computeDense() {
    const points = this.controlPoints;
    if (points.length < 2) return cloneAll(points);
    const closed = this.closed && points.length >= MIN_POINTS;
    const curve = new THREE.CatmullRomCurve3(cloneAll(points), closed, 'centripetal');
    const count = Math.max(points.length * 4, Math.round(curve.getLength() / DENSE_SPACING_MM));
    const samples = curve.getSpacedPoints(count);
    if (closed) samples.pop();
    const tree = this.jawMesh?.geometry.boundsTree;
    if (!tree) return samples;
    // The spline cuts corners between handles that sit on the surface; pull it back on.
    return samples.map(sample => tree.closestPointToPoint(sample, {})?.point.clone() ?? sample);
  }

  rebuild({ keepDense = false } = {}) {
    if (!this.group) return;
    if (!keepDense) this.densePoints = this.computeDense();
    this.updateLine();
    this.updateHandles();
  }

  scheduleRebuild() {
    if (this.rebuildPending) return;
    this.rebuildPending = true;
    requestAnimationFrame(() => {
      this.rebuildPending = false;
      this.rebuild();
    });
  }

  updateLine() {
    const points = this.densePoints;
    if (points.length < 2) {
      if (this.line) this.line.visible = false;
      return;
    }
    if (!this.line) {
      const material = new LineMaterial({ color: 0xe03131, linewidth: 3, worldUnits: false });
      // Pulled toward the camera: the ring lies exactly on the surface and would otherwise
      // z-fight with it into a dashed line.
      material.polygonOffset = true;
      material.polygonOffsetFactor = -4;
      material.polygonOffsetUnits = -4;
      this.line = new Line2(new LineGeometry(), material);
      this.line.name = 'margin-editor-line';
      this.line.renderOrder = 3;
      this.group.add(this.line);
    }
    const flat = [];
    const loop = this.closed ? [...points, points[0]] : points;
    for (const p of loop) flat.push(p.x, p.y, p.z);
    // A LineGeometry cannot be resized in place, so it is replaced.
    this.line.geometry.dispose();
    this.line.geometry = new LineGeometry();
    this.line.geometry.setPositions(flat);
    this.line.material.color.set(this.closed ? 0xe03131 : 0xf76707);
    this.line.visible = true;
  }

  updateHandles() {
    const wanted = this.mode === 'idle' ? 0 : this.controlPoints.length;
    while (this.handles.length > wanted) this.group.remove(this.handles.pop());
    while (this.handles.length < wanted) {
      const handle = new THREE.Mesh(handleGeometry, handleMaterial);
      handle.renderOrder = 4;
      this.group.add(handle);
      this.handles.push(handle);
    }
    this.handles.forEach((handle, index) => {
      handle.position.copy(this.controlPoints[index]);
      handle.material = index === this.dragIndex || index === this.hoverIndex
        ? handleActiveMaterial
        : index === 0 && this.mode === 'draw' ? handleFirstMaterial : handleMaterial;
    });
    this.updateScreenSizes();
  }

  worldPerPixel() {
    const camera = Editor.control?.camera;
    const height = Editor.container?.clientHeight;
    if (!camera || !height) return 0.05;
    return (camera.top - camera.bottom) / camera.zoom / height;
  }

  /** Handles and line keep a constant on-screen size whatever the zoom. */
  updateScreenSizes() {
    if (!this.group) return;
    const radius = this.worldPerPixel() * HANDLE_RADIUS_PX;
    for (const handle of this.handles) handle.scale.setScalar(radius);
    if (this.line && Editor.container) {
      this.line.material.resolution.set(Editor.container.clientWidth, Editor.container.clientHeight);
    }
  }

  // --- picking ----------------------------------------------------------------------------

  raycastJaw(event) {
    const camera = Editor.control?.camera;
    if (!camera || !this.jawMesh) return null;
    this.raycaster.setFromCamera(getMouseCartesianPosition(event, Editor.container), camera);
    return this.raycaster.intersectObject(this.jawMesh, false)[0] ?? null;
  }

  /** Screen-space nearest among `points` within the pick radius, ignoring hidden ones. */
  pickNearest(event, points) {
    const camera = Editor.control?.camera;
    if (!camera || !points.length) return -1;
    const rect = Editor.container.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const world = new THREE.Vector3();
    let best = -1;
    let bestDistance = PICK_RADIUS_PX;
    points.forEach((point, index) => {
      world.copy(point).applyMatrix4(this.jawMesh.matrixWorld).project(camera);
      const sx = ((world.x + 1) / 2) * rect.width;
      const sy = ((1 - world.y) / 2) * rect.height;
      const distance = Math.hypot(sx - mx, sy - my);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best < 0) return -1;

    const hit = this.raycastJaw(event);
    if (hit) {
      const candidate = points[best].clone().applyMatrix4(this.jawMesh.matrixWorld);
      const depth = this.raycaster.ray.origin.distanceTo(candidate);
      if (depth > hit.distance + OCCLUSION_TOLERANCE_MM) return -1;
    }
    return best;
  }

  setCursor(cursor) {
    if (Editor.container) Editor.container.style.cursor = cursor;
  }

  // --- input ------------------------------------------------------------------------------

  onPointerDown = event => {
    if (event.button !== 0 || this.mode === 'idle' || !this.jawMesh?.visible) return;

    if (this.mode === 'draw') {
      if (this.controlPoints.length >= MIN_POINTS && this.pickNearest(event, [this.controlPoints[0]]) === 0) {
        this.finishDrawing();
        return;
      }
      const hit = this.raycastJaw(event);
      if (!hit) return;
      const local = this.jawMesh.worldToLocal(hit.point.clone());
      const last = this.controlPoints[this.controlPoints.length - 1];
      // A double click lands twice on the same spot; one point is what was meant.
      if (last && last.distanceTo(local) < 0.2) return;
      this.controlPoints.push(local);
      this.rebuild();
      this.emit();
      return;
    }

    const index = this.pickNearest(event, this.controlPoints);
    if (index >= 0) {
      if (event.shiftKey) {
        this.deleteControlPoint(index);
        return;
      }
      this.pushHistory();
      this.dragIndex = index;
      this.dragMoved = false;
      if (Editor.control) Editor.control.enabled = false;
      Editor.container.setPointerCapture?.(event.pointerId);
      this.updateHandles();
      return;
    }

    const onLine = this.pickNearest(event, this.densePoints);
    if (onLine >= 0) this.insertControlPoint(this.densePoints[onLine]);
  };

  onPointerMove = event => {
    if (this.dragIndex >= 0) {
      const hit = this.raycastJaw(event);
      if (!hit) return;
      this.controlPoints[this.dragIndex].copy(this.jawMesh.worldToLocal(hit.point.clone()));
      this.dragMoved = true;
      this.scheduleRebuild();
      return;
    }
    if (this.mode === 'idle' || event.buttons !== 0 || !this.jawMesh?.visible) return;

    const candidates = this.mode === 'draw'
      ? (this.controlPoints.length >= MIN_POINTS ? [this.controlPoints[0]] : [])
      : this.controlPoints;
    const hover = this.pickNearest(event, candidates);
    if (hover !== this.hoverIndex) {
      this.hoverIndex = hover;
      this.updateHandles();
    }
    this.setCursor(hover >= 0 ? 'pointer' : this.mode === 'draw' ? 'crosshair' : '');
  };

  onPointerUp = event => {
    if (this.dragIndex < 0) return;
    Editor.container.releasePointerCapture?.(event.pointerId);
    if (Editor.control) Editor.control.enabled = true;
    const moved = this.dragMoved;
    this.dragIndex = -1;
    if (moved) {
      this.markEdited();
    } else {
      this.history.pop();
      this.updateHandles();
    }
  };

  onKeyDown = event => {
    if (this.mode === 'idle') return;
    const target = event.target;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

    const undoKey = (event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey);
    if (this.mode === 'draw') {
      if (event.key === 'Enter') this.finishDrawing();
      else if (event.key === 'Backspace' || undoKey) this.undo();
      else if (event.key === 'Escape') this.cancelDrawing();
      else return;
      event.preventDefault();
    } else if (undoKey) {
      this.undo();
      event.preventDefault();
    }
  };
}

export default new MarginEditor();
export { MIN_POINTS };
