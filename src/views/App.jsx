import './App.scss';

import { useReducer, useRef } from 'react';
import axios from 'axios';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
  MeshBVH,
} from 'three-mesh-bvh';

import Editor from '../utils/Editor';
import MeshDiffusion from '../utils/function/mesh-diffusion/MeshDiffusion';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

function App() {
  const containerRef = useRef();
  const [, forceRerender] = useReducer((x) => x + 1, 0);

  const loadModel = async () => {
    try {
      const res = await axios.get('./Easterfrog.stl', {
        responseType: 'arraybuffer',
      });

      const buffrGeometry = new STLLoader().parse(res.data);

      const posLength = buffrGeometry.getAttribute('position').array.length;
      const colorArray = new Float32Array(posLength).fill(1);
      const colorAttribute = new THREE.BufferAttribute(colorArray, 3);
      buffrGeometry.setAttribute('color', colorAttribute);

      buffrGeometry.boundsTree = new MeshBVH(buffrGeometry);

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.2,
        side: THREE.DoubleSide,
        vertexColors: true,
      });

      const mesh = new THREE.Mesh(buffrGeometry, material);

      Editor.targetMesh = mesh;
      Editor.scene.add(mesh);
    } catch (error) {
      console.log(error);
    }
  };

  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      await loadModel();
      MeshDiffusion.isEnable = true;
    };

    initial();
  }, []);

  return (
    <div className="container">
      <button
        onClick={() => {
          MeshDiffusion.onReset();
          forceRerender();
        }}
      >
        reset
      </button>
      <button
        onClick={() => {
          MeshDiffusion.isDrawBoundary = !MeshDiffusion.isDrawBoundary;
          forceRerender();
        }}
      >
        {MeshDiffusion.isDrawBoundary ? 'draw boundary' : 'select point'}
      </button>
      <div ref={containerRef} className="editor" />
    </div>
  );
}

export default App;
