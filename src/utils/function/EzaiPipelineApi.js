import axios from 'axios';

// The production entry point: one upload of the two raw arch scans, and the service runs
// jaw → transform → margin → crown itself. Same three models the browser used to call one
// by one, but without shipping multi-megabyte meshes back out to the client between each
// stage, and with the service reporting its own per-stage timings.
const PIPELINE_BASE = '/api/pipeline';

// The same service on two machines, for comparing them on identical input.
//
// Both entries are same-origin paths that vite.config.js proxies. The Chiayi one leaves
// this host over the public hostname and through Cloudflare Access; the Service Token that
// needs is attached by that proxy, server-side, and deliberately does not exist in this
// bundle. Do not "simplify" this by pointing the browser straight at
// https://ezai2.inteware.com.tw -- it would need the token in client code, and CORS would
// reject it anyway.
//
// `remote: true` is what the UI reads to know that wall-clock here includes an internet
// round trip and is therefore NOT the number to compare between the two boxes. The
// service's own timings_ms are.
const PIPELINE_TARGETS = {
  z790: {
    base: PIPELINE_BASE,
    label: 'z790 8031',
    hint: '台中 · RTX 5080 · 區網直連',
    remote: false,
  },
  rtx5090: {
    base: '/api/pipeline-rtx5090',
    label: '5090 ezai2',
    hint: '嘉義 · RTX 5090 · 經 Cloudflare tunnel',
    remote: true,
  },
  // The same box and the same proxy as above -- only how the meshes get there differs. The
  // scans go to object storage and the POST carries two URLs instead of 30 MB of body, so
  // ezai-pipeline pulls them from S3 (measured 18-21 MB/s) rather than having them pushed
  // through the tunnel (~8 MB/s at best, and the ceiling for a slow client is that client).
  //
  // Whether this is faster depends entirely on where the caller sits, which is the point of
  // having the button next to the plain one: run both on the same case and read the two
  // transfer rows against each other.
  rtx5090_s3: {
    base: '/api/pipeline-rtx5090',
    label: '5090 ezai2 · S3',
    hint: '嘉義 · RTX 5090 · 口掃走 S3',
    remote: true,
    viaS3: true,
  },
};

/**
 * Hand one file to the dev server, which streams it to S3 and answers with a presigned GET
 * URL for it. The AWS credentials stay in that process; this bundle never holds one.
 */
const uploadToS3 = async (file, key, timeoutMs) => {
  const { data } = await axios.post(
    `/api/s3/upload?key=${encodeURIComponent(key)}`,
    file,
    { headers: { 'Content-Type': 'application/octet-stream' }, timeout: timeoutMs },
  );
  return data;
};

// --- a very small zip reader -----------------------------------------------------------
// The archive holds one member worth having here — crown.ply, which the service stores
// uncompressed precisely because deflate buys nothing on dense binary floats — plus four
// small JSON/pts members the viewer does not need. Slicing one uncompressed range does not
// justify a zip dependency. The deflate branch exists so that a future change of heart in
// pipeline.py does not turn into a blank preview.
//
// Zip64 is not handled: these archives are a couple of megabytes.
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

const findEndOfCentralDirectory = (view) => {
  // The record is 22 bytes plus a comment of up to 64 KB, so scan back from the end.
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === SIG_EOCD) return at;
  }
  throw new Error('pipeline 回傳的檔案不是有效的 zip（找不到 end-of-central-directory）');
};

const readEntry = (buffer, name) => {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new Error('zip central directory 損毀');
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const entryName = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));

    if (entryName === name) {
      // The local header repeats the name and extra field, and its extra field length can
      // differ from the central one, so the data offset has to come from the local header.
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      return { bytes: new Uint8Array(buffer, start, compressedSize), method };
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`pipeline 回傳的 zip 裡沒有 ${name}`);
};

const extractFromZip = async (buffer, name) => {
  const { bytes, method } = readEntry(buffer, name);
  if (method === 0) return bytes;
  if (method === 8) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`不支援的 zip 壓縮方式：${method}`);
};

// --- the job API -------------------------------------------------------------------------

const STAGE_LABELS = {
  jaw: '擺正',
  transform: '座標轉換',
  margin: 'Margin',
  crown: '牙冠',
  packaging: '打包',
};

/** Row labels for the service's timings_ms, in the order the stages run. */
const TIMING_LABELS = [
  ['jaw_ms', '擺正推論'],
  ['transform_ms', '座標轉換'],
  ['margin_ms', 'Margin 推論'],
  ['crown_ms', '牙冠推論'],
  ['packaging_ms', '打包與回原座標'],
];

const pipelineTimings = (timingsMs = {}) => TIMING_LABELS
  .filter(([key]) => typeof timingsMs[key] === 'number')
  .map(([key, label]) => ({ label, seconds: timingsMs[key] / 1000 }));

const describeError = (job) => {
  const stage = job.error_stage ? `${STAGE_LABELS[job.error_stage] ?? job.error_stage} 階段：` : '';
  return `${stage}${job.error || '未提供原因'}`;
};

/**
 * Submit both raw scans, wait for the job, and return the crown plus what the service
 * measured. onStage reports progress; the caller decides how to show it.
 */
const runPipelineJob = async ({
  upperStl,
  lowerStl,
  fdi,
  allToothFdi = '',
  onStage = () => {},
  pollMs = 500,
  timeoutMs = 15 * 60 * 1000,
  // Defaults to the local box, so every existing call site keeps its behaviour.
  target = 'z790',
}) => {
  const site = PIPELINE_TARGETS[target];
  if (!site) throw new Error(`未知的 pipeline 目標：${target}`);
  const base = site.base;
  if (!upperStl || !lowerStl) throw new Error('需要 upper.stl 與 lower.stl');

  // Cloudflare caps a request body at 100 MB and cannot be configured past it, so a pair of
  // scans over that limit fails at the edge with a 413 that says nothing about which file
  // was too big. Catch it here while both sizes are still in hand. The local box has no
  // such limit, which is why this is checked per target rather than always.
  // Not checked for the S3 route: the request body there is a couple of hundred bytes of
  // URLs, so the edge cap simply does not apply to it. That is one of the things the button
  // exists to demonstrate.
  if (site.remote && !site.viaS3) {
    const totalMb = (upperStl.size + lowerStl.size) / 1024 / 1024;
    if (totalMb > 95) {
      throw new Error(
        `上下顎合計 ${totalMb.toFixed(1)} MB，超過 Cloudflare 的 100 MB 上限，`
        + `無法送到${site.hint}。這一組請改用 S3 那顆按鈕，或用本機 pipeline 測。`,
      );
    }
  }

  const form = new FormData();
  form.append('fdi', String(fdi));
  if (allToothFdi.trim()) form.append('all_tooth_numbers', allToothFdi.trim());

  let uploadSeconds = 0;
  let s3Keys = [];
  if (site.viaS3) {
    // One prefix per run, so two runs of the same case never race for the same key.
    const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    onStage('正在把上下顎口掃放上 S3…');
    const startedAt = performance.now();
    // Concurrently: the two are independent and S3 takes both at once happily.
    const [upper, lower] = await Promise.all([
      uploadToS3(upperStl, `${prefix}/upper.stl`, timeoutMs),
      uploadToS3(lowerStl, `${prefix}/lower.stl`, timeoutMs),
    ]);
    uploadSeconds = (performance.now() - startedAt) / 1000;
    s3Keys = [upper.key, lower.key];
    // The pipeline reads the file type from the URL path, which is why the keys above end
    // in .stl and why nothing here relies on a filename or a content type.
    form.append('upper_stl_url', upper.get);
    form.append('lower_stl_url', lower.get);
    onStage(`S3 上傳完成（${uploadSeconds.toFixed(1)} 秒），正在送出 job…`);
  } else {
    form.append('upper_stl', upperStl, 'upper.stl');
    form.append('lower_stl', lowerStl, 'lower.stl');
    onStage(`正在上傳上下顎口掃到 ${site.label}（${site.hint}）…`);
  }

  let submitted;
  try {
    submitted = await axios.post(`${base}/v1/jobs`, form, { timeout: timeoutMs });
  } finally {
    // ezai-pipeline fetches both objects *during* the POST, before it answers 202, so by
    // the time control returns here they have been read and nothing will want them again.
    // These are real clinical scans in a shared dev bucket; they do not get left there.
    // Fire and forget -- a failed cleanup must not fail a job that already succeeded.
    if (s3Keys.length) axios.post('/api/s3/cleanup', { keys: s3Keys }).catch(() => {});
  }
  const jobId = submitted.data.job_id;

  const deadline = Date.now() + timeoutMs;
  let job = submitted.data;
  let lastReport = '';

  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) throw new Error(`pipeline job ${jobId} 超過 ${timeoutMs / 1000} 秒未完成`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
    job = (await axios.get(`${base}/v1/jobs/${jobId}`, { timeout: 30000 })).data;

    const report = job.status === 'queued'
      ? `排隊中${job.queue_position != null ? `（前面還有 ${job.queue_position} 筆）` : ''}…`
      : `正在執行：${STAGE_LABELS[job.stage] ?? job.stage ?? '啟動中'}…`;
    if (report !== lastReport) {
      onStage(report);
      lastReport = report;
    }
  }

  if (job.status !== 'succeeded') throw new Error(describeError(job));

  onStage('正在取回結果…');
  const archive = await axios.get(`${base}/v1/jobs/${jobId}/result`, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
  });
  const crown = await extractFromZip(archive.data, 'crown.ply');

  return {
    // The service rotates the crown back into the frame the scans arrived in, so this
    // previews against the raw uploads with no matrix of our own.
    blob: new Blob([crown], { type: 'model/ply' }),
    // The target is in the filename so that two downloads of the same case do not collide
    // in ~/Downloads as "…(1).ply", which is exactly the moment a comparison stops being
    // one.
    fileName: `pipeline_crown_FDI${fdi}_${target}.ply`,
    jobId,
    timings: pipelineTimings(job.timings_ms),
    serverSeconds: (job.timings_ms?.total_ms ?? 0) / 1000,
    // The S3 route only: how long this browser spent putting the scans in the bucket, kept
    // apart from the pipeline's own time so the two buttons can be read against each other.
    uploadSeconds,
    // What the service says it fetched, and from where -- the URL with its signature
    // stripped, plus the bytes and the milliseconds it spent on each. This is the number
    // that says whether the box pulled them quickly; the browser cannot see that leg.
    sources: job.sources ?? {},
    warnings: job.warnings ?? [],
    // The service fixes these itself; the panel's Resolution and Chamfer controls do not
    // reach it. Reported so nobody tunes a control that this button ignores.
    crownParams: job.crown_params ?? {},
    // Which box produced this, for the panel to label the result and its timings.
    target,
    site,
  };
};

export { runPipelineJob, PIPELINE_TARGETS };
