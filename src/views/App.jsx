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
import { generateFlowToothCrown, getFlowToothHealth, FLOWTOOTH_MODEL_LABEL } from '../utils/function/FlowToothApi';
import { formatTimings } from '../utils/function/formatTimings';
import { runPipelineJob, PIPELINE_TARGETS } from '../utils/function/EzaiPipelineApi';

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
  // Which box the running one-click job is on, or null. Separate from flowGenerating so
  // that only the button actually running shows a spinner -- with two one-click buttons,
  // spinning both would leave the answer to "which one did I press" on screen for the
  // length of the job, and that answer is the entire point of having two.
  const [flowPipelineTarget, setFlowPipelineTarget] = useState(null);
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

  // Both instances get checked in one click: an A/B is worth nothing if one of the two is
  // down and the panel only ever reported the other one's state.
  const checkFlowToothHealth = async () => {
    setFlowApiStatus({ state: 'checking', label: '檢查中…' });

    const describe = async model => {
      const label = FLOWTOOTH_MODEL_LABEL[model];
      try {
        const health = await getFlowToothHealth(model);
        const loaded = health.model_loaded ? '模型已載入' : '模型待首次載入';
        return { ok: true, text: `${label} 正常 · ${health.device} · ${loaded}` };
      } catch (error) {
        return { ok: false, text: `${label} 無法連線：${error.message}` };
      }
    };

    const results = await Promise.all([describe('dev'), describe('prod')]);
    setFlowApiStatus({
      state: results.every(result => result.ok) ? 'online' : 'offline',
      label: results.map(result => result.text).join('　｜　'),
    });
  };

  const isValidFlowFdi = fdi => /^[1-4][1-8]$/.test(String(Number(fdi)));

  const generateCrownFromFiles = async (files, { abutfit = flowAbutfit, model = 'dev' } = {}) => {
    const fdi = Number(flowFdi);
    const result = await generateFlowToothCrown({
      model,
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
    // Names the instance: a successful generate only proves the one that served it.
    setFlowApiStatus({ state: 'online', label: `${result.modelLabel} 正常 · 模型已載入` });
    return result;
  };

  const runFlowToothGeneration = async (model = 'dev') => {
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

    const modelLabel = FLOWTOOTH_MODEL_LABEL[model] ?? model;
    setFlowGenerating(true);
    setFlowMessage(`步驟 3/3：正在用${modelLabel}生成牙冠…`);
    try {
      const result = await generateCrownFromFiles(flowToothFiles, { model });
      setFlowMessage(
        `完成（${result.modelLabel}）：${result.fileName} · Job ${result.jobId} · ${result.seconds.toFixed(1)} 秒`,
      );
    } catch (error) {
      setFlowMessage(`${modelLabel}生成失敗：${error.message}`);
    } finally {
      setFlowGenerating(false);
    }
  };

  // Production calls ezai-pipeline rather than the three services one at a time, so this
  // button does too: one upload, and the service runs jaw → transform → margin → crown
  // itself. Driving the same three calls from the browser measured something nobody runs --
  // it shipped every intermediate mesh back out to the client, and that traffic cost more
  // than the inference did.
  // `target` picks which box runs it -- 'z790' is this one, 'rtx5090' is Chiayi. Same code
  // path for both on purpose: the two runs are only comparable if nothing but the address
  // differs, so there is one function rather than two that drift apart.
  const runFlowToothPipeline = async (target = 'z790') => {
    const site = PIPELINE_TARGETS[target];
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
      setFlowMessage('pipeline 不接受 abutment points；一鍵流程請先關閉 Abutment fit');
      return;
    }

    setFlowGenerating(true);
    setFlowPipelineTarget(target);
    const startedAt = performance.now();
    try {
      const result = await runPipelineJob({
        upperStl: rawUpperStl,
        lowerStl: rawLowerStl,
        fdi: Number(flowFdi),
        allToothFdi: flowAllToothFdi,
        onStage: setFlowMessage,
        target,
      });
      const totalSeconds = (performance.now() - startedAt) / 1000;

      // The service returns the crown in the frame the scans were uploaded in, so the
      // preview uses the raw scans and none of our own matrices.
      const previewFiles = {
        ...flowToothFiles,
        upperStl: rawUpperStl,
        lowerStl: rawLowerStl,
        marginPts: undefined,
        contactsPly: undefined,
        upperMatrix: undefined,
        lowerMatrix: undefined,
        abutmentPoints: undefined,
      };
      setFlowToothFiles(previewFiles);
      await showFlowToothResult(result, previewFiles);
      if (flowResult?.url) URL.revokeObjectURL(flowResult.url);
      setFlowResult({ ...result, url: URL.createObjectURL(result.blob) });
      setFlowApiStatus({ state: 'online', label: `${site.label} 正常 · Job ${result.jobId}` });

      // The service's own stage timings, plus whatever the browser waited on top of them:
      // uploading both scans and pulling the archive back.
      const transferLabel = site.remote ? '上傳與取回（含 tunnel）' : '上傳與取回';
      const timings = [
        ...result.timings,
        { label: transferLabel, seconds: Math.max(0, totalSeconds - result.serverSeconds) },
      ];
      const params = Object.entries(result.crownParams)
        .map(([key, value]) => `${key}=${value}`).join(' ');
      const warnings = result.warnings.length ? `\n⚠ ${result.warnings.join('\n⚠ ')}` : '';
      // The whole point of the second button is comparing two boxes, and the number most
      // likely to be compared is the big one at the end -- which for Chiayi includes an
      // internet round trip through Cloudflare and says nothing about the GPU. Say so here
      // rather than letting the panel imply the remote box is slower than it is.
      const remoteNote = site.remote
        ? '\n  ⓘ 跨機比較請看上面各階段的推論時間；總計含 tunnel 往返，不是 GPU 的差距'
        : '';
      setFlowMessage(
        `一鍵流程完成（${site.label}・${site.hint}）：${result.fileName} · Job ${result.jobId}\n`
        + `${formatTimings(timings, totalSeconds)}\n`
        + `  牙冠參數由 pipeline 決定：${params}${remoteNote}${warnings}`,
      );
    } catch (error) {
      // A job can outlive this page's own Cloudflare Access session. When that session
      // ends, the next same-origin XHR is answered with a 302 to the Access login page,
      // the browser follows it cross-origin, and the fetch dies as a CORS failure -- which
      // axios reports as a bare "Network Error" with no response attached. Nothing in that
      // says "log in again", and the poll loop makes it most likely to land on a request
      // that looks like the remote box broke. Name it, since the fix is one reload.
      const sessionLikelyExpired = !error.response
        && (error.code === 'ERR_NETWORK' || /network error/i.test(error.message ?? ''));
      setFlowMessage(
        sessionLikelyExpired
          ? `${site.label} pipeline 中斷：與伺服器的連線被擋下。\n`
            + '  最常見的原因是這個頁面的 Cloudflare Access 登入階段過期了（DevTools 會看到\n'
            + '  一個 302 導向 cdn-cgi/access/login 以及一則 CORS 錯誤）。請重新整理頁面重新登入後再試。\n'
            + '  工作本身可能已經在遠端跑完了，重試不會有副作用。'
          : `${site.label} pipeline 失敗：${error.response?.data?.detail ?? error.message}`,
      );
    } finally {
      setFlowGenerating(false);
      setFlowPipelineTarget(null);
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
        <label className='flow-switch'>Chamfer <Switch checked={flowChamfer} onChange={setFlowChamfer} /></label>
        <label className='flow-switch'>Abutment fit <Switch checked={flowAbutfit} onChange={setFlowAbutfit} /></label>
      </div>

      <div className='flow-actions'>
        {/* Arrow wrappers, as with the two model buttons below: a bare reference would hand
            the handler its click event as the target argument, which PIPELINE_TARGETS would
            not resolve. */}
        <Button
          className='pipeline-button'
          type='primary'
          loading={flowPipelineTarget === 'z790'}
          disabled={flowGenerating && flowPipelineTarget !== 'z790'}
          onClick={() => runFlowToothPipeline('z790')}
        >
          一鍵：擺正 → Margin → 牙冠（台中 5080）
        </Button>
        {/* The same case on the Chiayi box, for comparing the two GPUs. Tinted rather than
            primary so the two one-click buttons cannot be hit interchangeably -- which box
            produced a crown is the whole point, and they are otherwise identical. */}
        <Button
          className='pipeline-button rtx5090-button'
          loading={flowPipelineTarget === 'rtx5090'}
          disabled={flowGenerating && flowPipelineTarget !== 'rtx5090'}
          onClick={() => runFlowToothPipeline('rtx5090')}
        >
          一鍵：擺正 → Margin → 牙冠（嘉義 5090）
        </Button>
        {/* Arrow wrappers, not a bare reference: onClick would hand the button its click
            event as the model argument.

            The labels say which role each instance plays rather than naming a checkpoint:
            dev is whichever pair production last replaced, and both rotate. Naming versions
            here would go stale silently, which is how the pipeline came to run the older
            model without anyone noticing. */}
        <Button disabled={flowGenerating} onClick={() => runFlowToothGeneration('dev')}>
          只用目前檔案生成（dev 8010・對照組）
        </Button>
        <Button
          className='prod-model-button'
          disabled={flowGenerating}
          onClick={() => runFlowToothGeneration('prod')}
        >
          只用目前檔案生成（prod 8013・線上權重）
        </Button>
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
