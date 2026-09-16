/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Collapse, Spin, Tag } from 'antd';

import { formatTimings } from '../../utils/function/formatTimings';
import { downloadBlob } from '../../utils/tool/useStores';

const MODE_LABEL = {
  full: 'AI margin → 牙冠',
  margin_only: '只預測 margin',
  margin_override: '自訂 margin → 牙冠',
};

/** The per-stage table, plus whatever the browser waited on top of the service's own time. */
const timingBlock = result => {
  const fetchSeconds = Object.values(result.sources ?? {}).map(s => (s.fetch_ms ?? 0) / 1000);
  const boxFetchSeconds = fetchSeconds.length ? Math.max(...fetchSeconds) : 0;
  const rows = result.site.viaS3
    ? [
      { label: 'S3 上傳', seconds: result.uploadSeconds, note: '瀏覽器 → 這台主機 → S3' },
      ...result.timings,
      {
        label: '送出與取回',
        seconds: Math.max(0, result.totalSeconds - result.serverSeconds - result.uploadSeconds),
        note: `其中 5090 從 S3 取檔 ${boxFetchSeconds.toFixed(1)} 秒`,
      },
    ]
    : [
      ...result.timings,
      {
        label: result.site.remote ? '上傳與取回（含 tunnel）' : '上傳與取回',
        seconds: Math.max(0, result.totalSeconds - result.serverSeconds),
      },
    ];
  const params = Object.entries(result.crownParams ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  return formatTimings(rows, result.totalSeconds)
    + (params ? `\n  牙冠參數（pipeline 決定）：${params}` : '')
    // The number most likely to be compared across boxes is the total, which for a remote
    // box includes an internet round trip and says nothing about the GPU.
    + (result.site.remote ? '\n  ⓘ 跨機比較請看各階段推論時間；總計含網路往返，不是 GPU 的差距' : '');
};

/**
 * Step 3's output: progress while a job runs, then what came back.
 *
 * Props: running (null | 'crown' | 'margin' | 'direct'), progress, error, result,
 * onEditRing (load the ring the job used into the editor).
 */
const ResultView = ({ running, progress, error, result, onEditRing }) => {
  if (!running && !error && !result) return null;

  const standin = result?.manifest?.backends?.crown?.antagonist;
  const relief = Number(result?.manifest?.backends?.crown?.antagonist_relief ?? 0);

  return <div className='result-view'>
    {running && <Alert type='info' showIcon icon={<Spin size='small' />} message={progress || '處理中…'} />}
    {!running && error && <Alert
      type='error'
      showIcon
      message='沒有完成'
      description={<pre className='plain-pre'>{error}</pre>}
    />}

    {!running && result && <>
      <Alert
        type={result.warnings.length ? 'warning' : 'success'}
        showIcon
        message={`${result.mode === 'margin_only' ? 'Margin 已預測' : '牙冠已生成'} · ${result.site.label}`}
        description={<div className='result-meta'>
          <div>
            <Tag>{MODE_LABEL[result.mode] ?? result.mode}</Tag>
            {result.singleArch
              ? <Tag color='orange'>單顎 · 對咬為平面替身 {standin?.height_above_margin_mm != null ? `${Number(standin.height_above_margin_mm).toFixed(1)} mm` : ''}</Tag>
              : result.mode !== 'margin_only' && <Tag color='blue'>上下顎</Tag>}
            {relief > 0 && <Tag color='gold'>對咬被移開 {relief.toFixed(2)} mm</Tag>}
          </div>
          <div className='job-id'>Job {result.jobId} · {result.totalSeconds.toFixed(1)} 秒</div>
        </div>}
      />

      {result.warnings.length > 0 && <ul className='warning-list'>
        {result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>}

      <div className='button-row'>
        {result.blob && <Button type='primary' onClick={() => downloadBlob(result.blob, result.fileName)}>下載牙冠 PLY</Button>}
        {result.archive && <Button onClick={() => downloadBlob(result.archive, result.archiveName)}>下載完整結果 ZIP</Button>}
        {result.mode === 'full' && result.marginOriginal?.length > 2 && <Button onClick={() => onEditRing(result)}>
          用這條 AI margin 修改
        </Button>}
      </div>

      <Collapse
        size='small'
        className='timing-collapse'
        items={[{ key: 't', label: '各階段時間', children: <pre className='flow-message'>{timingBlock(result)}</pre> }]}
      />
    </>}
  </div>;
};

export default ResultView;
