import * as THREE from 'three';
import Editor from "../Editor"
import axios from "axios"
import _ from 'lodash';

import { loadGeometry } from "../loader/loadGeometry";
import { disposeMesh } from '../tool/SceneTool';
import { loadMatrixJson } from '../loader/loadDirJson';

const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    side: THREE.DoubleSide,
});
class CheckGroundTrue {
    constructor() {
        this.caseList = [];
        this.upperMesh = null;
        this.lowerMesh = null;
        this.dataIndex = 0;

        this.cameraState = {};
        this.initQua = new THREE.Quaternion()
        this.pid2Qua = {};
        console.log(this)
    }

    init = async () => {
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

        try {
            const filedataRes = await axios.get('/api/training-data/6000');
            this.caseList = _.get(filedataRes.data, 'cases', []);
        } catch (err) {
            console.log(err);
        }
    }

    initKeyboardListener = () => {
        window.addEventListener('keydown', async (event) => {
            if (event.key === 's' || event.key === 'S') {
                this.save();
                await this.loadNext();
            }
        });
    }

    setStateFromJSON = () => {
        const control = Editor.control;
        control.setStateFromJSON(this.cameraState);
    }

    loadNext = async (dataIndex = this.dataIndex) => {
        try {
            this.setStateFromJSON();

            const caseID = this.caseList[dataIndex];
            const upperRes = await axios.get(`/api/training-data/6000/${caseID}/upper.stl`, { responseType: 'arraybuffer' });
            const lowerRes = await axios.get(`/api/training-data/6000/${caseID}/lower.stl`, { responseType: 'arraybuffer' });
            const upperFile = new File([upperRes.data], 'upper.stl')
            const lowerFile = new File([lowerRes.data], 'lower.stl')
            const upperGeometry = await loadGeometry(upperFile)
            const lowerGeometry = await loadGeometry(lowerFile)
            const upperMesh = new THREE.Mesh(upperGeometry, material);
            const lowerMesh = new THREE.Mesh(lowerGeometry, material);
            disposeMesh(this.upperMesh);
            disposeMesh(this.lowerMesh);
            this.upperMesh = upperMesh;
            this.lowerMesh = lowerMesh;
            Editor.scene.add(upperMesh, lowerMesh);

            const matrixRes = await axios.get(`/api/training-data/6000/${caseID}/ai/upper_matrix_-Z_+Y.json`, { responseType: 'arraybuffer' });
            const matrixFile = new File([matrixRes.data], 'upper_matrix_-Z_+Y.json')
            const matrix = await loadMatrixJson(matrixFile)
            matrix.invert()
            console.log(matrix)

            this.upperMesh.applyMatrix4(matrix)
            this.lowerMesh.applyMatrix4(matrix)
        } catch (error) {
            console.log(error)
        } finally {
            this.dataIndex++;
        }
    }

    save = () => {
        const { initQua } = this;
        const currentQua = Editor.control.camera.quaternion;
        console.log(this.initQua)
        console.log(currentQua)
        const diffQua = initQua.clone().multiply(currentQua.clone().invert());

        console.log(this.upperMesh.quaternion.clone().toArray())
        this.upperMesh.applyQuaternion(diffQua);
        this.lowerMesh.applyQuaternion(diffQua);
        console.log(this.upperMesh.quaternion.clone().toArray())

        const pid = this.caseList[this.dataIndex];
        this.pid2Qua[pid] = diffQua.toArray();

        this.setStateFromJSON()
        console.log(this.pid2Qua)
    }
}

export default new CheckGroundTrue()