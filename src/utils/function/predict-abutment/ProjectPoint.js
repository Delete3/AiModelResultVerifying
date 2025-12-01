import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * @param {THREE.Mesh} mesh 
 * @param {THREE.CatmullRomCurve3} curve 
 * @returns {THREE.CatmullRomCurve3}
 */
const projectCurveOnMesh = (mesh, curve) => {
    const pointArray = curve.getSpacedPoints(Math.round(curve.getLength()) * 10);
    for (const point of pointArray) {
        point.copy(projectPointOnMesh(mesh, point, point));
    }
    return new THREE.CatmullRomCurve3(pointArray, true, 'catmullrom');
}

/**
 * @param {THREE.Mesh} mesh 
 * @param {THREE.Vector3[]} pointArray 
 * @returns {THREE.CatmullRomCurve3}
 */
const projectPointArrayOnMesh = (mesh, pointArray) => {
    for (const point of pointArray) {
        point.copy(projectPointOnMesh(mesh, point, point));
    }
    return pointArray;
}

/**
 * @param {THREE.Mesh} mesh 
 * @param {THREE.Vector3} point 
 * @returns {THREE.Vector3}
 */
const projectPointOnMesh = (mesh, point, targetPoint = new THREE.Vector3()) => {
    const { geometry } = mesh;
    if (!geometry.boundsTree) geometry.computeBoundsTree();
    /**@type {MeshBVH} */
    const boundsTree = geometry.boundsTree;

    targetPoint.copy(point);
    mesh.worldToLocal(targetPoint);

    const closestPoint = boundsTree.closestPointToPoint(targetPoint).point;
    targetPoint.copy(closestPoint).applyMatrix4(mesh.matrix);
    return targetPoint;
}

export {
    projectCurveOnMesh,
    projectPointArrayOnMesh,
    projectPointOnMesh,
}