import * as THREE from 'three';

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

export { getMouseCartesianPosition };
