import './App.scss';

import { useRef, useState, useReducer } from 'react';
import * as THREE from 'three';
import { Upload, Button, Input, Spin } from 'antd';
import axios from 'axios';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import PredictDirection from '../utils/function/PredictDirection';
import PredictMargin from '../utils/function/PredictMargin';
import { loadGeometry, loadMesh } from '../utils/loader/loadGeometry';
import { loadDirJson, loadMatrixJson } from '../utils/loader/loadDirJson';
import PredictAbutment from '../utils/function/predict-abutment/PredictAbutment';

function App() {
  const containerRef = useRef();
  const [toothNumberStr, setToothNumberStr] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [, forceRerender] = useReducer(x => x + 1, 0);

  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      const axisHelper = new THREE.AxesHelper(10);
      Editor.scene.add(axisHelper);
      console.log(Editor)

      // await PredictAbutment.initFromPublic();
      // await PredictAbutment.callApi();
    };

    initial();
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

  const renderUploadModel = () => {
    return <div className='function-group'>
      <Upload
        customRequest={async uploadRequestOption => {
          const geometry = await loadGeometry(uploadRequestOption.file);
          const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.2,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(geometry, material);
          PredictAbutment.dispose();
          PredictDirection.mesh = mesh;
          PredictAbutment.mesh = mesh;
          Editor.scene.add(mesh);
        }}
        beforeUpload={(file) => file}
        showUploadList={false}
      >
        <Button>upload model</Button>
      </Upload>
      <Input
        className='function-button'
        value={PredictAbutment.toothFdi}
        onChange={e => {
          PredictAbutment.toothFdi = e.target.value;
          forceRerender();
        }}
        placeholder='input toothNumber'
      />
    </div>
  }

  const renderDirectionPredictFunc = () => {
    return <div className='function-group'>
      <Button
        className='function-button'
        onClick={() => PredictDirection.predictMesh(PredictAbutment.toothFdi > 28)}
      >
        predict dir
      </Button>
    </div>
  }

  const renderAbutmentPredictFunc = () => {
    return <div className='function-group'>
      <Button
        className='function-button'
        onClick={() => PredictAbutment.callApi()}
      >
        predict margin
      </Button>
    </div>
  }

  const renderDirAbuPredictFunc = () => {
    return <div className='function-group'>
      <Button
        className='function-button'
        onClick={async () => {
          setIsLoading(true)
          await PredictDirection.predictMesh()
          await PredictAbutment.callApi()
          setIsLoading(false)
        }}
      >
        predict dir and margin
      </Button>
    </div>
  }

  return (
    <div className="container">
        <Spin spinning={isLoading}>
        <div ref={containerRef} className="editor" />
        <div className='function-container'>
          {renderUploadModel()}
          {renderDirectionPredictFunc()}
          {renderAbutmentPredictFunc()}
          {renderDirAbuPredictFunc()}
        </div>
    </Spin>
      </div>
  )
}

export default App;
