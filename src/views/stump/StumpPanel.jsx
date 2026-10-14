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

// The library-stump test pipeline on the Chiayi box (/pipeline-stump/, 2026-10-14).
const TARGET = 'rtx5090_stump';
const JAW_NAME = { upper: '上顎', lower: '下顎' };
// The service's own bounds and defaults (ezai-pipeline app/library_stump.py); it answers 422
// outside them, and only what the user changed is sent.
const HEIGHT_RANGE = [1.5, 8.0];
const SHOULDER_RANGE = [0.3, 1.5];
const CLEARANCE_RANGE = [0.5, 3.0];
const DEFAULT_SHOULDER = 0.6;
const DEFAULT_CLEARANCE = 1.0;

/**
 * 「產生支台齒」: a stump for a site with no abutment yet -- the upper part of an AI abutment.
 *
 * The scan is cut along the drawn margin and a stump from EZCAD's abutment library is grown in
 * its place: its shape is the library's, its height, lean and widths are the median of real
 * preparations of that tooth (101's trainingData), it never overhangs the margin and keeps its
 * clearance to the bite, and it is stitched into the scan along the margin with no gap. No
 * crown. With a registered scan body the insertion axis can be given, and the stump stands
 * along it.
 *
 * Shares the case with the design tab -- the same scans, FDI and margin editor.
 *
 * Props: fdi, setFdi, prepJaw, scene (CaseScene snapshot).
 */
const StumpPanel = ({ fdi, setFdi, prepJaw, scene }) => {
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
  const [height, setHeight] = useState(4.0);
  const [shoulder, setShoulder] = useState(DEFAULT_SHOULDER);
  const [clearance, setClearance] = useState(DEFAULT_CLEARANCE);
  const [axisMode, setAxisMode] = useState('natural');
  const [axis, setAxis] = useState([0, 0, 1]);

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
  const axisOk = axis.every(Number.isFinite) && Math.hypot(...axis) > 1e-6;

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
  if (axisMode === 'manual' && !axisOk) blockers.push('插入方向不能是 0,0,0');
  if (!configured) blockers.push(`這個實例沒有設定「${site.label}」的憑證`);

  const run = async () => {
    const ring = MarginEditor.getRing();
    setRunning('stump');
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
        mode: PIPELINE_MODES.stump,
        marginPts: formatMarginPts(ring, fdi),
        singleArch,
        // null = the service's own choice; only what the user actually changed is sent.
        stump: {
          heightMm: heightMode === 'manual' ? height : null,
          shoulderMm: shoulder !== DEFAULT_SHOULDER ? shoulder : null,
          clearanceMm: clearance !== DEFAULT_CLEARANCE ? clearance : null,
          insertionAxis: axisMode === 'manual' ? axis : null,
        },
        target: TARGET,
        onStage: setProgress,
      });
      job.totalSeconds = (performance.now() - startedAt) / 1000;
      if (job.stumpMesh) await CaseScene.setStump(job.stumpMesh, job.stumpMeshName, { solid: true });
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

  const record = result?.stump;

  return <div className='design-panel'>
    <Alert
      className='section-alert'
      type='info'
      showIcon
      message='沒有 abutment 的口掃 → 支台齒（abutment 上半部）'
      description={<>
        沿 margin 把口掃挖開，放進 <b>EZCAD 支台齒資料庫</b>的形狀；高度、傾斜、寬度用同一顆牙的
        <b>真實支台齒中位數</b>，不超出 margin、離對咬至少 {DEFAULT_CLEARANCE} mm，並沿 margin 縫進口掃（沒有縫隙）。
        不生成牙冠。送到嘉義 5090 的測試 pipeline（/pipeline-stump，mode=stump）。
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
        message='沒有對咬顎'
        description='支台齒用自然高度，不檢查離對咬的距離。'
      />}
      {hasPrep && hasOpposing && <Checkbox checked={ignoreOpposing} onChange={e => setIgnoreOpposing(e.target.checked)} disabled={Boolean(running)}>
        忽略對咬顎（不檢查離對咬的距離）
      </Checkbox>}
    </section>

    <MarginSection
      marginSource='custom'
      setMarginSource={() => {}}
      customOnly
      customNote='沒有支台齒時 AI margin 模型找不到邊緣線，請直接在牙齦上畫出 abutment 要落的位置，或上傳 .pts。支台齒不會超出這條 margin，牙齦環太小時可以畫大一點。'
      fdi={fdi}
      prepJaw={prepJaw}
      hasPrepScan={hasPrep}
      busy={running}
      notice={marginNotice}
      setNotice={setMarginNotice}
      onPredict={() => {}}
    />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>3</span>支台齒參數</div>
      <Radio.Group
        value={heightMode}
        onChange={e => setHeightMode(e.target.value)}
        disabled={Boolean(running)}
        options={[{ label: '自然高度', value: 'auto' }, { label: '指定高度', value: 'manual' }]}
      />
      <div className='field-row'>
        {heightMode === 'manual' && <label>
          高度（mm）
          <InputNumber min={HEIGHT_RANGE[0]} max={HEIGHT_RANGE[1]} step={0.5} value={height} onChange={v => setHeight(v ?? 4.0)} disabled={Boolean(running)} />
        </label>}
        <label>
          肩台寬（mm）
          <InputNumber min={SHOULDER_RANGE[0]} max={SHOULDER_RANGE[1]} step={0.1} value={shoulder} onChange={v => setShoulder(v ?? DEFAULT_SHOULDER)} disabled={Boolean(running)} />
        </label>
        <label>
          離對咬（mm）
          <InputNumber min={CLEARANCE_RANGE[0]} max={CLEARANCE_RANGE[1]} step={0.1} value={clearance} onChange={v => setClearance(v ?? DEFAULT_CLEARANCE)} disabled={Boolean(running)} />
        </label>
      </div>
      <Radio.Group
        value={axisMode}
        onChange={e => setAxisMode(e.target.value)}
        disabled={Boolean(running)}
        options={[{ label: '插入方向：自然傾斜', value: 'natural' }, { label: '指定插入方向（scan body）', value: 'manual' }]}
      />
      {axisMode === 'manual' && <div className='field-row'>
        {['x', 'y', 'z'].map((name, index) => <label key={name}>
          {name}
          <InputNumber step={0.1} value={axis[index]} onChange={v => setAxis(prev => prev.map((p, i) => (i === index ? (v ?? 0) : p)))} disabled={Boolean(running)} />
        </label>)}
      </div>}
      <p className='panel-note'>
        高度是支台齒頂端到 margin 平均高度的距離。自然高度與傾斜是 101 trainingData 同一牙位真實支台齒的中位數
        （真實支台齒到對咬最近約 1.0–1.3 mm）。對咬在正上方、離不夠時自動降低，不低於 2 mm；
        對咬在旁邊（前牙深覆咬）時降低沒有幫助，只降到有幫助為止，兩種都會標示出來。插入方向用口掃上傳時的座標（正負都可以）。
      </p>
    </section>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>4</span>生成支台齒</div>
      <div className='target-row'>
        <span>{site.label} <span className='target-hint'>{site.hint}</span></span>
        <Button onClick={checkHealth} disabled={Boolean(running)}>檢查</Button>
      </div>
      {health && <div className={`health-line ${health.ok === false ? 'bad' : health.ok ? 'good' : ''}`}>{health.text}</div>}
      <div className='generate-summary'>
        <Tag>自訂 margin（mode=stump）</Tag>
        <Tag color='gold'>EZCAD 支台齒資料庫</Tag>
        {axisMode === 'manual' && <Tag color='purple'>指定插入方向</Tag>}
        {hasPrep && <Tag color={singleArch ? 'orange' : 'blue'}>{singleArch ? '單顎' : '上下顎'}</Tag>}
      </div>
      <Button
        type='primary'
        size='large'
        block
        loading={running === 'stump'}
        disabled={Boolean(running) || blockers.length > 0}
        onClick={run}
      >
        生成支台齒
      </Button>
      {blockers.length > 0 && !running && <ul className='blocker-list'>
        {blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
      </ul>}

      <ResultView
        running={running}
        progress={progress}
        error={error}
        result={result}
        onEditRing={() => {}}
      />
      {record && <pre className='flow-message'>{[
        `牙位群組 ${record.group}（${record.group_source}）· 資料庫 ${record.cap}`,
        `高度 ${record.height_mm} mm（自然 ${record.natural_height_mm} mm）· 肩台 ${record.shoulder_mm} mm · 離對咬 ${record.antagonist_gap_mm ?? '—'} mm（要求 ${record.clearance_mm}）`,
        `插入方向 ${record.axis_source === 'caller' ? '指定' : '自然傾斜'}，離咬合方向 ${record.axis_from_occlusal_deg}° · 原座標 [${(record.insertion_axis_original ?? []).map(v => Number(v).toFixed(3)).join(', ')}]`,
        `cap 縮放 ${record.cap_scale.join(' / ')} · margin 環 ${record.ring_md_bl_mm.join(' × ')} mm（近遠心 × 頰舌）`,
        `洞口 ${record.hole_edge_vertices} 點，吸附到 margin ${record.hole_snapped.moved} 點（最多 ${record.hole_snapped.max_move_mm} mm）· 沒縫合的邊 ${record.open_margin_edges}`,
      ].join('\n')}</pre>}
    </section>
  </div>;
};

export default StumpPanel;
