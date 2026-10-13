/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Progress, Radio, Select, Slider, Tag, Tooltip, Upload, Checkbox } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import ToothAlignScene, { CROWN_HEX, ROOT_HEX } from '../../utils/function/ToothAlignScene';
import {
  TOOTHSSM_ACCEPT,
  TOOTHSSM_SEG_OPTIONS,
  TOOTHSSM_TARGETS,
  deleteToothSsmJob,
  fetchToothSsmArchive,
  fetchToothSsmFile,
  getToothSsmHealth,
  getToothSsmInfo,
  rerunToothSsmStep,
  submitToothSsmJob,
  waitForToothSsmJob,
} from '../../utils/function/ToothSsmApi';
import { downloadBlob, useCaseScene, useToothAlignScene } from '../../utils/tool/useStores';

const JAW_NAME = { upper: '上顎', lower: '下顎' };
// The marching-cubes grid the roots are decoded on, ToothRoot's or tooth_ssm's (72_zhu_rawcase.py).
// On the 5080, 192 against 128 costs ToothRoot ~10 s and tooth_ssm ~10 s more for a full case.
const RES_OPTIONS = [
  { value: 128, label: '128（預設）' },
  { value: 160, label: '160' },
  { value: 192, label: '192（較慢）' },
];
// The eight ABO criteria, all penalty points (lower is better). RA reads the generated roots,
// so the scale for scans is ABO7 = TOTAL - RA. Only for comparing before / after -- not
// against the ABO pass thresholds (third_party/abo_eval/SOURCE.md).
const ABO_ROWS = [
  ['A', '排列'], ['MR', '邊緣嵴'], ['BLI', '頰舌傾斜'], ['OC', '咬合接觸'], ['OR', '咬合關係'],
  ['OJ', '覆蓋'], ['IPC', '鄰接接觸'], ['RA', '牙根平行（生成的）'], ['ABO7', 'ABO7＝總分−RA'], ['TOTAL', '總分'],
];
const STEP_LABEL = { segment: '分牙', generate: '牙根', align: '排牙' };
const DETAIL_LABEL = {
  toothroot_segment: 'ToothRoot 分牙',
  articulate: '咬合檢查',
  toothroot_roots: 'ToothRoot 生成牙根',
  'seg+articulate': '分牙＋咬合檢查',
  roots: '生成牙根（DeepSDF）',
  'publish+merge+export': '整理輸出',
  colour: '牙冠／牙根上色',
  align: '排牙模型',
  abo: 'ABO 評分',
  colour_aligned: '排牙結果上色',
};

const fmtSeconds = s => (s == null ? '—' : `${s.toFixed(1)} 秒`);

/** Fetch with a small pool: dozens of teeth at once through one proxy is no faster. */
const pooled = async (tasks, size = 6) => {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }));
  return results;
};

/**
 * The "AI排牙" tab: tooth_ssm (htyau/ssm_project), the orthodontic team's AI tooth arrangement.
 *
 *   step 1  分牙   YOLOv11-seg on 25 rendered views, back-projected onto the scan, FDI order by
 *                  a Viterbi chain; then, if both jaws face the same way, the upper is re-posed
 *                  into an estimated bite
 *   step 2  牙根   each crown -> a whole tooth: the per-FDI DeepSDF prior is fitted to the crown
 *                  plus a pseudo root and marched (Zhu et al. 2026); the crown surface moves a
 *                  little, the root is the prior's
 *   step 3  排牙   the alignment model (a diffusion transformer over both arches' crowns)
 *                  predicts one rigid move per tooth; the roots move with their crowns
 *
 * Both arches are required. Its own pair of scans, or the design tab's.
 */
const ToothAlignPanel = () => {
  const view = useToothAlignScene();
  const caseScene = useCaseScene();
  const [files, setFiles] = useState({ upper: null, lower: null });
  const [target, setTarget] = useState('z790');
  const [res, setRes] = useState(128);
  const [seg, setSeg] = useState('toothroot');
  const [running, setRunning] = useState(null);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [timing, setTiming] = useState(null);
  const [health, setHealth] = useState(null);
  const [palette, setPalette] = useState({});
  // target -> 'ok' | 'down' | null (not asked yet): what each box's /health said when the tab opened
  const [reach, setReach] = useState({});
  // The job lives on the box that took it: polls, files and deletes go to that one.
  const jobRef = useRef(null);

  useEffect(() => {
    for (const key of Object.keys(TOOTHSSM_TARGETS)) {
      getToothSsmHealth(key)
        .then(h => setReach(previous => ({ ...previous, [key]: h.status === 'ok' ? 'ok' : 'down' })))
        .catch(() => setReach(previous => ({ ...previous, [key]: 'down' })));
    }
  }, []);

  useEffect(() => {
    getToothSsmInfo(target).then(info => {
      setPalette(info.palette ?? {});
      ToothAlignScene.setPalette(info.palette ?? {});
    }).catch(() => {});
  }, [target]);

  const pickFile = jaw => file => {
    setFiles(previous => ({ ...previous, [jaw]: file }));
    setError(null);
    ToothAlignScene.setStage('raw');
    ToothAlignScene.setRaw(jaw, file)
      .then(() => ToothAlignScene.fitView())
      .catch(e => setError(e.message));
    return false;
  };

  const takeCaseScans = () => {
    const next = { upper: CaseScene.files.upper, lower: CaseScene.files.lower };
    setFiles(next);
    setError(null);
    ToothAlignScene.setStage('raw');
    for (const jaw of ['upper', 'lower']) if (!next[jaw]) ToothAlignScene.clearJaw(jaw);
    Promise.all(['upper', 'lower'].filter(jaw => next[jaw]).map(jaw => ToothAlignScene.setRaw(jaw, next[jaw])))
      .then(() => ToothAlignScene.fitView())
      .catch(e => setError(e.message));
  };

  const dropFile = jaw => {
    setFiles(previous => ({ ...previous, [jaw]: null }));
    ToothAlignScene.clearJaw(jaw);
  };

  const forgetJob = () => {
    if (jobRef.current) deleteToothSsmJob(jobRef.current.target, jobRef.current.id);
    jobRef.current = null;
    setJob(null);
  };

  /** Pull what a finished job made into the scene, from step `from` on. Returns the seconds it took. */
  const loadResults = async (doc, from = 'segment') => {
    const { id, target: box } = jobRef.current;
    const startedAt = performance.now();
    const r = doc.results ?? {};
    const kinds = { segment: ['crowns', 'teeth', 'aligned'], generate: ['teeth', 'aligned'], align: ['aligned'] }[from];
    for (const kind of kinds) ToothAlignScene.clearKind(kind);
    // An upper scan the service re-posed into a bite: everything else is in that pose now.
    if (from === 'segment' && r.articulation?.articulated && r.scans?.upper) {
      setStage('正在取回重新擺位的上顎口掃…');
      ToothAlignScene.setRaw('upper', await fetchToothSsmFile(box, id, r.scans.upper));
    }
    const parts = kinds.flatMap(kind => (r[kind] ?? []).map(part => ({ kind, ...part })));
    let done = 0;
    setStage(`正在取回結果（0 / ${parts.length}）…`);
    await pooled(parts.map(part => async () => {
      const buffer = await fetchToothSsmFile(box, id, part.url);
      ToothAlignScene.addPart(part.kind, part.jaw, part.fdi, buffer);
      setStage(`正在取回結果（${++done} / ${parts.length}）…`);
    }));
    ToothAlignScene.setStage(r.aligned?.length ? 'aligned' : r.teeth?.length ? 'teeth' : r.crowns?.length ? 'seg' : 'raw');
    return (performance.now() - startedAt) / 1000;
  };

  const follow = async () => {
    const { id, target: box } = jobRef.current;
    const doc = await waitForToothSsmJob(box, id, {
      onUpdate: update => {
        setJob(update);
        const elapsed = update.step_elapsed_s != null ? `，${Math.round(update.step_elapsed_s)} 秒` : '';
        const viaToothRoot = update.params?.seg === 'toothroot';
        if (update.state === 'queued') {
          setStage(`排隊中${update.queue_position ? `（前面還有 ${update.queue_position} 筆）` : ''}…`);
          setProgress(null);
        } else if (update.state === 'segmenting') {
          setStage(viaToothRoot
            ? `AI 分牙中（ToothRoot → 咬合檢查${elapsed}）…`
            : `AI 分牙中（25 視角 YOLO → FDI 排序 → 邊界修整 → 咬合檢查${elapsed}）…`);
          setProgress(null);
        } else if (update.state === 'generating') {
          const p = update.progress;
          setStage(`生成牙根中（${viaToothRoot ? 'ToothRoot' : 'DeepSDF'}${p ? `，${p.teeth_done} / ${p.teeth_total} 顆` : ''}${elapsed}）…`);
          setProgress(p && p.teeth_total ? Math.round((100 * p.teeth_done) / p.teeth_total) : null);
        } else if (update.state === 'aligning') {
          setStage(`排牙中（地標 → diffusion 50 步 → 套回整顆牙${elapsed}）…`);
          setProgress(null);
        }
      },
    });
    setProgress(null);
    return doc;
  };

  const run = async until => {
    if (!files.upper || !files.lower) {
      setError('上下顎口掃都要選');
      return;
    }
    setRunning(until === 'align' ? 'all' : until);
    setError(null);
    setTiming(null);
    forgetJob();
    ToothAlignScene.clearResults();
    const startedAt = performance.now();
    try {
      const submitted = await submitToothSsmJob({ target, upper: files.upper, lower: files.lower, res, until, seg, onStage: setStage });
      jobRef.current = { id: submitted.jobId, target };
      const doc = await follow();
      const download = await loadResults(doc, 'segment');
      setJob(doc);
      setTiming({
        upload: submitted.uploadSeconds,
        sentMb: submitted.sentBytes / 1048576,
        rawMb: submitted.rawBytes / 1048576,
        timings: doc.timings,
        download,
        total: (performance.now() - startedAt) / 1000,
        res: doc.params?.res,
        seg: doc.params?.seg,
        box: TOOTHSSM_TARGETS[target].box,
      });
      setStage('');
      ToothAlignScene.fitView();
    } catch (e) {
      setError(e.message);
      setStage('');
      // A failed job keeps what its earlier steps made; show that, it is usually why it failed.
      if (e.job) {
        setJob(e.job);
        await loadResults(e.job, 'segment').catch(() => {});
        setStage('');
      }
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const rerun = async step => {
    if (!jobRef.current) return;
    setRunning(step);
    setError(null);
    const startedAt = performance.now();
    try {
      await rerunToothSsmStep(jobRef.current.target, jobRef.current.id, { step, res });
      const doc = await follow();
      const download = await loadResults(doc, step);
      setJob(doc);
      setTiming(previous => ({
        ...(previous ?? {}),
        upload: null,
        timings: doc.timings,
        download,
        total: (performance.now() - startedAt) / 1000,
        res: doc.params?.res,
        rerun: step,
      }));
      setStage('');
    } catch (e) {
      setError(e.message);
      setStage('');
      if (e.job) {
        setJob(e.job);
        await loadResults(e.job, step).catch(() => {});
        setStage('');
      }
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const checkHealth = async () => {
    setHealth({ type: 'info', text: '檢查中…' });
    try {
      const h = await getToothSsmHealth(target);
      const gpu = h.gpu?.name ? `${h.gpu.name}（已用 ${(h.gpu.memory_used_mb / 1024).toFixed(1)} / ${(h.gpu.memory_total_mb / 1024).toFixed(1)} GB）` : `GPU 無法使用：${h.gpu?.error ?? '?'}`;
      setHealth({
        type: h.status === 'ok' ? 'success' : 'error',
        text: `${TOOTHSSM_TARGETS[target].box} · ${h.status} · ${gpu} · 佇列 ${h.queue}`
          + (h.missing?.length ? ` · 缺 checkpoint：${h.missing.join('、')}` : ''),
      });
    } catch (e) {
      setHealth({ type: 'error', text: `無法連線：${e.message}` });
    }
  };

  const downloadArchive = async () => {
    if (!jobRef.current) return;
    setStage('正在打包下載…');
    try {
      downloadBlob(await fetchToothSsmArchive(jobRef.current.target, jobRef.current.id), `toothssm-${jobRef.current.id}.zip`);
    } catch (e) {
      setError(e.message);
    } finally {
      setStage('');
    }
  };

  const clearAll = () => {
    forgetJob();
    ToothAlignScene.clearAll();
    setFiles({ upper: null, lower: null });
    setTiming(null);
    setError(null);
  };

  const r = job?.results;
  const busy = Boolean(running);
  const caseReady = Boolean(caseScene.hasUpper && caseScene.hasLower);
  const hasSeg = Boolean(r?.crowns?.length);
  const hasTeeth = Boolean(r?.teeth?.length);
  const abo = r?.abo;
  const t = timing?.timings ?? {};

  return <div className='direct-panel toothseg-panel'>
    <p className='panel-note'>
      矯正 AI 排牙（tooth_ssm）：上下顎口掃 → AI 分牙 → 依牙冠生成整顆牙（含牙根）→ 排牙模型移動每顆牙（牙根跟著動）→ ABO 評分。
      分牙和牙根預設由 ToothRoot 做（矯正專案檔的口掃是減過面的，tooth_ssm 自己的分牙在這種檔上會漏牙），排牙一律用 tooth_ssm 的模型。
      上下顎都要。上下顎朝同一方向時，服務會把上顎轉成估計的咬合位置再分一次。結果在服務端保留 2 小時。
    </p>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>1</span>上下顎口掃</div>
      <div className='scan-slots'>
        {['upper', 'lower'].map(jaw => <div key={jaw} className='scan-slot'>
          <div className='scan-slot-head'>
            {JAW_NAME[jaw]}
            {files[jaw] && <Button size='small' type='link' disabled={busy} onClick={() => dropFile(jaw)}>移除</Button>}
          </div>
          <Upload accept={TOOTHSSM_ACCEPT} showUploadList={false} beforeUpload={pickFile(jaw)} disabled={busy}>
            <Button block size='small' type={files[jaw] ? 'primary' : 'default'} title={files[jaw]?.name}>
              {files[jaw]?.name ?? '選擇檔案（STL / PLY / TRI）'}
            </Button>
          </Upload>
        </div>)}
      </div>
      <div className='button-row'>
        <Tooltip title={caseReady ? [caseScene.upperName, caseScene.lowerName].join(' + ') : '牙冠設計分頁還沒有載入上下顎口掃'}>
          <Button size='small' disabled={busy || !caseReady} onClick={takeCaseScans}>使用牙冠設計分頁的上下顎</Button>
        </Tooltip>
        <Button size='small' disabled={busy} onClick={clearAll}>全部清除</Button>
      </div>
    </section>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>2</span>執行</div>
      <div className='field-row'>
        <label>
          主機
          <Select size='small' value={target} onChange={setTarget} disabled={busy} options={Object.entries(TOOTHSSM_TARGETS).map(([key, value]) => ({
            value: key, label: value.label + (reach[key] === 'down' ? '（目前無法使用）' : reach[key] === 'ok' ? '' : '（檢查中）'),
          }))} />
        </label>
        <label title='誰負責分牙和生成牙根；排牙一律是 tooth_ssm 的排牙模型。矯正專案檔裡的口掃是減過面的（約 1.2 萬面），tooth_ssm 自己的分牙在這種檔上會漏掉大部分的牙'>
          分牙＋牙根
          <Select size='small' value={seg} onChange={setSeg} options={TOOTHSSM_SEG_OPTIONS} disabled={busy} />
        </label>
        <label>
          牙齒網格解析度
          <Select size='small' value={res} onChange={setRes} options={RES_OPTIONS} disabled={busy} />
        </label>
      </div>
      <div className='button-grid'>
        <Button type='primary' loading={running === 'all'} disabled={busy && running !== 'all'} onClick={() => run('align')}>
          AI 排牙（分牙→牙根→排牙）
        </Button>
        <Button loading={running === 'segment'} disabled={busy && running !== 'segment'} onClick={() => run('segment')}>
          只做 AI 分牙
        </Button>
        <Tooltip title='用同一份分牙結果、目前選的解析度，重新生成牙根，再排牙'>
          <Button loading={running === 'generate'} disabled={!hasSeg || (busy && running !== 'generate')} onClick={() => rerun('generate')}
            title={job?.params?.seg ? `沿用這筆的「${TOOTHSSM_SEG_OPTIONS.find(o => o.value === job.params.seg)?.label}」` : undefined}>
            {hasTeeth ? '重新生成牙根＋排牙' : '生成牙根＋排牙'}
          </Button>
        </Tooltip>
        <Tooltip title='用同一份牙齒，重新跑排牙模型'>
          <Button loading={running === 'align'} disabled={!hasTeeth || (busy && running !== 'align')} onClick={() => rerun('align')}>
            重新排牙
          </Button>
        </Tooltip>
        <Button disabled={busy} onClick={checkHealth}>檢查排牙 API</Button>
      </div>
      {stage && <div className='health-line'>{stage}</div>}
      {progress != null && <Progress percent={progress} size='small' />}
      {health && <Alert className='section-alert' type={health.type} showIcon message={health.text} />}
      {error && <Alert className='section-alert' type='error' showIcon message={<pre className='plain-pre'>{error}</pre>} />}
    </section>

    {(timing || r) && <section className='panel-section'>
      <div className='section-title'><span className='step'>3</span>結果</div>
      {timing && <div className='toothseg-timing'>
        {timing.box && <Tag>{timing.box}</Tag>}
        {timing.seg && <Tag>{timing.seg === 'toothroot' ? 'ToothRoot 分牙＋牙根' : 'tooth_ssm 原流程'}</Tag>}
        {timing.upload != null && <Tag>上傳 {fmtSeconds(timing.upload)}（{timing.sentMb.toFixed(1)} MB，原檔 {timing.rawMb.toFixed(1)} MB）</Tag>}
        {['segment', 'generate', 'align'].map(step => t[`${step}_s`] != null && <Tooltip key={step} title={
          Object.entries(t.detail ?? {}).filter(([name]) => ({
            segment: ['seg+articulate', 'toothroot_segment', 'articulate'],
            generate: ['roots', 'publish+merge+export', 'colour', 'toothroot_roots'],
            align: ['align', 'abo', 'colour_aligned'],
          })[step].includes(name)).map(([name, s]) => `${DETAIL_LABEL[name] ?? name} ${s.toFixed(1)} 秒`).join('、')
        }>
          <Tag color={{ segment: 'blue', generate: 'magenta', align: 'purple' }[step]}>
            {STEP_LABEL[step]} {fmtSeconds(t[`${step}_s`])}{step === 'generate' && timing.res ? `（res ${timing.res}）` : ''}
          </Tag>
        </Tooltip>)}
        <Tag>下載 {fmtSeconds(timing.download)}</Tag>
        <Tag color='green'>總共 {fmtSeconds(timing.total)}</Tag>
      </div>}
      {job?.job_id && <div className='health-line'>Job {job.job_id}{jobRef.current ? ` · ${TOOTHSSM_TARGETS[jobRef.current.target].box}` : ''}</div>}
      {job?.warnings?.length > 0 && <Alert className='section-alert' type='warning' showIcon message={
        <ul className='warning-list'>{job.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      } />}

      {r?.crowns?.length > 0 && <div className='toothseg-summary'>
        {['upper', 'lower'].map(jaw => {
          const crowns = r.crowns.filter(c => c.jaw === jaw && c.fdi);
          const align = r.align?.[jaw];
          const moved = Object.fromEntries((align?.teeth ?? []).map(row => [row.fdi, row]));
          const teeth = new Set(r.teeth.filter(x => x.jaw === jaw).map(x => x.fdi));
          return <div key={jaw} className='toothseg-jaw'>
            <div className='toothseg-jaw-head'>
              <b>{JAW_NAME[jaw]}</b>
              <span>{crowns.length} 顆</span>
              {align && <Tooltip title='排牙模型對每顆牙的旋轉（度）'>
                <Tag>平均轉 {align.rot_mean_deg}°，最大 {align.rot_max_deg}°</Tag>
              </Tooltip>}
              {align?.n_over_20deg > 0 && <Tag color='orange'>{align.n_over_20deg} 顆轉超過 20°</Tag>}
              {align?.kept?.length > 0 && <Tooltip title='排牙模型不處理智齒，原位保留'><Tag>保留 {align.kept.join('、')}</Tag></Tooltip>}
            </div>
            <table className='toothseg-table'>
              <thead><tr>
                <th>FDI</th>
                <th>整顆牙</th>
                {align && <><th>旋轉 °</th><th title='牙冠中心的位移'>位移 mm</th></>}
              </tr></thead>
              <tbody>{crowns.map(crown => {
                const row = moved[crown.fdi];
                return <tr key={crown.fdi} className={!teeth.has(crown.fdi) && hasTeeth ? 'bad' : ''}>
                  <td><span className='fdi-swatch' style={{ background: palette[crown.fdi] ?? crown.color }} />{crown.fdi}</td>
                  <td>{teeth.has(crown.fdi) ? '✓' : hasTeeth ? <span className='bad'>✗</span> : '—'}</td>
                  {align && <>
                    <td className={row?.rot_deg > 20 ? 'bad' : ''}>{row ? row.rot_deg.toFixed(1) : '—'}</td>
                    <td>{row ? row.trans_mm.toFixed(2) : '—'}</td>
                  </>}
                </tr>;
              })}</tbody>
            </table>
          </div>;
        })}
      </div>}

      {r?.crown_stats && <div className='health-line'>
        生成牙冠離掃描：平均 {r.crown_stats.mean_mm.toFixed(3)} mm（p95 平均 {r.crown_stats.p95_mm.toFixed(3)} mm）
        {r.crown_stats.worst && `，最大 ${r.crown_stats.worst.fdi} 的 ${r.crown_stats.worst.mm.toFixed(3)} mm`}
        ，封閉 {r.crown_stats.watertight} / {r.crown_stats.n}
        {r.crown_stats.failed?.length > 0 && <span className='bad'>，失敗：{r.crown_stats.failed.map(f => `${f.fdi}（${f.why}）`).join('、')}</span>}
      </div>}

      {r?.toothroot_stats && <div className='health-line'>
        ToothRoot 牙齒：{r.toothroot_stats.ok} / {r.toothroot_stats.n} 顆生成，封閉 {r.toothroot_stats.watertight}；
        掃描牙冠到生成牙齒的 p90 距離中位數 {r.toothroot_stats.fit_p90_median_mm?.toFixed(2)} mm
        {r.toothroot_stats.worst && `（最大 ${r.toothroot_stats.worst.fdi} 的 ${r.toothroot_stats.worst.mm.toFixed(2)} mm；> 1 mm 代表生成失敗）`}
        {r.toothroot_stats.failed?.length > 0 && <span className='bad'>，失敗：{r.toothroot_stats.failed.map(f => `${f.fdi}（${f.why ?? '?'}）`).join('、')}</span>}
      </div>}

      {(abo?.input || abo?.aligned) && <table className='toothseg-table abo-table'>
        <thead><tr><th>ABO（扣分，越低越好）</th><th>排牙前</th><th>排牙後</th></tr></thead>
        <tbody>{ABO_ROWS.map(([key, name]) => {
          const before = abo.input?.[key];
          const after = abo.aligned?.[key];
          const strong = key === 'ABO7' || key === 'TOTAL';
          return <tr key={key} style={strong ? { fontWeight: 600 } : undefined}>
            <td>{key} {name}</td>
            <td>{before ?? '—'}</td>
            <td className={after != null && before != null && after > before ? 'bad' : ''}>{after ?? '—'}</td>
          </tr>;
        })}</tbody>
      </table>}
      {(abo?.input || abo?.aligned) && <div className='panel-note'>只用來比較排牙前後，不能對照 ABO 及格門檻（這個量表本來就偏高）。</div>}

      {jobRef.current && <div className='button-row'>
        <Button size='small' disabled={busy} onClick={downloadArchive}>下載全部結果（zip）</Button>
      </div>}
    </section>}

    <section className='panel-section'>
      <div className='section-title'>顯示</div>
      <Radio.Group size='small' value={view.stage} onChange={e => ToothAlignScene.setStage(e.target.value)}>
        <Radio.Button value='raw' disabled={!view.hasRaw}>原始口掃</Radio.Button>
        <Radio.Button value='seg' disabled={!view.crownCount}>分牙</Radio.Button>
        <Radio.Button value='teeth' disabled={!view.teethCount}>排牙前</Radio.Button>
        <Radio.Button value='aligned' disabled={!view.alignedCount}>排牙後</Radio.Button>
        <Radio.Button value='compare' disabled={!view.alignedCount}>前後對照</Radio.Button>
      </Radio.Group>
      <div className='toothseg-switches'>
        <Checkbox checked={view.show.upper} onChange={e => ToothAlignScene.setShow('upper', e.target.checked)}>上顎</Checkbox>
        <Checkbox checked={view.show.lower} onChange={e => ToothAlignScene.setShow('lower', e.target.checked)}>下顎</Checkbox>
        {view.stage === 'seg' && <Checkbox checked={view.show.gum} onChange={e => ToothAlignScene.setShow('gum', e.target.checked)}>牙齦</Checkbox>}
        <Button size='small' onClick={() => ToothAlignScene.fitView()}>全部置中</Button>
      </div>
      {view.stage === 'compare' && <div className='preview-opacity'>
        <span>排牙前（灰）透明度</span>
        <Slider min={0} max={100} value={Math.round(view.ghostOpacity * 100)} onChange={v => ToothAlignScene.setGhostOpacity(v / 100)} />
        <span className='preview-percent'>{Math.round(view.ghostOpacity * 100)}%</span>
      </div>}
      {['teeth', 'aligned', 'compare'].includes(view.stage) && <>
        <div className='toothseg-switches'>
          <span>牙齒顏色</span>
          <Radio.Group size='small' value={view.teethColor} onChange={e => ToothAlignScene.setTeethColor(e.target.value)}>
            <Radio.Button value='source'>牙冠／牙根</Radio.Button>
            <Radio.Button value='fdi'>依 FDI</Radio.Button>
          </Radio.Group>
        </div>
        {view.teethColor === 'source' && <div className='panel-note'>
          <span className='fdi-swatch' style={{ background: CROWN_HEX }} />距掃描牙冠 0.5 mm 內
          <span className='fdi-swatch' style={{ background: ROOT_HEX, marginLeft: 10 }} />模型生成的牙根
        </div>}
      </>}
    </section>
  </div>;
};

export default ToothAlignPanel;
