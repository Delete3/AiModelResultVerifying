/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, InputNumber, Radio, Tag, Tooltip, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts } from '../../utils/function/margin-editor/marginPts';
import { getPipelineHealth, isAnteriorFdi, PIPELINE_MODES, PIPELINE_TARGETS, runPipelineJob } from '../../utils/function/EzaiPipelineApi';
import { loadLibraryIndex } from '../../utils/function/peek/peekBase';
import { SCAN_ACCEPT } from '../../utils/loader/loadGeometry';
import { useMarginEditor } from '../../utils/tool/useStores';
import describeFailure from '../design/describeFailure';
import MarginSection from '../design/MarginSection';
import ResultView from '../design/ResultView';
import PeekBuilder from './peekBuilder';
import PeekLowerSection from './PeekLowerSection';
import { DEFAULT_LIBRARY_PART, PEEK_DEFAULTS } from './peekParams';

// Chiayi's production pipeline (/pipeline/), since 2026-10-07; before that the test endpoint
// /pipeline-noabut/, taken down the same day.
const TARGET = 'rtx5090';
// 「參考對側牙」 (front teeth only) goes to Chiayi's contralateral test endpoint instead, which is
// production main plus that option: the same no_abutment shell, refitted to the mirrored same
// tooth on the other side of the arch. See the design tab's checkbox for the same thing.
const CONTRA_TARGET = 'rtx5090_contra';
// 「頸部平順」 (2026-10-08, test): the same endpoint's crown service, asked to bend the shell
// onto the margin over 5 mm instead of 2. A crown wider than the ring (FDI 12 here) is otherwise
// squeezed back within 2 mm: a vertical wall from the margin and a corner, the palatal bulge.
const RIM_FALLOFF_MM = 5;
const JAW_NAME = { upper: '上顎', lower: '下顎' };
// The service's own bounds (ezai-pipeline app/virtual_prep.py); it answers 422 outside them.
const HEIGHT_RANGE = [1.0, 6.0];
const SHOULDER_RANGE = [0.3, 1.5];
const DEFAULT_SHOULDER = 0.8;
// Parameter edits rebuild the PEEK lower part once they settle for this long.
const REBUILD_DELAY_MS = 350;

/** A library part that exists in `index`: `wanted` if it does, else the first one. */
const pickLibraryPart = (index, wanted) => {
  const find = part => index.systems.find(s => s.name === part.system)
    ?.types.find(t => t.name === part.type)?.subtypes.some(u => u.name === part.subtype);
  if (wanted && find(wanted)) return wanted;
  if (find(DEFAULT_LIBRARY_PART)) return DEFAULT_LIBRARY_PART;
  const system = index.systems[0];
  const type = system.types[0];
  return { system: system.name, type: type.name, subtype: type.subtypes[0].name };
};

/**
 * "peek abut設計": a crown's outer surface for a scan that has NO abutment yet -- an implant
 * site whose abutment (PEEK, AI-designed) will be made from the crown afterwards.
 *
 * FlowToothSDF only knows prepared teeth, so this sends the case with no_abutment=true to the
 * Chiayi box's production pipeline, which puts a virtual stump inside the ring before building
 * the crown. The margin model cannot find a finish line that is not there, so the ring is always
 * drawn or uploaded here (mode=margin_override).
 *
 * Shares the case with the design tab -- the same scans, FDI and margin editor -- so a case
 * loaded there can be tried here without uploading it again.
 *
 * The service returns the crown's outer shell only. The PEEK crown's lower part is built
 * here in the browser, the way AIrDesign will build it from the same shell (step 5).
 *
 * Props: fdi, setFdi, prepJaw, scene (CaseScene snapshot).
 */
const PeekAbutPanel = ({ fdi, setFdi, prepJaw, scene }) => {
  const editor = useMarginEditor();
  const [marginNotice, setMarginNotice] = useState(null);
  const [ignoreOpposing, setIgnoreOpposing] = useState(false);
  const [contralateral, setContralateral] = useState(false);
  const [smoothRim, setSmoothRim] = useState(false);
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
  const [peekEnabled, setPeekEnabled] = useState(true);
  const [peekParams, setPeekParams] = useState({ ...PEEK_DEFAULTS });
  const [libraryIndex, setLibraryIndex] = useState(null);
  const [library, setLibraryState] = useState(null);
  const [peekState, setPeekState] = useState(null);
  const [peekBusy, setPeekBusy] = useState(false);
  const [peekError, setPeekError] = useState(null);
  const [hasShell, setHasShell] = useState(false);
  const builder = useRef(null);
  const buildSeq = useRef(0);

  useEffect(() => {
    fetch('/api/viewer-config')
      .then(response => (response.ok ? response.json() : null))
      .then(setViewerConfig)
      .catch(() => setViewerConfig(null));
  }, []);

  // The implant library, when this instance has one: picked by default, since a real
  // interface says more than the generic placeholder.
  useEffect(() => {
    loadLibraryIndex().then(index => {
      setLibraryIndex(index);
      if (index) setLibraryState(pickLibraryPart(index, null));
    });
  }, []);

  useEffect(() => {
    builder.current = new PeekBuilder();
    return () => builder.current.dispose();
  }, []);

  const setLibrary = value => setLibraryState(value === 'default' ? pickLibraryPart(libraryIndex, library) : value);

  const dropPeek = () => {
    buildSeq.current++;
    builder.current?.dispose();
    setHasShell(false);
    setPeekState(null);
    setPeekError(null);
  };

  // Build (or rebuild) the lower part from the shell held by the builder. A build that a
  // newer one overtook is thrown away.
  const rebuildPeek = useCallback(async () => {
    if (!builder.current?.hasJob) return;
    const seq = ++buildSeq.current;
    setPeekBusy(true);
    setPeekError(null);
    // Let the busy state paint: the build runs on this thread for up to a second or so.
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
      if (seq !== buildSeq.current) return;
      const out = await builder.current.build(peekParams, library);
      if (seq !== buildSeq.current) {
        out.solid?.dispose();
        out.tibase?.dispose();
        return;
      }
      if (out.error) {
        CaseScene.clearPeek();
        setPeekState(null);
        setPeekError(out.error);
        return;
      }
      CaseScene.setPeek(out.solid, out.tibase);
      setPeekState(out);
    } catch (buildError) {
      if (seq === buildSeq.current) setPeekError(buildError.message);
    } finally {
      if (seq === buildSeq.current) setPeekBusy(false);
    }
  }, [peekParams, library]);

  // Parameters changed: rebuild once they settle.
  useEffect(() => {
    if (!hasShell || !peekEnabled) return undefined;
    const timer = setTimeout(rebuildPeek, REBUILD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasShell, peekEnabled, rebuildPeek]);

  const anterior = isAnteriorFdi(fdi);
  const useContralateral = contralateral && anterior;
  const target = useContralateral || smoothRim ? CONTRA_TARGET : TARGET;
  const site = PIPELINE_TARGETS[target];
  const opposingJaw = prepJaw === 'upper' ? 'lower' : prepJaw === 'lower' ? 'upper' : null;
  const has = { upper: scene.hasUpper, lower: scene.hasLower };
  const hasPrep = Boolean(prepJaw && has[prepJaw]);
  const hasOpposing = Boolean(opposingJaw && has[opposingJaw]);
  const singleArch = hasPrep && (!hasOpposing || ignoreOpposing);
  const configured = viewerConfig?.targets?.[target] ?? true;

  const uploadScan = jaw => async file => {
    setScanError(null);
    try {
      await CaseScene.setScan(jaw, file);
      CaseScene.clearCrown();
      dropPeek();
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
    dropPeek();
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
    dropPeek();
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
        contralateral: useContralateral,
        rimFalloff: smoothRim ? RIM_FALLOFF_MM : null,
        target,
        onStage: setProgress,
      });
      job.totalSeconds = (performance.now() - startedAt) / 1000;
      await CaseScene.setCrown(job.blob, job.fileName);
      if (job.virtualPrep) await CaseScene.setStump(job.virtualPrep, job.virtualPrepName);
      setResult(job);
      // The shell, the margin and the site go to the builder now; the build itself follows
      // from hasShell (and from every parameter change after it).
      try {
        await builder.current.setJob({
          crownBlob: job.blob,
          marginOriginal: job.marginOriginal,
          rotation: job.rotation,
          fdi: Number(fdi),
          prepPositions: CaseScene.meshes[prepJaw].geometry.getAttribute('position').array,
        });
        setHasShell(true);
      } catch (setupError) {
        setPeekError(setupError.message);
      }
      setHealth({ ok: true, text: `${site.label} 正常 · Job ${job.jobId}` });
    } catch (runError) {
      setError(describeFailure(runError, site));
    } finally {
      setRunning(null);
    }
  };

  const checkHealth = async () => {
    setHealth({ ok: null, text: '檢查中…' });
    setHealth(await getPipelineHealth(target));
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
        送到嘉義 5090 的正式 pipeline（/pipeline，no_abutment=true）。
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
      <Tooltip title={anterior
        ? '把整個口掃左右鏡射找出中線，讓牙冠外壁的形狀接近另一側的同名牙（例如 11 參考 21）。位置仍照實際空間。對側缺牙、也是支台齒、或只掃半邊時會自動不套用，並說明原因。每顆約多 2 秒。測試功能：勾選時改送「5090 參考對側牙（測試）」。'
        : '只適用前牙（FDI x1–x3）'}>
        <Checkbox checked={contralateral} onChange={e => { setContralateral(e.target.checked); setHealth(null); }} disabled={Boolean(running) || !anterior}>
          參考對側牙（前牙，測試）
        </Checkbox>
      </Tooltip>
      <Tooltip title={`牙冠比畫的 margin 寬時（例如 FDI 12 的舌側），服務會在 margin 往上 2 mm 內把外壁拉回 margin，留下一段垂直的牆和一個轉角（舌側凸起）。勾選後改在 ${RIM_FALLOFF_MM} mm 內拉回，變成平順的弧線。和「參考對側牙」一起用、支台齒高度設 1 mm 時，舌側最接近天然牙。測試功能：勾選時改送「5090 參考對側牙（測試）」。`}>
        <Checkbox checked={smoothRim} onChange={e => { setSmoothRim(e.target.checked); setHealth(null); }} disabled={Boolean(running)}>
          頸部平順（測試）
        </Checkbox>
      </Tooltip>
      <div className='generate-summary'>
        <Tag>自訂 margin（mode=margin_override）</Tag>
        <Tag color='green'>no_abutment</Tag>
        {peekEnabled && <Tag color='gold'>PEEK 下半部：瀏覽器</Tag>}
        {useContralateral && <Tag color='purple'>參考對側牙</Tag>}
        {smoothRim && <Tag color='cyan'>頸部平順 {RIM_FALLOFF_MM} mm</Tag>}
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

      <ResultView
        running={running}
        progress={progress}
        error={error}
        result={result}
        onEditRing={() => {}}
      />
    </section>

    <PeekLowerSection
      enabled={peekEnabled}
      setEnabled={setPeekEnabled}
      params={peekParams}
      setParams={setPeekParams}
      library={library}
      setLibrary={setLibrary}
      libraryIndex={libraryIndex}
      state={peekState}
      busy={peekBusy}
      error={peekError}
      hasShell={hasShell}
      onRebuild={rebuildPeek}
      result={result}
      running={running}
    />
  </div>;
};

export default PeekAbutPanel;
