import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

import { loadMesh } from '../loader/loadGeometry.js';
import PredictDirection from './PredictDirection.js';
import PredictAbutment from './predict-abutment/PredictAbutment.js';

const meshToStlFile = (mesh, fileName) => {
  const data = new STLExporter().parse(mesh, { binary: true });
  return new File([data], fileName, { type: 'model/stl' });
};

const marginPointsToPtsFile = (points, fdi) => {
  const rows = points.map(point => `${point.x} ${point.y} ${point.z}`);
  const text = ['BEGIN_PTS', ...rows, 'END_PTS', ''].join('\n');
  return new File([text], `design_service_margin_line-${fdi}.pts`, {
    type: 'text/plain',
  });
};

/**
 * Return the midpoint of two rotations on the shortest quaternion arc.
 * q and -q represent the same rotation, so align their hemispheres first.
 */
const averageJawQuaternions = (upperQuaternion, lowerQuaternion) => {
  const upper = upperQuaternion.clone().normalize();
  const lower = lowerQuaternion.clone().normalize();
  if (upper.dot(lower) < 0) {
    lower.set(-lower.x, -lower.y, -lower.z, -lower.w);
  }

  return upper.slerp(lower, 0.5).normalize();
};

/**
 * Prepare the exact files required by FlowToothSDF:
 * raw scans -> direction prediction -> positioned scans -> two-stage margin -> .pts.
 */
const prepareFlowToothInputs = async ({
  upperStl,
  lowerStl,
  fdi,
  allToothFdi = '',
  modelApi = 'v6',
  onStep = () => {},
}) => {
  if (!upperStl || !lowerStl) throw new Error('需要 upper.stl 與 lower.stl');

  onStep('正在解析上下顎口掃…');
  const [upperMesh, lowerMesh] = await Promise.all([
    loadMesh(upperStl),
    loadMesh(lowerStl),
  ]);
  if (!upperMesh || !lowerMesh) throw new Error('無法解析 upper.stl 或 lower.stl');

  onStep('步驟 1/3：正在分別預測上下顎方向…');
  const [upperQuaternion, lowerQuaternion] = await Promise.all([
    PredictDirection.predictQuaternion(upperMesh, true),
    PredictDirection.predictQuaternion(lowerMesh, false),
  ]);

  // Both scans start in the same bite coordinate system. Applying one shared
  // rotation preserves every relative upper/lower position and distance.
  const sharedQuaternion = averageJawQuaternions(upperQuaternion, lowerQuaternion);
  PredictDirection.applyQuaternion(upperMesh, sharedQuaternion);
  PredictDirection.applyQuaternion(lowerMesh, sharedQuaternion);
  onStep('步驟 1/3：已套用上下顎平均共同方向');

  const positionedUpperStl = meshToStlFile(upperMesh, 'upper.stl');
  const positionedLowerStl = meshToStlFile(lowerMesh, 'lower.stl');

  onStep('步驟 2/3：正在產生 two-stage margin…');
  const preparedMesh = Number(fdi) < 30 ? upperMesh : lowerMesh;
  PredictAbutment.mesh = preparedMesh;
  PredictAbutment.toothFdi = Number(fdi);
  // v6 sibling conditioning needs the complete prepared-tooth list when a scan
  // contains multiple preparations. Keep an empty list for the single-prep path.
  PredictAbutment.allToothFdi = allToothFdi.trim();
  PredictAbutment.modelApi = modelApi;
  PredictAbutment.lastTwoStageResult = null;
  const marginPoints = await PredictAbutment.callApi_2(true);
  if (!marginPoints?.length) throw new Error('Margin API 沒有回傳有效的 margin 點');
  const marginValidity = PredictAbutment.lastTwoStageResult?.validity ?? null;

  const marginPts = marginPointsToPtsFile(marginPoints, fdi);
  onStep('步驟 2/3：擺正與 margin 已完成');

  return {
    upperStl: positionedUpperStl,
    lowerStl: positionedLowerStl,
    marginPts,
    marginPoints,
    marginValidity,
    upperQuaternion,
    lowerQuaternion,
    sharedQuaternion,
  };
};

export { averageJawQuaternions, marginPointsToPtsFile, prepareFlowToothInputs };
