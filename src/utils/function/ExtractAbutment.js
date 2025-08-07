import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH, } from 'three-mesh-bvh';

import Editor from "../Editor";
import {
    applyColorByPointKeySet,
    buildPointMap,
    posKey2Vec,
    getTriPointKeyArray,
} from '../tool/BufferGeometryTool';
import { pointSpread } from '../tool/SpreadGeometry';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

/**
 * 
 * @param {THREE.Vector3[]} marginPoints 
 * @param {number} num 
 */
const makeLinePointDenser = (marginPoints, num = 500) => {
    if (marginPoints.length == 0) return [];
    const line = new THREE.CatmullRomCurve3(marginPoints, true, 'catmullrom');
    return line.getSpacedPoints(num);
}

/**
 * @param {THREE.Mesh} mesh 
 * @param {THREE.Vector3[]} marginPoints 
 * @param {THREE.Vector3} zAxis
 */
const extractAbutment = (mesh, marginPoints, zAxis) => {
    const geometry = mesh.geometry;
    const denserMarginPoints = makeLinePointDenser(marginPoints, 2000);

    /**@type {MeshBVH} */
    const boundingTree = geometry.boundsTree;
    const pointMap = buildPointMap(geometry);
    geometry.pointMap = pointMap;
    const pointKeyArray = Object.keys(pointMap);
    const posAttr = geometry.getAttribute('position');
    const colorAttr = geometry.getAttribute('color');
    
    // Abtain spread boundary by margin
    const boundaryPointPointSet = new Set();
    for (const marginPoint of denserMarginPoints) {
        const info = boundingTree.closestPointToPoint(marginPoint);
        const pointKeyArray = getTriPointKeyArray(geometry, info.faceIndex);
        for (const pointKey of pointKeyArray) {
            boundaryPointPointSet.add(pointKey)
        }
    }

    // Abtain seedpoint by z axis hit point
    const seedPointKeySet = new Set();
    const marginBoundingSphere = new THREE.Sphere().setFromPoints(marginPoints);
    const center = marginBoundingSphere.center;
    raycaster.set(center, zAxis);
    const result = raycaster.intersectObject(mesh);
    if (result.length == 0) return;

    const { face, faceIndex } = result[0];
    if (face.normal.dot(zAxis) <= 0) return;

    const seedPointArray = getTriPointKeyArray(geometry, faceIndex);
    for (const seedPoint of seedPointArray) {
        boundaryPointPointSet.add(seedPoint)
    }

    // Abtain abutment
    const ifSpreadJudgeFunc = (seedPointKey, neighborKey) => {
        if (boundaryPointPointSet.has(neighborKey)) return false;
        return true;
    }
    const spreadPointKeySet = pointSpread(geometry, seedPointArray, ifSpreadJudgeFunc);
    const abutmentPointKeySet = new Set([...boundaryPointPointSet, ...seedPointKeySet, ...spreadPointKeySet]);

    applyColorByPointKeySet(geometry, abutmentPointKeySet)
}

/**
 * 
 * @param {THREE.BufferGeometry} geometry 
 * @param {THREE.Vector3[]} marginPoints 
 */
const extractAbutment1 = (geometry, marginPoints) => {
    const denserMarginPoints = makeLinePointDenser(marginPoints, 500);

    /**@type {MeshBVH} */
    const boundingTree = geometry.boundsTree;
    const pointMap = buildPointMap(geometry);
    geometry.pointMap = pointMap;
    const pointKeyArray = Object.keys(pointMap);

    const boundingShpere = new THREE.Sphere().setFromPoints(marginPoints);

    const tempPoint = new THREE.Vector3();
    const boundaryPointPointSet = new Set();
    for (const pointKey of pointKeyArray) {
        const scanPoint = posKey2Vec(pointKey, tempPoint);
        if (!boundingShpere.containsPoint(scanPoint)) continue;

        for (const marginPoint of marginPoints) {
            const squrDistance = scanPoint.distanceToSquared(marginPoint);
            if (squrDistance > 0.04) continue;

            boundaryPointPointSet.add(pointKey);
        }
    }
    // for(const marginPoint of marginPoints){
    //     const info = boundingTree.closestPointToPoint(marginPoint, {});
    //     info.faceIndex
    //     const pointKey = `${info.point.x}_${info.point.y}_${info.point.z}`;
    //     boundaryPointPointSet.add(pointKey)
    // }

    console.log(boundaryPointPointSet);
    applyColorByPointKeySet(geometry, boundaryPointPointSet)

}

export { extractAbutment };