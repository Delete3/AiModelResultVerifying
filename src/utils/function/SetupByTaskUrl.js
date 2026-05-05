import axios from "axios";
import _ from 'lodash';

import { loadGeometry } from '../loader/loadGeometry.js';
import { onUploadFile } from "../../views/App.jsx";
import PredictAbutment from "./predict-abutment/PredictAbutment.js";

/**
 * 
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
            else if(fileName.includes('inputData.json')){
                console.log(fileName, ' ', fileData)
            }
            else if (fileName.includes('output.json')){
                // console.log(fileName, ' ', fileData)
                PredictAbutment.processResult(fileData);
            }
        }
    } catch (error) {
        console.log(error);
    }
}



export { setupByAbutTaskUrl };