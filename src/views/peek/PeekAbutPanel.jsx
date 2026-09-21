/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, InputNumber, Radio, Tag, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts } from '../../utils/function/margin-editor/marginPts';
import { getPipelineHealth, PIPELINE_MODES, PIPELINE_TARGETS, runPipelineJob } from '../../utils/function/EzaiPipelineApi';
import { SCAN_ACCEPT } from '../../utils/loader/loadGeometry';
import { useMarginEditor } from '../../utils/tool/useStores';
import describeFailure from '../design/describeFailure';
import MarginSection from '../design/MarginSection';
import ResultView from '../design/ResultView';

const TARGET = 'rtx5090_noabut';
const JAW_NAME = { upper: '上顎', lower: '下顎' };
// The service's own bounds (ezai-pipeline app/virtual_prep.py); it answers 422 outside them.
const HEIGHT_RANGE = [1.0, 6.0];
const SHOULDER_RANGE = [0.3, 1.5];
const DEFAULT_SHOULDER = 0.8;

/**
 * "peek abut設計": a crown's outer surface for a scan that has NO abutment yet -- an implant
 * site whose abutment (PEEK, AI-designed) will be made from the crown afterwards.
 *
 * FlowToothSDF only knows prepared teeth, so this sends the case to the no-abutment test
 * endpoint on the Chiayi box, which puts a virtual stump inside the ring before building the
 * crown. The margin model cannot find a finish line that is not there, so the ring is always
 * drawn or uploaded here (mode=margin_override).
 *
 * Shares the case with the design tab -- the same scans, FDI and margin editor -- so a case
 * loaded there can be tried here without uploading it again.
 *
 * Props: fdi, setFdi, prepJaw, scene (CaseScene snapshot).
 */
const PeekAbutPanel = ({ fdi, setFdi, prepJaw, scene }) => {
  const editor = useMarginEditor();
  const [marginNotice, setMarginNotice] = useState(null);
  const [ignoreOpposing, setIgnoreOpposing] = useState(false);
  const [viewerConfig, setViewerConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [running, setRunning] = useState(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [heightMode, setHeightMode] = useState('auto');
  const [height, setHeight] = useState(3.0);
  const [shoulder, setShoulder] = useState(DEFAULT_SHOULDER);

  useEffect(() => {
    fetch('/api/viewer-config')
      .then(response => (response.ok ? response.json() : null))
      .then(setViewerConfig)
      .catch(() => setViewerConfig(null));
  }, []);

  const site = PIPELINE_TARGETS[TARGET];
  const opposingJaw = prepJaw === 'upper' ? 'lower' : prepJaw === 'lower' ? 'upper' : null;
  const has = { upper: scene.hasUpper, lower: scene.hasLower };
  const hasPrep = Boolean(prepJaw && has[prepJaw]);
  const hasOpposing = Boolean(opposingJaw && has[opposingJaw]);
  const singleArch = hasPrep && (!hasOpposing || ignoreOpposing);
  const configured = viewerConfig?.targets?.[TARGET] ?? true;

  const uploadScan = jaw => async file => {
    setScanError(null);
    try {
      await CaseScene.setScan(jaw, file);
      CaseScene.clearCrown();
      if (CaseScene.referenceRing?.parent === CaseScene.meshes[jaw] || !CaseScene.meshes[prepJaw]) {
        CaseScene.clearReferenceRing();
      }
      setResult(null);
    } catch (uploadError) {
      setScanError(uploadError.message);
    }
    return false;
  };

  const removeScan = jaw => {
    CaseScene.removeScan(jaw);
    CaseScene.clearCrown();
    setResult(null);
  };

  const blockers = [];
  if (!prepJaw) blockers.push('輸入有效的 FDI（11–48）');
  else if (!hasPrep) blockers.push(`上傳${JAW_NAME[prepJaw]}（FDI ${fdi} 所在的顎）`);
  if (editor.mode === 'draw') blockers.push('完成 margin 繪製（閉合）');
  else if (!editor.hasRing) blockers.push('在牙齦上繪製或上傳 margin');
  if (!configured) blockers.push(`這個實例沒有設定「${site.label}」的憑證`);

  const run = async () => {
    const ring = MarginEditor.getRing();
    setRunning('crown');
    setError(null);
    setResult(null);
    setProgress('準備中…');
    CaseScene.resetScanMatrices();
    CaseScene.clearCrown();
    CaseScene.clearReferenceRing();
    MarginEditor.setEditing(false);
    const startedAt = performance.now();
    try {
      const job = await runPipelineJob({
        upperStl: CaseScene.files.upper,
        lowerStl: CaseScene.files.lower,
        fdi: Number(fdi),
        mode: PIPELINE_MODES.marginOverride,
        marginPts: formatMarginPts(ring, fdi),
        singleArch,
        // null = the service's own choice; only what the user actually changed is sent.
        noAbutment: {
          stumpHeightMm: heightMode === 'manual' ? height : null,
          stumpShoulderMm: shoulder !== DEFAULT_SHOULDER ? shoulder : null,
        },
        target: TARGET,
        onStage: setProgress,
      });
      job.totalSeconds = (performance.now() - startedAt) / 1000;
      await CaseScene.setCrown(job.blob, job.fileName);
      if (job.virtualPrep) await CaseScene.setStump(job.virtualPrep, job.virtualPrepName);
      setResult(job);
      setHealth({ ok: true, text: `${site.label} 正常 · Job ${job.jobId}` });
    } catch (runError) {
      setError(describeFailure(runError, site));
    } finally {
      setRunning(null);
    }
  };

  const checkHealth = async () => {
    setHealth({ ok: null, text: '檢查中…' });
    setHealth(await getPipelineHealth(TARGET));
  };

  const scanSlot = jaw => {
    const role = !prepJaw ? '' : jaw === prepJaw ? '植體位置所在顎' : '對咬顎';
    const fileName = jaw === 'upper' ? scene.upperName : scene.lowerName;
    return <div className={`scan-slot ${has[jaw] ? 'loaded' : ''} ${jaw === prepJaw ? 'prep' : ''}`}>
      <div className='scan-slot-head'>
        <span>{JAW_NAME[jaw]}</span>
        {role && <Tag color={jaw === prepJaw ? 'orange' : 'default'}>{role}</Tag>}
      </div>
      <Upload accept={SCAN_ACCEPT} showUploadList={false} beforeUpload={uploadScan(jaw)} disabled={Boolean(running)}>
        <Button block size='small' type={has[jaw] ? 'default' : 'dashed'} disabled={Boolean(running)} title={fileName ?? `${JAW_NAME[jaw]}口掃：.stl、.ply 或 .tri`}>
          {fileName ?? '上傳 STL / PLY / TRI'}
        </Button>
      </Upload>
      {has[jaw] && <Button size='small' type='link' danger disabled={Boolean(running)} onClick={() => removeScan(jaw)}>移除</Button>}
    </div>;
  };

  return <div className='design-panel'>
    <Alert
      className='section-alert'
      type='info'
      showIcon
      message='沒有 abutment 的口掃 → 牙冠外壁'
      description={<>
        給植體位置還沒有 abutment 的口掃。在牙齦上畫出牙冠要落的位置，服務會在環內放一個
        <b>虛擬支台齒</b>再生成牙冠；只有<b>外壁</b>可以使用，內面是配合虛擬支台齒的。
        送到嘉義 5090 的測試端點（/pipeline-noabut），正式的 pipeline 不受影響。
      </>}
    />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>1</span>病例</div>
      <div className='field-row'>
        <label>
          FDI
          <InputNumber min={11} max={48} value={fdi} onChange={setFdi} placeholder='例如 36' disabled={Boolean(running)} />
        </label>
      </div>
      <div className='scan-slots'>
        {scanSlot('upper')}
        {scanSlot('lower')}
      </div>
      {scanError && <Alert className='section-alert' type='error' showIcon message={scanError} />}
      {hasPrep && !hasOpposing && <Alert
        className='section-alert'
        type='info'
        showIcon
        message='沒有對咬顎：以單顎模式生成'
        description='對咬會用「鄰牙高度的平面」代替，牙冠咬合面沒有依照真實咬合，需另外確認。'
      />}
      {hasPrep && hasOpposing && <Checkbox checked={ignoreOpposing} onChange={e => setIgnoreOpposing(e.target.checked)} disabled={Boolean(running)}>
        忽略對咬顎，用單顎模式生成（比較用）
      </Checkbox>}
    </section>

    <MarginSection
      marginSource='custom'
      setMarginSource={() => {}}
      customOnly
      customNote='沒有支台齒時 AI margin 模型找不到邊緣線，請直接在牙齦上畫出牙冠要落的位置，或上傳 .pts。'
      fdi={fdi}
      prepJaw={prepJaw}
      hasPrepScan={hasPrep}
      busy={running}
      notice={marginNotice}
      setNotice={setMarginNotice}
      onPredict={() => {}}
    />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>3</span>虛擬支台齒</div>
      <Radio.Group
        value={heightMode}
        onChange={e => setHeightMode(e.target.value)}
        disabled={Boolean(running)}
        options={[{ label: '自動高度', value: 'auto' }, { label: '指定高度', value: 'manual' }]}
      />
      <div className='field-row'>
        {heightMode === 'manual' && <label>
          高度（mm）
          <InputNumber min={HEIGHT_RANGE[0]} max={HEIGHT_RANGE[1]} step={0.5} value={height} onChange={v => setHeight(v ?? 3.0)} disabled={Boolean(running)} />
        </label>}
        <label>
          肩台寬（mm）
          <InputNumber min={SHOULDER_RANGE[0]} max={SHOULDER_RANGE[1]} step={0.1} value={shoulder} onChange={v => setShoulder(v ?? DEFAULT_SHOULDER)} disabled={Boolean(running)} />
        </label>
      </div>
      <p className='panel-note'>
        自動：牙齦到對咬的距離減 1.5 mm，限制在 1.5–4.0 mm；錐度 8°。牙齦到對咬不到 3 mm 時放不下牙冠，結果會標示出來。
      </p>
    </section>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>4</span>生成牙冠外壁</div>
      <div className='target-row'>
        <span>{site.label} <span className='target-hint'>{site.hint}</span></span>
        <Button onClick={checkHealth} disabled={Boolean(running)}>檢查</Button>
      </div>
      {health && <div className={`health-line ${health.ok === false ? 'bad' : health.ok ? 'good' : ''}`}>{health.text}</div>}
      <div className='generate-summary'>
        <Tag>自訂 margin（mode=margin_override）</Tag>
        <Tag color='green'>no_abutment</Tag>
        {hasPrep && <Tag color={singleArch ? 'orange' : 'blue'}>{singleArch ? '單顎' : '上下顎'}</Tag>}
      </div>
      <Button
        type='primary'
        size='large'
        block
        loading={running === 'crown'}
        disabled={Boolean(running) || blockers.length > 0}
        onClick={run}
      >
        生成牙冠外壁
      </Button>
      {blockers.length > 0 && !running && <ul className='blocker-list'>
        {blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
      </ul>}

      <ResultView running={running} progress={progress} error={error} result={result} onEditRing={() => {}} />
    </section>
  </div>;
};

export default PeekAbutPanel;
