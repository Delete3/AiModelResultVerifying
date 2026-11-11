/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Progress, Radio, Select, Tag, Tooltip, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import ToothAlignScene from '../../utils/function/ToothAlignScene';
import { getToothSsmInfo } from '../../utils/function/ToothSsmApi';
import {
  STEP_NAME,
  V2_SCAN_FORMATS,
  V2_STEPS,
  V2_TARGETS,
  boxLabel,
  bundleScanFile,
  combinationOf,
  deleteV2Job,
  fetchV2Bundle,
  getV2Health,
  isV2Dispatched,
  planMatrix,
  readCrownsZip,
  readV2Bundle,
  splitByLabels,
  submitV2Job,
  waitForV2Job,
} from '../../utils/function/ToothSsmV2Api';
import { downloadBlob, useCaseScene } from '../../utils/tool/useStores';
import ToothAlignDisplay from './ToothAlignDisplay';
import ToothSsmDocs from './ToothSsmDocs';

const JAW_NAME = { upper: '上顎', lower: '下顎' };
const ACCEPT = V2_SCAN_FORMATS.map(f => `.${f}`).join(',');
// The parameters, as GET /v2/capabilities lists them; each belongs to one step and is sent only
// when the job runs that step (the service refuses the others: param_not_used).
const PARAMS = {
  seg: { step: 'segment', label: '分牙', options: [['ssm', 'tooth_ssm（預設）'], ['toothroot', 'ToothRoot（v2 還沒驗證）']] },
  crown: { step: 'generate', label: '牙冠', options: [['fit', 'AI 牙齒擬合口掃（預設）'], ['exact', '口掃牙冠原樣'], ['zhu', '整顆 AI 重新生成']] },
  root: { step: 'generate', label: '牙根', options: [['virtual', '矯正式虛擬牙根（預設）'], ['generated', 'AI 生成牙根'], ['none', '不接牙根（不能排牙）']] },
  res: { step: 'generate', label: '網格解析度', options: [[128, '128（預設）'], [160, '160'], [192, '192（較慢）']] },
  fast_roots: { step: 'generate', label: '生成牙根', options: [[true, '加速版（預設）'], [false, '加速前']] },
  arranged: { step: 'align', label: '排好的網格', options: [[false, '不附（預設）'], [true, '附在結果包']] },
};
const DEFAULTS = { seg: 'ssm', crown: 'fit', root: 'virtual', res: 128, fast_roots: true, arranged: false };
const ABO_ROWS = [
  ['A', '排列'], ['MR', '邊緣嵴'], ['BLI', '頰舌傾斜'], ['OC', '咬合接觸'], ['OR', '咬合關係'],
  ['OJ', '覆蓋'], ['IPC', '鄰接接觸'], ['RA', '牙根平行'], ['ABO7', '總分扣掉 RA'], ['TOTAL', '總分'],
];
const ISSUE_LEVEL = { error: { label: '錯誤', color: 'red' }, warning: { label: '警告', color: 'orange' }, info: { label: '提示', color: 'blue' } };
const fmt = s => (s == null ? '—' : `${s.toFixed(1)} 秒`);

/**
 * The AI排牙 tab with tooth_ssm's API v2 (2026-11-11): one job of any of 分牙 (a), 生成牙齒 (b) and
 * 排牙 (c). A job that does not segment takes the previous job's bundle ("job:<id>"), so a, then
 * c, then b on the same segmentation is three clicks. Every result is drawn from the bundle as the
 * team gets it: the labels cut the scans on screen into crowns, the teeth are its teeth, and the
 * arrangement is plan.json's matrices applied to them (or to the crowns when there are none).
 * Or, input 「只送牙冠」: a zip of crowns already apart, for 排牙 alone; drawn before the job from
 * the zip, and after it from the bundle's merged scan (scan/<jaw>.stl) and labels.
 */
const ToothAlignV2Panel = () => {
  const caseScene = useCaseScene();
  const [mode, setMode] = useState('scans');      // 'scans' | 'crowns'
  const [crowns, setCrowns] = useState(null);     // { file, info: readCrownsZip's } | null
  const [files, setFiles] = useState({ upper: null, lower: null });
  const [target, setTarget] = useState('dispatcher');
  const [steps, setSteps] = useState(['segment', 'generate', 'align']);
  const [params, setParams] = useState(DEFAULTS);
  const [reach, setReach] = useState({});
  const [health, setHealth] = useState(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);   // the last finished job: { target, id, status, bundle, timing, steps }
  const [palette, setPalette] = useState({});
  // every job this panel made, to delete when it is done with them
  const made = useRef([]);
  const bundleRef = useRef(null);
  // crowns zips picked, so a slow preview stops drawing once a newer pick (or a clear) replaced it
  const crownsPick = useRef(0);

  useEffect(() => {
    for (const key of Object.keys(V2_TARGETS)) {
      getV2Health(key).then(h => setReach(r => ({ ...r, [key]: h.ok ? 'ok' : 'down' })))
        .catch(() => setReach(r => ({ ...r, [key]: 'down' })));
    }
    getToothSsmInfo('rtx5090').then(info => {
      setPalette(info.palette ?? {});
      ToothAlignScene.setPalette(info.palette ?? {});
    }).catch(() => {});
    return () => forgetAll();
  }, []);

  const forgetAll = () => {
    for (const job of made.current) deleteV2Job(job.target, job.id);
    made.current = [];
  };

  const byCrowns = mode === 'crowns';
  // crowns go with 排牙 alone (the service refuses the others: input_not_used)
  const activeSteps = byCrowns ? ['align'] : steps;
  const segments = activeSteps.includes('segment');
  // b, c, bc take the previous job's bundle: one that has labels, made the same way in
  const ref = !byCrowns && !segments && result?.status.state === 'succeeded' && result.target === target && result.bundle?.labels.upper
    ? result : null;
  const combination = combinationOf(activeSteps);
  const conflict = activeSteps.includes('align') && activeSteps.includes('generate') && params.root === 'none';
  const crownsReady = Boolean(crowns && !crowns.info.problems.length);

  const showScans = next => {
    ToothAlignScene.clearResults();
    ToothAlignScene.setStage('raw');
    Promise.all(['upper', 'lower'].map(jaw => (next[jaw] ? ToothAlignScene.setRaw(jaw, next[jaw]) : ToothAlignScene.clearJaw(jaw))))
      .then(() => ToothAlignScene.fitView())
      .catch(e => setError(e.message));
  };
  const pickFile = jaw => file => {
    const next = { ...files, [jaw]: file };
    setFiles(next);
    setResult(null);
    setError(null);
    showScans(next);
    return false;
  };
  const takeCaseScans = () => {
    const next = { upper: CaseScene.files.upper, lower: CaseScene.files.lower };
    setFiles(next);
    setResult(null);
    setError(null);
    showScans(next);
  };
  const clearAll = () => {
    forgetAll();
    crownsPick.current += 1;
    ToothAlignScene.clearAll();
    setFiles({ upper: null, lower: null });
    setCrowns(null);
    setResult(null);
    setError(null);
  };

  const switchMode = next => {
    clearAll();
    setMode(next);
  };

  /** Check a crowns zip as the service will, and draw its crowns (stage 分牙, by FDI colour). */
  const pickCrowns = file => {
    const pick = ++crownsPick.current;
    ToothAlignScene.clearAll();
    setResult(null);
    setError(null);
    setCrowns(null);
    (async () => {
      const info = await readCrownsZip(file);
      if (pick !== crownsPick.current) return;
      setCrowns({ file, info });
      const unread = [];
      for (const jaw of ['upper', 'lower']) {
        for (const tooth of info.teeth[jaw]) {
          try {
            const geometry = await info.geometry(tooth.name);
            if (pick !== crownsPick.current) return;
            if (geometry) ToothAlignScene.addGeometry('crowns', jaw, tooth.fdi, geometry);
            else unread.push(tooth.name);
          } catch (e) {
            unread.push(`${tooth.name}（${e.message}）`);
          }
        }
      }
      if (unread.length) setError(`這些檔畫面上畫不出來（服務照樣會讀；.obj 只有服務讀）：${unread.join('、')}`);
      ToothAlignScene.setStage('seg');
      ToothAlignScene.fitView();
    })().catch(e => setError(e.message));
    return false;
  };

  const toggleStep = key => setSteps(s => (s.includes(key) ? s.filter(k => k !== key) : [...s, key]));

  /** Draw a bundle on the scans on screen: the crowns from its labels, its teeth, the plan applied. */
  const draw = bundle => {
    ToothAlignScene.clearResults();
    const crowns = { upper: new Map(), lower: new Map() };
    for (const jaw of ['upper', 'lower']) {
      const labels = bundle.labels[jaw];
      const geometry = ToothAlignScene.rawGeometry(jaw);
      if (!labels || !geometry) continue;
      for (const [label, g] of splitByLabels(geometry, labels)) {
        ToothAlignScene.addGeometry('crowns', jaw, label, g);
        if (label !== 0 && label !== 254) crowns[jaw].set(label, g);
      }
    }
    const hasTeeth = bundle.teeth.length > 0;
    // 「排牙前」: the whole teeth, or the crowns when the job has none (c on scans + labels)
    const before = { upper: new Map(), lower: new Map() };
    if (hasTeeth) for (const t of bundle.teeth) before[t.jaw].set(t.fdi, t.geometry);
    else for (const jaw of ['upper', 'lower']) for (const [fdi, g] of crowns[jaw]) before[jaw].set(fdi, g.clone());
    for (const jaw of ['upper', 'lower']) {
      for (const [fdi, g] of before[jaw]) ToothAlignScene.addGeometry('teeth', jaw, fdi, g);
    }
    if (bundle.plan) {
      for (const jaw of ['upper', 'lower']) {
        const moves = new Map((bundle.plan.jaws?.[jaw]?.teeth ?? []).map(t => [t.fdi, t.matrix]));
        for (const [fdi, g] of before[jaw]) {
          const moved = g.clone();
          if (moves.has(fdi)) moved.applyMatrix4(planMatrix(moves.get(fdi)));
          ToothAlignScene.addGeometry('aligned', jaw, fdi, moved);
        }
      }
    }
    ToothAlignScene.setStage(bundle.plan ? 'aligned' : hasTeeth ? 'teeth' : Object.keys(bundle.labels).length ? 'seg' : 'raw');
  };

  const run = async () => {
    const steps = activeSteps;
    if (!steps.length) return;
    if (byCrowns && !crownsReady) {
      setError(crowns ? '牙冠 zip 有問題，服務會拒絕：見上面的紅字' : '先選牙冠 zip');
      return;
    }
    if (segments && (!files.upper || !files.lower)) {
      setError('上下顎口掃都要選');
      return;
    }
    setRunning(true);
    setError(null);
    setProgress(null);
    const startedAt = performance.now();
    const sent = Object.fromEntries(Object.entries(params).filter(([key, value]) =>
      steps.includes(PARAMS[key].step) && value !== DEFAULTS[key]));
    try {
      const submitted = await submitV2Job({
        target, steps, params: sent, scans: segments ? files : null, ref: ref?.id,
        crowns: byCrowns ? crowns.file : null, onStage: setStage,
      });
      made.current.push({ target, id: submitted.id });
      const status = await waitForV2Job(target, submitted.id, {
        onUpdate: s => {
          const on = isV2Dispatched(target) && s.where ? `${boxLabel(s.where)}：` : '';
          if (s.state === 'queued') {
            setStage(isV2Dispatched(target)
              ? `分派器排隊中${s.predicted != null ? `，預計 ${Math.round(s.predicted)} 秒後完成` : ''}…`
              : `排隊中${s.queuePosition ? `（前面還有 ${s.queuePosition} 筆）` : ''}…`);
          } else if (s.state === 'starting') {
            setStage(`${on}取輸入、送進排牙服務…`);
          } else if (s.state === 'running') {
            setStage(`${on}${s.waitingFor ? `等同一張卡上的 v1 工作做完，再${STEP_NAME[s.step] ?? ''}` : `${STEP_NAME[s.step] ?? s.step ?? '執行'}中`}${s.progress ? `（${s.progress.done} / ${s.progress.total} 顆）` : ''}…`);
          }
          setProgress(s.progress ? Math.round((100 * s.progress.done) / s.progress.total) : null);
        },
      });
      const wall = (performance.now() - startedAt) / 1000;
      if (status.state !== 'succeeded') {
        setResult({ target, id: submitted.id, status, bundle: null, steps, timing: { wall, upload: submitted.uploadSeconds } });
        setError(`${status.error ?? status.state}${status.logTail ? `\n\n${status.logTail}` : ''}`);
        return;
      }
      setStage('正在下載結果包…');
      const t1 = performance.now();
      const buffer = await fetchV2Bundle(target, submitted.id);
      const download = (performance.now() - t1) / 1000;
      bundleRef.current = buffer;
      const bundle = await readV2Bundle(buffer);
      // crowns: the scan the labels follow is the service's merged one, in the bundle
      if (byCrowns) {
        for (const jaw of ['upper', 'lower']) await ToothAlignScene.setRaw(jaw, await bundleScanFile(bundle, jaw));
      }
      draw(bundle);
      // the job it chained from is no longer needed: this bundle holds all of it
      if (ref) {
        deleteV2Job(ref.target, ref.id);
        made.current = made.current.filter(j => j.id !== ref.id);
      }
      setResult({
        target, id: submitted.id, status, bundle, steps, ref: ref?.id,
        timing: { wall, upload: submitted.uploadSeconds, sentMb: submitted.sentBytes / 1048576, download, bytes: buffer.byteLength },
      });
      ToothAlignScene.fitView();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
      setStage('');
      setProgress(null);
    }
  };

  const checkHealth = async () => {
    setHealth({ type: 'info', text: '檢查中…' });
    try {
      const h = await getV2Health(target);
      setHealth({ type: h.ok ? 'success' : 'error', text: h.text });
    } catch (e) {
      setHealth({ type: 'error', text: `無法連線：${e.message}` });
    }
  };

  const download = (name, data, type) => downloadBlob(new Blob([data], { type }), name);
  const downloadMember = async (member, name) => {
    const data = await result.bundle.read(member);
    if (data) download(name, data, 'application/json');
  };

  const status = result?.status;
  const summary = status?.summary;
  const bundle = result?.bundle;
  const plan = bundle?.plan;
  const abo = plan?.abo;
  const issues = summary?.issues ?? [];
  const warnings = [...(summary?.warnings ?? []), ...(status?.warnings ?? [])]
    .filter(w => !(issues.length && /^\[(seg|gen|input)\./.test(w)));
  const fdisOf = jaw => {
    const labels = bundle?.labels?.[jaw];
    if (!labels) return [];
    const seen = new Set(labels);
    return [...seen].filter(l => l !== 0 && l !== 254).sort((a, b) => a - b);
  };
  const debris = jaw => (bundle?.labels?.[jaw] ? bundle.labels[jaw].reduce((n, l) => n + (l === 254), 0) : 0);
  const teethSet = jaw => new Set((bundle?.teeth ?? []).filter(t => t.jaw === jaw).map(t => t.fdi));
  const caseReady = Boolean(caseScene.hasUpper && caseScene.hasLower);

  return <div className='direct-panel toothseg-panel'>
    <p className='panel-note'>
      API v2：分牙（a）、生成牙齒（b）、排牙（c）任意組合，一筆 job 跑勾選的步驟；結果都是一個結果包（zip），可以直接當下一筆的輸入。
      沒勾分牙時，用上一筆的結果（<code>job:&lt;id&gt;</code>）：例如先只分牙，再只排牙（c），用的是同一份分牙。
      「分派器（測試站）」就是矯正團隊串接的網址（經 AI 分派器，口掃經這台主機放上 S3）；「嘉義 5090（直接）」直接打嘉義的 v2 服務。
      畫面上的分牙、牙齒、排牙都是從結果包畫的：標記照面切開畫面上的口掃，排牙＝plan.json 的矩陣套在牙齒（沒有整顆牙時套在牙冠）上。
      手上已經是分開的牙冠時，輸入選「只送牙冠」：一個 zip、每顆牙一個檔，只排牙（c）。
    </p>

    <ToothSsmDocs />

    <section className='panel-section'>
      <div className='section-title'><span className='step'>1</span>{byCrowns ? '分開的牙冠' : '上下顎口掃'}</div>
      <Radio.Group size='small' value={mode} disabled={running} onChange={e => switchMode(e.target.value)}>
        <Radio.Button value='scans'>口掃</Radio.Button>
        <Radio.Button value='crowns'>只送牙冠（zip，只排牙）</Radio.Button>
      </Radio.Group>
      {byCrowns ? <>
        <p className='panel-note'>
          一個 zip，每顆牙一個檔，檔名是牙位：例如 <code>11.stl</code>、<code>upper/11.stl</code>、<code>tooth_11.ply</code>（.stl .ply .obj .tri，可加 .gz）。
          兩顎都要、單位 mm、兩顎在咬合位置；開口或封閉的牙冠都可以，不要帶牙根。服務把每顎的牙冠合成一個網格、每個面標上牙位，接著排牙（c）。
        </p>
        <Upload accept='.zip' showUploadList={false} beforeUpload={pickCrowns} disabled={running}>
          <Button block size='small' type={crowns ? 'primary' : 'default'} title={crowns?.file.name}>
            {crowns ? `${crowns.file.name}（${(crowns.file.size / 1048576).toFixed(2)} MB）` : '選擇牙冠 zip'}
          </Button>
        </Upload>
        {crowns && <div className='toothseg-summary'>
          {['upper', 'lower'].map(jaw => <div key={jaw} className='health-line'>
            <b>{JAW_NAME[jaw]}</b> {crowns.info.teeth[jaw].length} 顆：{crowns.info.teeth[jaw].map(t => <span key={t.fdi} style={{ marginRight: 6 }}>
              <span className='fdi-swatch' style={{ background: palette[t.fdi] ?? '#ccc' }} />{t.fdi}
            </span>)}
          </div>)}
          {crowns.info.ignored.length > 0 && <div className='health-line'>略過（不是網格檔）：{crowns.info.ignored.join('、')}</div>}
          {crowns.info.notes.map(n => <div key={n} className='health-line'>{n}</div>)}
          {crowns.info.problems.map(p => <div key={p} className='health-line bad'>{p}</div>)}
        </div>}
        <div className='button-row'>
          <Button size='small' disabled={running} onClick={clearAll}>全部清除</Button>
        </div>
      </> : <>
      <div className='scan-slots'>
        {['upper', 'lower'].map(jaw => <div key={jaw} className='scan-slot'>
          <div className='scan-slot-head'>{JAW_NAME[jaw]}</div>
          <Upload accept={ACCEPT} showUploadList={false} beforeUpload={pickFile(jaw)} disabled={running}>
            <Button block size='small' type={files[jaw] ? 'primary' : 'default'} title={files[jaw]?.name}>
              {files[jaw]?.name ?? '選擇檔案（STL / PLY / OBJ / TRI）'}
            </Button>
          </Upload>
        </div>)}
      </div>
      <div className='button-row'>
        <Tooltip title={caseReady ? [caseScene.upperName, caseScene.lowerName].join(' + ') : '牙冠設計分頁還沒有載入上下顎口掃'}>
          <Button size='small' disabled={running || !caseReady} onClick={takeCaseScans}>使用牙冠設計分頁的上下顎</Button>
        </Tooltip>
        <Button size='small' disabled={running} onClick={clearAll}>全部清除</Button>
      </div>
      </>}
    </section>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>2</span>執行</div>
      <div className='field-row'>
        <label>
          主機
          <Select size='small' value={target} onChange={setTarget} disabled={running} options={Object.entries(V2_TARGETS).map(([key, t]) => ({
            value: key, label: t.label + (reach[key] === 'down' ? '（目前無法使用）' : reach[key] === 'ok' ? '' : '（檢查中）'),
          }))} />
        </label>
      </div>
      <div className='toothseg-switches'>
        <span>步驟</span>
        {V2_STEPS.map(s => <Checkbox key={s.key} checked={activeSteps.includes(s.key)} disabled={running || byCrowns} onChange={() => toggleStep(s.key)}>
          {s.label}（{s.letter}）
        </Checkbox>)}
        {combination && <Tag>組合 {combination}</Tag>}
      </div>
      <div className='health-line'>
        輸入：{byCrowns
          ? (crownsReady ? `牙冠 zip（inputs.crowns，上顎 ${crowns.info.teeth.upper.length} 顆、下顎 ${crowns.info.teeth.lower.length} 顆）：只送牙冠時只能排牙`
            : <span className='bad'>先在上面選一個沒有紅字的牙冠 zip</span>)
          : segments
            ? '上下顎口掃'
            : ref ? `上一筆的結果包（job:${ref.id}，組合 ${ref.status.combination ?? combinationOf(ref.steps)}）`
              : <span className='bad'>沒勾分牙時要用上一筆的結果：先在同一台主機跑一筆有分牙的 job</span>}
      </div>
      <div className='field-row'>
        {Object.entries(PARAMS).filter(([, p]) => activeSteps.includes(p.step)).map(([key, p]) => <label key={key}>
          {p.label}
          <Select size='small' value={params[key]} disabled={running}
            onChange={value => setParams(prev => ({ ...prev, [key]: value }))}
            options={p.options.map(([value, label]) => ({ value, label }))} />
        </label>)}
      </div>
      {conflict && <div className='health-line bad'>牙根選「不接牙根」時不能排牙：服務會回 conflicting_params</div>}
      <div className='button-grid'>
        <Button type='primary' loading={running} disabled={!activeSteps.length || (byCrowns ? !crownsReady : !segments && !ref)} onClick={run}>
          執行 {combination ? `${combination}（${V2_STEPS.filter(s => activeSteps.includes(s.key)).map(s => s.label).join('→')}）` : ''}
        </Button>
        <Button disabled={running} onClick={checkHealth}>檢查排牙 API</Button>
      </div>
      {stage && <div className='health-line'>{stage}</div>}
      {progress != null && <Progress percent={progress} size='small' />}
      {health && <Alert className='section-alert' type={health.type} showIcon message={health.text} />}
      {error && <Alert className='section-alert' type='error' showIcon message={<pre className='plain-pre'>{error}</pre>} />}
    </section>

    {result && <section className='panel-section'>
      <div className='section-title'><span className='step'>3</span>結果</div>
      <div className='toothseg-timing'>
        <Tag>{V2_TARGETS[result.target].label}{isV2Dispatched(result.target) && status.where ? ` → ${boxLabel(status.where)}${status.attempts > 1 ? `（第 ${status.attempts} 次）` : ''}` : ''}</Tag>
        <Tag>組合 {status.combination ?? combinationOf(result.steps)}</Tag>
        {result.timing.upload != null && result.timing.sentMb > 0 && <Tag>上傳 {fmt(result.timing.upload)}（{result.timing.sentMb.toFixed(1)} MB）</Tag>}
        {Object.entries(summary?.steps_s ?? {}).filter(([k]) => STEP_NAME[k]).map(([k, s]) => <Tag key={k}
          color={{ segment: 'blue', generate: 'magenta', align: 'purple' }[k]}>{STEP_NAME[k]} {fmt(s)}</Tag>)}
        {summary?.steps_s && <Tooltip title='服務自己的時間：準備、各步驟、打包（不含排隊和等 v1）'>
          <Tag>服務 {fmt(Object.values(summary.steps_s).reduce((a, b) => a + b, 0))}</Tag>
        </Tooltip>}
        {status.timings?.queued_s != null && <Tag color='geekblue'>分派器排隊 {fmt(status.timings.queued_s)}</Tag>}
        <Tooltip title='送出 job 到狀態變成做完（含上傳口掃）'><Tag color='green'>全程 {fmt(result.timing.wall)}</Tag></Tooltip>
        {result.timing.download != null && <Tag>下載結果包 {fmt(result.timing.download)}（{(result.timing.bytes / 1048576).toFixed(1)} MB）</Tag>}
      </div>
      <div className='health-line'>Job {result.id}{result.ref ? `（接著 job:${result.ref}）` : ''}{bundle?.manifest?.version ? ` · ${bundle.manifest.version}` : ''}</div>
      {bundle?.manifest?.inputs?.crowns && <div className='health-line'>
        牙冠 zip：{['upper', 'lower'].map(jaw => `${JAW_NAME[jaw]} ${bundle.manifest.inputs.crowns.teeth?.[jaw]?.length ?? 0} 個檔`).join('、')}
        {bundle.manifest.inputs.crowns.ignored?.length ? `，略過 ${bundle.manifest.inputs.crowns.ignored.length} 個` : ''}
        ；服務合成的每顎網格在結果包的 scan/，各面的牙位在 labels/（畫面上的牙冠就是從它們切的）
      </div>}
      {issues.length > 0 && <Alert className='section-alert' showIcon type={issues.some(i => i.level === 'error') ? 'error' : 'warning'}
        message={<>
          <div>服務檢查到的問題（issues）：</div>
          <ul className='warning-list'>{issues.map((i, n) => <li key={n}>
            <Tag color={ISSUE_LEVEL[i.level]?.color}>{ISSUE_LEVEL[i.level]?.label ?? i.level}</Tag>
            {i.jaw ? `${JAW_NAME[i.jaw]} ` : ''}{i.message} <span className='issue-code'>{i.code}</span>
          </li>)}</ul>
        </>} />}
      {warnings.length > 0 && <Alert className='section-alert' type='warning' showIcon message={
        <ul className='warning-list'>{warnings.map(w => <li key={w}>{w}</li>)}</ul>} />}

      {bundle && Object.keys(bundle.labels).length > 0 && <div className='toothseg-summary'>
        {['upper', 'lower'].map(jaw => {
          const fdis = fdisOf(jaw);
          const moves = Object.fromEntries((plan?.jaws?.[jaw]?.teeth ?? []).map(t => [t.fdi, t]));
          const kept = plan?.jaws?.[jaw]?.kept ?? [];
          const teeth = teethSet(jaw);
          return <div key={jaw} className='toothseg-jaw'>
            <div className='toothseg-jaw-head'>
              <b>{JAW_NAME[jaw]}</b>
              <span>{fdis.length} 顆</span>
              {debris(jaw) > 0 && <Tooltip title='分牙前移掉的漂浮碎片：標記是 254'><Tag>碎片 {debris(jaw)} 面</Tag></Tooltip>}
              {kept.length > 0 && <Tooltip title='排牙模型不處理的牙，原位保留'><Tag>保留 {kept.join('、')}</Tag></Tooltip>}
              {plan?.jaws?.[jaw]?.moved && <Tag>{plan.jaws[jaw].moved === 'teeth' ? '移動整顆牙' : '移動牙冠'}</Tag>}
            </div>
            <table className='toothseg-table'>
              <thead><tr>
                <th>FDI</th>
                <th>整顆牙</th>
                {plan && <><th>旋轉 °</th><th>位移 mm</th></>}
              </tr></thead>
              <tbody>{fdis.map(fdi => <tr key={fdi}>
                <td><span className='fdi-swatch' style={{ background: palette[fdi] ?? '#ccc' }} />{fdi}</td>
                <td>{teeth.has(fdi) ? '✓' : bundle.teeth.length ? <span className='bad'>✗</span> : '—'}</td>
                {plan && <>
                  <td className={moves[fdi]?.rot_deg > 20 ? 'bad' : ''}>{moves[fdi] ? moves[fdi].rot_deg.toFixed(1) : '—'}</td>
                  <td>{moves[fdi] ? moves[fdi].trans_mm.toFixed(2) : '—'}</td>
                </>}
              </tr>)}</tbody>
            </table>
          </div>;
        })}
      </div>}

      {abo && (abo.before || abo.after) && <table className='toothseg-table abo-table'>
        <thead><tr><th>ABO（扣分，越低越好）</th><th>排牙前</th><th>排牙後</th></tr></thead>
        <tbody>{ABO_ROWS.filter(([key]) => abo.before?.[key] !== undefined || abo.after?.[key] !== undefined).map(([key, name]) => {
          const before = abo.before?.[key];
          const after = abo.after?.[key];
          return <tr key={key} style={key === 'TOTAL' || key === 'ABO7' ? { fontWeight: 600 } : undefined}>
            <td>{key} {name}</td>
            <td>{before ?? '—'}</td>
            <td className={after != null && before != null && after > before ? 'bad' : ''}>{after ?? '—'}</td>
          </tr>;
        })}</tbody>
      </table>}
      {abo && <div className='panel-note'>只用來比較排牙前後。RA 要整顆牙：只有牙冠時是空的（null）。{abo.note}</div>}
      {bundle?.axes && <div className='health-line'>牙軸（teeth/axes.json）：{Object.keys(bundle.axes.teeth ?? bundle.axes).length} 筆</div>}

      {bundle && <div className='button-row'>
        <Button size='small' onClick={() => download(`toothssm-v2-${result.id}.zip`, bundleRef.current, 'application/zip')}>下載結果包（zip）</Button>
        {plan && <Button size='small' onClick={() => downloadMember('plan.json', `plan-${result.id}.json`)}>下載 plan.json</Button>}
        {bundle.axes && <Button size='small' onClick={() => downloadMember('teeth/axes.json', `axes-${result.id}.json`)}>下載 axes.json</Button>}
        <Tooltip title={`結果包裡的檔案：${bundle.names.join('、')}`}><Tag>{bundle.names.length} 個檔</Tag></Tooltip>
      </div>}
    </section>}

    <ToothAlignDisplay sourceColors={false} teethLabel={bundle && !bundle.teeth.length && plan ? '排牙前（牙冠）' : '排牙前'} />
  </div>;
};

export default ToothAlignV2Panel;
