import * as THREE from 'three';
import Editor from "../Editor"
import axios from "axios"
import _ from 'lodash';

import { loadGeometry } from "../loader/loadGeometry";
import { disposeMesh } from '../tool/SceneTool';
import { loadMatrixJson } from '../loader/loadDirJson';
import PredictDirection from './PredictDirection';
import PredictAbutment from './predict-abutment/PredictAbutment';

const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    side: THREE.DoubleSide,
});

class CheckAIMarginResult {
    constructor() {
        this.pid2MarginPointArrayGT = {};
        this.pid2MarginPointArrayV1 = {};
        this.pid2MarginPointArrayV2 = {};
        console.log(this)
    }

    init = async () => {
        // const filedataRes = await axios.get('/api/training-data/6000');
        // console.log(_.get(filedataRes.data, 'cases', []))
        // console.log(caseList)
        // return
        console.time('test')
        try {
            // public/ is copied verbatim rather than bundled, and it is git-ignored, so the
            // case list exists only on checkouts that happen to carry it. Importing it
            // statically took the whole app down on the ones that do not. Loading it by URL
            // at the moment it is needed leaves the failure inside this panel.
            // The specifier goes through a variable on purpose: given a literal, Vite
            // resolves it at transform time and fails the module again, @vite-ignore or not.
            const caseListUrl = '/caseList.js'
            const { caseList } = await import(/* @vite-ignore */ caseListUrl)

            // for (let i = 0; i < 3; i++) {
            for (let i = 0; i < 100; i++) {
                // await this.predictMarginProcess_v1(caseList[i]);
                await this.predictMarginProcess_v2(caseList[i]);
                // await this.getGTMargin(caseList[i]);

                // console.log(this.pid2MarginPointArrayV1)
                console.log(this.pid2MarginPointArrayV2)
                // console.log(this.pid2MarginPointArrayGT)
            }
        } catch (err) {
            console.log(err);
        } finally {
            console.timeEnd('test')
        }
    }

    getGTMargin = async (caseID) => {
        try {
            const res = await axios.get(`/api/training-data/6000/${caseID}/abutmentPoints`);
            const filename = _.get(res.data, 'entries.0.name', '');
            const toothFdi = Number(filename.split(/[\.\_]/)[1]);
            if (isNaN(toothFdi)) return;

            const isUpper = toothFdi < 30;
            const baseRes = await axios.get(`/api/training-data/6000/${caseID}/${isUpper ? 'upper' : 'lower'}.stl`, { responseType: 'arraybuffer' });
            const baseFile = new File([baseRes.data], 'upper.stl');
            const baseGeo = await loadGeometry(baseFile);
            const baseMesh = new THREE.Mesh(baseGeo, material);

            PredictDirection.setMesh(baseMesh);
            if (PredictAbutment.mesh) {
                disposeMesh(PredictAbutment.mesh);
                PredictAbutment.mesh = null;
            }
            PredictAbutment.dispose();

            const gtDirRes = await axios.get(`/api/training-data/6000/${caseID}/ai`);
            const ptsFileInfo = _.get(gtDirRes.data, 'entries', []).find(fileInfo => fileInfo.name.includes('.pts'));

            const ptsFileRes = await axios.get(`/api/training-data/6000/${caseID}/ai/${ptsFileInfo.name}`);
            /**@type {string[]} */
            const marginTextArray = ptsFileRes.data.split('\n');
            const marginPoints = marginTextArray.map(lineText => {
                const vectorText = lineText.split(' ');
                if (vectorText.length != 3) return null;
                return new THREE.Vector3(Number(vectorText[0]), Number(vectorText[1]), Number(vectorText[2]));
            }).filter(vector => !!vector);
            PredictAbutment.showMarginLine(marginPoints);

            this.pid2MarginPointArrayGT[caseID] = marginPoints.map(point => point.clone());
        } catch (error) {
            console.log(error);
        }
    }

    predictMarginProcess_v1 = async (caseID) => {
        try {
            const res = await axios.get(`/api/training-data/6000/${caseID}/abutmentPoints`);
            const filename = _.get(res.data, 'entries.0.name', '');
            const toothFdi = Number(filename.split(/[\.\_]/)[1]);
            if (isNaN(toothFdi)) return;

            const isUpper = toothFdi < 30;
            const baseRes = await axios.get(`/api/training-data/6000/${caseID}/${isUpper ? 'upper' : 'lower'}.stl`, { responseType: 'arraybuffer' });
            const baseFile = new File([baseRes.data], 'upper.stl');
            const baseGeo = await loadGeometry(baseFile);
            const baseMesh = new THREE.Mesh(baseGeo, material);

            PredictDirection.setMesh(baseMesh);
            if (PredictAbutment.mesh) {
                disposeMesh(PredictAbutment.mesh);
                PredictAbutment.mesh = null;
            }
            PredictAbutment.dispose();

            const quaternion = await PredictDirection.predictMesh(isUpper);
            PredictAbutment.mesh = baseMesh;
            PredictAbutment.toothFdi = toothFdi;
            const marginPointArray = await PredictAbutment.callApi(2);

            const quaternionInvert = quaternion.invert();
            // baseMesh.geometry.applyQuaternion(quaternionInvert);
            for (const point of marginPointArray) {
                point.applyQuaternion(quaternionInvert);
            }
            this.pid2MarginPointArrayV1[caseID] = marginPointArray.map(point => point.clone());
        } catch (error) {
            console.log(error)
        }
    }

    predictMarginProcess_v2 = async (caseID) => {
        try {
            const res = await axios.get(`/api/training-data/6000/${caseID}/abutmentPoints`);
            const filename = _.get(res.data, 'entries.0.name', '');
            const toothFdi = Number(filename.split(/[\.\_]/)[1]);
            if (isNaN(toothFdi)) return;

            const isUpper = toothFdi < 30;
            const baseRes = await axios.get(`/api/training-data/6000/${caseID}/${isUpper ? 'upper' : 'lower'}.stl`, { responseType: 'arraybuffer' });
            const baseFile = new File([baseRes.data], 'upper.stl');
            const baseGeo = await loadGeometry(baseFile);
            const baseMesh = new THREE.Mesh(baseGeo, material);

            PredictDirection.setMesh(baseMesh);
            if (PredictAbutment.mesh) {
                disposeMesh(PredictAbutment.mesh);
                PredictAbutment.mesh = null;
            }
            PredictAbutment.dispose();

            const quaternion = await PredictDirection.predictMesh(isUpper);
            PredictAbutment.mesh = baseMesh;
            PredictAbutment.toothFdi = toothFdi;
            const marginPointArray = await PredictAbutment.callApi_2();

            const quaternionInvert = quaternion.invert();
            // baseMesh.geometry.applyQuaternion(quaternionInvert);
            for (const point of marginPointArray) {
                point.applyQuaternion(quaternionInvert);
            }

            this.pid2MarginPointArrayV2[caseID] = marginPointArray.map(point => point.clone());
        } catch (error) {
            console.log(error)
        }
    }
}

export default new CheckAIMarginResult()