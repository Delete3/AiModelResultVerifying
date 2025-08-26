import * as THREE from 'three';
import { MeshBVH, CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';

import PredictAbutment from './PredictAbutment';
import { applyColorByPointKeySet, buildPointMap, pointSpread, posKey2Vec } from '../../../tool/BufferGeometryTool';
import { fdi2Uni } from '../../../tool/ToothNumberMap';
import { drawArrow, drawPoint, prepareColorMesh } from '../../../tool/SceneTool';

const pointCloud2Boundary = (abutPointCloudKeyMap, normalPointCloudKeyMap) => {
    const geometry = PredictAbutment.mesh.geometry;

    const abutPointSet = getAllPointByPointCloud(abutPointCloudKeyMap, 0.8);
    const normalPointSet = getAllPointByPointCloud(normalPointCloudKeyMap, 0.4);
    for (const abutPointKey of abutPointSet) {
        if (!normalPointSet.has(abutPointKey)) continue;
        abutPointSet.delete(abutPointKey);
    }
    // applyColorByPointKeySet(geometry, abutPointSet, new THREE.Color(0, 1, 0));

    // 頂點擴散
    const seedPointKeySet = getSeedPoint(abutPointSet);
    const edgePointKeySet = new Set();
    const spreadPointSet = pointSpread(geometry, seedPointKeySet, (seedPointKey, neighborKey) => {
        if (normalPointSet.has(neighborKey)) {
            edgePointKeySet.add(seedPointKey);
            return false;
        }
        return true;
    });

    return edgePointKeySet;
}

/**
  * @param {Map<string, number[]>} pointKeyMap
  */
const getAllPointByPointCloud = (pointKeyMap, radius = 0.5) => {
    const geometry = PredictAbutment.mesh.geometry;

    if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry);
    /**@type {MeshBVH} */
    const boundsTree = geometry.boundsTree;

    if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);
    const pointMap = geometry.pointMap;

    const pointKeySet = new Set();
    const tempPoint = new THREE.Vector3();

    const tempBoundingSphere = new THREE.Sphere();
    tempBoundingSphere.radius = radius;

    for (const [pointKey, pointData] of pointKeyMap) {
        const [x, y, z] = pointData;
        const point = tempPoint.set(x, y, z);
        tempBoundingSphere.center.copy(point);

        boundsTree.shapecast({
            intersectsBounds: (box) => {
                if (tempBoundingSphere.intersectsBox(box)) return INTERSECTED;
                return NOT_INTERSECTED;
            },
            intersectsTriangle: (tri, triIndex, contained) => {
                const aKey = `${tri.a.x}_${tri.a.y}_${tri.a.z}`;
                const bKey = `${tri.b.x}_${tri.b.y}_${tri.b.z}`;
                const cKey = `${tri.c.x}_${tri.c.y}_${tri.c.z}`;

                if (contained) {
                    pointKeySet.add(aKey);
                    pointKeySet.add(bKey);
                    pointKeySet.add(cKey);
                    return;
                }

                if (tempBoundingSphere.containsPoint(tri.a)) pointKeySet.add(aKey);
                if (tempBoundingSphere.containsPoint(tri.b)) pointKeySet.add(bKey);
                if (tempBoundingSphere.containsPoint(tri.c)) pointKeySet.add(cKey);
            }
        });
    }

    return pointKeySet;
}

/**
 * 獲得pointKey中心的點，再向齒軸方向找出種子點
 * @param {Set<string>} pointKeySet 
 */
const getSeedPoint = (pointKeySet) => {
    const geometry = PredictAbutment.mesh.geometry;

    if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);
    /**@type {import('../../../tool/BufferGeometryTool').PointMap} */
    const pointMap = geometry.pointMap;
    const posAttr = geometry.getAttribute('position');

    const boundingBox = new THREE.Box3();
    const tempPoint = new THREE.Vector3();
    for (const pointKey of pointKeySet) {
        const pointData = pointMap[pointKey];
        if (!pointData) {
            console.log(`Can not find ${pointKey} in pointMap`);
            continue;
        }

        const [x, y, z] = pointData.vectorNums;
        const point = tempPoint.set(x, y, z);
        boundingBox.expandByPoint(point);
    }

    const center = boundingBox.getCenter(new THREE.Vector3());
    const isUpper = fdi2Uni[PredictAbutment.toothFdi] < 16;
    const dir = new THREE.Vector3(0, 0, isUpper ? -1 : 1);
    const raycaster = new THREE.Raycaster(center, dir);
    const results = raycaster.intersectObject(PredictAbutment.mesh, false);
    if (results.length == 0) return;

    const seedPointKeySet = new Set();
    const { face } = results[0];
    const tempPoint2 = new THREE.Vector3();
    for (const posIndex of [face.a, face.b, face.c]) {
        const point = tempPoint2.fromBufferAttribute(posAttr, posIndex);
        seedPointKeySet.add(`${point.x}_${point.y}_${point.z}`);
    }

    return seedPointKeySet;
}
export { pointCloud2Boundary }