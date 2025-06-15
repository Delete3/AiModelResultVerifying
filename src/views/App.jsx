import './App.scss';

import { useRef } from 'react';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import * as THREE from 'three';
import { Upload, Button } from 'antd';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import PredictDirection from '../utils/function/PredictDirection';

/**
 * @param {string} string 
 * @returns {string}
 */
const getFileExtension = (string) => {
  return string.slice((string.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
}

/**
 * @param {Blob} blob 
 * @param {string} fileFormat 
 * @returns {GeometryWithFileFormat}
 */
const parseGeometry = async (blob, fileFormat) => {
  /**@type {THREE.BufferGeometry} */
  let geometry = null;
  if (fileFormat == 'stl') geometry = new STLLoader().parse(await blob.arrayBuffer());
  else if (fileFormat == 'obj') {
    const group = new OBJLoader().parse(await blob.text());
    const mesh = group.children[0];
    geometry = mesh.geometry;
  }
  else if (fileFormat == 'ply') geometry = new PLYLoader().parse(await blob.arrayBuffer());
  else return;

  return geometry;
}

/**
 * @param {File} file 
 */
const loadModel = async file => {
  try {
    const fileExtension = getFileExtension(file.name);
    const buffrGeometry = await parseGeometry(file, fileExtension);

    const posLength = buffrGeometry.getAttribute('position').array.length;
    const colorArray = new Float32Array(posLength).fill(1);
    const colorAttribute = new THREE.BufferAttribute(colorArray, 3);
    buffrGeometry.setAttribute('color', colorAttribute);

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      side: THREE.DoubleSide,
      vertexColors: true,
    });

    const mesh = new THREE.Mesh(buffrGeometry, material);
    PredictDirection.addMesh(mesh);
  } catch (error) {
    console.log(error);
  }
};

function App() {
  const containerRef = useRef();

  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      const axisHelper = new THREE.AxesHelper(10);
      Editor.scene.add(axisHelper);
    };

    initial();
  }, []);

  return (
    <div className="container">
      <Upload
        customRequest={uploadRequestOption => loadModel(uploadRequestOption.file)}
        beforeUpload={(file) => file}
        showUploadList={false}
      >
        <Button>upload model</Button>
      </Upload>
      <Button
        onClick={() => PredictDirection.predictMesh()}
      >
        predict dirction
      </Button>
      <div ref={containerRef} className="editor" />
    </div>
  );
}

export default App;
