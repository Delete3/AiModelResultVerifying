import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import axios from 'axios';

import Editor from '../Editor';
import { disposeMesh } from '../tool/SceneTool';

class PredictDirection {
  constructor() {
    /**@type {THREE.Mesh} */
    this.mesh = null;
  }

  /**
   * @param {THREE.Mesh} mesh 
   */
  setMesh = (mesh) => {
    if (this.mesh) disposeMesh(this.mesh);
    this.mesh = mesh;
    Editor.scene.add(mesh);
  }

  /** Predict orientation without mutating the jaw mesh. */
  predictQuaternion = async (mesh, isUpper = true) => {
    if (!mesh) throw new Error('No jaw mesh was provided for direction prediction');

    const stlData = new STLExporter().parse(mesh, { binary: true });
    const blob = new Blob([stlData], { type: 'model/stl' });
    const formData = new FormData();
    formData.append('file', blob, 'model.stl');
    formData.append('is_upper', String(isUpper));

    // Same-origin Vite proxy avoids browser CORS and HTTPS mixed-content errors.
    const res = await axios.post('/api/direction/predict', formData);
    return this.parseQuaternion(res.data);
  }

  /** Predict and apply orientation to an arbitrary jaw mesh. */
  predictTargetMesh = async (mesh, isUpper = true) => {
    const quaternion = await this.predictQuaternion(mesh, isUpper);
    this.applyQuaternion(mesh, quaternion);
    return quaternion;
  }

  predictMesh = async (isUpper = true) => {
    try {
      return await this.predictTargetMesh(this.mesh, isUpper);
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  parseQuaternion = (data) => {
    const quaternionRawData = data.quaternion;
    if (!quaternionRawData) throw new Error('Direction API returned an invalid quaternion');

    const quaternion = new THREE.Quaternion(quaternionRawData.x, quaternionRawData.y, quaternionRawData.z, quaternionRawData.w);
    if (
      !quaternion.toArray().every(Number.isFinite)
      || quaternion.lengthSq() < Number.EPSILON
    ) {
      throw new Error('Direction API returned an invalid quaternion');
    }
    return quaternion.normalize();
  }

  applyQuaternion = (mesh, quaternion) => {
    if (!mesh || !quaternion) throw new Error('A jaw mesh and quaternion are required');
    mesh.geometry.applyQuaternion(quaternion);
  }

  processResult = (data, mesh = this.mesh) => {
    const quaternion = this.parseQuaternion(data);
    this.applyQuaternion(mesh, quaternion);
    return quaternion;
  }
}

export default new PredictDirection();