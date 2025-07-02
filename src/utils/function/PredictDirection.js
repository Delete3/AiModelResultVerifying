import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import axios from 'axios';

import Editor from '../Editor';

class PredictDirection {
  constructor() {
    /**@type {{originalMesh: THREE.Mesh, predictDirMesh: THREE.Mesh}[]} */
    this.meshInfoArray = [];
  }

  /**
   * @param {THREE.Mesh} mesh 
   */
  addMesh = (mesh) => {
    this.meshInfoArray.push({
      originalMesh: mesh,
      predictDirMesh: null,
    });

    Editor.scene.add(mesh);
  }

  predictMesh = async (isUpper = true) => {
    try {
      console.log('predict direction');
      const lastMeshInfo = this.meshInfoArray[this.meshInfoArray.length - 1];
      const mesh = lastMeshInfo.originalMesh;
      const exporter = new STLExporter();
      const stlString = exporter.parse(mesh, { binary: true });
      const blob = new Blob([stlString], { type: 'text/plain' });

      const formData = new FormData();
      formData.append('file', blob, 'model.stl');
      formData.append('is_upper', isUpper)
      const res = await axios.post('http://localhost:8000/predict/', formData);

      const quaternionRawData = res.data?.quaternion;
      if (!quaternionRawData || !Array.isArray(quaternionRawData) || quaternionRawData.length !== 4) throw `${data} is not a valid quaternion data`;
      const quaternion = new THREE.Quaternion(quaternionRawData[0], quaternionRawData[1], quaternionRawData[2], quaternionRawData[3]);

      const newMesh = mesh.clone();
      newMesh.quaternion.copy(quaternion);

      lastMeshInfo.predictDirMesh = newMesh;
      Editor.scene.add(newMesh);

      console.log(this.meshInfoArray);
    } catch (error) {
      console.log(error)
    }
  }
}

export default new PredictDirection();