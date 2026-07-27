import axios from "axios";
import _ from 'lodash';
import * as THREE from 'three';

import { loadGeometry } from '../loader/loadGeometry.js';
import { onUploadFile } from "../../views/App.jsx";
import PredictAbutment from "./predict-abutment/PredictAbutment.js";
import PredictDirection from "./PredictDirection.js";
import Editor from "../Editor.js";

/**
 * @param {string} taskUrl http://localhost:3000/api/executable/airdesign/task/5c13dce6-a0c3-492d-bde9-422b406c0668
 */
const setupByAbutTaskUrl = async (taskUrl) => {
    // const taskUrl = 'http://localhost:3000/api/executable/airdesign/task/5c13dce6-a0c3-492d-bde9-422b406c0668'
    // const taskUrl = 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/e17a7401-d0af-4d7a-aa58-986c634899f9'
    const url = new URL(taskUrl);

    try {
        const taskDataRes = await axios.get(taskUrl);
        console.log(taskDataRes.data)

        /**
         * 
         * @param {boolean} isInput 
         * @param {string} fileId 
         * @param {string} fileName 
         */
        const getFile = async (isInput, fileId, fileName) => {
            const inputFileDataRes = await axios.get(`${url.origin}/api/executable/airdesign/file/task/${isInput ? 'input' : 'output'}/${fileId}`, {
                ...(fileName.includes('.stl') ? { responseType: 'arraybuffer' } : null)
            });
            return { isInput, fileData: inputFileDataRes.data, fileName };
        }

        const filePromiseArray = [];
        for (const inputFile of _.get(taskDataRes.data, 'inputFiles', []))
            filePromiseArray.push(getFile(true, _.get(inputFile, 'id', null), _.get(inputFile, 'name', null)));
        for (const outputFile of _.get(taskDataRes.data, 'outputFiles', []))
            filePromiseArray.push(getFile(false, _.get(outputFile, 'id', null), _.get(outputFile, 'name', null)));

        const fileInfoArray = await Promise.all(filePromiseArray);
        for (const fileInfo of fileInfoArray) {
            const { fileData, isInput, fileName } = fileInfo;

            if (fileName.includes('.stl')) {
                const file = new File([fileData], fileName);
                await onUploadFile(file);
            }
            else if (fileName.includes('inputData.json')) {
                console.log(fileName, ' ', fileData)
            }
            else if (fileName.includes('output.json')) {
                // console.log(fileName, ' ', fileData)
                PredictAbutment.processResult(fileData);
            }
        }
    } catch (error) {
        console.log(error);
    }
}

/**
 * @param {string} taskUrl http://localhost:3000/api/executable/airdesign/task/5c13dce6-a0c3-492d-bde9-422b406c0668
 */
const setupByDirectionTaskUrl = async (taskUrl) => {
    // taskUrl = 'http://localhost:3000/api/executable/airdesign/task/7d82962e-2c6f-4b95-a76d-8786909f8741'
    // taskUrl = 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/7d82962e-2c6f-4b95-a76d-8786909f8741'
    // taskUrl = 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/5c4b775b-5e50-4074-ad61-7528ef46d343'
    const url = new URL(taskUrl);

    try {
        const taskDataRes = await axios.get(taskUrl);
        console.log(taskDataRes.data)

        /**
         * 
         * @param {boolean} isInput 
         * @param {string} fileId 
         * @param {string} fileName 
         */
        const getFile = async (isInput, fileId, fileName) => {
            const inputFileDataRes = await axios.get(`${url.origin}/api/executable/airdesign/file/task/${isInput ? 'input' : 'output'}/${fileId}`, {
                ...(fileName.includes('.stl') ? { responseType: 'arraybuffer' } : null)
            });
            return { isInput, fileData: inputFileDataRes.data, fileName };
        }

        const filePromiseArray = [];
        for (const inputFile of _.get(taskDataRes.data, 'inputFiles', []))
            filePromiseArray.push(getFile(true, _.get(inputFile, 'id', null), _.get(inputFile, 'name', null)));
        for (const outputFile of _.get(taskDataRes.data, 'outputFiles', []))
            filePromiseArray.push(getFile(false, _.get(outputFile, 'id', null), _.get(outputFile, 'name', null)));

        let upperMesh, lowerMesh
        const fileInfoArray = await Promise.all(filePromiseArray);
        for (const fileInfo of fileInfoArray) {
            const { fileData, isInput, fileName } = fileInfo;

            if (fileName.includes('.stl')) {
                const file = new File([fileData], fileName);
                await onUploadFile(file);

                if (fileName == 'upper.stl') upperMesh = PredictDirection.mesh
                else lowerMesh = PredictDirection.mesh
            }
            else if (fileName.includes('inputData.json')) {
                console.log(fileName, ' ', fileData)
            }
            // else if (fileName.includes('output.json')) {
            else if (fileName.includes('combinedOutput.json')) {
                // console.log(fileName, ' ', fileData)
                // PredictDirection.processResult(fileData);

                upperMesh.applyQuaternion(new THREE.Quaternion(0.16996470093727112, 0.023742804303765297, 0.9851571917533875, 0.003685142612084746));
                lowerMesh.applyQuaternion(new THREE.Quaternion(0.013462147675454617, 0.10492822527885437, 0.9940822720527649, -0.0246844850480556))
                Editor.scene.add(upperMesh, lowerMesh)

                // const baseQuaternionRawData = fileData.quaternion;
                // const biteQuaternionRawData = {

                //     "x": 0.04413897171616554,
                //     "y": -0.010116918943822384,
                //     "z": 0.995209276676178,
                //     "w": -0.0866483524441719
                // }
                // const averQuaRawData = averageQuaternions(baseQuaternionRawData, biteQuaternionRawData);


                // const averQuaternion = new THREE.Quaternion(baseQuaternionRawData.x, baseQuaternionRawData.y, baseQuaternionRawData.z, averQuaRawData.w);
                // // const averQuaternion = new THREE.Quaternion(averQuaRawData.x, averQuaRawData.y, averQuaRawData.z, averQuaRawData.w);
                // PredictDirection.mesh.geometry.applyQuaternion(averQuaternion);
            }
        }
    } catch (error) {
        console.log(error);
    }
}

const averageQuaternions = (q1, q2) => {
    return {
        x: (q1.x + q2.x) / 2,
        y: (q1.y + q2.y) / 2,
        z: (q1.z + q2.z) / 2,
        w: (q1.w + q2.w) / 2,
    };
}

export { setupByAbutTaskUrl, setupByDirectionTaskUrl };