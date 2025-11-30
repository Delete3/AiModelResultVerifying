import * as THREE from 'three';
import Editor from '../Editor';

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
 * @param {THREE.Material | THREE.Material[]} material 
 */
const disposeMaterial = material => {
    if (!material) return;

    material.length == undefined ?
        material.dispose() :
        material.forEach(m => m.dispose());
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

/**
 * 在場景中畫立方體，能確保不在場景中畫出名稱重複的立方體
 * @param {THREE.Box3} box 
 * @param {THREE.ColorRepresentation} color 
 * @param {string} name 
 */
const drawBox = (box = new THREE.Box3(), color = 0xff0000, name = 'drawBoxTest') => {
    disposeObjectsByName(name);

    const boxHelper = new THREE.Box3Helper(box, color);
    boxHelper.name = name;

    Editor.scene.add(boxHelper);
    return boxHelper;
}

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
 * 在場景中畫自定義geometry，能確保在場景中名稱不重複
 * @param {THREE.BufferGeometry} geometry 
 * @param {THREE.ColorRepresentation} color 
 * @param {string} name 
 */
const drawCustomGeometry = (geometry, color = 0xff0000, name = 'drawGeometryTesh') => {
    disposeObjectsByName(name);

    const material = new THREE.MeshPhongMaterial({ color: color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;

    Editor.scene.add(mesh);
}

/**
 * 在場景中畫平面，能確保不在場景中畫出名稱重複的平面
 * @param {THREE.Plane} plane 
 * @param {THREE.ColorRepresentation} color 
 * @param {string} name 
 */
const drawPlane = (plane = new THREE.Plane(), color = 0xff0000, name = 'drawPlaneTest') => {
    disposeObjectsByName(name);

    const planeHelper = new THREE.PlaneHelper(plane, 100, color);
    planeHelper.name = name;

    Editor.scene.add(planeHelper);
}

const drawPoint = (point = new THREE.Vector3(), size = 0.1, color = 0xff0000, name = 'drawPointTest') => {
    disposeObjectsByName(name);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([point.x, point.y, point.z], 3));
    const material = new THREE.PointsMaterial({ size: size, color: color });
    const mesh = new THREE.Points(geometry, material);
    mesh.name = name;
    Editor.scene.add(mesh);
    return mesh;
}

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

export {
    disposeMesh,
    drawSphere,
    drawBox,
    drawArrow,
    drawCustomGeometry,
    drawPlane,
    drawPoint,
    prepareColorMesh,
}