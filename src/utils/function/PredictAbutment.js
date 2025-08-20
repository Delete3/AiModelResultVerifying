import * as THREE from 'three';
import axios from 'axios';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import _ from 'lodash';
import { MeshBVH, CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';

import Editor from '../Editor';
import { loadGeometry } from '../loader/loadGeometry';
import { loadMatrixJson } from '../loader/loadDirJson';
import { applyColorByPointKeySet, buildPointMap, posKey2Vec, prepareColorMesh } from '../tool/BufferGeometryTool';
import { abutmentData } from '../../../public/abutmentData';

class PredictAbutment {
    constructor() {
        /**@type {THREE.Mesh} */
        this.mesh = null;
        this.toothFdi = null;
    }

    initFromPublic = async () => {
        const modelName = 'upper.ply';
        const modelRes = await axios.get(`./${modelName}`, { responseType: 'blob' });
        const modelFile = modelRes.data;
        modelFile.name = modelName;
        const geometry = await loadGeometry(modelFile);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            side: THREE.DoubleSide,
        }));
        Editor.scene.add(mesh);
        this.mesh = mesh;

        const marginName = 'design_service_margin_line-16.pts';
        const match = marginName.match(/^design_service_margin_line-(.+?)\.[^.]+$/);
        const toothFdi = match ? match[1] : null;
        this.toothFdi = toothFdi;

        const dirName = 'upper_matrix_-Z_+Y.json';
        const dirRes = await axios.get(`./${dirName}`, { responseType: 'blob' });
        const dirFile = dirRes.data;
        dirFile.name = dirName;
        const matrix = await loadMatrixJson(dirFile);

        geometry.applyMatrix4(matrix.clone().invert());
        // geometry.applyMatrix4(matrix);
    }

    /**
     * @param {THREE.BufferGeometry} abutPointGeometry 
     */
    getAbutment = (abutPointGeometry) => {
        const geometry = this.mesh.geometry;
        if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry);
        /**@type {MeshBVH} */
        const boundsTree = geometry.boundsTree;

        const pointMap = buildPointMap(geometry);
        geometry.pointMap = pointMap;
        const abutPosAttr = abutPointGeometry.getAttribute('position');

        const abutPointKeySet = new Set();
        const tempAbutPoint = new THREE.Vector3();

        const tempBoundingSphere = new THREE.Sphere();
        tempBoundingSphere.radius = 0.8

        for (let i = 0; i < abutPosAttr.count; i++) {
            const abutPoint = tempAbutPoint.fromBufferAttribute(abutPosAttr, i);
            tempBoundingSphere.center.copy(abutPoint);

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
                        abutPointKeySet.add(aKey);
                        abutPointKeySet.add(bKey);
                        abutPointKeySet.add(cKey);
                        return;
                    }

                    if (tempBoundingSphere.containsPoint(tri.a)) abutPointKeySet.add(aKey);
                    if (tempBoundingSphere.containsPoint(tri.b)) abutPointKeySet.add(bKey);
                    if (tempBoundingSphere.containsPoint(tri.c)) abutPointKeySet.add(cKey);
                }
            });
        }

        prepareColorMesh(this.mesh, true);
        applyColorByPointKeySet(geometry, abutPointKeySet, new THREE.Color(0, 1, 0))
    }

    callApi = async () => {
        if (!this.mesh || !this.toothFdi) return;
        console.log('predict abutment');

        try {
            // const formData = new FormData();

            // const stlString = new STLExporter().parse(this.mesh, { binary: true });
            // const stlBlob = new Blob([stlString], { type: 'text/plain' });
            // formData.append('file', stlBlob, 'model.stl');
            // formData.append('tooth_number', this.toothFdi);
            // formData.append('threshold', 0.35);

            // const res = await axios.post('http://localhost:8001/predict_abutment/', formData);
            // console.log(res.data);


            /**@type {number[][]} */
            const jawPoints = _.get(abutmentData, 'jaw_points', []);
            const oriPointCloudVertex = jawPoints.flat();
            const oriPointGeometry = new THREE.BufferGeometry();
            oriPointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(oriPointCloudVertex, 3));
            const oriPointMaterial = new THREE.PointsMaterial({ color: 0x888888, size: 4 });
            const oriPointsMesh = new THREE.Points(oriPointGeometry, oriPointMaterial);
            // Editor.scene.add(oriPointsMesh);

            /**@type {number[][]} */
            const abutPoints = _.get(abutmentData, 'abutment_points', []);
            const abutPointCloudVertex = abutPoints.flat();
            const abutPointGeometry = new THREE.BufferGeometry();
            abutPointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(abutPointCloudVertex, 3));
            const abutPointMaterial = new THREE.PointsMaterial({ color: 0xff0000, size: 5 });
            const abutPointsMesh = new THREE.Points(abutPointGeometry, abutPointMaterial);
            // Editor.scene.add(abutPointsMesh);

            // normalPoints = jawPoints過濾掉abutPoints
            // const normalPoints = 
            const abutPointCloudKeyMap = new Map();
            for (const abutPointData of abutPoints) {
                const [x, y, z] = abutPointData;
                abutPointCloudKeyMap.set(`${x}_${y}_${z}`, [x, y, z]);
            }

            const normalPointCloudKeyMap = new Map();
            for (const jawPointData of jawPoints) {
                const [x, y, z] = jawPointData;
                const pointKey = `${x}_${y}_${z}`;
                if (abutPointCloudKeyMap.has(pointKey)) continue;

                normalPointCloudKeyMap.set(pointKey, [x, y, z]);
            }

            // 先獲得abutment點雲大範圍的點，再用不是abutment的點雲小範圍去除點
            prepareColorMesh(this.mesh, true);
            const geometry = this.mesh.geometry;

            const abutPointSet = this.getAllPointByPointCloud(geometry, abutPointCloudKeyMap, 0.8);
            const normalPointSet = this.getAllPointByPointCloud(geometry, normalPointCloudKeyMap, 0.4);
            for (const abutPointKey of abutPointSet) {
                if (!normalPointSet.has(abutPointKey)) continue;
                abutPointSet.delete(abutPointKey);
            }
            applyColorByPointKeySet(geometry, abutPointSet, new THREE.Color(0, 1, 0));

            this.getSeedPoint(geometry, abutPointSet);
        } catch (error) {
            console.log(error);
        }
    }

    /**
     * @param {THREE.BufferGeometry} geometry 
     * @param {Map<string, number[]>} pointKeyMap
     */
    getAllPointByPointCloud = (geometry, pointKeyMap, radius = 0.5) => {
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
     * @param {THREE.BufferGeometry} geometry 
     * @param {Set<string>} pointKeySet 
     */
    getSeedPoint = (geometry, pointKeySet) => {
        if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);
        /**@type {import('../tool/BufferGeometryTool').PointMap} */
        const pointMap = geometry.pointMap;

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

        //畫出包圍框中心點
        console.log(boundingBox)
    }
}

export default new PredictAbutment();