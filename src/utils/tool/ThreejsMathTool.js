import * as THREE from 'three';
import Editor from '../Editor';

/**
 * 
 * @param {THREE.Material | THREE.Material[]} material 
 */
const disposeMaterial = material => {
    if (!material) return;

    material.length == undefined ?
        material.dispose() :
        material.forEach(m => m.dispose());
}

/**
 * @param {THREE.Mesh} mesh 
 * @param {object} options
 * @param {boolean} [options.removeFromScene=true] 是否從場景中移除該mesh
 * @param {*} [options.editor] 
 */
const disposeMesh = (mesh, options) => {
    if (!mesh) return;

    options = Object.assign({
        removeFromScene: true,
        editor: Editor,
    }, options);

    if (mesh?.geometry?.isBufferGeometry) mesh.geometry.dispose();
    disposeMaterial(mesh.material);
    if (options.removeFromScene) options.editor.scene.remove(mesh);
}

/**
 * 釋放場景中符合名稱的物件
 * @param {string} name 
 * @param {THREE.Scene | THREE.Camera} parent scene|camera
 */
const disposeObjectsByName = (name, parent = Editor.scene) => {
    if (!name) return;

    const meshs = parent.children.filter(mesh => mesh.name === name);
    for (const mesh of meshs) {
        parent.remove(mesh);
        disposeMesh(mesh);
    }
}

/**
 * 計算滑鼠位置，以canvas中心為原點，區分四個象限，座標值介於 0-1 之間
 * @param {MouseEvent} mouseEvent
 * @param {HTMLElement} container
 * @returns {THREE.Vector2}
 */
const getMouseCartesianPosition = (mouseEvent, container) => {
  const { clientX, clientY } = mouseEvent;
  const { top, bottom, left, right } = container.getBoundingClientRect();

  const position = new THREE.Vector2();
  position.x = ((clientX - left) / (right - left)) * 2 - 1;
  position.y = -((clientY - top) / (bottom - top)) * 2 + 1;

  return position;
};

/**
 * 在場景中畫箭頭，能確保不在場景中畫出名稱重複的箭頭
 * @param {THREE.Vector3} dir 箭頭方向
 * @param {THREE.Vector3} origin 箭頭起點
 * @param {THREE.ColorRepresentation} color 箭頭顏色
 * @param {string} name 箭頭網格名稱
 */
const drawArrow = (dir, origin, color = 0xff0000, name = 'drawArrowTest') => {
    disposeObjectsByName(name);

    const arrowHelper = new THREE.ArrowHelper(dir.clone().normalize(), origin, dir.length(), color);
    arrowHelper.name = name;
    Editor.scene.add(arrowHelper);
    return arrowHelper;
}

/**
 * 在場景中畫球，能確保不在場景中畫出名稱重複的球
 * @param {THREE.Vector3} position 球中心點位置
 * @param {THREE.ColorRepresentation} color 
 * @param {string} name 
 * @param {number} radius 
 */
const drawSphere = (position = new THREE.Vector3(), color = 0xff0000, name = 'drawSphereTest', radius = 0.3) => {
    disposeObjectsByName(name);

    const sphereGeometry = new THREE.SphereGeometry(radius, 30, 30);
    const sphereMaterial = new THREE.PointsMaterial({ color });
    const sphereMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphereMesh.position.copy(position)
    sphereMesh.name = name;

    Editor.scene.add(sphereMesh);
    return sphereMesh;
}

export { 
  getMouseCartesianPosition,
  drawArrow,
  drawSphere,
 };
