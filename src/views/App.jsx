import './App.scss';

import { useRef, useState, useReducer } from 'react';
import * as THREE from 'three';
import { Upload, Button, Input } from 'antd';
import axios from 'axios';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import PredictDirection from '../utils/function/PredictDirection';
import PredictMargin from '../utils/function/PredictMargin';
import { loadGeometry, loadMesh } from '../utils/loader/loadGeometry';
import { loadDirJson, loadMatrixJson } from '../utils/loader/loadDirJson';
import PredictAbutment from '../utils/function/view-control/predict-abutment/PredictAbutment';
import AdjustScanDir from '../utils/function/AdjustScanDir';

function App() {
  const containerRef = useRef();
  const [toothNumberStr, setToothNumberStr] = useState(null)
  const [, forceRerender] = useReducer(x => x + 1, 0);

  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      const axisHelper = new THREE.AxesHelper(10);
      Editor.scene.add(axisHelper);
      console.log(Editor)

      await AdjustScanDir.init();
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

  const renderAbutmentPredictFunc = () => {
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
      <Button
        className='function-button'
        onClick={() => PredictAbutment.callApi()}
      >
        predict margin from abutment
      </Button>
    </div>
  }

  const renderAdjustScanDirFunc = () => {
    return <div className='function-group'>
      <Button onClick={AdjustScanDir.pre}>
        pre
      </Button>
      <Button onClick={AdjustScanDir.next}>
        next
      </Button>
      <Button onClick={async () => {
        AdjustScanDir.save()
        await AdjustScanDir.next()
      }}>
        save & next
      </Button>
    </div>
  }

  return <div className="container">
    <div ref={containerRef} className="editor" />
    <div className='function-container'>
      {/* {renderDirPredictFunc()}
      {renderMarginPredictFunc()} */}
      {/* {renderAbutmentPredictFunc()} */}
      {renderAdjustScanDirFunc()}
    </div>
  </div>
}

export default App;
