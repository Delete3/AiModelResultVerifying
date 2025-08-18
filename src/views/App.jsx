import './App.scss';

import { useRef, useState } from 'react';
import * as THREE from 'three';
import { Upload, Button, Input } from 'antd';
import axios from 'axios';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import PredictDirection from '../utils/function/PredictDirection';
import PredictMargin from '../utils/function/PredictMargin';
import { loadGeometry, loadMesh } from '../utils/loader/loadGeometry';
import { loadDirJson, loadMatrixJson } from '../utils/loader/loadDirJson';
import PredictAbutment from '../utils/function/PredictAbutment';

function App() {
  const containerRef = useRef();
  const [toothNumberStr, setToothNumberStr] = useState(null)

  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      const axisHelper = new THREE.AxesHelper(10);
      Editor.scene.add(axisHelper);
    };

    initial();
    PredictAbutment.initFromPublic();
    console.log(Editor)
  }, []);

  const renderDirPredictFunc = () => {
    return <div className='function-group'>
      <Upload
        customRequest={uploadRequestOption => {
          const geometry = loadGeometry(uploadRequestOption.file);
          const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(geometry, material);
          PredictDirection.addMesh(mesh);
        }}
        beforeUpload={(file) => file}
        showUploadList={false}
      >
        <Button>upload model</Button>
      </Upload>
      <Button
        className='function-button'
        onClick={() => PredictDirection.predictMesh()}
      >
        predict upper direction
      </Button>
      <Button
        className='function-button'
        onClick={() => PredictDirection.predictMesh(false)}
      >
        predict lower direction
      </Button>
    </div>
  }

  const renderMarginPredictFunc = () => {
    return <div className='function-group'>
      <Upload
        customRequest={uploadRequestOption => {
          const geometry = loadGeometry(uploadRequestOption.file);
          const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(geometry, material);
          PredictMargin.addMesh(mesh);
        }}
        beforeUpload={(file) => file}
        showUploadList={false}
      >
        <Button>upload model</Button>
      </Upload>
      <Input
        className='function-button'
        value={toothNumberStr}
        onChange={e => setToothNumberStr(e.target.value)}
        placeholder='input toothNumber'
      />
      <Button
        className='function-button'
        onClick={() => PredictMargin.predictMesh(toothNumberStr)}
      >
        predict margin
      </Button>
    </div>
  }

  const renderAbutmentPredictFunc = () => {
    return <div className='function-group'>
      {/* <Upload
        customRequest={uploadRequestOption => {
          const geometry = loadGeometry(uploadRequestOption.file);
          const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(geometry, material);
          PredictMargin.addMesh(mesh);
        }}
        beforeUpload={(file) => file}
        showUploadList={false}
      >
        <Button>upload model</Button>
      </Upload>
      <Input
        className='function-button'
        value={toothNumberStr}
        onChange={e => setToothNumberStr(e.target.value)}
        placeholder='input toothNumber'
      /> */}
      <Button
        className='function-button'
        onClick={() => PredictAbutment.callApi()}
      >
        predict margin from abutment
      </Button>
    </div>
  }

  return <div className="container">
    <div ref={containerRef} className="editor" />
    <div className='function-container'>
      {renderDirPredictFunc()}
      {renderMarginPredictFunc()}
      {renderAbutmentPredictFunc()}
    </div>
  </div>
}

export default App;
