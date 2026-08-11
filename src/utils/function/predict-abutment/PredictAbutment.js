import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import axios from 'axios';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter'
import _ from 'lodash';
import { MeshBVH, CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';
import { message } from 'antd';

import Editor from '../../Editor';
import { loadGeometry } from '../../loader/loadGeometry';
import { loadMatrixJson } from '../../loader/loadDirJson';
import { applyColorByPointKeySet, buildPointMap, pointSpread, posKey2Vec } from '../../tool/BufferGeometryTool';
import { disposeMesh, drawArrow, drawPoint, prepareColorMesh } from '../../tool/SceneTool';
import { optimizePointOrder } from './SortPoint';
import { smoothPoints, smoothPointsWithProjection } from './SmoothPoint';
import { pointCloud2Boundary } from './PointCloud2Boundary';
import { projectCurveOnMesh, projectPointArrayOnMesh } from './ProjectPoint';
import PredictDirection from '../PredictDirection';

const curveMaterial = new THREE.MeshStandardMaterial({
    color: 0xff0000,
    emissive: 0,
    metalness: 0.2,
    side: 2,
    roughness: 0.5
});

// 兩個 two-stage 選項的 stage2 都是 v8_plain，差別在 stage1：
//   v6: stage1_v6_sibseed（正式部署的最佳單模型；可使用同顎所有備牙 FDI 作競爭牙 seed）
//   v8: stage1_v8_mcls_fgdice（多類別 runner-up；一次 forward 標註所有備牙）
export const MODEL_API_PATHS = {
    v6: '/api/margin-two-stage-v6',
    v8: '/api/margin-two-stage-v8',
};

class PredictAbutment {
    constructor() {
        /**@type {THREE.Mesh} */
        this.mesh = null;
        /**@type {number} */
        this.toothFdi = null;
        /**@type {string} */
        this.allToothFdi = '';
        /**@type {keyof typeof MODEL_API_PATHS} */
        this.modelApi = 'v6';
        this.lastTwoStageResult = null;
        /**@type {THREE.Mesh} */
        this.curveMesh = null;
        /**@type {THREE.Mesh[]} */
        this.tempMeshArray = [];
        console.log(this)
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
    }

    /**
     * @param {THREE.BufferGeometry} abutPointGeometry 
     */
    getAbutment = (abutPointGeometry) => {
        const geometry = this.mesh.geometry;
        if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry);
        /**@type {MeshBVH} */
        const boundsTree = geometry.boundsTree;

        if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);
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

    /**
     * 呼叫 AI API 預測 abutment margin line
     * @param {number} version - API 版本
     * @param {number} [gradientThreshold=0.3] - 機率梯度閾值（使用者可調）
     */
    callApi = async (version, gradientThreshold = 0.4) => {
        if (!this.mesh || !this.toothFdi) return;

        this.dispose();

        console.log('predict abutment');

        try {
            const formData = new FormData();

            const stlString = new STLExporter().parse(this.mesh, { binary: true });
            const stlBlob = new Blob([stlString], { type: 'text/plain' });
            formData.append('file', stlBlob, 'model.stl');
            formData.append('tooth_number', this.toothFdi);
            formData.append('threshold', gradientThreshold);

            console.time('AI predict abutment');
            let res;
            // if (version == 2) res = await axios.post('http://192.168.0.101:8001/predict_abutment_v2/', formData);
            // else res = await axios.post('http://192.168.0.101:8001/predict_abutment/', formData);

            if (version == 2) res = await axios.post('https://4e942d61-8fdf-4adb-b15d-495a88409d93.inteware.com.tw/margin/predict_abutment_v2/', formData);
            else if (version == 1) res = await axios.post('https://4e942d61-8fdf-4adb-b15d-495a88409d93.inteware.com.tw/margin/predict_abutment/', formData);

            console.log(res.data);
            console.timeEnd('AI predict abutment');

            return this.processResult(res.data, gradientThreshold);
        } catch (error) {
            console.log(error);
            message.error('predict margin fail')
        }
    }

    callApi_2 = async (throwOnError = false) => {
        if (!this.mesh || !this.toothFdi) return;

        this.dispose();
        console.log('predict abutment2');

        try {
            const formData = new FormData();

            const stlString = new STLExporter().parse(this.mesh, { binary: true });
            const stlBlob = new Blob([stlString], { type: 'text/plain' });
            formData.append('file', stlBlob, 'model.stl');
            formData.append('tooth_number', this.toothFdi);
            if (this.allToothFdi) formData.append('all_tooth_numbers', this.allToothFdi);
            // formData.append('return_debug', true);
            // formData.append('curve_smooth_iterations', 8);
            // formData.append('spline_point', 128);
            formData.append('boundary_mode', 'prob_isocontour');
            // formData.append('threshold', gradientThreshold);

            console.time('AI predict abutment2');

            // Same-origin Vite proxy avoids browser CORS and HTTPS mixed-content errors.
            const res = await axios.post(`${MODEL_API_PATHS[this.modelApi]}/predict_margin_two_stage`, formData);
            // const res = await axios.post('https://4e942d61-8fdf-4adb-b15d-495a88409d93.inteware.com.tw/margin-new/predict_margin_two_stage', formData);
            this.lastTwoStageResult = res.data;
            console.log(res.data)
            // stage1.conditioning 會回報實際生效的 conditioning；v6 多備牙時應有 sibling seed。
            console.log('conditioning:', _.get(res.data, 'stage1.conditioning'))
            console.log(_.get(res.data, 'validity.valid', true))



            const responsePointArray = _.get(res.data, 'spline_points_mm', []).length
                ? _.get(res.data, 'spline_points_mm', [])
                : _.get(res.data, 'margin_points_mm', []);
            const marginPointArray = responsePointArray.map(pointData => {
                const x = _.get(pointData, '0', 0);
                const y = _.get(pointData, '1', 0);
                const z = _.get(pointData, '2', 0);
                return new THREE.Vector3(x, y, z)
            });
            this.showMarginLine(marginPointArray, _.get(res.data, 'margin_closed', true));

            if (false) {
                const verticeArray = _.get(res.data, 'debug.vertices_mm', []);
                const posAttr = new THREE.Float32BufferAttribute(verticeArray.flat(), 3, false);

                const faceArray = _.get(res.data, 'debug.faces', []);
                const indexAttr = new THREE.Uint32BufferAttribute(faceArray.flat(), 1, false);

                const colorAttr = new THREE.Float32BufferAttribute(posAttr.array.length, 3, false);
                colorAttr.array.fill(1);
                // const labelArray = _.get(res.data, 'debug.raw_stage2_labels', []);
                const labelArray = _.get(res.data, 'debug.postprocessed_labels', []);
                for (let faceIndex = 0; faceIndex < labelArray.length; faceIndex++) {
                    const isLabel = labelArray[faceIndex] === 1;
                    if (!isLabel) continue;

                    const faceIndexFlat = faceIndex * 3;
                    for (let i = 0; i < 3; i++) {
                        const posIndex = indexAttr.array[faceIndexFlat + i];
                        colorAttr.setXYZ(posIndex, 0, 1, 0);
                    }
                }
                colorAttr.needsUpdate = true;
                const newGeo = new THREE.BufferGeometry();
                newGeo.setAttribute('position', posAttr);
                newGeo.setAttribute('color', colorAttr);
                newGeo.setIndex(indexAttr);
                newGeo.computeVertexNormals();
                this.mesh.geometry = newGeo;
                this.mesh.material.vertexColors = true;
                this.mesh.material.needsUpdate = true;
                console.log(this.mesh)
            }

            console.timeEnd('AI predict abutment2');
            return marginPointArray;
        } catch (error) {
            console.error(error);
            message.error(`predict margin2 fail: ${error.response?.data?.detail ?? error.message}`);
            if (throwOnError) throw error;
            return null;
        }
    }

    callApi_checkNPZ = async () => {
        try {
            console.time('AI predict abutment3');

            const res = await axios.get('http://192.168.0.101:8011/case_npz?filename=68a6b953879fae70eb3e20c1_16_stage2');
            console.log(res.data)

            const verticeArray = _.get(res.data, 'vertices_mm', []);
            const posAttr = new THREE.Float32BufferAttribute(verticeArray.flat(), 3, false);

            const faceArray = _.get(res.data, 'faces', []);
            const indexAttr = new THREE.Uint32BufferAttribute(faceArray.flat(), 1, false);

            const colorAttr = new THREE.Float32BufferAttribute(posAttr.array.length, 3, false);
            colorAttr.array.fill(1);
            const labelArray = _.get(res.data, 'labels', []);
            for (let faceIndex = 0; faceIndex < labelArray.length; faceIndex++) {
                const isLabel = labelArray[faceIndex] === 1;
                if (!isLabel) continue;

                const faceIndexFlat = faceIndex * 3;
                for (let i = 0; i < 3; i++) {
                    const posIndex = indexAttr.array[faceIndexFlat + i];
                    colorAttr.setXYZ(posIndex, 1, 0, 0);
                }
            }
            colorAttr.needsUpdate = true;

            const newGeo = new THREE.BufferGeometry();
            newGeo.setAttribute('position', posAttr);
            newGeo.setAttribute('color', colorAttr);
            newGeo.setIndex(indexAttr);
            newGeo.computeVertexNormals();

            const material = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                roughness: 0.2,
                side: THREE.DoubleSide,
            });
            material.vertexColors = true;
            material.needsUpdate = true;

            this.mesh = new THREE.Mesh(newGeo, material);
            console.log(this.mesh)
            Editor.scene.add(this.mesh)

            console.timeEnd('AI predict abutment3');
        } catch (error) {
            console.log(error);
            message.error('predict margin3 fail')
        }
    }

    /**
     * 處理 AI 回傳的結果，提取 margin line
     * @param {object} data - API response
     * @param {number} gradientThreshold - 機率梯度閾值
     */
    processResult = (data, gradientThreshold = 0.4) => {
        /**@type {number[][]} */
        const jawPoints = _.get(data, 'jaw_points', []);
        /**@type {number[]} */
        const allProbabilities = _.get(data, 'all_probabilities', []);

        if (jawPoints.length === 0 || allProbabilities.length === 0) {
            throw new Error('AI response missing jaw_points or all_probabilities');
        }

        if (false) {
            // 視覺化：顯示所有點雲（灰色）
            const oriPointCloudVertex = jawPoints.flat();
            const oriPointGeometry = new THREE.BufferGeometry();
            oriPointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(oriPointCloudVertex, 3));
            const oriPointMaterial = new THREE.PointsMaterial({ color: 0x888888, size: 4 });
            const oriPointsMesh = new THREE.Points(oriPointGeometry, oriPointMaterial);
            this.tempMeshArray.push(oriPointsMesh);
            Editor.scene.add(oriPointsMesh);

            // 視覺化：顯示 abutment 點（綠色，按機率過濾）
            const abutPoints = jawPoints.filter((_, i) => allProbabilities[i] > 0.5);
            if (abutPoints.length === 0) throw new Error('AI can not recognize abutment');

            const abutPointCloudVertex = abutPoints.flat();
            const abutPointGeometry = new THREE.BufferGeometry();
            abutPointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(abutPointCloudVertex, 3));
            const abutPointMaterial = new THREE.PointsMaterial({ color: 0x00ff00, size: 5 });
            const abutPointsMesh = new THREE.Points(abutPointGeometry, abutPointMaterial);
            this.tempMeshArray.push(abutPointsMesh);
            Editor.scene.add(abutPointsMesh);
        }

        // Step 1: Angular Sweep 輪廓提取（輸出已有序、閉合）
        console.time('Boundary extraction');
        const outlinePoints = pointCloud2Boundary(jawPoints, allProbabilities, this.toothFdi, {
            probThreshold: gradientThreshold,
        });
        console.timeEnd('Boundary extraction');

        if (outlinePoints.length === 0) {
            throw new Error('Failed to extract outline points');
        }

        console.log(`Outline points: ${outlinePoints.length}`);

        // Step 2: 投影到 mesh 上
        let sortedPoints = projectPointArrayOnMesh(this.mesh, outlinePoints);

        // Step 3: 2-opt 微調排序（輪廓已大致有序，微調即可）
        sortedPoints = optimizePointOrder(sortedPoints);

        // Step 4: Laplacian 平滑 + mesh 投影
        sortedPoints = smoothPointsWithProjection(sortedPoints, this.mesh, 3, 0.5, 1);

        // Step 5: 生成 CatmullRomCurve3 + TubeGeometry
        this.showMarginLine(sortedPoints);
        return sortedPoints;
    }

    /**
     * @param {THREE.Vector3[]} pointArray 
     * @param {boolean} closed
     */
    showMarginLine = (pointArray, closed = true) => {
        if (pointArray.length < 2) return;

        const curvePath = new THREE.CurvePath();
        for (let i = 0; i < pointArray.length - 1; i++) {
            curvePath.add(new THREE.LineCurve3(pointArray[i], pointArray[i + 1]));
        }
        if (closed && pointArray.length > 2) {
            curvePath.add(new THREE.LineCurve3(pointArray[pointArray.length - 1], pointArray[0]));
        }

        const curveGeometry = new THREE.TubeGeometry(curvePath, Math.max(pointArray.length, 16), 0.02, 8, false);
        const curveMesh = new THREE.Mesh(curveGeometry, curveMaterial);
        this.curveMesh = curveMesh;
        Editor.scene.add(curveMesh);
    }

    dispose = () => {
        disposeMesh(this.curveMesh);
        this.curveMesh = null;

        for (const mesh of this.tempMeshArray) {
            disposeMesh(mesh);
        }
        this.tempMeshArray = [];
    }
}

export default new PredictAbutment();
