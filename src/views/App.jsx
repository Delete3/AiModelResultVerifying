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
import { setupByAbutTaskUrl, setupByDirectionTaskUrl } from '../utils/function/SetupByTaskUrl';
import CheckGroundTrue from '../utils/function/CheckGroundTrue';
import CheckAIMarginResult from '../utils/function/CheckAIMarginResult';
import { computeMarginAccuracy } from '../utils/tool/MarginAccuracy';

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
  console.log(mesh)
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

  const tempTest = async () => {
    return;

    const marginGTRes = await axios.get('./marginGT.json');
    // const oldMarginRes = await axios.get('./oldMarginResult.json');
    // const oldMarginRes = await axios.get('./newMarginResult.json');
    const oldMarginRes = await axios.get('./newMarginResult4_256.json');
    // const newMarginRes = await axios.get('./newMarginResult3.json');
    const newMarginRes = await axios.get('./newMarginResult4_opt_in.json');

    const marginGT = marginGTRes.data;
    const oldMargin = oldMarginRes.data;
    const newMargin = newMarginRes.data;
    // console.log(marginGT)
    // console.log(newMargin)
    // console.log(oldMargin)

    const newResults = [];
    const oldResults = [];

    let i = 0;
    for (const pid of Object.keys(newMargin)) {
      if (i >= 100) break
      const gtPointArray = marginGT[pid];
      const oldPointArray = oldMargin[pid];
      const newPointArray = newMargin[pid];
      if (!gtPointArray?.length || !newPointArray?.length || !oldPointArray?.length) continue;

      const oldAcc = computeMarginAccuracy(oldPointArray, gtPointArray);
      const newAcc = computeMarginAccuracy(newPointArray, gtPointArray);

      if (oldAcc) oldResults.push(oldAcc);
      if (newAcc) newResults.push(newAcc);
      i++
    }

    const avg = (arr, key) => arr.reduce((s, r) => s + r[key], 0) / arr.length;

    console.group('=== Margin Accuracy Summary ===');
    console.log(`Cases evaluated: ${i}`);
    console.group('New Model');
    console.log(`Mean Dist   : ${avg(newResults, 'meanDist').toFixed(4)} mm (symmetric)`);
    console.log(`RMS Dist    : ${avg(newResults, 'rmsDist').toFixed(4)} mm (symmetric)`);
    console.log(`P95 Dist    : ${avg(newResults, 'p95Dist').toFixed(4)} mm (robust)`);
    console.log(`Hausdorff   : ${avg(newResults, 'hausdorffDist').toFixed(4)} mm (avg)`);
    console.groupEnd();
    console.group('Old Model');
    console.log(`Mean Dist   : ${avg(oldResults, 'meanDist').toFixed(4)} mm (symmetric)`);
    console.log(`RMS Dist    : ${avg(oldResults, 'rmsDist').toFixed(4)} mm (symmetric)`);
    console.log(`P95 Dist    : ${avg(oldResults, 'p95Dist').toFixed(4)} mm (robust)`);
    console.log(`Hausdorff   : ${avg(oldResults, 'hausdorffDist').toFixed(4)} mm (avg)`);
    console.groupEnd();
    console.groupEnd();
  }


  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      const axisHelper = new THREE.AxesHelper(10);
      Editor.scene.add(axisHelper);
      console.log(Editor)

      // await PredictAbutment.initFromPublic();
      // await PredictAbutment.callApi();
      await CheckGroundTrue.init();
    };

    initial();
    tempTest()
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
        <Select
          className='function-button'
          value={PredictAbutment.modelApi}
          onChange={value => {
            PredictAbutment.modelApi = value;
            forceRerender();
          }}
          options={[
            { value: 'current', label: 'AI: v5+v6 現行' },
            { value: 'v8', label: 'AI: v8 多類別' },
          ]}
        />
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
            await PredictAbutment.callApi_2()
            setIsLoading(false)
          }}
        />
      </div>

      <div className='function-group'>
        <Input
          className='function-button'
          value={PredictAbutment.allToothFdi}
          onChange={e => {
            PredictAbutment.allToothFdi = e.target.value;
            forceRerender();
          }}
          placeholder='input All FDI'
          onPressEnter={async () => {
            const fdiStrArray = PredictAbutment.allToothFdi.split(',');
            if (!fdiStrArray[0]) return;
            
            setIsLoading(true)
            await PredictDirection.predictMesh(fdiStrArray[0] < 30)
            await PredictAbutment.callApi_2()
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
          predict dir and margin 1
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
          predict dir and margin 1_2
        </Button>
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30)
            await PredictAbutment.callApi_2()
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
        predict margin 1
      </Button>
      <Button
        className='function-button'
        onClick={async () => {
          setIsLoading(true)
          await PredictAbutment.callApi(2)
          setIsLoading(false)
        }}
      >
        predict margin 1_2
      </Button>
      <Button
        className='function-button'
        onClick={async () => {
          setIsLoading(true)
          await PredictAbutment.callApi_2()
          setIsLoading(false)
        }}
      >
        predict margin 2
      </Button>
      <Button
        className='function-button'
        onClick={async () => {
          setIsLoading(true)
          await PredictAbutment.callApi_checkNPZ()
          setIsLoading(false)
        }}
      >
        predict margin 2_checkNPZ
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
        <Button
          className='function-button'
          onClick={async () => {
            setIsLoading(true)
            await setupByDirectionTaskUrl(taskDomain + taskId);
            setIsLoading(false)
          }}
        >
          setupByDirTaskUrl
        </Button>
      </div>
    </>
  }

  const renderCheckGroundTrue = () => {
    return <div className='function-group'>
      <Input
        className='function-button'
        value={CheckGroundTrue.dataIndex}
        onChange={e => {
          CheckGroundTrue.dataIndex = Number(e.target.value);
          console.log(CheckGroundTrue.dataIndex)
          forceRerender();
        }}
        onPressEnter={async () => {
          await CheckGroundTrue.loadNext();
          forceRerender();
        }}
      />
      <Button
        className='function-button'
        onClick={async () => {
          await CheckGroundTrue.loadNext();
          forceRerender();
        }}
      >
        next
      </Button>
      <Button
        className='function-button'
        onClick={async () => {
          await CheckGroundTrue.save();
        }}
      >
        save
      </Button>
    </div>
  }

  const renderCheckAIMarginResult = () => {
    return <div className='function-group'>
      <Button
        className='function-button'
        onClick={async () => {
          await CheckAIMarginResult.init();
        }}
      >
        checkAIMarginResult
      </Button>
    </div>
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
          <Divider style={{ pointerEvents: 'none' }} />
          {renderCheckGroundTrue()}
          {renderCheckAIMarginResult()}
        </div>
      </Spin>
    </div>
  )
}

export default App;
export { onUploadFile }
