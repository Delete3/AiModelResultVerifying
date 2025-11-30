import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import axios from 'axios';

import Editor from '../Editor';

class PredictMargin {
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

  drawMarginCircle = (points) => {
    const newPoints = points.map(point => point.clone());
    const fittedCurve = new THREE.CatmullRomCurve3(newPoints, true);
    const curveGeometry = new THREE.TubeGeometry(fittedCurve, newPoints.length, 0.02, 8, true);
    const curveMaterial = new THREE.MeshStandardMaterial({
      color: 0xff0000,
      emissive: 0,
      metalness: 0.2,
      side: 2,
      roughness: 0.5
    });
    const curveMesh = new THREE.Mesh(curveGeometry, curveMaterial);
    Editor.scene.add(curveMesh);
  }

  predictMesh = async (toothNumberStr) => {
    try {
      const toothNumber = Number(toothNumberStr)
      console.log('predict margin');
      const lastMeshInfo = this.meshInfoArray[this.meshInfoArray.length - 1];
      const mesh = lastMeshInfo.originalMesh;
      const exporter = new STLExporter();
      const stlString = exporter.parse(mesh, { binary: true });
      const blob = new Blob([stlString], { type: 'text/plain' });

      const formData = new FormData();
      formData.append('file', blob, 'model.stl');
      formData.append('tooth_number', toothNumber);
      const res = await axios.post('/api/margin/predict-margin/', formData);
      console.log(res.data)
      const quaternionRawData = res.data?.quaternion;
      const marginLineRawData = res.data?.margin_line;
      if (!quaternionRawData || !Array.isArray(quaternionRawData) || quaternionRawData.length !== 4) throw `${res.data} is not a valid quaternion data`;
      if (!marginLineRawData || !Array.isArray(marginLineRawData)) throw `${res.data} is not a valid margin line data`;

      const quaternion = new THREE.Quaternion(quaternionRawData[0], quaternionRawData[1], quaternionRawData[2], quaternionRawData[3]);
      console.log(quaternion);
      const newMesh = new THREE.Mesh(mesh.geometry, mesh.material.clone());
      mesh.material.transparent = true;
      mesh.material.opacity = 0.5
      newMesh.quaternion.copy(quaternion);
      Editor.scene.add(newMesh);

      const marginLine = [];
      for (const pointArray of marginLineRawData) {
        const [x, y, z] = pointArray;
        const point = new THREE.Vector3(x, y, z);
        marginLine.push(point);
      }
      console.log(marginLine);
      this.drawMarginCircle(marginLine);

      console.log(this.meshInfoArray);
    } catch (error) {
      console.log(error)
    }
  }
}

export default new PredictMargin();