/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Progress, Radio, Select, Slider, Tag, Tooltip, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import ToothSegScene, { GENERATED_HEX, OBSERVED_HEX } from '../../utils/function/ToothSegScene';
import {
  TOOTHROOT_ACCEPT,
  deleteToothRootJob,
  fetchToothRootArchive,
  fetchToothRootFile,
  getToothRootHealth,
  getToothRootInfo,
  rerunToothRootRoots,
  submitToothRootJob,
  waitForToothRootJob,
} from '../../utils/function/ToothRootApi';
import { downloadBlob, useCaseScene, useToothSegScene } from '../../utils/tool/useStores';

const JAW_NAME = { upper: '上顎', lower: '下顎' };
// Step 2's marching-cubes grid. Measured on 95 on 2026-10-07, one real case (27 teeth, 13 + 16 MB
// STL): 33 / 50 / 80 s. Against 192, 128 moves a tooth by 0.070 mm (Chamfer median, max 0.099)
// and 160 by 0.059 mm -- while the same 192 run with another seed moves it by 0.157 mm (max
// 0.48), so the grid costs less than the sampler's own randomness. Hence 128 by default; 192
// is what the ToothRoot package's own numbers were measured at.
const RES_OPTIONS = [
  { value: 128, label: '128（約 33 秒）' },
  { value: 160, label: '160（約 50 秒）' },
  { value: 192, label: '192（約 80 秒，作者量測用）' },
];
// The package README's reading of crown fit: over ~1 mm is the pipeline failing, not a shape
// error. All 140 of its own teeth were 0.09-0.17 mm.
const FIT_WARN_MM = 1.0;

const fmtSeconds = s => (s == null ? '—' : `${s.toFixed(1)} 秒`);

/** Fetch with a small pool: two dozen teeth at once through one proxy is no faster. */
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
 * The "AI分牙" tab: ToothRoot (htyau/ToothRoot) on the Chiayi 5090 box.
 *
 *   step 1  AI 分牙    archnorm puts each arch in a canonical pose, a 25-view 2D U-Net labels
 *                      every vertex with its FDI number, and each tooth's crown is cut out
 *   step 2  生成牙根   per crown, a rectified flow samples a whole-tooth shape and the SDF
 *                      decoder marches it -- the crown as scanned, the root generated
 *
 * Its own pair of scans, or the design tab's: both arches are required, because the sign of
 * each tooth's crown->apex axis is voted across the arch and needs the opposing jaw.
 */
const ToothSegPanel = () => {
  const view = useToothSegScene();
  const caseScene = useCaseScene();
  const [files, setFiles] = useState({ upper: null, lower: null });
  const [res, setRes] = useState(128);
  const [swap, setSwap] = useState('auto');
  const [running, setRunning] = useState(null);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [timing, setTiming] = useState(null);
  const [health, setHealth] = useState(null);
  const [palette, setPalette] = useState({});
  const jobRef = useRef(null);

  useEffect(() => {
    getToothRootInfo().then(info => {
      setPalette(info.palette ?? {});
      ToothSegScene.setPalette(info.palette ?? {});
    }).catch(() => {});
  }, []);

  const pickFile = jaw => file => {
    setFiles(previous => ({ ...previous, [jaw]: file }));
    setError(null);
    ToothSegScene.setRaw(jaw, file)
      .then(() => ToothSegScene.fitView())
      .catch(e => setError(e.message));
    return false;
  };

  const takeCaseScans = () => {
    const next = { upper: CaseScene.files.upper, lower: CaseScene.files.lower };
    setFiles(next);
    setError(null);
    Promise.all(['upper', 'lower'].map(jaw => ToothSegScene.setRaw(jaw, next[jaw])))
      .then(() => ToothSegScene.fitView())
      .catch(e => setError(e.message));
  };

  const forgetJob = () => {
    if (jobRef.current) deleteToothRootJob(jobRef.current);
    jobRef.current = null;
    setJob(null);
  };

  /** Pull what a finished job made into the scene. Returns the seconds it took. */
  const loadResults = async (doc, { segmentation = true } = {}) => {
    const startedAt = performance.now();
    if (segmentation) {
      ToothSegScene.clearResults();
      setStage('正在取回分牙結果…');
      const segs = await Promise.all(['upper', 'lower'].map(jaw => fetchToothRootFile(doc.job_id, `segmentation/${jaw}_seg.ply`)));
      ['upper', 'lower'].forEach((jaw, i) => ToothSegScene.setSegmentation(jaw, segs[i]));
      ToothSegScene.setLabels(doc.crowns);
    } else {
      ToothSegScene.clearTeeth();
    }
    const teeth = ['upper', 'lower'].flatMap(jaw => (doc.teeth?.[jaw] ?? []).filter(t => t.ok).map(t => ({ jaw, fdi: t.fdi })));
    if (teeth.length) {
      let done = 0;
      setStage(`正在取回牙齒（0 / ${teeth.length}）…`);
      await pooled(teeth.map(({ jaw, fdi }) => async () => {
        const buffer = await fetchToothRootFile(doc.job_id, `roots/${jaw}/tooth_${fdi}.ply`);
        ToothSegScene.addTooth(jaw, fdi, buffer);
        setStage(`正在取回牙齒（${++done} / ${teeth.length}）…`);
      }));
    }
    return (performance.now() - startedAt) / 1000;
  };

  const follow = async (jobId, startedAt, extra = {}) => {
    const doc = await waitForToothRootJob(jobId, {
      onUpdate: update => {
        setJob(update);
        if (update.state === 'queued') {
          setStage(`排隊中${update.queue_position ? `（前面還有 ${update.queue_position} 筆）` : ''}…`);
        } else if (update.state === 'segmenting') {
          setStage('AI 分牙中（archnorm 擺正 + 25 視角 U-Net）…');
        } else if (update.state === 'generating') {
          const p = update.progress;
          setStage(`生成牙根中${p ? `（${p.teeth_done} / ${p.teeth_total} 顆）` : ''}…`);
          setProgress(p && p.teeth_total ? Math.round((100 * p.teeth_done) / p.teeth_total) : null);
        }
      },
    });
    setProgress(null);
    return { doc, serverDone: (performance.now() - startedAt) / 1000, ...extra };
  };

  const run = async ({ roots }) => {
    if (!files.upper || !files.lower) {
      setError('上下顎都要：牙根的方向是整個牙弓一起投票決定的，需要知道對顎在哪一側');
      return;
    }
    setRunning(roots ? 'all' : 'segment');
    setError(null);
    setTiming(null);
    forgetJob();
    const startedAt = performance.now();
    try {
      const submitted = await submitToothRootJob({ upper: files.upper, lower: files.lower, roots, res, swap, onStage: setStage });
      jobRef.current = submitted.jobId;
      const followed = await follow(submitted.jobId, startedAt);
      const download = await loadResults(followed.doc);
      setJob(followed.doc);
      setTiming({
        upload: submitted.uploadSeconds,
        sentMb: submitted.sentBytes / 1048576,
        rawMb: submitted.rawBytes / 1048576,
        segment: followed.doc.timings?.segment_s,
        roots: followed.doc.timings?.roots_s,
        download,
        total: (performance.now() - startedAt) / 1000,
        res: roots ? res : null,
      });
      setStage('');
      ToothSegScene.fitView();
    } catch (e) {
      setError(e.message);
      setStage('');
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const rerunRoots = async () => {
    const jobId = jobRef.current;
    if (!jobId) return;
    setRunning('roots');
    setError(null);
    const startedAt = performance.now();
    try {
      await rerunToothRootRoots(jobId, { res });
      const followed = await follow(jobId, startedAt);
      const download = await loadResults(followed.doc, { segmentation: false });
      setJob(followed.doc);
      setTiming(previous => ({
        ...(previous ?? {}),
        upload: null,
        roots: followed.doc.timings?.roots_s,
        download,
        total: (performance.now() - startedAt) / 1000,
        res,
        rerun: true,
      }));
      setStage('');
    } catch (e) {
      setError(e.message);
      setStage('');
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  const checkHealth = async () => {
    setHealth({ type: 'info', text: '檢查中…' });
    try {
      const h = await getToothRootHealth();
      const missing = Object.entries(h.checkpoints ?? {}).filter(([, ok]) => !ok).map(([name]) => name);
      setHealth({
        type: h.status === 'ok' && !missing.length ? 'success' : 'error',
        text: `ToothRoot ${h.status} · ${h.gpu ?? 'CPU'} · torch ${h.torch} · 佇列 ${h.queue}`
          + (missing.length ? ` · 缺 checkpoint：${missing.join('、')}` : ''),
      });
    } catch (e) {
      setHealth({ type: 'error', text: `無法連線：${e.message}` });
    }
  };

  const downloadArchive = async () => {
    if (!jobRef.current) return;
    setStage('正在打包下載…');
    try {
      downloadBlob(await fetchToothRootArchive(jobRef.current), `toothroot-${jobRef.current}.zip`);
    } catch (e) {
      setError(e.message);
    } finally {
      setStage('');
    }
  };

  const clearAll = () => {
    forgetJob();
    ToothSegScene.clearAll();
    setFiles({ upper: null, lower: null });
    setTiming(null);
    setError(null);
  };

  const summary = job?.summary;
  const hasSegmentation = Boolean(summary);
  const busy = Boolean(running);
  const caseReady = Boolean(caseScene.hasUpper && caseScene.hasLower);

  return <div className='direct-panel toothseg-panel'>
    <p className='panel-note'>
      矯正 AI 分牙（ToothRoot，嘉義 5090）：上下顎口掃 → 每顆牙標上 FDI 並切出牙冠 → 依牙冠生成完整牙齒（含牙根）。
      <b>上下顎都要</b>：牙根朝哪個方向是整個牙弓一起投票決定的。口掃會先在瀏覽器 gzip 壓縮再送出；結果在 5090 上保留 2 小時。
    </p>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>1</span>上下顎口掃</div>
      <div className='scan-slots'>
        {['upper', 'lower'].map(jaw => <div key={jaw} className='scan-slot'>
          <div className='scan-slot-head'>{JAW_NAME[jaw]}</div>
          <Upload accept={TOOTHROOT_ACCEPT} showUploadList={false} beforeUpload={pickFile(jaw)} disabled={busy}>
            <Button block size='small' type={files[jaw] ? 'primary' : 'default'} title={files[jaw]?.name}>
              {files[jaw]?.name ?? '選擇檔案（STL / PLY / OBJ / TRI）'}
            </Button>
          </Upload>
        </div>)}
      </div>
      <div className='button-row'>
        <Tooltip title={caseReady ? `${caseScene.upperName} + ${caseScene.lowerName}` : '牙冠設計分頁還沒有載入上下顎'}>
          <Button size='small' disabled={busy || !caseReady} onClick={takeCaseScans}>使用牙冠設計分頁的上下顎</Button>
        </Tooltip>
        <Button size='small' disabled={busy} onClick={clearAll}>全部清除</Button>
      </div>
    </section>

    <section className='panel-section'>
      <div className='section-title'><span className='step'>2</span>執行</div>
      <div className='field-row'>
        <label>
          牙根網格解析度
          <Select size='small' value={res} onChange={setRes} options={RES_OPTIONS} disabled={busy} />
        </label>
        <label title='檔名標錯上下顎時，模型會自動發現並對調（看兩種擺法各有幾種翻轉被判成正確的顎）'>
          上下顎檔案對調
          <Select size='small' value={swap} onChange={setSwap} disabled={busy} options={[
            { value: 'auto', label: '自動偵測' },
            { value: 'no', label: '不對調' },
            { value: 'yes', label: '強制對調' },
          ]} />
        </label>
      </div>
      <div className='button-grid'>
        <Button type='primary' loading={running === 'all'} disabled={busy && running !== 'all'} onClick={() => run({ roots: true })}>
          AI 分牙＋生成牙根
        </Button>
        <Button loading={running === 'segment'} disabled={busy && running !== 'segment'} onClick={() => run({ roots: false })}>
          只做 AI 分牙
        </Button>
        <Tooltip title='用同一份分牙結果、目前選的解析度，重新生成牙根'>
          <Button loading={running === 'roots'} disabled={!hasSegmentation || (busy && running !== 'roots')} onClick={rerunRoots}>
            {job?.teeth && Object.keys(job.teeth).length ? '重新生成牙根' : '生成牙根'}
          </Button>
        </Tooltip>
        <Button disabled={busy} onClick={checkHealth}>檢查 ToothRoot API</Button>
      </div>
      {stage && <div className='health-line'>{stage}</div>}
      {progress != null && <Progress percent={progress} size='small' />}
      {health && <Alert className='section-alert' type={health.type} showIcon message={health.text} />}
      {error && <Alert className='section-alert' type='error' showIcon message={<pre className='plain-pre'>{error}</pre>} />}
    </section>

    {(timing || summary) && <section className='panel-section'>
      <div className='section-title'><span className='step'>3</span>結果</div>
      {timing && <div className='toothseg-timing'>
        {timing.upload != null && <Tag>上傳 {fmtSeconds(timing.upload)}（{timing.sentMb.toFixed(1)} MB，原檔 {timing.rawMb.toFixed(1)} MB）</Tag>}
        {timing.segment != null && !timing.rerun && <Tag color='blue'>分牙 {fmtSeconds(timing.segment)}</Tag>}
        {timing.roots != null && <Tag color='magenta'>牙根 {fmtSeconds(timing.roots)}（res {timing.res}）</Tag>}
        <Tag>下載 {fmtSeconds(timing.download)}</Tag>
        <Tag color='green'>總共 {fmtSeconds(timing.total)}</Tag>
      </div>}
      {job?.job_id && <div className='health-line'>Job {job.job_id}</div>}
      {job?.warnings?.length > 0 && <Alert className='section-alert' type='warning' showIcon message={
        <ul className='warning-list'>{job.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      } />}
      {summary && <div className='toothseg-summary'>
        {['upper', 'lower'].map(jaw => {
          const info = summary[jaw];
          if (!info) return null;
          const teeth = job.teeth?.[jaw] ?? [];
          return <div key={jaw} className='toothseg-jaw'>
            <div className='toothseg-jaw-head'>
              <b>{JAW_NAME[jaw]}</b>
              <span>{info.fdi.length} 顆</span>
              <Tooltip title='archnorm 自評的擺正不確定度；> 1.3 mm 時 FDI 編號可能整排錯位，請檢查'>
                <Tag color={info.sigma_mm > 1.3 ? 'orange' : 'default'}>σ {info.sigma_mm.toFixed(2)} mm</Tag>
              </Tooltip>
              <Tooltip title={`8 種翻轉中，有幾種被模型判成${JAW_NAME[jaw]}`}>
                <Tag>{info.jaw_consistent_hypotheses}/{info.hypotheses} 判對顎</Tag>
              </Tooltip>
              <span className='toothseg-file' title={info.source_file}>{info.source_file}</span>
            </div>
            <table className='toothseg-table'>
              <thead><tr>
                <th />
                <th>FDI</th>
                <th>牙冠 mm²</th>
                {teeth.length > 0 && <>
                  <th title='掃描牙冠到生成牙齒的 p90 距離；> 1 mm 代表生成失敗'>貼合 p90</th>
                  <th title='沿主軸的整顆牙長度'>長度</th>
                  <th>封閉</th>
                </>}
              </tr></thead>
              <tbody>{(job.crowns?.[jaw] ?? []).map(crown => {
                const tooth = teeth.find(t => t.fdi === crown.fdi);
                const key = `${jaw}:${crown.fdi}`;
                const hidden = view.hiddenTeeth.includes(key);
                return <tr key={key} className={tooth && !tooth.ok ? 'bad' : ''}>
                  <td>{tooth?.ok && <Checkbox checked={!hidden} onChange={e => ToothSegScene.setToothVisible(jaw, crown.fdi, e.target.checked)} />}</td>
                  <td>
                    <span className='fdi-swatch' style={{ background: palette[crown.fdi] ?? '#ccc' }} />
                    {tooth?.ok
                      ? <a onClick={() => ToothSegScene.fitView({ jaw, fdi: crown.fdi })}>{crown.fdi}</a>
                      : crown.fdi}
                  </td>
                  <td>{crown.area_mm2.toFixed(0)}</td>
                  {teeth.length > 0 && (tooth?.ok
                    ? <>
                      <td className={tooth.crown_fit_p90_mm > FIT_WARN_MM ? 'bad' : ''}>{tooth.crown_fit_p90_mm.toFixed(2)}</td>
                      <td>{tooth.length_mm.toFixed(1)}</td>
                      <td>{tooth.watertight ? '✓' : <span className='bad'>✗</span>}</td>
                    </>
                    : <td colSpan={3} className='bad'>{tooth?.why ?? '—'}</td>)}
                </tr>;
              })}</tbody>
            </table>
          </div>;
        })}
        <div className='button-row'>
          <Button size='small' disabled={busy || !jobRef.current} onClick={downloadArchive}>下載全部結果（zip）</Button>
        </div>
      </div>}
    </section>}

    <section className='panel-section'>
      <div className='section-title'>顯示</div>
      <div className='toothseg-switches'>
        <Checkbox checked={view.show.upper} onChange={e => ToothSegScene.setShow('upper', e.target.checked)}>上顎</Checkbox>
        <Checkbox checked={view.show.lower} onChange={e => ToothSegScene.setShow('lower', e.target.checked)}>下顎</Checkbox>
        <Checkbox checked={view.show.raw} disabled={!view.hasRaw} onChange={e => ToothSegScene.setShow('raw', e.target.checked)}>原始口掃</Checkbox>
        <Checkbox checked={view.show.seg} disabled={!view.hasSeg} onChange={e => ToothSegScene.setShow('seg', e.target.checked)}>分牙結果</Checkbox>
        <Checkbox checked={view.show.labels} disabled={!view.hasLabels} onChange={e => ToothSegScene.setShow('labels', e.target.checked)}>FDI 編號</Checkbox>
        <Checkbox checked={view.show.teeth} disabled={!view.teethCount} onChange={e => ToothSegScene.setShow('teeth', e.target.checked)}>牙齒＋牙根</Checkbox>
      </div>
      <div className='preview-opacity'>
        <span>口掃透明度</span>
        <Slider min={0} max={100} value={Math.round(view.archOpacity * 100)} onChange={v => ToothSegScene.setArchOpacity(v / 100)} />
        <span className='preview-percent'>{Math.round(view.archOpacity * 100)}%</span>
      </div>
      <div className='toothseg-switches'>
        <span>牙齒顏色</span>
        <Radio.Group size='small' value={view.teethColor} onChange={e => ToothSegScene.setTeethColor(e.target.value)}>
          <Radio.Button value='source'>掃描／生成</Radio.Button>
          <Radio.Button value='fdi'>依 FDI</Radio.Button>
        </Radio.Group>
      </div>
      {view.teethColor === 'source' && <div className='panel-note'>
        <span className='fdi-swatch' style={{ background: OBSERVED_HEX }} />口掃實際看到的部分
        <span className='fdi-swatch' style={{ background: GENERATED_HEX, marginLeft: 10 }} />模型生成的部分（牙根）
      </div>}
    </section>
  </div>;
};

export default ToothSegPanel;
