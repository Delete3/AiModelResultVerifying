import * as THREE from 'three';
import axios from 'axios';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import _ from 'lodash';
import { MeshBVH, CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';

import Editor from '../Editor';
import { loadGeometry } from '../loader/loadGeometry';
import { loadMatrixJson } from '../loader/loadDirJson';
import { applyColorByPointKeySet, buildPointMap, posKey2Vec, prepareColorMesh } from '../tool/BufferGeometryTool';

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

    callApi = async () => {
        if (!this.mesh || !this.toothFdi) return;
        console.log('predict abutment');

        try {
            const formData = new FormData();

            const stlString = new STLExporter().parse(this.mesh, { binary: true });
            const stlBlob = new Blob([stlString], { type: 'text/plain' });
            formData.append('file', stlBlob, 'model.stl');
            formData.append('tooth_number', this.toothFdi);
            formData.append('threshold', 0.35);

            const res = await axios.post('http://localhost:8001/predict_abutment/', formData);
            console.log(res.data);

            //如何從點雲獲得完整網格
            /**@type {number[][]} */
            const jawPoints = _.get(res.data, 'jaw_points', []);
            const oriPointCloudVertex = jawPoints.flat();
            const oriPointGeometry = new THREE.BufferGeometry();
            oriPointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(oriPointCloudVertex, 3));
            const oriPointMaterial = new THREE.PointsMaterial({ color: 0x888888, size: 4 });
            const oriPointsMesh = new THREE.Points(oriPointGeometry, oriPointMaterial);
            // Editor.scene.add(oriPointsMesh);

            /**@type {number[][]} */
            const abutPoints = _.get(res.data, 'abutment_points', []);
            const abutPointCloudVertex = abutPoints.flat();
            const abutPointGeometry = new THREE.BufferGeometry();
            abutPointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(abutPointCloudVertex, 3));
            const abutPointMaterial = new THREE.PointsMaterial({ color: 0xff0000, size: 5 });
            const abutPointsMesh = new THREE.Points(abutPointGeometry, abutPointMaterial);
            // Editor.scene.add(abutPointsMesh);

            this.getAbutment(abutPointGeometry);
        } catch (error) {
            console.log(error);
        }
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

        const posAttr = geometry.getAttribute('position');
        const indexAttr = geometry.getIndex();

        const abutPosAttr = abutPointGeometry.getAttribute('position');

        const abutPointKeySet = new Set();
        const tempBoundBox = new THREE.Box3();
        const tempAbutPoint = new THREE.Vector3();
        const boxSize = new THREE.Vector3(1, 1, 1);
        for (let i = 0; i < abutPosAttr.count; i++) {
            const abutPoint = tempAbutPoint.fromBufferAttribute(abutPosAttr, i);
            tempBoundBox.setFromCenterAndSize(abutPoint, boxSize); //試試看包圍球的效果

            //遍歷口掃每個頂點，找出在包圍框內的
            boundsTree.shapecast({
                intersectsBounds: (box) => {
                    if (tempBoundBox.containsBox(box)) return CONTAINED;
                    if (tempBoundBox.intersectsBox(box)) return INTERSECTED;
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

                    if (tempBoundBox.containsPoint(tri.a)) abutPointKeySet.add(aKey);
                    if (tempBoundBox.containsPoint(tri.b)) abutPointKeySet.add(bKey);
                    if (tempBoundBox.containsPoint(tri.c)) abutPointKeySet.add(cKey);
                }
            });
        }

        prepareColorMesh(this.mesh, true);
        applyColorByPointKeySet(geometry, abutPointKeySet, new THREE.Color(0, 1, 0))
        console.log(abutPointKeySet, this.mesh)
    }
}

export default new PredictAbutment();