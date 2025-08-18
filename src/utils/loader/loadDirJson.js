import * as THREE from 'three';

/**
 * @param {File} file 
 */
const loadMatrixJson = async file => {
    const dirText = await file.text();
    const matrixArrayData = JSON.parse(dirText);
    const matrix = new THREE.Matrix4()
    matrix.fromArray(matrixArrayData.flat());
    return matrix;
}

/**
 * @param {File} file 
*/
const loadDirJson = async file => {
    const matrix = await loadMatrixJson(file);

    /**@type {string} */
    const filename = file.name;
    const isLower = filename.split('_')[2].includes('+');

    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
    const dirVector = new THREE.Vector3(0, 0, isLower ? 1 : -1);
    return dirVector.applyQuaternion(quaternion);
}

export { loadMatrixJson, loadDirJson };