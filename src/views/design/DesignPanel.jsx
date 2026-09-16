/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Select, Tag, Tooltip, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts } from '../../utils/function/margin-editor/marginPts';
import { getPipelineHealth, singleArchTargets, PIPELINE_MODES, PIPELINE_TARGETS, runPipelineJob } from '../../utils/function/EzaiPipelineApi';
import { useMarginEditor } from '../../utils/tool/useStores';
import MarginSection from './MarginSection';
import ResultView from './ResultView';

const JAW_NAME = { upper: '上顎', lower: '下顎' };
const TARGET_STORAGE_KEY = 'checkingViewer.pipelineTarget';

const readStoredTarget = () => {
  try {
    const stored = window.localStorage.getItem(TARGET_STORAGE_KEY);
    return PIPELINE_TARGETS[stored] ? stored : 'z790';
  } catch {
    return 'z790';
  }
};

/**
 * A job can outlive this page's own Cloudflare Access session. When that session ends, the
 * next same-origin XHR is answered with a 302 to the Access login page, the browser follows
 * it cross-origin, and the request dies as a bare "Network Error" -- which says nothing
 * about logging in again. Name it, since the fix is one reload.
 */
const describeFailure = (error, site) => {
  const sessionLikelyExpired = !error.response
    && (error.code === 'ERR_NETWORK' || /network error/i.test(error.message ?? ''));
  if (sessionLikelyExpired) {
    return `${site.label} 連線被擋下。最常見的原因是這個頁面的 Cloudflare Access 登入過期了，`
      + '請重新整理頁面後再試（工作本身可能已經在伺服器跑完，重試沒有副作用）。';
  }
  return error.response?.data?.detail ?? error.message;
};

/**
 * The main tab: case → margin → crown, through ezai-pipeline.
 *
 * Props: fdi, setFdi, allToothFdi, setAllToothFdi, prepJaw, scene (CaseScene snapshot).
 */
const DesignPanel = ({ fdi, setFdi, allToothFdi, setAllToothFdi, prepJaw, scene }) => {
  const editor = useMarginEditor();
  const [marginSource, setMarginSource] = useState('ai');
  const [marginNotice, setMarginNotice] = useState(null);
  const [ignoreOpposing, setIgnoreOpposing] = useState(false);
  const [target, setTarget] = useState(readStoredTarget);
  const [viewerConfig, setViewerConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [running, setRunning] = useState(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [scanError, setScanError] = useState(null);

  useEffect(() => {
    // Which targets this instance can reach. An older server without the endpoint just
    // leaves every target enabled, which is how the panel behaved before it existed.
    fetch('/api/viewer-config')
      .then(response => (response.ok ? response.json() : null))
      .then(setViewerConfig)
      .catch(() => setViewerConfig(null));
  }, []);

  const site = PIPELINE_TARGETS[target];
  const opposingJaw = prepJaw === 'upper' ? 'lower' : prepJaw === 'lower' ? 'upper' : null;
  const has = { upper: scene.hasUpper, lower: scene.hasLower };
  const hasPrep = Boolean(prepJaw && has[prepJaw]);
  const hasOpposing = Boolean(opposingJaw && has[opposingJaw]);
  const singleArch = hasPrep && (!hasOpposing || ignoreOpposing);
  const targetConfigured = viewerConfig?.targets?.[target] ?? true;

  const chooseTarget = value => {
    setTarget(value);
    setHealth(null);
    try {
      window.localStorage.setItem(TARGET_STORAGE_KEY, value);
    } catch {
      // private window or blocked storage: the choice just does not persist
    }
  };

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
  if (marginSource === 'custom') {
    if (editor.mode === 'draw') blockers.push('完成 margin 繪製（閉合）');
    else if (!editor.hasRing) blockers.push('繪製或上傳 margin');
  }
  if (singleArch && !site.singleArch) blockers.push(`「${site.label}」不支援單顎：改選 ${singleArchTargets()} 或補上對咬顎`);
  if (!targetConfigured) blockers.push(`這個實例沒有設定「${site.label}」`);

  const predictBlockers = blockers.filter(b => !b.includes('margin'));

  const run = async (mode) => {
    const kind = mode === PIPELINE_MODES.marginOnly ? 'margin' : 'crown';
    const ring = mode === PIPELINE_MODES.marginOverride ? MarginEditor.getRing() : null;
    setRunning(kind);
    setError(null);
    setResult(null);
    setProgress('準備中…');
    CaseScene.resetScanMatrices();
    // The result panel only ever describes one job, so the crown on screen goes with it.
    CaseScene.clearCrown();
    if (ring) MarginEditor.setEditing(false);
    const startedAt = performance.now();
    try {
      const job = await runPipelineJob({
        upperStl: CaseScene.files.upper,
        lowerStl: CaseScene.files.lower,
        fdi: Number(fdi),
        allToothFdi,
        mode,
        marginPts: ring ? formatMarginPts(ring, fdi) : null,
        singleArch,
        target,
        onStage: setProgress,
      });
      job.totalSeconds = (performance.now() - startedAt) / 1000;

      if (mode === PIPELINE_MODES.marginOnly) {
        MarginEditor.setRing(job.marginOriginal, 'ai');
        CaseScene.clearReferenceRing();
        CaseScene.focusRing(job.prepJaw, job.marginOriginal);
        setMarginSource('custom');
        setMarginNotice({ type: 'info', text: 'AI 預測的 margin 已載入，可拖曳修改後再生成牙冠。' });
      } else {
        await CaseScene.setCrown(job.blob, job.fileName);
        if (mode === PIPELINE_MODES.full) CaseScene.setReferenceRing(job.prepJaw, job.marginOriginal);
        else CaseScene.clearReferenceRing();
      }
      setResult(job);
      setHealth({ ok: true, text: `${site.label} 正常 · Job ${job.jobId}` });
    } catch (runError) {
      setError(describeFailure(runError, site));
    } finally {
      setRunning(null);
    }
  };

  const editResultRing = job => {
    MarginEditor.setRing(job.marginOriginal, 'ai');
    CaseScene.clearReferenceRing();
    CaseScene.focusRing(job.prepJaw, job.marginOriginal);
    setMarginSource('custom');
    setMarginNotice({ type: 'info', text: '這次 AI 用的 margin 已載入，修改後按「生成牙冠」會以自訂 margin 重跑。' });
  };

  const checkHealth = async () => {
    setHealth({ ok: null, text: '檢查中…' });
    setHealth(await getPipelineHealth(target));
  };

  const scanSlot = jaw => {
    const role = !prepJaw ? '' : jaw === prepJaw ? '備牙顎' : '對咬顎';
    const fileName = jaw === 'upper' ? scene.upperName : scene.lowerName;
    return <div className={`scan-slot ${has[jaw] ? 'loaded' : ''} ${role === '備牙顎' ? 'prep' : ''}`}>
      <div className='scan-slot-head'>
        <span>{JAW_NAME[jaw]}</span>
        {role && <Tag color={role === '備牙顎' ? 'orange' : 'default'}>{role}</Tag>}
      </div>
      <Upload accept='.stl,.ply' showUploadList={false} beforeUpload={uploadScan(jaw)} disabled={Boolean(running)}>
        <Button block size='small' type={has[jaw] ? 'default' : 'dashed'} disabled={Boolean(running)} title={fileName ?? ''}>
          {fileName ?? `上傳 ${jaw}.stl`}
        </Button>
      </Upload>
      {has[jaw] && <Button size='small' type='link' danger disabled={Boolean(running)} onClick={() => removeScan(jaw)}>移除</Button>}
    </div>;
  };

  const targetOptions = Object.entries(PIPELINE_TARGETS).map(([key, entry]) => ({
    value: key,
    disabled: viewerConfig ? !viewerConfig.targets?.[key] : false,
    label: <div className='target-option'>
      <span>{entry.label}</span>
      {entry.singleArch && <Tag color='orange' bordered={false}>單顎</Tag>}
      <span className='target-hint'>{entry.hint}</span>
    </div>,
  }));

  const generateMode = marginSource === 'custom' ? PIPELINE_MODES.marginOverride : PIPELINE_MODES.full;

  return <div className='design-panel'>
    <section className='panel-section'>
      <div className='section-title'><span className='step'>1</span>病例</div>
      <div className='field-row'>
        <label>
          FDI
          <InputNumber min={11} max={48} value={fdi} onChange={setFdi} placeholder='例如 36' disabled={Boolean(running)} />
        </label>
        {marginSource === 'ai' && <label>
          <Tooltip title='同一顎有多顆備牙時填入完整清單（含本顆），供 margin 模型參考；單顆可留白'>
            同顎所有備牙 FDI
          </Tooltip>
          <Input value={allToothFdi} onChange={e => setAllToothFdi(e.target.value)} placeholder='例如 14,15' disabled={Boolean(running)} />
        </label>}
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
      marginSource={marginSource}
      setMarginSource={value => {
        setMarginSource(value);
        if (value === 'ai' && editor.mode !== 'idle') MarginEditor.setEditing(false);
      }}
      fdi={fdi}
      prepJaw={prepJaw}
      hasPrepScan={hasPrep}
      busy={running}
      notice={marginNotice}
      setNotice={setMarginNotice}
      onPredict={() => {
        if (predictBlockers.length) {
          setError(`還不能預測：${predictBlockers.join('；')}`);
          return;
        }
        run(PIPELINE_MODES.marginOnly);
      }}
    />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>3</span>生成牙冠</div>
      <label className='stacked-label'>
        Pipeline
        <div className='target-row'>
          <Select value={target} onChange={chooseTarget} options={targetOptions} disabled={Boolean(running)} popupMatchSelectWidth={false}
            labelRender={() => <span>{site.label} <span className='target-hint'>{site.hint}</span></span>} />
          <Button onClick={checkHealth} disabled={Boolean(running)}>檢查</Button>
        </div>
      </label>
      {health && <div className={`health-line ${health.ok === false ? 'bad' : health.ok ? 'good' : ''}`}>{health.text}</div>}

      <div className='generate-summary'>
        <Tag>{generateMode === PIPELINE_MODES.full ? 'AI margin（mode=full）' : '自訂 margin（mode=margin_override）'}</Tag>
        {hasPrep && <Tag color={singleArch ? 'orange' : 'blue'}>{singleArch ? '單顎' : '上下顎'}</Tag>}
      </div>
      <Button
        type='primary'
        size='large'
        block
        loading={running === 'crown'}
        disabled={Boolean(running) || blockers.length > 0}
        onClick={() => run(generateMode)}
      >
        生成牙冠
      </Button>
      {blockers.length > 0 && !running && <ul className='blocker-list'>
        {blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
      </ul>}

      <ResultView running={running} progress={progress} error={error} result={result} onEditRing={editResultRing} />
    </section>
  </div>;
};

export default DesignPanel;
