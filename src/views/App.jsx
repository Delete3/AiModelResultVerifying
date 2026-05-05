import './App.scss';

import { useRef, useState, useReducer } from 'react';
import * as THREE from 'three';
import { Upload, Button, Input, Spin, Divider, Select } from 'antd';
import axios from 'axios';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import PredictDirection from '../utils/function/PredictDirection';
import PredictMargin from '../utils/function/PredictMargin';
import { loadGeometry, loadMesh } from '../utils/loader/loadGeometry';
import { loadDirJson, loadMatrixJson } from '../utils/loader/loadDirJson';
import PredictAbutment from '../utils/function/predict-abutment/PredictAbutment';
import { disposeMesh } from '../utils/tool/SceneTool';
import { setupByAbutTaskUrl } from '../utils/function/SetupByTaskUrl';

/**
 * @param {File} file 
 */
const onUploadFile = async file => {
  if (PredictDirection.mesh) disposeMesh(PredictDirection.mesh);
  if (PredictAbutment.mesh) disposeMesh(PredictAbutment.mesh);
  PredictDirection.mesh = null;
  PredictAbutment.mesh = null;

  const geometry = await loadGeometry(file);
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
}

const taskDomainOption = [{
  value: 'http://localhost:3000/api/executable/airdesign/task/',
  label: 'http://localhost:3000/api/executable/airdesign/task/',
}, {
  value: 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/',
  label: 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/',
}];

function App() {
  const containerRef = useRef();
  const [, forceRerender] = useReducer(x => x + 1, 0);

  const [toothNumberStr, setToothNumberStr] = useState(null)
  const [isLoading, setIsLoading] = useState(false)

  const [taskDomain, setTaskDomain] = useState(taskDomainOption[1].value)
  const [taskId, setTaskId] = useState('');

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

  const onUploadAbutmentData = async uploadRequestOption => {
    /**@type {File} */
    const fileData = uploadRequestOption.file;
    const string = await fileData.text();
    const object = JSON.parse(string);
    PredictAbutment.processResult(object)

    console.log(object)
  }

  const renderUploadModel = () => {
    return <>
      <div className='function-group'>
        <Upload
          customRequest={async uploadRequestOption => await onUploadFile(uploadRequestOption.file)}
          beforeUpload={(file) => file}
          showUploadList={false}
        >
          <Button>upload model</Button>
        </Upload>
        <Upload
          customRequest={onUploadAbutmentData}
          beforeUpload={(file) => file}
          showUploadList={false}
        >
          <Button>import abutment data</Button>
        </Upload>
      </div>
      <div className='function-group'>
        <Input
          className='function-button'
          value={PredictAbutment.toothFdi}
          onChange={e => {
            PredictAbutment.toothFdi = e.target.value;
            forceRerender();
          }}
          placeholder='input FDI'
          onPressEnter={async () => {
            setIsLoading(true)
            await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30)
            await PredictAbutment.callApi(2)
            setIsLoading(false)
          }}
        />
      </div>
    </>
  }

  const renderDirectionPredictFunc = () => {
    return <>
      <div className='function-group'>
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30)
            await PredictAbutment.callApi()
            setIsLoading(false)
          }}
        >
          predict dir and margin
        </Button>
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30)
            await PredictAbutment.callApi(2)
            setIsLoading(false)
          }}
        >
          predict dir and margin 2
        </Button>
      </div>
      <div className='function-group'>
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await PredictDirection.predictMesh(true)
            setIsLoading(false)
          }}
        >
          predict upper dir
        </Button>
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await PredictDirection.predictMesh(false)
            setIsLoading(false)
          }}
        >
          predict lower dir
        </Button>
      </div>
    </>
  }

  const renderAbutmentPredictFunc = () => {
    return <div className='function-group'>
      <Button
        className='function-button'
        onClick={async () => {
          setIsLoading(true)
          await PredictAbutment.callApi()
          setIsLoading(false)
        }}
      >
        predict margin
      </Button>
      <Button
        className='function-button'
        onClick={async () => {
          setIsLoading(true)
          await PredictAbutment.callApi(2)
          setIsLoading(false)
        }}
      >
        predict margin 2
      </Button>
    </div>
  }

  const renderTaskIdInput = () => {
    return <>
      <div className='function-group'>
        <Select
          // className='function-button'
          value={taskDomain}
          options={taskDomainOption}
          onChange={value => setTaskDomain(value)}
        />
      </div>
      <div className='function-group'>
        <Input
          className='function-button'
          value={taskId}
          onChange={e => setTaskId(e.target.value)}
          placeholder='input abut taskId'
          onPressEnter={async () => {
            setIsLoading(true)
            await setupByAbutTaskUrl(taskDomain + taskId);
            setIsLoading(false)
          }}
        />
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await setupByAbutTaskUrl(taskDomain + taskId);
            setIsLoading(false)
          }}
        >
          setupByAbutTaskUrl
        </Button>
      </div>
    </>
  }

  return (
    <div className="container">
      <Spin spinning={isLoading}>
        <div ref={containerRef} className="editor" />
        <div className='function-container'>
          {renderUploadModel()}
          <Divider style={{ pointerEvents: 'none' }} />
          {renderDirectionPredictFunc()}
          {renderAbutmentPredictFunc()}
          <Divider style={{ pointerEvents: 'none' }} />
          {renderTaskIdInput()}
        </div>
      </Spin>
    </div>
  )
}

export default App;
export { onUploadFile }
