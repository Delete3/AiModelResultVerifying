import './App.scss';

import { useRef } from 'react';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import * as THREE from 'three';
import { Upload, Button } from 'antd';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import PredictDirection from '../utils/function/PredictDirection';

function App() {
  const containerRef = useRef();

  /**
   * @param {File} file 
   */
  const loadModel = async file => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffrGeometry = new STLLoader().parse(arrayBuffer);

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
