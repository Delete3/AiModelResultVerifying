import * as THREE from 'three';
import { ArcballControls as ThreeArcballControls } from 'three/addons/controls/ArcballControls.js';
import OrthographicCamera from './OrthographicCamera';
import Editor from '../../Editor';
import _ from 'lodash';

class ArcballControls extends ThreeArcballControls {
  /**
   * @param {HTMLElement} domElement
   */
  constructor(domElement) {
    const orthographicCamera = new OrthographicCamera(domElement);
    super(orthographicCamera, domElement, Editor.scene);

    /**@type {OrthographicCamera} */
    this.camera = orthographicCamera;
    this.scene.add(this.camera);

    this.setLight();
    this.enableAnimations = false;
    this.radiusFactor = 0.8;
    this.maxDistance = 500;
    this.maxZoom = 8;
    this.minZoom = 0.4;
    this.enablePan = true;
    this.target.set(0, 0, 0);
    this.camera.up.set(0, 0, 1);
    this.setGizmosVisible(true);
    this.unsetMouseAction(0);
    this.setMouseAction('PAN', 1);
    this.setMouseAction('ZOOM', 'WHEEL');
    this.setMouseAction('ROTATE', 2);
    this.update();
  }

  setLight = () => {
    const pointLight1 = new THREE.PointLight(0xffffff, 0.5, 0, 0);
    pointLight1.position.set(0, 5, 0);
    pointLight1.castShadow = true;

    const pointLight2 = new THREE.PointLight(0xffffff, 0.5, 0, 0);
    pointLight2.position.set(0, -5, 0);

    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);

    const cameraGroup = new THREE.Group();
    cameraGroup.name = 'cameraLight';
    cameraGroup.add(pointLight1, pointLight2, hemisphereLight);
    this.camera.add(cameraGroup);
  };

  onWindowResize = () => {
    this.camera.onWindowResize();
  };
}

export default ArcballControls;
