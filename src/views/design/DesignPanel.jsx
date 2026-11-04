/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Select, Tag, Tooltip, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts } from '../../utils/function/margin-editor/marginPts';
import { getPipelineHealth, isAnteriorFdi, isPosteriorFdi, singleArchTargets, CROWN_MODELS, PIPELINE_MODES, PIPELINE_TARGETS, runPipelineJob } from '../../utils/function/EzaiPipelineApi';
import { SCAN_ACCEPT } from '../../utils/loader/loadGeometry';
import { useMarginEditor } from '../../utils/tool/useStores';
import CrownDocs from './CrownDocs';
import describeFailure from './describeFailure';
import MarginSection from './MarginSection';
import ResultView from './ResultView';

const JAW_NAME = { upper: '上顎', lower: '下顎' };
const TARGET_STORAGE_KEY = 'checkingViewer.pipelineTarget';

const readStoredTarget = () => {
  try {
    const stored = window.localStorage.getItem(TARGET_STORAGE_KEY);
    // A target that belongs to another tab (`panel`) is never offered here.
    return PIPELINE_TARGETS[stored] && !PIPELINE_TARGETS[stored].panel ? stored : 'z790';
  } catch {
    return 'z790';
  }
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
  const [contralateral, setContralateral] = useState(false);
  // 'default' (the service's own, v3) or a CROWN_MODELS key; deliberately not remembered across
  // visits, so nobody builds HeyGears crowns today because of a choice made last week.
  const [crownModel, setCrownModel] = useState('default');
  const [occlusalClearance, setOcclusalClearance] = useState(null);
  const [occlusalDetail, setOcclusalDetail] = useState(false);
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
  const anterior = isAnteriorFdi(fdi);
  // Only sent for a front tooth on a target that can do it; the checkbox stays ticked across
  // FDI changes so going 11 -> 21 -> 11 does not lose it.
  const useContralateral = contralateral && anterior && Boolean(site.contralateral);
  const contraTarget = Object.keys(PIPELINE_TARGETS).find(key => PIPELINE_TARGETS[key].contralateral);
  const model = CROWN_MODELS[crownModel] ?? null;  // null: the service's default
  const modelTargetOf = name => Object.keys(PIPELINE_TARGETS)
    .find(key => !PIPELINE_TARGETS[key].panel && PIPELINE_TARGETS[key].crownModels?.includes(name));
  // Like 「參考對側牙」: only sent for a back tooth on a target that has it, and the box stays
  // ticked across FDI changes.
  const posterior = isPosteriorFdi(fdi);
  const useOcclusalDetail = occlusalDetail && posterior && Boolean(site.occlusalDetail);
  const detailTarget = Object.keys(PIPELINE_TARGETS)
    .find(key => !PIPELINE_TARGETS[key].panel && PIPELINE_TARGETS[key].occlusalDetail);
  // A tooth the model was not trained on is still sent; the crown service answers with v3.
  const modelSkipsTooth = Boolean(model && prepJaw && !model.teeth.includes(Number(fdi) % 10));

  const chooseTarget = value => {
    setTarget(value);
    setHealth(null);
    if (CROWN_MODELS[crownModel] && !PIPELINE_TARGETS[value]?.crownModels?.includes(crownModel)) {
      setCrownModel('default');
      setOcclusalClearance(null);
    }
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
  if (contralateral && anterior && !site.contralateral) blockers.push(`「${site.label}」不能參考對側牙：改選「${PIPELINE_TARGETS[contraTarget]?.label}」或取消勾選`);
  // Only generating needs the model, so this one does not stop a margin prediction.
  const modelBlocker = model && !site.crownModels?.includes(crownModel)
    ? `「${site.label}」還沒有「${model.label}」牙冠模型：改選「${PIPELINE_TARGETS[modelTargetOf(crownModel)]?.label}」或改回 v3`
    : null;
  if (modelBlocker) blockers.push(modelBlocker);
  // Generating only, as with the model.
  const detailBlocker = occlusalDetail && posterior && !site.occlusalDetail
    ? `「${site.label}」還沒有「咬合面細節」：改選「${PIPELINE_TARGETS[detailTarget]?.label}」或取消勾選`
    : null;
  if (detailBlocker) blockers.push(detailBlocker);

  const chooseCrownModel = value => {
    setCrownModel(value);
    // Each model comes with the clearance its customer's callers send (HeyGears 0.2 mm), and the
    // default goes back to none, as every other caller sends; either can be edited afterwards.
    setOcclusalClearance(CROWN_MODELS[value]?.occlusalClearanceMm ?? null);
    // HeyGears style comes with 咬合面細節 ticked; going back to v3 leaves the box as it is.
    if (CROWN_MODELS[value]?.occlusalDetail) setOcclusalDetail(true);
  };

  const toggleContralateral = checked => {
    setContralateral(checked);
    // The option lives on one test endpoint for now, so ticking it takes the user there;
    // unticking leaves the target alone, which is what makes an on/off comparison on the
    // same endpoint one click.
    if (checked && !site.contralateral && contraTarget) chooseTarget(contraTarget);
  };

  const toggleOcclusalDetail = checked => {
    setOcclusalDetail(checked);
    // Ticking it takes the panel to a target that has it; unticking leaves the target alone,
    // so on / off on the same case and target is one click.
    if (checked && !site.occlusalDetail && detailTarget) chooseTarget(detailTarget);
  };

  const predictBlockers = blockers.filter(b => !b.includes('margin') && b !== modelBlocker && b !== detailBlocker);

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
        contralateral: useContralateral,
        // A margin prediction builds no crown, so neither is sent with it.
        crownModel: kind === 'crown' && model ? crownModel : null,
        occlusalClearanceMm: kind === 'crown' ? occlusalClearance : null,
        occlusalDetail: kind === 'crown' && useOcclusalDetail,
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
      <Upload accept={SCAN_ACCEPT} showUploadList={false} beforeUpload={uploadScan(jaw)} disabled={Boolean(running)}>
        <Button block size='small' type={has[jaw] ? 'default' : 'dashed'} disabled={Boolean(running)} title={fileName ?? `${JAW_NAME[jaw]}口掃：.stl、.ply 或 .tri`}>
          {fileName ?? '上傳 STL / PLY / TRI'}
        </Button>
      </Upload>
      {has[jaw] && <Button size='small' type='link' danger disabled={Boolean(running)} onClick={() => removeScan(jaw)}>移除</Button>}
    </div>;
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

  const crownModelOptions = [
    { value: 'default', label: <div className='target-option'><span>v3（預設）</span><span className='target-hint'>其他客戶都用這個</span></div> },
    ...Object.entries(CROWN_MODELS).map(([key, entry]) => {
      // Only selectable while the chosen pipeline serves it (HeyGears: the Chiayi targets).
      const served = Boolean(site.crownModels?.includes(key));
      const where = PIPELINE_TARGETS[modelTargetOf(key)]?.label;
      return {
        value: key,
        disabled: !served,
        label: <div className='target-option'>
          <span>{entry.label}</span>
          <span className='target-hint'>{served ? entry.hint : where ? `pipeline 選「${where}」才能選` : '目前沒有主機'}</span>
        </div>,
      };
    }),
  ];

  const generateMode = marginSource === 'custom' ? PIPELINE_MODES.marginOverride : PIPELINE_MODES.full;

  return <div className='design-panel'>
    <CrownDocs />

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

      <div className='field-row'>
        <label>
          <Tooltip title='生成牙冠用的模型。「HeyGears 風格」是用 HeyGears 技師的 exocad 牙冠再訓練的 v3，只學過小臼齒、大臼齒，其他牙位會自動改用 v3（結果會註明）。只有 pipeline 選嘉義時才能選；換到其他 pipeline 會自動改回 v3。選它時會自動填咬合間隙 0.2、勾選「咬合面細節」，都可以再改。'>
            牙冠模型
          </Tooltip>
          <Select value={crownModel} onChange={chooseCrownModel} options={crownModelOptions} disabled={Boolean(running)}
            popupMatchSelectWidth={false} labelRender={() => <span>{model ? model.label : 'v3（預設）'}</span>} />
        </label>
        <label>
          <Tooltip title='牙冠咬合面和對咬牙之間至少留這個距離（mm），由牙冠服務在生成後調整。HeyGears 的設計習慣是 0.2，選 HeyGears 風格時自動填入。空白＝不另外留，其他客戶都是這樣。兩台都支援。'>
            咬合間隙 mm
          </Tooltip>
          <InputNumber min={-0.3} max={1} step={0.05} value={occlusalClearance} onChange={setOcclusalClearance}
            placeholder='不指定' disabled={Boolean(running)} />
        </label>
      </div>
      {modelSkipsTooth && <Alert
        className='section-alert'
        type='info'
        showIcon
        message={`「${model.label}」只學過小臼齒、大臼齒：FDI ${fdi} 會用 v3 生成，結果會註明`}
      />}

      <Tooltip title={anterior
        ? '把整個口掃左右鏡射找出中線，讓牙冠的形狀接近另一側的同名牙（例如 11 參考 21）。位置仍照實際空間。對側缺牙、也是支台齒、或只掃半邊時會自動不套用，並說明原因。每顆約多 2 秒。台中、嘉義的正式 pipeline 都能用。'
        : '只適用前牙（FDI x1–x3）'}>
        <Checkbox checked={contralateral} onChange={e => toggleContralateral(e.target.checked)} disabled={Boolean(running) || !anterior}>
          參考對側牙（前牙）
        </Checkbox>
      </Tooltip>
      <Tooltip title={posterior
        ? '生成後沿窩溝、窩往下挖深，補回模型磨平的咬合面細節。只往下挖：牙尖、接觸點、外壁和邊緣不動，不會更靠近對咬牙，咬合間隙照樣保留。75 例測試起伏多約 12%、形態不變，每顆約多 0.1 秒。v3、HeyGears 都能用；目前只有嘉義有。'
        : '只適用小臼齒、大臼齒（FDI x4–x7）'}>
        <Checkbox checked={occlusalDetail} onChange={e => toggleOcclusalDetail(e.target.checked)} disabled={Boolean(running) || !posterior}>
          咬合面細節（後牙）
        </Checkbox>
      </Tooltip>

      <div className='generate-summary'>
        <Tag>{generateMode === PIPELINE_MODES.full ? 'AI margin（mode=full）' : '自訂 margin（mode=margin_override）'}</Tag>
        {hasPrep && <Tag color={singleArch ? 'orange' : 'blue'}>{singleArch ? '單顎' : '上下顎'}</Tag>}
        {useContralateral && <Tag color='purple'>參考對側牙</Tag>}
        {useOcclusalDetail && <Tag color='cyan'>咬合面細節</Tag>}
        {model && <Tag color='geekblue'>{model.label}</Tag>}
        {occlusalClearance != null && <Tag>咬合間隙 {occlusalClearance} mm</Tag>}
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
