import * as THREE from 'three';

/**
 * @typedef {Object.<string, {triIndices: number[], posIndices: number[], vectorNums: number[]}>} PointMap
 */

/**
 * @param {string} key
 * @param {THREE.Vector3} [vector]
 * @returns {THREE.Vector3}
 */
const posKey2Vec = (key, vector = new THREE.Vector3()) => {
  const data = pointMap[key];
  if (!data) {
    const coordArray = key.split("_");
    vector.set(Number(coordArray[0]), Number(coordArray[1]), Number(coordArray[2]));
    return vector;
  }

  vector.set(data.vectorNums[0], data.vectorNums[1], data.vectorNums[2]);
  return vector;
};

/**
 * @param {THREE.Vector3} vector
 * @returns {string}
 */
const vec2PosKey = (vector) => {
  return `${vector.x}_${vector.y}_${vector.z}`;
};

/**
 * 為每個點對應用到的三角形索引，和用到的點索引
 * @param {THREE.BufferGeometry} geometry
 * @returns {PointMap}
 */
const buildPointMap = (geometry) => {
  const index = geometry.getIndex();
  const posAttr = geometry.getAttribute('position');

  const points = {};
  for (let i = 0; i < index.count; i++) {
    const triIndex = Math.floor(i / 3);
    const posIndex = index.getX(i);

    const vx = posAttr.getX(posIndex);
    const vy = posAttr.getY(posIndex);
    const vz = posAttr.getZ(posIndex);
    const key = `${vx}_${vy}_${vz}`;

    if (points[key]) {
      points[key].triIndices.push(triIndex);
      points[key].posIndices.push(posIndex);
      continue;
    }

    points[key] = {
      vectorNums: [vx, vy, vz],
      triIndices: [triIndex],
      posIndices: [posIndex],
    };
  }

  return points;
};

/**
 * 根據點資料，回傳其周圍的點資料
 * @param {THREE.BufferGeometry} geometry
 * @param {PointMap} pointMap
 * @param {string} key
 * @returns {Set<string>}
 */
const posKey2Neighbors = (geometry, pointMap, key) => {
  const neighborKeys = new Set();
  if (!pointMap[key]) return neighborKeys;

  const { triIndices } = pointMap[key];
  const posAttr = geometry.getAttribute('position');

  const tempPoint = new THREE.Vector3();
  for (const triIndex of triIndices) {
    const posIndices = tri2PosIndices(geometry, triIndex);

    for (const posIndex of posIndices) {
      const point = tempPoint.fromBufferAttribute(posAttr, posIndex);
      neighborKeys.add(vec2PosKey(point));
    }
  }

  neighborKeys.delete(key);
  return neighborKeys;
};

/**
 * 根據三角形索引，獲得三個點的索引
 * @param {THREE.BufferGeometry} geometry
 * @param {number} triIndex
 * @returns {number[]}
 */
const tri2PosIndices = (geometry, triIndex) => {
  const index = geometry.getIndex();
  const ia = index.getX(triIndex * 3 + 0);
  const ib = index.getX(triIndex * 3 + 1);
  const ic = index.getX(triIndex * 3 + 2);
  return [ia, ib, ic];
};

/**
 * 根據三角形索引，獲得三個頂點的pointKey
 * @param {BufferGeometry} geometry
 * @param {number} triIndex
 * @returns {string[]}
 */
const getTriPointKeyArray = (geometry, triIndex) => {
  const indexAttr = geometry.getIndex();
  const posAttr = geometry.getAttribute('position');
  const tempVector = new THREE.Vector3();

  const aIndex = indexAttr.getX(triIndex * 3);
  const aPoint = tempVector.fromBufferAttribute(posAttr, aIndex);
  const aKey = `${aPoint.x}_${aPoint.y}_${aPoint.z}`;

  const bIndex = indexAttr.getX(triIndex * 3 + 1);
  const bPoint = tempVector.fromBufferAttribute(posAttr, bIndex);
  const bKey = `${bPoint.x}_${bPoint.y}_${bPoint.z}`;

  const cIndex = indexAttr.getX(triIndex * 3 + 2);
  const cPoint = tempVector.fromBufferAttribute(posAttr, cIndex);
  const cKey = `${cPoint.x}_${cPoint.y}_${cPoint.z}`;

  return [aKey, bKey, cKey];
};

/**
 * @param {BufferGeometry} geometry
 * @param {Set<number>} seedtriIndexSet 所有種子三角形
 * @param {(checkedTriIndex: number, neighborTriIndex: number)=>{}} ifSpreadJudgeFunc 擴散判斷函式，為true則繼續擴散
 */
const triangleSpread = (geometry, seedtriIndexSet, ifSpreadJudgeFunc = () => true) => {
    if (!geometry.triMap) geometry.triMap = buildTriMap(geometry);
    /**@type {import('./GeometryMapTool').TriMap} */
    const triMap = geometry.triMap;

    const spreadTriIndexSet = new Set();
    const boundaryPointKeySet = new Set();
    const tempSeedTriIndexSet = new Set([...seedtriIndexSet]);

    const neighborTriIndexSet = new Set();
    while (tempSeedTriIndexSet.size > 0) {
        neighborTriIndexSet.clear();

        for (const seedTriKey of tempSeedTriIndexSet) {
            const { triIndices: neighborTriArray } = triMap[seedTriKey];
            spreadTriIndexSet.add(seedTriKey);

            for (const neighborKey of neighborTriArray) {
                if (spreadTriIndexSet.has(neighborKey)) continue;
                if (boundaryPointKeySet.has(neighborKey)) continue;

                if (!ifSpreadJudgeFunc(seedTriKey, neighborKey)) {
                    boundaryPointKeySet.add(neighborKey);
                    continue;
                }

                neighborTriIndexSet.add(neighborKey);
            }
        }

        tempSeedTriIndexSet.clear();
        for (const neighborKey of neighborTriIndexSet)
            tempSeedTriIndexSet.add(neighborKey);
    }

    return { spreadTriIndexSet, boundaryPointKeySet };
}

/**
 * @param {BufferGeometry} geometry
 * @param {Set<string>} seedPointKeySet 所有種子點
 * @param {(seedPointKey: string, neighborPointKey: string)=>{}} ifSpreadJudgeFunc 擴散判斷函式，為true則繼續擴散
 * @return {Set<string>} 所有擴散到的點
 */
const pointSpread = (geometry, seedPointKeySet, ifSpreadJudgeFunc = () => true) => {
    if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);
    /**@type {import('./GeometryMapTool').PointMap} */
    const pointMap = geometry.pointMap;

    const checkedPointKeySet = new Set();
    const tempSeedPointKeySet = new Set([...seedPointKeySet]);

    const neighborSeedKeySet = new Set();
    while (tempSeedPointKeySet.size > 0) {
        neighborSeedKeySet.clear();

        for (const seedPointKey of tempSeedPointKeySet) {
            const neighborKeySet = posKey2Neighbors(geometry, pointMap, seedPointKey);
            checkedPointKeySet.add(seedPointKey);

            for (const neighborKey of neighborKeySet) {
                if (checkedPointKeySet.has(neighborKey)) continue;
                if (!ifSpreadJudgeFunc(seedPointKey, neighborKey)) continue;

                neighborSeedKeySet.add(neighborKey);
            }
        }

        tempSeedPointKeySet.clear();
        for (const neighborKey of neighborSeedKeySet)
            tempSeedPointKeySet.add(neighborKey);
    }

    return checkedPointKeySet;
}

/**
 * 根據checkedPointKeySet的點，給三角形上色
 * @param {THREE.BufferGeometry} geometry
 * @param {Set<string>} pointKeySet
 * @param {THREE.Color} [color]
 */
const applyColorByPointKeySet = (
  geometry,
  pointKeySet,
  color = new THREE.Color(0, 1, 0)
) => {
  /**@type {PointMap} */
  const { pointMap } = geometry;
  if (!pointMap) return;

  const colorAttr = geometry.getAttribute('color');

  for (const pointKey of pointKeySet) {
    const { posIndices } = pointMap[pointKey];

    for (const posIndex of posIndices) {
      colorAttr.setXYZ(posIndex, color.r, color.g, color.b);
    }
  }

  colorAttr.needsUpdate = true;
};

export {
  buildPointMap,
  triangleSpread,
  pointSpread,
  posKey2Vec,
  vec2PosKey,
  applyColorByPointKeySet,
};
