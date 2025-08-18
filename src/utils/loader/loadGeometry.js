import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

import { getFileExtension } from '../tool/StringProcessing';

/**
 * @param {File} file 
 */
const loadGeometry = async file => {
    const fileFormat = getFileExtension(file.name);
    /**@type {THREE.BufferGeometry} */
    let geometry = null;
    if (fileFormat == 'stl') geometry = new STLLoader().parse(await file.arrayBuffer());
    // else if (fileFormat == 'obj') {
    //     const group = new OBJLoader().parse(await file   .text());
    //     const mesh = group.children[0];
    //     geometry = mesh.geometry;
    // }
    else if (fileFormat == 'ply') geometry = new PLYLoader().parse(await file.arrayBuffer());
    else return;

    geometry.computeVertexNormals();
    return geometry;
}

/**
 * @param {File} file 
 */
const loadMesh = async file => {
    try {
        const buffrGeometry = await loadGeometry(file);

        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(buffrGeometry, material);
        return mesh;
    } catch (error) {
        console.log(error);
    }
};

export { loadGeometry, loadMesh };