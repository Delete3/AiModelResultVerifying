import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import axios from 'axios';

import Editor from '../Editor';

class PredictDirection {
  constructor() {
    /**@type {THREE.Mesh} */
    this.mesh = null;
  }

  /**
   * @param {THREE.Mesh} mesh 
   */
  setMesh = (mesh) => {
    this.mesh = mesh;
    Editor.scene.add(mesh);
  }

  predictMesh = async (isUpper = true) => {
    try {
      console.log('predict direction');
      const exporter = new STLExporter();
      const stlString = exporter.parse(this.mesh, { binary: true });
      const blob = new Blob([stlString], { type: 'text/plain' });

      const formData = new FormData();
      formData.append('file', blob, 'model.stl');
      formData.append('is_upper', isUpper)
      const res = await axios.post('http://192.168.0.101:8002/predict_direction/', formData);
      console.log(res.data)

      const quaternionRawData = res.data?.quaternion;
      if (!quaternionRawData || !Array.isArray(quaternionRawData) || quaternionRawData.length !== 4) throw `${data} is not a valid quaternion data`;
      const quaternion = new THREE.Quaternion(quaternionRawData[0], quaternionRawData[1], quaternionRawData[2], quaternionRawData[3]);
      this.mesh.geometry.applyQuaternion(quaternion)

    } catch (error) {
      console.log(error)
    }
  }
}

export default new PredictDirection();