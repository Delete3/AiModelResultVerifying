import axios from 'axios';

// The production entry point: one upload of the two raw arch scans, and the service runs
// jaw → transform → margin → crown itself. Same three models the browser used to call one
// by one, but without shipping multi-megabyte meshes back out to the client between each
// stage, and with the service reporting its own per-stage timings.
const PIPELINE_BASE = '/api/pipeline';

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
}) => {
  if (!upperStl || !lowerStl) throw new Error('需要 upper.stl 與 lower.stl');

  const form = new FormData();
  form.append('upper_stl', upperStl, 'upper.stl');
  form.append('lower_stl', lowerStl, 'lower.stl');
  form.append('fdi', String(fdi));
  if (allToothFdi.trim()) form.append('all_tooth_numbers', allToothFdi.trim());

  onStage('正在上傳上下顎口掃到 pipeline…');
  const submitted = await axios.post(`${PIPELINE_BASE}/v1/jobs`, form, { timeout: timeoutMs });
  const jobId = submitted.data.job_id;

  const deadline = Date.now() + timeoutMs;
  let job = submitted.data;
  let lastReport = '';

  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) throw new Error(`pipeline job ${jobId} 超過 ${timeoutMs / 1000} 秒未完成`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
    job = (await axios.get(`${PIPELINE_BASE}/v1/jobs/${jobId}`, { timeout: 30000 })).data;

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
  const archive = await axios.get(`${PIPELINE_BASE}/v1/jobs/${jobId}/result`, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
  });
  const crown = await extractFromZip(archive.data, 'crown.ply');

  return {
    // The service rotates the crown back into the frame the scans arrived in, so this
    // previews against the raw uploads with no matrix of our own.
    blob: new Blob([crown], { type: 'model/ply' }),
    fileName: `pipeline_crown_FDI${fdi}.ply`,
    jobId,
    timings: pipelineTimings(job.timings_ms),
    serverSeconds: (job.timings_ms?.total_ms ?? 0) / 1000,
    warnings: job.warnings ?? [],
    // The service fixes these itself; the panel's Resolution and Chamfer controls do not
    // reach it. Reported so nobody tunes a control that this button ignores.
    crownParams: job.crown_params ?? {},
  };
};

export { runPipelineJob };
