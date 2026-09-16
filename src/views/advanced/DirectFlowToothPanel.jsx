/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useState } from 'react';
import * as THREE from 'three';
import { Alert, Button, InputNumber, Switch, Tag, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts } from '../../utils/function/margin-editor/marginPts';
import { FLOWTOOTH_MODEL_LABEL, generateFlowToothCrown, getFlowToothHealth } from '../../utils/function/FlowToothApi';
import { downloadBlob, useMarginEditor } from '../../utils/tool/useStores';

const EXTRA_FILES = [
  ['marginPts', 'margin .pts', '.pts'],
  ['contactsPly', 'contacts .ply', '.ply'],
  ['upperMatrix', 'upper matrix .json', '.json'],
  ['lowerMatrix', 'lower matrix .json', '.json'],
  ['abutmentPoints', 'abutmentPoints .txt', '.txt'],
];

/** The matrix files are row-major 4x4, as the preview has always read them. */
const readPreviewMatrix = async file => {
  if (!file) return null;
  const values = JSON.parse((await file.text()).replace(/^\uFEFF/, '')).flat();
  if (values.length !== 16) throw new Error(`${file.name} 不是 4x4 matrix`);
  return new THREE.Matrix4().set(...values);
};

/**
 * The comparison path that bypasses the pipeline: both FlowToothSDF instances on this box,
 * called directly with whatever files are given. dev (8010) tracks whatever is being worked
 * on; prod (8013) is pinned. Nothing is canonicalized here, so the scans, margin, contacts
 * and abutment points must already share a frame -- or come with the jaw matrices that put
 * them in one.
 *
 * Uses the scans from the design tab. The margin is the uploaded .pts if there is one,
 * otherwise the ring from the design tab's editor.
 *
 * Props: fdi, prepJaw.
 */
const DirectFlowToothPanel = ({ fdi }) => {
  const editor = useMarginEditor();
  const [files, setFiles] = useState({});
  const [res, setRes] = useState(128);
  const [chamfer, setChamfer] = useState(true);
  const [abutfit, setAbutfit] = useState(false);
  const [running, setRunning] = useState(null);
  const [message, setMessage] = useState(null);
  const [result, setResult] = useState(null);

  const setFile = key => file => {
    setFiles(previous => ({ ...previous, [key]: file }));
    return false;
  };

  const checkHealth = async () => {
    setMessage({ type: 'info', text: '檢查中…' });
    const describe = async model => {
      try {
        const health = await getFlowToothHealth(model);
        return { ok: true, text: `${FLOWTOOTH_MODEL_LABEL[model]} 正常 · ${health.device} · ${health.model_loaded ? '模型已載入' : '模型待首次載入'}` };
      } catch (error) {
        return { ok: false, text: `${FLOWTOOTH_MODEL_LABEL[model]} 無法連線：${error.message}` };
      }
    };
    // Both at once: an A/B is worth nothing if one side is down and only the other was checked.
    const results = await Promise.all([describe('dev'), describe('prod')]);
    setMessage({ type: results.every(r => r.ok) ? 'success' : 'error', text: results.map(r => r.text).join('\n') });
  };

  const generate = async model => {
    const ring = MarginEditor.getRing();
    const marginFile = files.marginPts
      ?? (ring ? new File([formatMarginPts(ring, fdi)], `design_service_margin_line-${fdi}.pts`, { type: 'text/plain' }) : null);
    const missing = [
      !/^[1-4][1-8]$/.test(String(Number(fdi))) && '有效的 FDI',
      !CaseScene.files.upper && 'upper.stl（牙冠設計分頁）',
      !CaseScene.files.lower && 'lower.stl（牙冠設計分頁）',
      !marginFile && 'margin（上傳 .pts 或在牙冠設計分頁畫一條）',
      abutfit && !files.abutmentPoints && 'abutmentPoints .txt（已開啟 Abutment fit）',
    ].filter(Boolean);
    if (missing.length) {
      setMessage({ type: 'error', text: `缺少：${missing.join('、')}` });
      return;
    }

    setRunning(model);
    setMessage({ type: 'info', text: `正在用${FLOWTOOTH_MODEL_LABEL[model]}生成牙冠…` });
    try {
      const crown = await generateFlowToothCrown({
        model,
        fdi: Number(fdi),
        upperStl: CaseScene.files.upper,
        lowerStl: CaseScene.files.lower,
        marginPts: marginFile,
        contactsPly: files.contactsPly,
        upperMatrix: files.upperMatrix,
        lowerMatrix: files.lowerMatrix,
        abutmentPoints: files.abutmentPoints,
        res,
        chamfer,
        abutfit,
      });
      // The crown comes back in the frame the jaw matrices define, so the scans are shown in
      // that frame too. The pipeline path resets this before it runs.
      CaseScene.setScanMatrix('upper', await readPreviewMatrix(files.upperMatrix));
      CaseScene.setScanMatrix('lower', await readPreviewMatrix(files.lowerMatrix));
      CaseScene.clearReferenceRing();
      await CaseScene.setCrown(crown.blob, crown.fileName);
      setResult(crown);
      setMessage({
        type: 'success',
        text: `完成（${crown.modelLabel}）：${crown.fileName} · Job ${crown.jobId} · ${crown.seconds.toFixed(1)} 秒`
          + (files.marginPts ? '' : '\n使用的是牙冠設計分頁畫的 margin'),
      });
    } catch (error) {
      setMessage({ type: 'error', text: `${FLOWTOOTH_MODEL_LABEL[model]}生成失敗：${error.message}` });
    } finally {
      setRunning(null);
    }
  };

  return <div className='direct-panel'>
    <p className='panel-note'>
      繞過 pipeline，直接呼叫這台主機上的兩個 FlowToothSDF（dev 8010 / prod 8013）做對照。
      <b>不會擺正</b>：口掃、margin、contacts 必須已在同一座標系，或另外提供 jaw matrix。
      口掃沿用「牙冠設計」分頁上傳的檔案。
    </p>

    <section className='panel-section'>
      <div className='section-title'>額外檔案（選填）</div>
      <div className='file-grid'>
        {EXTRA_FILES.map(([key, label, accept]) => <div key={key} className='file-cell'>
          <Upload accept={accept} showUploadList={false} beforeUpload={setFile(key)} disabled={Boolean(running)}>
            <Button block size='small' type={files[key] ? 'primary' : 'default'} title={files[key]?.name}>
              {files[key]?.name ?? label}
            </Button>
          </Upload>
          {files[key] && <Button size='small' type='link' onClick={() => setFiles(previous => ({ ...previous, [key]: undefined }))}>×</Button>}
        </div>)}
      </div>
      {!files.marginPts && <div className='panel-note'>
        margin：{editor.hasRing ? <Tag color='green'>使用牙冠設計分頁的 margin（{editor.pointCount} 點）</Tag> : <Tag>尚未提供</Tag>}
      </div>}
    </section>

    <section className='panel-section'>
      <div className='section-title'>參數</div>
      <div className='field-row'>
        <label>Resolution<InputNumber min={64} max={256} value={res} onChange={setRes} /></label>
        <label className='switch-field'>Chamfer <Switch checked={chamfer} onChange={setChamfer} /></label>
        <label className='switch-field'>Abutment fit <Switch checked={abutfit} onChange={setAbutfit} /></label>
      </div>
    </section>

    <section className='panel-section'>
      <div className='button-grid'>
        <Button loading={running === 'dev'} disabled={Boolean(running)} onClick={() => generate('dev')}>生成（dev 8010・對照組）</Button>
        <Button className='prod-model-button' loading={running === 'prod'} disabled={Boolean(running)} onClick={() => generate('prod')}>
          生成（prod 8013・線上權重）
        </Button>
        <Button disabled={Boolean(running)} onClick={checkHealth}>檢查 FlowTooth API</Button>
        <Button disabled={!result} onClick={() => downloadBlob(result.blob, result.fileName)}>下載 PLY</Button>
      </div>
      {message && <Alert className='section-alert' type={message.type} showIcon message={<pre className='plain-pre'>{message.text}</pre>} />}
    </section>
  </div>;
};

export default DirectFlowToothPanel;
