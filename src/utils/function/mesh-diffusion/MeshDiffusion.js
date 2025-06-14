import * as THREE from 'three';

import Editor from '../../Editor';
import { getMouseCartesianPosition } from '../../tool/ThreejsMathTool';
import {
  buildPointMap,
  triangleSpread,
  vec2PosKey,
  applyColorByPointKeySet,
} from '../../tool/BufferGeometryTool';

const raycaster = new THREE.Raycaster();

class MeshDiffusion {
  constructor() {
    this._isEnable = false;
    this._isDrawBoundary = false;

    /**@type {import('../../tool/BufferGeometryTool').PointMap} */
    this.pointMap = null;
    /**@type {Set<string>} */
    this.boundaryPointKeySet = new Set();
  }

  set isEnable(bool) {
    if (this._isEnable == bool) return;

    if (bool) {
      const geometry = Editor.targetMesh.geometry;
      if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);

      Editor.container.addEventListener('mousedown', this.onMouseDown);
    } else {
      this._isDrawBoundary = false;
      Editor.container.removeEventListener('mousedown', this.onMouseDown);
      Editor.container.removeEventListener('mousemove', this.onMouseMove);
      Editor.container.removeEventListener('mouseup', this.onMouseUp);
    }

    this._isEnable = bool;
  }

  get isEnable() {
    return this._isEnable;
  }

  set isDrawBoundary(bool) {
    if (this._isDrawBoundary == bool) return;
    if (bool) this.onReset();
    this._isDrawBoundary = bool;
  }

  get isDrawBoundary() {
    return this._isDrawBoundary;
  }

  onReset = () => {
    const { targetMesh } = Editor;
    const colorAttr = targetMesh.geometry.getAttribute('color');
    for (let i = 0; i < colorAttr.count; i++) {
      colorAttr.setXYZ(i, 1, 1, 1);
    }
    colorAttr.needsUpdate = true;

    this.boundaryPointKeySet.clear();
    this.isEnable = false;
    this.isEnable = true;
  };

  /**
   * @param {MouseEvent} event
   */
  onMouseDown = (event) => {
    event.preventDefault();
    if (event.button != 0) return;

    const mouse = getMouseCartesianPosition(event, Editor.container);
    raycaster.setFromCamera(mouse, Editor.control.camera);
    const intersects = raycaster.intersectObject(Editor.targetMesh, false);

    if (intersects.length == 0) return;

    if (!this.isDrawBoundary) this.onSelectSpreadPoint(intersects[0]);
    else {
      this.onSelectBoundary(intersects[0]);
      Editor.container.addEventListener('mousemove', this.onMouseMove);
      Editor.container.addEventListener('mouseup', this.onMouseUp);
    }
  };

  /**
   * @param {MouseEvent} event
   */
  onMouseMove = (event) => {
    const mouse = getMouseCartesianPosition(event, Editor.container);
    raycaster.setFromCamera(mouse, Editor.control.camera);
    const intersects = raycaster.intersectObject(Editor.targetMesh, false);
    if (intersects.length == 0) return;
    this.onSelectBoundary(intersects[0]);
  };

  /**
   * @param {MouseEvent} event
   */
  onMouseUp = (event) => {
    Editor.container.removeEventListener('mousemove', this.onMouseMove);
    Editor.container.removeEventListener('mouseup', this.onMouseUp);
  };

  /**
   * @param {THREE.Intersection} intersect
   */
  onSelectBoundary = async (intersect) => {
    const { face } = intersect;
    const { geometry } = Editor.targetMesh;
    const posAttr = geometry.getAttribute('position');

    const tempPoint = new THREE.Vector3();
    tempPoint.fromBufferAttribute(posAttr, face.a);
    this.boundaryPointKeySet.add(vec2PosKey(tempPoint));
    tempPoint.fromBufferAttribute(posAttr, face.b);
    this.boundaryPointKeySet.add(vec2PosKey(tempPoint));
    tempPoint.fromBufferAttribute(posAttr, face.c);
    this.boundaryPointKeySet.add(vec2PosKey(tempPoint));

    applyColorByPointKeySet(
      geometry,
      this.boundaryPointKeySet,
      new THREE.Color(0, 0, 0)
    );
  };

  /**
   * @param {THREE.Intersection} intersect
   */
  onSelectSpreadPoint = async (intersect) => {
    const { geometry } = Editor.targetMesh;
    const posAttr = geometry.getAttribute('position');

    // this.isEnable = false;

    const { face, faceIndex } = intersect;
    const point = new THREE.Vector3().fromBufferAttribute(posAttr, face.a);
    const seedPointKey = vec2PosKey(point);

    // await triangleSpread(geometry, seedPointKey, this.boundaryPointKeySet);
    triangleSpread(geometry, new Set([faceIndex]), () => true);
  };
}

export default new MeshDiffusion();
