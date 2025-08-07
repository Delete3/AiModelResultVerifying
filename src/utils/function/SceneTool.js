import * as THREE from 'three';

/**
 * @param {THREE.Mesh} mesh 
 * @param {boolean} resetColor 
 */
const prepareColorMesh = (mesh, resetColor = true) => {
    const geometry = mesh.geometry;

    if (!geometry.hasAttribute('color')) {
        const positionArray = geometry.getAttribute('position').array;
        const colorAttribute = new THREE.BufferAttribute(new Uint8Array(positionArray.length), 3, true);
        geometry.setAttribute('color', colorAttribute);
    }

    const colorAttribute = geometry.getAttribute('color');
    if (resetColor) {
        if (colorAttribute.array instanceof Uint8Array) colorAttribute.array.fill(255);
        else colorAttribute.array.fill(1);
    }
    colorAttribute.needsUpdate = true;

    if (!mesh.material.vertexColors) {
        mesh.material.vertexColors = true;
        mesh.material.needsUpdate = true;
    }
}

export { prepareColorMesh };