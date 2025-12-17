import * as THREE from 'three';

import { caseList, finishCase, exportedCase } from './CaseList';
import Editor from '../Editor';
import axios from 'axios';
import { loadGeometry } from '../loader/loadGeometry';
import { disposeMesh } from '../tool/SceneTool';

class AdjustScanDir {
    constructor() {
        this.index = -1;
        this.upperMaterial = new THREE.MeshStandardMaterial({
            color: 0xffdddd,
            roughness: 0.2,
            side: THREE.DoubleSide,
        });
        this.lowerMaterial = new THREE.MeshStandardMaterial({
            color: 0xddffdd,
            roughness: 0.2,
            side: THREE.DoubleSide,
        });
        this.upperMesh = null;
        this.lowerMesh = null;
        this.cameraState = {};
        this.initQua = new THREE.Quaternion()
        this.pid2Qua = {};
        console.log(this)

        this.initKeyboardListener();
    }

    initKeyboardListener = () => {
        window.addEventListener('keydown', async (event) => {
            if (event.key === 's' || event.key === 'S') {
                this.save();
                await this.next();
            }
        });
    }

    loadModel = async (folderPath, isUpper, format = 'stl') => {
        const modelPath = `${folderPath}/${isUpper ? 'upper' : 'lower'}.${format}`;
        console.log(modelPath)
        const modelRes = await axios.get(modelPath, { responseType: 'blob' });

        if (format == 'stl' && modelRes.data.type == 'text/html') return await this.loadModel(folderPath, isUpper, 'ply');
        if (modelRes.data.type == 'text/html') return null;

        const modelFile = modelRes.data;
        modelFile.name = `${isUpper ? 'upper' : 'lower'}.${format}`;
        const geometry = await loadGeometry(modelFile);
        return geometry;
    }

    loadCase = async () => {
        const folderPath = `./data/${caseList[this.index]}`;

        const upperGeo = await this.loadModel(folderPath, true);
        const lowerGeo = await this.loadModel(folderPath, false);
        const upperMesh = new THREE.Mesh(upperGeo, this.upperMaterial);
        const lowerMesh = new THREE.Mesh(lowerGeo, this.lowerMaterial);
        disposeMesh(this.upperMesh);
        disposeMesh(this.lowerMesh);
        this.upperMesh = upperMesh;
        this.lowerMesh = lowerMesh;
        Editor.scene.add(upperMesh, lowerMesh);

        const quaRawData = finishCase[caseList[this.index]]
        if (quaRawData) {
            const qua = new THREE.Quaternion().fromArray(quaRawData);
            upperMesh.applyQuaternion(qua);
            lowerMesh.applyQuaternion(qua);
        }
    }

    init = async () => {
        console.log('in')

        const control = Editor.control;
        this.cameraState = JSON.stringify({
            arcballState: {
                cameraFar: control.camera.far,
                cameraMatrix: control.camera.matrix,
                cameraNear: control.camera.near,
                cameraUp: control.camera.up,
                cameraZoom: control.camera.zoom,
                gizmoMatrix: control._gizmos.matrix
            }
        });
        this.initQua.setFromRotationMatrix(control.camera.matrix);

        this.index++;
        while (finishCase[caseList[this.index]] !== undefined || exportedCase[caseList[this.index]] !== undefined) {
            this.index++
        }
        await this.loadCase();
    }

    setStateFromJSON = () => {
        const control = Editor.control;
        control.setStateFromJSON(this.cameraState);
    }

    next = async () => {
        this.index++;
        await this.loadCase();
    }

    pre = async () => {
        this.index--;
        await this.loadCase();
    }

    save = () => {
        const { initQua } = this;
        const currentQua = Editor.control.camera.quaternion;
        console.log(this.initQua)
        console.log(currentQua)
        const diffQua = initQua.clone().multiply(currentQua.clone().invert());

        this.upperMesh.applyQuaternion(diffQua);
        this.lowerMesh.applyQuaternion(diffQua);

        const pid = caseList[this.index];
        this.pid2Qua[pid] = diffQua.toArray();

        this.setStateFromJSON()
        console.log(this.pid2Qua)
    }
}

export default new AdjustScanDir();