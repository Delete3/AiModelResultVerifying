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
 * Run fn and append its wall-clock cost to timings.
 *
 * Wall clock, not server-reported time: the number the UI used to show came from the crown
 * service's own X-FlowTooth-Seconds header, which starts after the upload has been read and
 * stops before the response is sent. That hid the mesh work in this file, which turns out to
 * be the larger half. `await fn()` is fine for synchronous fn too, and `finally` means a
 * failed step still reports how long it ran before throwing.
 */
const timed = async (timings, label, fn) => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings.push({ label, seconds: (performance.now() - start) / 1000 });
  }
};

/**
 * Monospace columns: CJK occupies two cells, so string length alone misaligns them.
 * Escapes rather than the characters themselves — the range opens at U+3000, an ideographic
 * space, and the literal form trips eslint's no-irregular-whitespace.
 */
const displayWidth = text => [...text]
  .reduce((total, ch) => total + (/[\u3000-\u9FFF\uFF00-\uFF60]/.test(ch) ? 2 : 1), 0);

/**
 * Render steps as an aligned block ending in the measured total.
 * totalSeconds is passed in rather than summed: the caller's wall clock also covers the gaps
 * between steps, and a column that does not add up to the total is the honest version.
 */
const formatTimings = (timings, totalSeconds) => {
  const width = Math.max(...[...timings.map(t => t.label), '總計'].map(displayWidth));
  const row = (label, seconds, note) =>
    `  ${label}${' '.repeat(width - displayWidth(label))}  ${seconds.toFixed(1).padStart(5)} 秒${note ? `  ${note}` : ''}`;

  return [
    ...timings.map(t => row(t.label, t.seconds, t.note)),
    `  ${'─'.repeat(width + 9)}`,
    row('總計', totalSeconds),
  ].join('\n');
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

  const timings = [];

  onStep('正在解析上下顎口掃…');
  const [upperMesh, lowerMesh] = await timed(timings, '解析口掃', () => Promise.all([
    loadMesh(upperStl),
    loadMesh(lowerStl),
  ]));
  if (!upperMesh || !lowerMesh) throw new Error('無法解析 upper.stl 或 lower.stl');

  onStep('步驟 1/3：正在分別預測上下顎方向…');
  const [upperQuaternion, lowerQuaternion] = await timed(timings, '擺正推論', () => Promise.all([
    PredictDirection.predictQuaternion(upperMesh, true),
    PredictDirection.predictQuaternion(lowerMesh, false),
  ]));

  // Both scans start in the same bite coordinate system. Applying one shared
  // rotation preserves every relative upper/lower position and distance.
  const sharedQuaternion = averageJawQuaternions(upperQuaternion, lowerQuaternion);
  const [positionedUpperStl, positionedLowerStl] = await timed(timings, '匯出擺正後口掃', () => {
    PredictDirection.applyQuaternion(upperMesh, sharedQuaternion);
    PredictDirection.applyQuaternion(lowerMesh, sharedQuaternion);
    onStep('步驟 1/3：已套用上下顎平均共同方向');
    return [
      meshToStlFile(upperMesh, 'upper.stl'),
      meshToStlFile(lowerMesh, 'lower.stl'),
    ];
  });

  onStep('步驟 2/3：正在產生 two-stage margin…');
  const preparedMesh = Number(fdi) < 30 ? upperMesh : lowerMesh;
  PredictAbutment.mesh = preparedMesh;
  PredictAbutment.toothFdi = Number(fdi);
  // v6 sibling conditioning needs the complete prepared-tooth list when a scan
  // contains multiple preparations. Keep an empty list for the single-prep path.
  PredictAbutment.allToothFdi = allToothFdi.trim();
  PredictAbutment.modelApi = modelApi;
  PredictAbutment.lastTwoStageResult = null;
  const marginPoints = await timed(timings, 'Margin 推論', () => PredictAbutment.callApi_2(true));
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
    timings,
  };
};

export { averageJawQuaternions, formatTimings, marginPointsToPtsFile, prepareFlowToothInputs };
