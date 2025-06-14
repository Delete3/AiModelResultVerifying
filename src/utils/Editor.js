import * as THREE from 'three';
import _ from 'lodash';
import ArcballControls from './function/view-control/ArcballControls';

class Editor {
  constructor() {
    /**@type {HTMLElement} */
    this.container = null;
    this.scene = null;
    this.renderer = null;
    this.control = null;
    /**@type {THREE.Mesh} */
    this.targetMesh = null;
  }

  setEditor = (container) => {
    const setLight = () => {
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);

      const sceneGroup = new THREE.Group();
      sceneGroup.name = 'sceneLight';
      sceneGroup.add(ambientLight);
      this.scene.add(sceneGroup);
    };

    this.container = container;
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf6ffed);
    this.control = new ArcballControls(this.container);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.autoClear = false;
    this.renderer.setSize(this.width, this.height);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.id = this.id;

    setLight();
    this.animate();
  };

  animate = () => {
    this.handleWindowResize();
    this.renderer.render(this.scene, this.control.camera);
    window.requestAnimationFrame(this.animate);
  };

  handleWindowResize = () => {
    const { clientWidth, clientHeight } = this.container;
    if (this.width == clientWidth && this.height == clientHeight) return;

    this.width = clientWidth;
    this.height = clientHeight;
    this.control.onWindowResize();
    this.renderer.setSize(this.width, this.height);
  };
}

export default new Editor();
