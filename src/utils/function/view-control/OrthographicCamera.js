import * as THREE from 'three';

class OrthographicCamera extends THREE.OrthographicCamera {
  constructor(container) {
    super();
    this.container = container;
    this.name = 'camera';
    this.defaultCameraDistance = 195;
    this.defaultFov = 25;

    this.position.set(0, -this.defaultCameraDistance, 0);
    this.near = 1;
    this.far = 2000;
    this.onWindowResize();
  }

  onWindowResize = () => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    const halfFovV = THREE.MathUtils.DEG2RAD * this.defaultFov * 0.5;
    const halfFovH = Math.atan((width / height) * Math.tan(halfFovV));
    const halfW = this.defaultCameraDistance * Math.tan(halfFovH);
    const halfH = this.defaultCameraDistance * Math.tan(halfFovV);
    this.left = -halfW;
    this.right = halfW;
    this.top = halfH;
    this.bottom = -halfH;
    this.updateProjectionMatrix();
  };
}

export default OrthographicCamera;
