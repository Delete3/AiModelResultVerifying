import './App.scss';

import { useRef, useState, useReducer } from 'react';
import * as THREE from 'three';
import { Upload, Button, Input, InputNumber, Spin, Select, Switch, Tag, Tooltip, Collapse } from 'antd';
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
import { generateFlowToothCrown, getFlowToothHealth } from '../utils/function/FlowToothApi';
import { prepareFlowToothInputs } from '../utils/function/FlowToothPipeline';

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

  const [flowToothFiles, setFlowToothFiles] = useState({});
  const [flowFdi, setFlowFdi] = useState(null);
  const [flowAllToothFdi, setFlowAllToothFdi] = useState('');
  const [flowRes, setFlowRes] = useState(128);
  const [flowChamfer, setFlowChamfer] = useState(true);
  const [flowAbutfit, setFlowAbutfit] = useState(false);
  const [flowGenerating, setFlowGenerating] = useState(false);
  const [flowApiStatus, setFlowApiStatus] = useState({ state: 'unknown', label: '尚未檢查' });
  const [flowMessage, setFlowMessage] = useState('');
  const [flowResult, setFlowResult] = useState(null);
  const flowMeshesRef = useRef([]);
  const flowRawScansRef = useRef({});

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

  const setFlowFile = (key, file) => {
    if (key === 'upperStl' || key === 'lowerStl') {
      flowRawScansRef.current[key] = file;
    }
    setFlowToothFiles(previous => ({ ...previous, [key]: file }));
    setFlowMessage('');
    return false;
  };

  const renderFlowFileUpload = (key, label, accept, required = false) => {
    const file = flowToothFiles[key];
    return <Upload
      accept={accept}
      beforeUpload={selected => setFlowFile(key, selected)}
      maxCount={1}
      showUploadList={false}
    >
      <Button className='flow-file-button' type={file ? 'primary' : 'default'}>
        {required ? '* ' : ''}{file?.name || label}
      </Button>
    </Upload>
  };

  const clearFlowPreview = () => {
    for (const mesh of flowMeshesRef.current) disposeMesh(mesh);
    flowMeshesRef.current = [];
  };

  const applyPreviewMatrix = async (mesh, matrixFile) => {
    if (!mesh || !matrixFile) return;
    const matrixData = JSON.parse((await matrixFile.text()).replace(/^\uFEFF/, ''));
    const matrixValues = matrixData.flat();
    if (matrixValues.length !== 16) throw new Error(`${matrixFile.name} 不是 4x4 matrix`);
    mesh.applyMatrix4(new THREE.Matrix4().set(...matrixValues));
  };

  const showFlowToothResult = async (result, files = flowToothFiles) => {
    if (!Editor.scene || !Editor.control) throw new Error('3D viewer 尚未初始化');

    const crownFile = new File([result.blob], result.fileName, { type: 'model/ply' });
    const [upperMesh, lowerMesh, crownMesh] = await Promise.all([
      loadMesh(files.upperStl),
      loadMesh(files.lowerStl),
      loadMesh(crownFile),
    ]);
    if (!upperMesh || !lowerMesh || !crownMesh) throw new Error('無法解析 API 回傳的牙冠模型');

    await Promise.all([
      applyPreviewMatrix(upperMesh, files.upperMatrix),
      applyPreviewMatrix(lowerMesh, files.lowerMatrix),
    ]);

    clearFlowPreview();

    const setMaterial = (mesh, name, color, opacity) => {
      mesh.name = name;
      mesh.material.color.set(color);
      mesh.material.transparent = opacity < 1;
      mesh.material.opacity = opacity;
      mesh.material.depthWrite = opacity === 1;
    };
    setMaterial(upperMesh, 'flowtooth-upper', 0x8fc8ff, 0.22);
    setMaterial(lowerMesh, 'flowtooth-lower', 0xc6b4ff, 0.22);
    setMaterial(crownMesh, 'flowtooth-crown', 0xff7a18, 1);
    crownMesh.renderOrder = 2;

    flowMeshesRef.current = [upperMesh, lowerMesh, crownMesh];
    Editor.scene.add(...flowMeshesRef.current);

    const box = new THREE.Box3();
    for (const mesh of flowMeshesRef.current) box.expandByObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const cameraOffset = Editor.control.camera.position.clone().sub(Editor.control.target);
    Editor.control.target.copy(center);
    Editor.control.camera.position.copy(center).add(cameraOffset);
    Editor.control.camera.zoom = THREE.MathUtils.clamp(70 / Math.max(size.x, size.y, size.z, 1), 0.4, 8);
    Editor.control.camera.updateProjectionMatrix();
    Editor.control.update();
  };

  const checkFlowToothHealth = async () => {
    setFlowApiStatus({ state: 'checking', label: '檢查中…' });
    try {
      const health = await getFlowToothHealth();
      const loaded = health.model_loaded ? '模型已載入' : '模型待首次載入';
      setFlowApiStatus({
        state: 'online',
        label: `API 正常 · ${health.device} · ${loaded}`,
      });
    } catch (error) {
      setFlowApiStatus({ state: 'offline', label: `無法連線：${error.message}` });
    }
  };

  const isValidFlowFdi = fdi => /^[1-4][1-8]$/.test(String(Number(fdi)));

  const generateCrownFromFiles = async (files, { abutfit = flowAbutfit } = {}) => {
    const fdi = Number(flowFdi);
    const result = await generateFlowToothCrown({
      fdi,
      upperStl: files.upperStl,
      lowerStl: files.lowerStl,
      marginPts: files.marginPts,
      contactsPly: files.contactsPly,
      upperMatrix: files.upperMatrix,
      lowerMatrix: files.lowerMatrix,
      abutmentPoints: files.abutmentPoints,
      res: flowRes,
      chamfer: flowChamfer,
      abutfit,
    });

    await showFlowToothResult(result, files);
    if (flowResult?.url) URL.revokeObjectURL(flowResult.url);
    const url = URL.createObjectURL(result.blob);
    setFlowResult({ ...result, url });
    setFlowApiStatus({ state: 'online', label: 'API 正常 · 模型已載入' });
    return result;
  };

  const runFlowToothGeneration = async () => {
    const requiredFiles = [
      ['upperStl', 'upper.stl'],
      ['lowerStl', 'lower.stl'],
      ['marginPts', 'margin .pts'],
    ];
    const missing = requiredFiles.filter(([key]) => !flowToothFiles[key]).map(([, label]) => label);

    if (!isValidFlowFdi(flowFdi)) {
      setFlowMessage('請輸入有效的兩位數 FDI（11–48，每象限牙位 1–8）');
      return;
    }
    if (missing.length) {
      setFlowMessage(`缺少必要檔案：${missing.join('、')}`);
      return;
    }
    if (flowAbutfit && !flowToothFiles.abutmentPoints) {
      setFlowMessage('啟用 abutment fit 時必須提供 abutmentPoints .txt');
      return;
    }

    setFlowGenerating(true);
    setFlowMessage('步驟 3/3：正在生成牙冠…');
    try {
      const result = await generateCrownFromFiles(flowToothFiles);
      setFlowMessage(`完成：${result.fileName} · Job ${result.jobId} · ${result.seconds.toFixed(1)} 秒`);
    } catch (error) {
      setFlowMessage(`生成失敗：${error.message}`);
    } finally {
      setFlowGenerating(false);
    }
  };

  const runFlowToothPipeline = async () => {
    const rawUpperStl = flowRawScansRef.current.upperStl || flowToothFiles.upperStl;
    const rawLowerStl = flowRawScansRef.current.lowerStl || flowToothFiles.lowerStl;
    if (!isValidFlowFdi(flowFdi)) {
      setFlowMessage('請先輸入有效的兩位數 FDI（11–48，每象限牙位 1–8）');
      return;
    }
    if (!rawUpperStl || !rawLowerStl) {
      setFlowMessage('一鍵流程需要原始 upper.stl 與 lower.stl');
      return;
    }
    if (flowAbutfit) {
      setFlowMessage('一鍵擺正流程目前不套用原座標的 abutment points；請先關閉 Abutment fit');
      return;
    }

    setFlowGenerating(true);
    try {
      const prepared = await prepareFlowToothInputs({
        upperStl: rawUpperStl,
        lowerStl: rawLowerStl,
        fdi: Number(flowFdi),
        allToothFdi: flowAllToothFdi,
        modelApi: PredictAbutment.modelApi,
        onStep: setFlowMessage,
      });

      // Positioned scans and generated margin already share one coordinate frame.
      // Do not resend original matrices/contacts/abutment points from the raw frame.
      const pipelineFiles = {
        ...flowToothFiles,
        ...prepared,
        contactsPly: undefined,
        upperMatrix: undefined,
        lowerMatrix: undefined,
        abutmentPoints: undefined,
      };
      setFlowToothFiles(pipelineFiles);
      setFlowMessage('步驟 3/3：正在生成牙冠…');
      const result = await generateCrownFromFiles(pipelineFiles, { abutfit: false });
      const marginWarning = prepared.marginValidity?.valid === false
        ? ` ⚠ Margin：${prepared.marginValidity.flags?.join(', ') || 'validity=false'}`
        : '';
      setFlowMessage(
        `一鍵流程完成：擺正 → Margin → ${result.fileName} · ${result.seconds.toFixed(1)} 秒（未帶入原座標 contacts）${marginWarning}`,
      );
    } catch (error) {
      setFlowMessage(`Pipeline 失敗：${error.response?.data?.detail ?? error.message}`);
    } finally {
      setFlowGenerating(false);
    }
  };

  const downloadFlowResult = () => {
    if (!flowResult) return;
    const anchor = document.createElement('a');
    anchor.href = flowResult.url;
    anchor.download = flowResult.fileName;
    anchor.click();
  };

  const renderFlowToothPanel = () => {
    const tagColor = {
      unknown: 'default',
      checking: 'processing',
      online: 'success',
      offline: 'error',
    }[flowApiStatus.state];
    const legacyItems = [
      { key: 'model', label: '既有模型與牙位設定', children: renderUploadModel() },
      {
        key: 'predict',
        label: '擺正與 Margin 測試工具',
        children: <div className='legacy-tool-stack'>
          {renderDirectionPredictFunc()}
          {renderAbutmentPredictFunc()}
        </div>,
      },
      { key: 'task', label: 'Task 載入', children: renderTaskIdInput() },
      {
        key: 'verify',
        label: '驗證工具',
        children: <div className='legacy-tool-stack'>
          {renderCheckGroundTrue()}
          {renderCheckAIMarginResult()}
        </div>,
      },
    ];

    return <section className='flowtooth-panel'>
      <div className='flow-panel-header'>
        <strong>AI Checking Viewer</strong>
        <Button size='small' onClick={checkFlowToothHealth}>檢查 API</Button>
      </div>
      <Tag color={tagColor}>{flowApiStatus.label}</Tag>

      <div className='flow-section-title'>擺正 → Margin → 牙冠</div>
      <div className='flow-files'>
        {renderFlowFileUpload('upperStl', 'upper.stl', '.stl', true)}
        {renderFlowFileUpload('lowerStl', 'lower.stl', '.stl', true)}
        {renderFlowFileUpload('marginPts', 'margin .pts（可自動產生）', '.pts')}
        {renderFlowFileUpload('contactsPly', '定位後 contacts .ply', '.ply')}
        {renderFlowFileUpload('upperMatrix', 'upper matrix .json', '.json')}
        {renderFlowFileUpload('lowerMatrix', 'lower matrix .json', '.json')}
        {renderFlowFileUpload('abutmentPoints', 'abutmentPoints .txt', '.txt')}
      </div>

      <div className='flow-options'>
        <label>
          FDI
          <InputNumber min={11} max={48} value={flowFdi} onChange={setFlowFdi} placeholder='例如 27' />
        </label>
        <label>
          同顎所有備牙 FDI
          <Input
            value={flowAllToothFdi}
            onChange={e => setFlowAllToothFdi(e.target.value)}
            placeholder='多備牙時，例如 14,15'
          />
        </label>
        <label>
          Resolution
          <InputNumber min={64} max={256} value={flowRes} onChange={setFlowRes} />
        </label>
        <label>
          Margin AI
          <Select
            value={PredictAbutment.modelApi}
            onChange={value => {
              PredictAbutment.modelApi = value;
              forceRerender();
            }}
            options={[
              { value: 'v6', label: 'v6（正式推薦）' },
              { value: 'v8', label: 'v8（多類別 runner-up）' },
            ]}
          />
        </label>
        <label className='flow-switch'>Chamfer <Switch checked={flowChamfer} onChange={setFlowChamfer} /></label>
        <label className='flow-switch'>Abutment fit <Switch checked={flowAbutfit} onChange={setFlowAbutfit} /></label>
      </div>

      <div className='flow-actions'>
        <Button className='pipeline-button' type='primary' loading={flowGenerating} onClick={runFlowToothPipeline}>
          一鍵：擺正 → Margin → 牙冠
        </Button>
        <Button disabled={flowGenerating} onClick={runFlowToothGeneration}>只用目前檔案生成</Button>
        <Button disabled={!flowResult} onClick={downloadFlowResult}>下載 PLY</Button>
        <Button disabled={!flowMeshesRef.current.length} onClick={clearFlowPreview}>清除預覽</Button>
      </div>
      {flowMessage && <pre className={/失敗|缺少|請先|需要/.test(flowMessage) ? 'flow-message error' : flowMessage.includes('⚠') ? 'flow-message warning' : 'flow-message'}>{flowMessage}</pre>}

      <div className='panel-divider' />
      <div className='flow-section-title legacy-title'>既有工具</div>
      <Collapse className='legacy-tools' size='small' items={legacyItems} />
    </section>;
  };

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
            { value: 'v6', label: 'AI: v6 正式推薦' },
            { value: 'v8', label: 'AI: v8 多類別 runner-up' },
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
        {renderFlowToothPanel()}
      </Spin>
    </div>
  )
}

export default App;
export { onUploadFile }
