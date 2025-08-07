import {
  BufferGeometry,
  BufferAttribute,
  Vector3,
  Color,
} from 'three';

/**
 * @typedef {Object.<string, {triIndices: number[], indexIndices: number[], posIndices: number[]}>} PointMap
 */

/**
 * @param {BufferGeometry} geometry 
 * @returns {Set<string>}
 */
const getPointKeySet = geometry => {
  const pointKeySet = new Set();
  const posAttr = geometry.getAttribute('position');
  const tempVector = new Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    const point = tempVector.fromBufferAttribute(posAttr, i);
    pointKeySet.add(`${point.x}_${point.y}_${point.z}`);
  }
  return pointKeySet;
}

/**
 * Build a map from each vertex position to its triangle
 * @param {BufferGeometry} geometry 
 * @returns {PointMap}
 */
const buildPointMap = geometry => {
  if (!geometry.getIndex()) geometry.computeBoundsTree();

  const index = geometry.getIndex();
  const posAttr = geometry.getAttribute('position');

  const points = {};
  for (let i = 0; i < index.count; i++) {
    const triIndex = Math.floor(i / 3);
    const positionIndex = index.getX(i);

    const vx = posAttr.getX(positionIndex);
    const vy = posAttr.getY(positionIndex);
    const vz = posAttr.getZ(positionIndex);
    const key = `${vx}_${vy}_${vz}`;

    if (points[key]) {
      points[key].triIndices.push(triIndex);
      points[key].indexIndices.push(i);
      points[key].posIndices.push(positionIndex);
      continue;
    }

    points[key] = {
      triIndices: [triIndex],
      indexIndices: [i],
      posIndices: [positionIndex],
    }
  }

  return points;
}

/**
 * @typedef {Object.<string, {length: number, triIndices: number[], node1: string, node2: string}>} EdgeMap
 */

/**
 * Build a map from each edge to its vertices and triangles
 * @param {BufferGeometry} geometry 
 * @returns {EdgeMap}
 */
const buildEdgeMap = geometry => {
  const tempVector1 = new Vector3();
  const tempVector2 = new Vector3();

  if (!geometry.getIndex()) geometry.computeBoundsTree();

  const index = geometry.getIndex();
  const posAttr = geometry.getAttribute('position');

  const edges = {};
  for (let i = 0; i < index.count / 3; i++) {
    const triIndex = i;
    const ia = index.getX(triIndex * 3 + 0);
    const ib = index.getX(triIndex * 3 + 1);
    const ic = index.getX(triIndex * 3 + 2);

    for (const edge of [{ i1: ia, i2: ib }, { i1: ib, i2: ic }, { i1: ic, i2: ia }]) {
      const v1 = tempVector1.fromBufferAttribute(posAttr, edge.i1);
      const v2 = tempVector2.fromBufferAttribute(posAttr, edge.i2);

      const key1 = `${v1.x}_${v1.y}_${v1.z}`;
      const key2 = `${v2.x}_${v2.y}_${v2.z}`;

      const key = key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;
      const length = v1.distanceTo(v2);

      if (!edges[key]) {
        edges[key] = {
          length: length,
          triIndices: [triIndex],
          node1: key1 < key2 ? key1 : key2,
          node2: key1 < key2 ? key2 : key1,
        };
      }
      else {
        edges[key].triIndices.push(triIndex);
      }
    }
  }

  return edges;
}

/**
 * @typedef {{ triIndices: number[] }[]} TriMap
 */

/**
 * @param {BufferGeometry} geometry 
 * @returns {TriMap}
 */
const buildTriMap = geometry => {
  if (!geometry.edgeMap) geometry.edgeMap = buildEdgeMap(geometry);
  /**@type {EdgeMap} */
  const edgeMap = geometry.edgeMap;

  const indexAttr = geometry.getIndex();

  const edgeConnectTriSet = new Set();
  /**@type {TriMap} */
  const triMap = [];
  for (let triIndex = 0; triIndex < indexAttr.count / 3; triIndex++) {
    const [a, b, c] = triangleIndex2PositionKey(geometry, triIndex);

    const triEdgeKey1 = getEdgeKeyByTwoPointKey(a, b);
    const triEdgeKey2 = getEdgeKeyByTwoPointKey(a, c);
    const triEdgeKey3 = getEdgeKeyByTwoPointKey(b, c);

    edgeConnectTriSet.clear();
    for (const triEdgeKey of [triEdgeKey1, triEdgeKey2, triEdgeKey3]) {
      const { triIndices: connectTriIndices } = edgeMap[triEdgeKey];
      for (const triIndex of connectTriIndices) {
        edgeConnectTriSet.add(triIndex);
      }
    }
    edgeConnectTriSet.delete(triIndex);

    triMap.push({
      triIndices: [...edgeConnectTriSet],
    })
  }

  return triMap;
}

/**
 * @param {THREE.Vector3} v1 
 * @param {THREE.Vector3} v2 
 */
const getEdgeKeyByTwoPointKey = (key1, key2) => {
  const key = key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;
  return key;
}

/**
 * Given the key of a point, check whether or not it is a border node
 * @param {BufferGeometry} geometry 
 * @param {PointMap} pointMap 
 * @param {EdgeMap} edgeMap 
 * @param {string} key 
 * @returns {boolean}
 */
const checkBorderNode = (geometry, pointMap, edgeMap, key) => {
  const neighbors = posKey2Neighbors(geometry, pointMap, key);

  let singleTriCount = 0;
  for (const neighborKey of neighbors) {
    const edgeKey = key < neighborKey ? `${key}-${neighborKey}` : `${neighborKey}-${key}`
    const { triIndices } = edgeMap[edgeKey];
    if (triIndices.length == 1) singleTriCount++;
  }

  return singleTriCount == 2;
}

/**
 * Given a point key, convert it to the position vector 
 * @param {string} key 
 * @param {Vector3} [vector] 
 * @returns {Vector3}
 */
const posKey2Vec = (key, vector = new Vector3()) => {
  const coordArray = key.split("_");
  vector.set(Number(coordArray[0]), Number(coordArray[1]), Number(coordArray[2]));
  return vector;
}

/**
 * Given the key of a point, return the keys of its neighbors
 * @param {BufferGeometry} geometry 
 * @param {PointMap} pointMap 
 * @param {string} key 
 * @returns {Set<string>}
 */
const posKey2Neighbors = (geometry, pointMap, key) => {
  if (!pointMap[key]) {
    console.log(key);
    return new Set();
  }

  const posAttr = geometry.attributes.position;
  const { triIndices } = pointMap[key];

  const neighborKeys = new Set();
  for (let i = 0; i < triIndices.length; i++) {
    const triIndex = triIndices[i];
    const posIndices = posTri2Indices(geometry, triIndex);

    for (let j = 0; j < posIndices.length; j++) {
      const posIndex = posIndices[j];
      const key = `${posAttr.getX(posIndex)}_${posAttr.getY(posIndex)}_${posAttr.getZ(posIndex)}`;
      neighborKeys.add(key);
    }
  }
  neighborKeys.delete(key);

  return neighborKeys;
}

/**
 * Given the geometry and the triangle index, return the attribute indices 
 * @param {BufferGeometry} geometry 
 * @param {number} triIndex 
 * @returns {number[]}
 */
const posTri2Indices = (geometry, triIndex) => {
  const index = geometry.index;
  const ia = index.getX(triIndex * 3 + 0);
  const ib = index.getX(triIndex * 3 + 1);
  const ic = index.getX(triIndex * 3 + 2);
  return [ia, ib, ic];
}

/**
 * @param {BufferAttribute} positionAttribute 
 * @param {number} pointIndex
 * @returns {string}
 */
const pointIndex2positionKey = (positionAttribute, pointIndex) => {
  const ax = positionAttribute.getX(pointIndex);
  const ay = positionAttribute.getY(pointIndex);
  const az = positionAttribute.getZ(pointIndex);
  return `${ax}_${ay}_${az}`;
}

/**
 * 將三角形索引轉換成三個positionKey
 * @param {BufferGeometry} geometry 
 * @param {number} triangleIndex 
 * @returns {string[]}
 */
const triangleIndex2PositionKey = (geometry, triangleIndex) => {
  const [a, b, c] = posTri2Indices(geometry, triangleIndex);

  const positionAttribute = geometry.getAttribute('position');
  const aPointKey = pointIndex2positionKey(positionAttribute, a);
  const bPointKey = pointIndex2positionKey(positionAttribute, b);
  const cPointKey = pointIndex2positionKey(positionAttribute, c);

  return [aPointKey, bPointKey, cPointKey];
}

/**
 * @param {BufferGeometry} geometry 
 * @param {number} triangleIndex 
 * @param {Vector3} aPoint 
 * @param {Vector3} bPoint 
 * @param {Vector3} cPoint 
 * @returns {Vector3[]}
 */
const triangleIndex2Position = (geometry, triangleIndex, aPoint = new Vector3(), bPoint = new Vector3(), cPoint = new Vector3()) => {
  const [a, b, c] = posTri2Indices(geometry, triangleIndex);

  const posAttr = geometry.getAttribute('position');
  aPoint.fromBufferAttribute(posAttr, a);
  bPoint.fromBufferAttribute(posAttr, b);
  cPoint.fromBufferAttribute(posAttr, c);

  return [aPoint, bPoint, cPoint];
}

/**
 * 獲得幾何體邊緣的資訊
 * @param {EdgeMap} edgeMap 
 */
const getEdgeSet = edgeMap => {
  const edgePointKeySet = new Set();
  const edgeTriIndexSet = new Set();

  for (const edgeKey of Object.keys(edgeMap)) {
    const { triIndices, node1, node2 } = edgeMap[edgeKey];
    if (triIndices.length == 2) continue; // 只能是1或2

    edgePointKeySet.add(node1);
    edgePointKeySet.add(node2);
    edgeTriIndexSet.add(triIndices[0]);
  }

  return { edgePointKeySet, edgeTriIndexSet };
}

/**
 * 根據checkedPointKeySet的點，給三角形上色
 * @param {BufferGeometry} geometry
 * @param {Set<string>} pointKeySet
 * @param {Color} [color]
 */
const applyColorByPointKeySet = (
  geometry,
  pointKeySet,
  color = new Color(0, 1, 0)
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

/**
 * 根據三角形索引，獲得三個頂點的pointKey
 * @param {BufferGeometry} geometry
 * @param {number} triIndex
 * @returns {string[]}
 */
const getTriPointKeyArray = (geometry, triIndex) => {
  const indexAttr = geometry.getIndex();
  const posAttr = geometry.getAttribute('position');
  const tempVector = new Vector3();

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

export {
  buildPointMap,
  buildEdgeMap,
  buildTriMap,
  posKey2Vec,
  posKey2Neighbors,
  posTri2Indices,
  getEdgeKeyByTwoPointKey,
  checkBorderNode,
  pointIndex2positionKey,
  triangleIndex2PositionKey,
  getEdgeSet,
  triangleIndex2Position,
  getPointKeySet,
  applyColorByPointKeySet,
  getTriPointKeyArray,
}