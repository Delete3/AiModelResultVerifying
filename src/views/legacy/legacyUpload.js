import * as THREE from 'three';

import Editor from '../../utils/Editor';
import PredictDirection from '../../utils/function/PredictDirection';
import PredictAbutment from '../../utils/function/predict-abutment/PredictAbutment';
import { loadGeometry } from '../../utils/loader/loadGeometry';
import { disposeMesh } from '../../utils/tool/SceneTool';

/**
 * The old single-model loader the legacy tools share (and SetupByTaskUrl calls). Kept apart
 * from App.jsx so that importing it does not pull the whole view in.
 * @param {File} file
 */
const onUploadFile = async file => {
  if (PredictDirection.mesh) disposeMesh(PredictDirection.mesh);
  if (PredictAbutment.mesh) disposeMesh(PredictAbutment.mesh);
  PredictDirection.mesh = null;
  PredictAbutment.mesh = null;

  const geometry = await loadGeometry(file);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  PredictAbutment.dispose();
  PredictDirection.mesh = mesh;
  PredictAbutment.mesh = mesh;
  Editor.scene.add(mesh);
};

export { onUploadFile };
