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

  predictMesh = async (isUpper = true) => {
    console.log(isUpper)
    try {
      console.log('predict direction');
      const exporter = new STLExporter();
      const stlString = exporter.parse(this.mesh, { binary: true });
      const blob = new Blob([stlString], { type: 'text/plain' });

      const formData = new FormData();
      formData.append('file', blob, 'model.stl');
      formData.append('is_upper', isUpper)
      // const res = await axios.post('http://192.168.0.101:8003/predict_direction/', formData);
      // const res = await axios.post('http://localhost:8000/predict', formData);
      // const res = await axios.post('http://192.168.0.101:8000/predict', formData);
      const res = await axios.post('https://4e942d61-8fdf-4adb-b15d-495a88409d93.inteware.com.tw/jaw/predict', formData);
      console.log(res.data)
      return this.processResult(res.data);
    } catch (error) {
      console.log(error)
    }
  }

  processResult = (data) => {
    const quaternionRawData = data.quaternion;
    const quaternion = new THREE.Quaternion(quaternionRawData.x, quaternionRawData.y, quaternionRawData.z, quaternionRawData.w);
    // if (!quaternionRawData || !Array.isArray(quaternionRawData) || quaternionRawData.length !== 4) throw `${data} is not a valid quaternion data`;
    // const quaternion = new THREE.Quaternion(quaternionRawData[0], quaternionRawData[1], quaternionRawData[2], quaternionRawData[3]);
    this.mesh.geometry.applyQuaternion(quaternion)
    return quaternion;
  }
}

export default new PredictDirection();