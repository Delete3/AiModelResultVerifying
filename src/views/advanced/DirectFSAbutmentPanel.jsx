/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useState } from 'react';
import { Alert, Button, InputNumber, Select, Switch, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import { FSABUTMENT_KNOWN_FOLDS, generateFSAbutment, getFSAbutmentHealth } from '../../utils/function/FSAbutmentApi';
import { downloadBlob } from '../../utils/tool/useStores';

/**
 * FSAbutment on the Chiayi 5090 box, reached through ezai2.
 *
 * Its own four uploads rather than the design tab's scans, because this path needs two
 * files nothing else in this viewer has:
 *
 *   SC.stl   the treated arch RE-SCANNED WITH THE SCAN BODIES IN. The implant frame is
 *            measured off the machined post and the post is in no other file, so this is
 *            not interchangeable with upper or lower and there is no way to derive it.
 *   C.stl    the designed crown. It is the second context channel and it is what
 *            `seat crown` snaps the abutment onto, so the path does not run without it.
 *
 * That is also why this is not a one-click button on an arbitrary case: the viewer's own
 * cases carry upper.stl and lower.stl and neither of these.
 *
 * Nothing here is canonicalized and nothing needs to be -- the four files are raw exports
 * from the design software in one shared coordinate system, and the abutment comes back in
 * that same frame, so it lands on top of the crown with no alignment step.
 */

const FILES = [
  ['upperStl', 'U.stl（上顎）'],
  ['lowerStl', 'L.stl（下顎）'],
  ['scStl', 'SC.stl（含 scan body 重掃）'],
  ['crownStl', 'C.stl（設計好的牙冠）'],
];

const DirectFSAbutmentPanel = () => {
  const [files, setFiles] = useState({});
  const [fold, setFold] = useState(0);
  const [seatCrown, setSeatCrown] = useState(true);
  const [site, setSite] = useState(0);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(null);
  const [result, setResult] = useState(null);

  const setFile = key => file => {
    setFiles(previous => ({ ...previous, [key]: file }));
    // A case directory's files are named U/L/SC/C, so a correctly picked set gives the
    // fold away for the five staged cases. Only a hint -- it never overrides a choice
    // already made by hand, and it is silent for any other file name.
    const stem = file.name.replace(/\.[^.]+$/, '');
    const known = FSABUTMENT_KNOWN_FOLDS[stem.split(/[_-]/)[0]?.toUpperCase()];
    if (known !== undefined) setFold(known);
    return false;
  };

  const checkHealth = async () => {
    setMessage({ type: 'info', text: '檢查中…' });
    try {
      const health = await getFSAbutmentHealth();
      const tags = Object.entries(health.checkpoints ?? {})
        .map(([tag, folds]) => `${tag} fold ${folds.join(',')}`).join(' · ');
      setMessage({
        type: 'success',
        text: `FSAbutment 正常 · ${health.device}${health.gpu ? ` · ${health.gpu}` : ''}\n${tags}`
          + `\n連接部 CAD library：${health.cad_lib ?? '未設定（連接部是 marching-cubes 面，離真實零件約 0.104 mm）'}`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: `無法連線：${error.message}` });
    }
  };

  const generate = async () => {
    const missing = FILES.filter(([key]) => !files[key]).map(([, label]) => label);
    if (missing.length) {
      setMessage({ type: 'error', text: `缺少：${missing.join('、')}` });
      return;
    }

    setRunning(true);
    setMessage({ type: 'info', text: '正在嘉義 5090 上生成 abutment…' });
    try {
      const abutment = await generateFSAbutment({
        upperStl: files.upperStl,
        lowerStl: files.lowerStl,
        scStl: files.scStl,
        crownStl: files.crownStl,
        fold,
        seatCrown,
        site,
      });
      await CaseScene.setAbutment(abutment.blob, abutment.fileName);
      setResult(abutment);
      setMessage({
        type: abutment.watertight ? 'success' : 'warning',
        text: [
          `完成：${abutment.fileName} · ${abutment.seconds.toFixed(1)} 秒 · Job ${abutment.jobId}`,
          `${abutment.tag} fold ${abutment.fold} · 偵測到 ${abutment.sites} 個植體，顯示第 ${abutment.site} 個`,
          `高度 ${abutment.heightMm} mm · ${abutment.faces} 面 · ${abutment.watertight ? '封閉' : '不封閉（有問題）'}`,
          `clip=${abutment.clip} · seat=${(abutment.seatCoverage * 100).toFixed(0)}% · noi=${abutment.merge} · corridor=${abutment.corridor}`,
          abutment.merge === 'off' && '註：noi=off 代表沒有 CAD library，連接部不是型錄零件本身。',
          abutment.corridor?.startsWith('fallback') && '註：corridor 退回未修正版本，是拓樸守門機制起作用，不是錯誤。',
        ].filter(Boolean).join('\n'),
      });
    } catch (error) {
      setMessage({ type: 'error', text: `生成失敗：${error.message}` });
    } finally {
      setRunning(false);
    }
  };

  return <div className='direct-panel'>
    <p className='panel-note'>
      呼叫嘉義 5090 上的 FSAbutment（經 ezai2）產生客製 abutment。這台主機無法直連 192.168.50.0/24，
      走的是公開網域加 Service Token，token 只在伺服器端。
      <b>四個檔案都要自己上傳</b>：這條路徑需要 SC.stl（含 scan body 的重掃）和設計好的牙冠，
      本 viewer 的案例資料兩者都沒有。四個檔案必須同一座標系（設計軟體原始匯出即可）。
    </p>

    <section className='panel-section'>
      <div className='section-title'>案例檔案（四個都必填）</div>
      <div className='file-grid'>
        {FILES.map(([key, label]) => <div key={key} className='file-cell'>
          <Upload accept='.stl' showUploadList={false} beforeUpload={setFile(key)} disabled={running}>
            <Button block size='small' type={files[key] ? 'primary' : 'default'} title={files[key]?.name}>
              {files[key]?.name ?? label}
            </Button>
          </Upload>
          {files[key] && <Button size='small' type='link' onClick={() => setFiles(previous => ({ ...previous, [key]: undefined }))}>×</Button>}
        </div>)}
      </div>
    </section>

    <section className='panel-section'>
      <div className='section-title'>參數</div>
      <div className='field-row'>
        <label title='五折交叉驗證：只有把這個案例留在 test 的那一折才是留出成績，用錯不會報錯'>
          Fold
          <Select
            size='small'
            style={{ width: 88 }}
            value={fold}
            onChange={setFold}
            options={[0, 1, 2, 3, 4].map(f => ({ value: f, label: `fold ${f}` }))}
          />
        </label>
        <label title='關掉會讓 seat 從 0.067 mm 退回 0.47 mm；INFERENCE.md 明確建議開著'>
          <span className='switch-field'>Seat crown <Switch checked={seatCrown} onChange={setSeatCrown} /></span>
        </label>
        <label title='一個案例有多個植體時，要回傳哪一個'>
          Site<InputNumber size='small' min={0} max={9} value={site} onChange={v => setSite(v ?? 0)} />
        </label>
      </div>
      <div className='panel-note'>
        fold 不是隨便選的：五個現成案例是 B01→0、C03→1、C35→2、C30→4、C17→2。
        選錯會拿學過的資料評分，而且<b>不會有任何錯誤訊息</b>。
      </div>
    </section>

    <section className='panel-section'>
      <div className='button-grid'>
        <Button className='prod-model-button' loading={running} onClick={generate}>生成 abutment（嘉義 5090）</Button>
        <Button disabled={running} onClick={checkHealth}>檢查 FSAbutment API</Button>
        <Button disabled={!result} onClick={() => downloadBlob(result.blob, result.fileName)}>下載 PLY</Button>
      </div>
      {message && <Alert className='section-alert' type={message.type} showIcon message={<pre className='plain-pre'>{message.text}</pre>} />}
    </section>
  </div>;
};

export default DirectFSAbutmentPanel;
