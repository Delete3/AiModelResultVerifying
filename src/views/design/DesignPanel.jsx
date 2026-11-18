/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Button, Segmented, Select, Tag } from 'antd';

import Editor from '../../utils/Editor';
import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts } from '../../utils/function/margin-editor/marginPts';
import {
  getPipelineHealth, isAnteriorFdi, isPosteriorFdi, singleArchTargets, CROWN_MODELS, PIPELINE_MODES, PIPELINE_TARGETS,
  runPipelineJob,
} from '../../utils/function/EzaiPipelineApi';
import { loadLibraryIndex } from '../../utils/function/peek/peekBase';
import { useMarginEditor } from '../../utils/tool/useStores';
import PeekBuilder from '../peek/peekBuilder';
import PeekLowerSection from '../peek/PeekLowerSection';
import { DEFAULT_LIBRARY_PART, PEEK_DEFAULTS, pickLibraryPart } from '../peek/peekParams';
import AbutmentBuilder from '../stump/abutmentBuilder';
import AbutmentSection from '../stump/AbutmentSection';
import CaseSection from './CaseSection';
import CrownDocs from './CrownDocs';
import CrownOptions from './CrownOptions';
import describeFailure from './describeFailure';
import MarginSection from './MarginSection';
import ResultView from './ResultView';
import StumpOptions from './StumpOptions';
import StumpRecord from './StumpRecord';
import targetWith from './targetWith';
import {
  AXIS_SOURCE, SHAPE_LABEL, STYLE_NAME, initialSpec, isLibrary, noAbutmentOption, sentAxis, specBlockers, stumpOption,
} from './stumpSpec';
import useLowerBuild from './useLowerBuild';

const JAW_NAME = { upper: '上顎', lower: '下顎' };
const TARGET_STORAGE_KEY = 'checkingViewer.pipelineTarget';

// What the tab makes. One case (scans, FDI, margin) and one pipeline target serve all three; they
// were three tabs until 2026-11-18 (牙冠設計, peek abut設計, 產生支台齒).
const PRODUCTS = {
  crown: {
    label: '牙冠',
    sub: '有支台齒',
    summary: <>已修磨的支台齒 → 牙冠。margin 讓 AI 預測（<code>mode=full</code>），或自己畫、上傳（<code>margin_override</code>）。</>,
    prepRole: '備牙顎',
    settings: '牙冠選項',
    action: '生成牙冠',
  },
  peek: {
    label: 'PEEK abut',
    sub: '植體 · 牙冠外壁',
    summary: <>植體位置還沒有支台齒：在牙齦上畫出牙冠要落的位置，服務在環內放一個支台齒再生成牙冠，只有<b>外壁</b>可用（<code>no_abutment=true</code>）；接著在瀏覽器建 PEEK 下半部。</>,
    prepRole: '植體位置所在顎',
    settings: '支台齒與牙冠',
    action: '生成牙冠外壁',
    marginNote: '沒有支台齒時 AI margin 模型找不到邊緣線，請直接在牙齦上畫出牙冠要落的位置，或上傳 .pts。',
  },
  stump: {
    label: '支台齒',
    sub: '植體 · 上半部',
    summary: <>植體位置還沒有支台齒：沿 margin 把口掃挖開，縫進一顆支台齒（資料庫形狀，或牙冠 cutback 剩下的部分），不做牙冠（<code>mode=stump</code>）；接著在瀏覽器做客製化支台齒。</>,
    prepRole: '植體位置所在顎',
    settings: '支台齒',
    action: '生成支台齒',
    marginNote: '沒有支台齒時 AI margin 模型找不到邊緣線，請直接在牙齦上畫出 abutment 要落的位置，或上傳 .pts。支台齒不會超出這條 margin，牙齦環太小時可以畫大一點。',
  },
};

const NO_OPPOSING = {
  crown: {
    message: '沒有對咬顎：以單顎模式生成',
    description: '對咬會用「鄰牙高度的平面」代替，牙冠咬合面沒有依照真實咬合，需另外確認。',
  },
  stump: { message: '沒有對咬顎', description: '支台齒用自然高度，不檢查離對咬的距離。' },
};
const IGNORE_LABEL = {
  crown: '忽略對咬顎，用單顎模式生成（比較用）',
  stump: '忽略對咬顎（不檢查離對咬的距離）',
};

// A custom abutment as one titanium piece on the implant: a 2-piece Ti-base's chimney seldom fits
// inside a stump the way it does inside a PEEK crown.
const ABUTMENT_PART = { ...DEFAULT_LIBRARY_PART, subtype: '1-Piece' };

const drawPeek = (solid, tibase) => CaseScene.setPeek(solid, tibase);
const clearPeek = () => CaseScene.clearPeek();
const drawAbutment = (solid, tibase) => CaseScene.setCustomAbutment(solid, tibase);
const clearAbutment = () => CaseScene.clearCustomAbutment();

const readStoredTarget = () => {
  try {
    const stored = window.localStorage.getItem(TARGET_STORAGE_KEY);
    return PIPELINE_TARGETS[stored] && !PIPELINE_TARGETS[stored].panel ? stored : 'z790';
  } catch {
    return 'z790';
  }
};

/** The ring's centroid, uploaded frame, or null without a closed ring. */
const ringCentre = () => {
  const ring = MarginEditor.getRing();
  if (!ring) return null;
  const centre = new THREE.Vector3();
  for (const point of ring) centre.add(point);
  return centre.divideScalar(ring.length);
};

/**
 * 「牙冠設計」: case → margin → a crown, a PEEK abut (a crown's outer shell over a stump, for a
 * site with no abutment, and the PEEK lower part built here), or a stump (stitched into the scan,
 * and a custom abutment built here) -- all through ezai-pipeline, on whichever target is chosen.
 *
 * Props: fdi, setFdi, allToothFdi, setAllToothFdi, prepJaw, scene (CaseScene snapshot), active
 * (this tab is shown: the insertion arrow is this tab's alone).
 */
const DesignPanel = ({ fdi, setFdi, allToothFdi, setAllToothFdi, prepJaw, scene, active }) => {
  const editor = useMarginEditor();
  const [product, setProduct] = useState('crown');
  const [marginSource, setMarginSource] = useState('ai');
  const [marginNotice, setMarginNotice] = useState(null);
  const [ignoreOpposing, setIgnoreOpposing] = useState(false);
  // 'default' (the service's own, v3) or a CROWN_MODELS key; deliberately not remembered across
  // visits, so nobody builds HeyGears crowns today because of a choice made last week.
  const [crownModel, setCrownModel] = useState('default');
  const [occlusalClearance, setOcclusalClearance] = useState(null);
  const [occlusalDetail, setOcclusalDetail] = useState(false);
  const [contralateral, setContralateral] = useState(false);
  const [peekSpec, setPeekSpec] = useState(() => initialSpec('virtual'));
  const [stumpSpec, setStumpSpec] = useState(() => initialSpec('library'));
  const [target, setTarget] = useState(readStoredTarget);
  const [viewerConfig, setViewerConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [running, setRunning] = useState(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [libraryIndex, setLibraryIndex] = useState(null);
  const [peekEnabled, setPeekEnabled] = useState(true);
  const [peekParams, setPeekParams] = useState({ ...PEEK_DEFAULTS });
  const [peekPart, setPeekPart] = useState(null);
  const [abutEnabled, setAbutEnabled] = useState(true);
  const [abutParams, setAbutParams] = useState({ ...PEEK_DEFAULTS });
  const [abutPart, setAbutPart] = useState(null);

  const peekBuild = useLowerBuild({
    createBuilder: () => new PeekBuilder(),
    draw: drawPeek,
    clear: clearPeek,
    enabled: peekEnabled && product === 'peek',
    params: peekParams,
    part: peekPart,
  });
  const abutBuild = useLowerBuild({
    createBuilder: () => new AbutmentBuilder(),
    draw: drawAbutment,
    clear: clearAbutment,
    enabled: abutEnabled && product === 'stump',
    params: abutParams,
    part: abutPart,
  });

  useEffect(() => {
    // Which targets this instance can reach. An older server without the endpoint just
    // leaves every target enabled, which is how the panel behaved before it existed.
    fetch('/api/viewer-config')
      .then(response => (response.ok ? response.json() : null))
      .then(setViewerConfig)
      .catch(() => setViewerConfig(null));
    // The implant library, when this instance has one: a real interface says more than the
    // generic placeholder. 2-Piece under a PEEK crown, 1-Piece under a custom abutment.
    loadLibraryIndex().then(index => {
      setLibraryIndex(index);
      if (index) {
        setPeekPart(pickLibraryPart(index, null));
        setAbutPart(pickLibraryPart(index, ABUTMENT_PART));
      }
    });
  }, []);

  const meta = PRODUCTS[product];
  const site = PIPELINE_TARGETS[target];
  const opposingJaw = prepJaw === 'upper' ? 'lower' : prepJaw === 'lower' ? 'upper' : null;
  const has = { upper: scene.hasUpper, lower: scene.hasLower };
  const hasPrep = Boolean(prepJaw && has[prepJaw]);
  const hasOpposing = Boolean(opposingJaw && has[opposingJaw]);
  const singleArch = hasPrep && (!hasOpposing || ignoreOpposing);
  const targetConfigured = viewerConfig?.targets?.[target] ?? true;
  // A crown or a PEEK abut takes the AI margin or a custom one; a site with no abutment has no
  // finish line for the margin model to find.
  const marginMode = product === 'crown' ? marginSource : 'custom';
  const spec = product === 'peek' ? peekSpec : product === 'stump' ? stumpSpec : null;
  const setSpec = product === 'peek' ? setPeekSpec : setStumpSpec;

  // The crown service's options apply wherever a crown is built: the crown, the PEEK abut's shell,
  // and the crown a cutback stump is cut back from. mode=stump refuses contralateral.
  const crownBuilt = product !== 'stump' || stumpSpec.shape === 'cutback';
  const contraOffered = product !== 'stump';
  const anterior = isAnteriorFdi(fdi);
  const posterior = isPosteriorFdi(fdi);
  // Only sent for a front tooth on a target that can do it; the box stays ticked across FDI
  // changes so going 11 -> 21 -> 11 does not lose it.
  const useContralateral = contraOffered && contralateral && anterior && Boolean(site.contralateral);
  const model = crownBuilt ? CROWN_MODELS[crownModel] ?? null : null;  // null: the service's default
  const useOcclusalDetail = crownBuilt && occlusalDetail && posterior && Boolean(site.occlusalDetail);
  const useClearance = crownBuilt ? occlusalClearance : null;
  const libraryStumpWanted = product === 'stump' || (product === 'peek' && isLibrary(peekSpec));

  // The insertion arrow: a library stump's axis -- the one that will be sent, or after a job in the
  // natural mode, the one the job used.
  const axisSpec = spec && isLibrary(spec) ? spec : null;
  const axisToSend = axisSpec ? sentAxis(axisSpec) : null;
  const jobAxis = (result?.stump ?? result?.noAbutment)?.insertion_axis_original ?? null;
  const shownAxis = axisSpec ? axisToSend ?? (axisSpec.axisMode === 'natural' ? jobAxis : null) : null;

  useEffect(() => {
    const centre = active && shownAxis && prepJaw ? ringCentre() : null;
    CaseScene.setInsertionArrow(prepJaw, centre, centre && new THREE.Vector3(...shownAxis).normalize());
  }, [active, shownAxis, prepJaw, editor, scene]);
  useEffect(() => () => CaseScene.clearInsertionArrow(), []);

  // AIrDesign's insertion operation: the reverse of where the camera looks, in the frame of the
  // uploaded scan (the frame the service takes the axis in).
  const captureView = () => {
    const mesh = CaseScene.meshes[prepJaw];
    if (!mesh || !Editor.control) return;
    mesh.updateMatrixWorld();
    const toScan = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
    const look = Editor.control.camera.getWorldDirection(new THREE.Vector3());
    const insertion = look.negate().applyMatrix3(toScan).normalize();
    setSpec(prev => ({ ...prev, viewAxis: insertion.toArray().map(v => Number(v.toFixed(4))) }));
  };

  const lookAlong = () => {
    const centre = ringCentre();
    if (centre && shownAxis) CaseScene.viewAlong(prepJaw, centre, new THREE.Vector3(...shownAxis).normalize());
  };

  // What is on screen describes one job; a new case, scan or product puts it away.
  const dropJob = () => {
    peekBuild.drop();
    abutBuild.drop();
    CaseScene.clearCrown();
    setResult(null);
  };

  const chooseProduct = value => {
    if (value === product) return;
    setProduct(value);
    dropJob();
    CaseScene.clearReferenceRing();
    setError(null);
  };

  const chooseTarget = value => {
    setTarget(value);
    setHealth(null);
    if (CROWN_MODELS[crownModel] && !PIPELINE_TARGETS[value]?.crownModels?.includes(crownModel)) {
      setCrownModel('default');
      setOcclusalClearance(null);
      setOcclusalDetail(false);
    }
    try {
      window.localStorage.setItem(TARGET_STORAGE_KEY, value);
    } catch {
      // private window or blocked storage: the choice just does not persist
    }
  };

  const chooseCrownModel = value => {
    setCrownModel(value);
    // Each model comes with the clearance its customer's callers send (HeyGears 0.2 mm), and the
    // default goes back to none, as every other caller sends; either can be edited afterwards.
    setOcclusalClearance(CROWN_MODELS[value]?.occlusalClearanceMm ?? null);
    // HeyGears style comes with 咬合面細節 ticked, and v3 goes back to unticked (user, 2026-11-04).
    setOcclusalDetail(Boolean(CROWN_MODELS[value]?.occlusalDetail));
  };

  // Ticking an option takes the panel to a target that has it; unticking leaves the target alone,
  // so on / off on the same case and target is one click.
  const toggleContralateral = checked => {
    setContralateral(checked);
    const where = targetWith(s => s.contralateral);
    if (checked && !site.contralateral && where) chooseTarget(where);
  };
  const toggleOcclusalDetail = checked => {
    setOcclusalDetail(checked);
    const where = targetWith(s => s.occlusalDetail);
    if (checked && !site.occlusalDetail && where) chooseTarget(where);
  };

  const uploadScan = jaw => async file => {
    setScanError(null);
    try {
      await CaseScene.setScan(jaw, file);
      dropJob();
      if (CaseScene.referenceRing?.parent === CaseScene.meshes[jaw] || !CaseScene.meshes[prepJaw]) {
        CaseScene.clearReferenceRing();
      }
      if (jaw === prepJaw) {
        setPeekSpec(prev => ({ ...prev, viewAxis: null }));
        setStumpSpec(prev => ({ ...prev, viewAxis: null }));
      }
    } catch (uploadError) {
      setScanError(uploadError.message);
    }
    return false;
  };

  const removeScan = jaw => {
    CaseScene.removeScan(jaw);
    dropJob();
    if (jaw === prepJaw) {
      setPeekSpec(prev => ({ ...prev, viewAxis: null }));
      setStumpSpec(prev => ({ ...prev, viewAxis: null }));
    }
  };

  const labelOf = key => PIPELINE_TARGETS[key]?.label;
  const caseBlockers = [];
  if (!prepJaw) caseBlockers.push('輸入有效的 FDI（11–48）');
  else if (!hasPrep) caseBlockers.push(`上傳${JAW_NAME[prepJaw]}（FDI ${fdi} 所在的顎）`);
  if (singleArch && !site.singleArch) caseBlockers.push(`「${site.label}」不支援單顎：改選 ${singleArchTargets()} 或補上對咬顎`);
  if (!targetConfigured) caseBlockers.push(`這個實例沒有設定「${site.label}」`);

  const blockers = [...caseBlockers];
  if (marginMode === 'custom') {
    if (editor.mode === 'draw') blockers.push('完成 margin 繪製（閉合）');
    else if (!editor.hasRing) blockers.push(product === 'crown' ? '繪製或上傳 margin' : '在牙齦上繪製或上傳 margin');
  }
  if (product === 'peek' && !site.noAbutment) {
    blockers.push(`「${site.label}」不能做 PEEK abut（no_abutment）：改選「${labelOf(targetWith(s => s.noAbutment))}」`);
  }
  if (libraryStumpWanted && !site.libraryStump) {
    blockers.push(`「${site.label}」沒有資料庫／cutback 支台齒：改選「${labelOf(targetWith(s => s.libraryStump))}」`
      + (product === 'peek' ? '或改回通用虛擬支台齒' : ''));
  }
  if (spec) blockers.push(...specBlockers(spec));
  if (contraOffered && contralateral && anterior && !site.contralateral) {
    blockers.push(`「${site.label}」不能參考對側牙：改選「${labelOf(targetWith(s => s.contralateral))}」或取消勾選`);
  }
  if (model && !site.crownModels?.includes(crownModel)) {
    blockers.push(`「${site.label}」還沒有「${model.label}」牙冠模型：改選「${labelOf(targetWith(s => s.crownModels?.includes(crownModel)))}」或改回 v3`);
  }
  if (crownBuilt && occlusalDetail && posterior && !site.occlusalDetail) {
    blockers.push(`「${site.label}」還沒有「咬合面細節」：改選「${labelOf(targetWith(s => s.occlusalDetail))}」或取消勾選`);
  }

  const generateMode = product === 'stump' ? PIPELINE_MODES.stump
    : marginMode === 'custom' ? PIPELINE_MODES.marginOverride : PIPELINE_MODES.full;

  const run = async mode => {
    const predicting = mode === PIPELINE_MODES.marginOnly;
    const forProduct = product;
    const ring = !predicting && marginMode === 'custom' ? MarginEditor.getRing() : null;
    setRunning(predicting ? 'margin' : 'job');
    setError(null);
    setProgress('準備中…');
    // The result panel only ever describes one job, so whatever is on screen goes with it.
    dropJob();
    CaseScene.resetScanMatrices();
    if (forProduct !== 'crown') CaseScene.clearReferenceRing();
    if (ring) MarginEditor.setEditing(false);
    const startedAt = performance.now();
    try {
      const job = await runPipelineJob({
        upperStl: CaseScene.files.upper,
        lowerStl: CaseScene.files.lower,
        fdi: Number(fdi),
        allToothFdi: forProduct === 'crown' ? allToothFdi : '',
        mode,
        marginPts: ring ? formatMarginPts(ring, fdi) : null,
        singleArch,
        noAbutment: forProduct === 'peek' ? noAbutmentOption(peekSpec) : null,
        stump: forProduct === 'stump' ? stumpOption(stumpSpec) : null,
        contralateral: useContralateral,
        // A margin prediction builds no crown, so none of these is sent with it.
        crownModel: !predicting && model ? crownModel : null,
        occlusalClearanceMm: predicting ? null : useClearance,
        occlusalDetail: !predicting && useOcclusalDetail,
        target,
        onStage: setProgress,
      });
      job.totalSeconds = (performance.now() - startedAt) / 1000;

      if (predicting) {
        MarginEditor.setRing(job.marginOriginal, 'ai');
        CaseScene.clearReferenceRing();
        CaseScene.focusRing(job.prepJaw, job.marginOriginal);
        setMarginSource('custom');
        setMarginNotice({ type: 'info', text: 'AI 預測的 margin 已載入，可拖曳修改後再生成牙冠。' });
      } else if (forProduct === 'stump') {
        // The crown first: setCrown clears whatever stump is on screen.
        if (job.cutbackCrown) await CaseScene.setCrown(job.cutbackCrown, job.cutbackCrownName, { translucent: true });
        if (job.stumpMesh) await CaseScene.setStump(job.stumpMesh, job.stumpMeshName, { solid: true });
      } else {
        await CaseScene.setCrown(job.blob, job.fileName);
        if (forProduct === 'crown' && mode === PIPELINE_MODES.full) CaseScene.setReferenceRing(job.prepJaw, job.marginOriginal);
        else CaseScene.clearReferenceRing();
        if (job.virtualPrep) await CaseScene.setStump(job.virtualPrep, job.virtualPrepName);
      }
      setResult(job);

      // The part built in this browser from the job: the PEEK lower part from the shell, the
      // custom abutment from the stump (standing on the stump's insertion axis).
      const buildInput = {
        marginOriginal: job.marginOriginal,
        rotation: job.rotation,
        fdi: Number(fdi),
        prepPositions: CaseScene.meshes[job.prepJaw].geometry.getAttribute('position').array,
      };
      if (forProduct === 'peek' && job.blob) await peekBuild.setJob({ ...buildInput, crownBlob: job.blob });
      if (forProduct === 'stump' && job.stumpMesh) {
        await abutBuild.setJob({ ...buildInput, stumpBlob: job.stumpMesh, axis: job.stump?.insertion_axis_original });
      }
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

  const targetOptions = Object.entries(PIPELINE_TARGETS).filter(([, entry]) => !entry.panel).map(([key, entry]) => ({
    value: key,
    disabled: viewerConfig ? !viewerConfig.targets?.[key] : false,
    label: <div className='target-option'>
      <span>{entry.label}</span>
      {entry.singleArch && <Tag color='orange' bordered={false}>單顎</Tag>}
      <span className='target-hint'>{entry.hint}</span>
    </div>,
  }));

  const crownOptions = note => <CrownOptions
    site={site}
    fdi={fdi}
    prepJaw={prepJaw}
    busy={running}
    crownModel={crownModel}
    occlusalClearance={occlusalClearance}
    contralateral={contralateral}
    occlusalDetail={occlusalDetail}
    onModel={chooseCrownModel}
    onClearance={setOcclusalClearance}
    onContralateral={toggleContralateral}
    onDetail={toggleOcclusalDetail}
    showContralateral={contraOffered}
    note={note}
  />;

  const stumpOptions = shapes => <StumpOptions
    spec={spec}
    setSpec={setSpec}
    shapes={shapes}
    product={product}
    busy={running}
    hasPrep={hasPrep}
    hasRing={editor.hasRing}
    shownAxis={shownAxis}
    onCaptureView={captureView}
    onLookAlong={lookAlong}
  />;

  const stumpKind = product === 'stump'
    ? (stumpSpec.shape === 'cutback' ? `Cutback（${STYLE_NAME[stumpSpec.cutbackStyle]}）：資料庫支台齒 → 牙冠 → 往內縮` : 'EZCAD 支台齒資料庫')
    : null;

  return <div className='design-panel'>
    <CrownDocs />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>1</span>要做什麼</div>
      <Segmented
        block
        className='product-picker'
        value={product}
        onChange={chooseProduct}
        disabled={Boolean(running)}
        options={Object.entries(PRODUCTS).map(([value, entry]) => ({
          value,
          label: <div className='product-option'><b>{entry.label}</b><small>{entry.sub}</small></div>,
        }))}
      />
      <p className='panel-note product-summary'>{meta.summary}</p>
    </section>

    <CaseSection
      step={2}
      fdi={fdi}
      setFdi={setFdi}
      allToothFdi={allToothFdi}
      setAllToothFdi={marginMode === 'ai' ? setAllToothFdi : null}
      prepJaw={prepJaw}
      prepRole={meta.prepRole}
      scene={scene}
      busy={running}
      onUpload={uploadScan}
      onRemove={removeScan}
      scanError={scanError}
      ignoreOpposing={ignoreOpposing}
      setIgnoreOpposing={setIgnoreOpposing}
      noOpposing={NO_OPPOSING[product === 'stump' ? 'stump' : 'crown']}
      ignoreLabel={IGNORE_LABEL[product === 'stump' ? 'stump' : 'crown']}
    />

    <MarginSection
      step={3}
      marginSource={marginMode}
      setMarginSource={value => {
        setMarginSource(value);
        if (value === 'ai' && editor.mode !== 'idle') MarginEditor.setEditing(false);
      }}
      customOnly={product !== 'crown'}
      customNote={meta.marginNote ?? null}
      fdi={fdi}
      prepJaw={prepJaw}
      hasPrepScan={hasPrep}
      busy={running}
      notice={marginNotice}
      setNotice={setMarginNotice}
      onPredict={() => {
        if (caseBlockers.length) {
          setError(`還不能預測：${caseBlockers.join('；')}`);
          return;
        }
        run(PIPELINE_MODES.marginOnly);
      }}
    />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>4</span>{meta.settings}</div>
      {product === 'crown' && crownOptions(null)}
      {product === 'peek' && <>
        <div className='sub-title'>牙冠底下的支台齒</div>
        {stumpOptions(['virtual', 'library', 'cutback'])}
        <div className='sub-title'>牙冠</div>
        {crownOptions(null)}
      </>}
      {product === 'stump' && <>
        {stumpOptions(['library', 'cutback'])}
        {stumpSpec.shape === 'cutback' && <>
          <div className='sub-title'>Cutback 用的牙冠</div>
          {crownOptions('切成支台齒之前，先在資料庫支台齒上生成的那顆牙冠。')}
        </>}
      </>}
    </section>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>5</span>{meta.action}</div>
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
        {product === 'crown' && <Tag>{generateMode === PIPELINE_MODES.full ? 'AI margin（mode=full）' : '自訂 margin（mode=margin_override）'}</Tag>}
        {product === 'peek' && <>
          <Tag>自訂 margin（mode=margin_override）</Tag>
          <Tag color='green'>no_abutment · {SHAPE_LABEL[peekSpec.shape]}</Tag>
        </>}
        {product === 'stump' && <>
          <Tag>自訂 margin（mode=stump）</Tag>
          <Tag color='gold'>{stumpKind}</Tag>
        </>}
        {axisSpec && axisSpec.axisMode !== 'natural' && <Tag color='purple'>插入方向：{AXIS_SOURCE[axisSpec.axisMode]}</Tag>}
        {hasPrep && <Tag color={singleArch ? 'orange' : 'blue'}>{singleArch ? '單顎' : '上下顎'}</Tag>}
        {useContralateral && <Tag color='purple'>參考對側牙</Tag>}
        {useOcclusalDetail && <Tag color='cyan'>咬合面細節</Tag>}
        {model && <Tag color='geekblue'>{model.label}</Tag>}
        {useClearance != null && <Tag>咬合間隙 {useClearance} mm</Tag>}
        {product === 'peek' && peekEnabled && <Tag color='gold'>PEEK 下半部：瀏覽器</Tag>}
        {product === 'stump' && abutEnabled && <Tag color='blue'>客製化支台齒：瀏覽器</Tag>}
      </div>
      <Button
        type='primary'
        size='large'
        block
        loading={running === 'job'}
        disabled={Boolean(running) || blockers.length > 0}
        onClick={() => run(generateMode)}
      >
        {meta.action}
      </Button>
      {blockers.length > 0 && !running && <ul className='blocker-list'>
        {blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
      </ul>}

      <ResultView running={running} progress={progress} error={error} result={result} onEditRing={editResultRing} />
      {product === 'stump' && !running && <StumpRecord record={result?.stump ?? null} />}
    </section>

    {product === 'peek' && <PeekLowerSection
      step={6}
      enabled={peekEnabled}
      setEnabled={setPeekEnabled}
      params={peekParams}
      setParams={setPeekParams}
      library={peekPart}
      setLibrary={value => setPeekPart(value === 'default' ? pickLibraryPart(libraryIndex, peekPart) : value)}
      libraryIndex={libraryIndex}
      state={peekBuild.state}
      busy={peekBuild.busy}
      error={peekBuild.error}
      hasShell={peekBuild.hasJob}
      onRebuild={peekBuild.rebuild}
      result={result}
      running={running}
    />}
    {product === 'stump' && <AbutmentSection
      step={6}
      enabled={abutEnabled}
      setEnabled={setAbutEnabled}
      params={abutParams}
      setParams={setAbutParams}
      library={abutPart}
      setLibrary={value => setAbutPart(value === 'default' ? pickLibraryPart(libraryIndex, abutPart ?? ABUTMENT_PART) : value)}
      libraryIndex={libraryIndex}
      state={abutBuild.state}
      busy={abutBuild.busy}
      error={abutBuild.error}
      hasStump={abutBuild.hasJob}
      onRebuild={abutBuild.rebuild}
      result={result}
      running={running}
    />}
  </div>;
};

export default DesignPanel;
