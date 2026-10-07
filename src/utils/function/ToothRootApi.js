import axios from 'axios';

import { getFileExtension } from '../tool/StringProcessing.js';

// ToothRoot on the Chiayi 5090 box (CADCAM-RTX5090, 192.168.50.95): the orthodontic team's
// AI tooth segmentation (archnorm + a 25-view 2D U-Net) and root generation (an SDF
// autoencoder + rectified flow). htyau/ToothRoot, served by deploy/deploy_api.py on that box.
//
// Reached the same way as FSAbutment: this box has no route into 192.168.50.0/24, so it goes
// through ezai2's public hostname, and the Cloudflare Access Service Token is attached by the
// proxy in vite.config.js -- server-side, never in this bundle.
const TOOTHROOT_PROXY_BASE = '/api/toothroot-rtx5090';

// What the service reads (it picks the reader from the name). Anything may also be sent
// gzipped as <name>.gz, which is what upload() does with every scan: an arch STL is ~20-30 MB
// and the uplink from this office is ~35 Mbps.
const TOOTHROOT_FORMATS = ['stl', 'ply', 'obj', 'tri'];
const TOOTHROOT_ACCEPT = TOOTHROOT_FORMATS.map(format => `.${format}`).join(',');

const describeHttpError = error => {
  const data = error.response?.data;
  let detail = null;
  if (data instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(data);
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {
      detail = text.slice(0, 300);
    }
  } else if (data && typeof data === 'object') {
    detail = data.detail ?? data.error ?? null;
  } else if (typeof data === 'string' && data && !data.trimStart().startsWith('<')) {
    detail = data.slice(0, 300);
  }
  const status = error.response?.status;
  if (status === 403) return 'Cloudflare Access 拒絕（403）：這個 viewer 實例的 Service Token 可能失效';
  return detail ? `${status ? `${status}：` : ''}${detail}` : (error.message || '連線失敗');
};

/** gzip in the browser. Roughly halves an STL or PLY for well under a second of CPU. */
const gzipFile = async file => {
  const stream = file.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
};

const getToothRootHealth = async () => {
  try {
    return (await axios.get(`${TOOTHROOT_PROXY_BASE}/health`, { timeout: 20000 })).data;
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

const getToothRootInfo = async () => (await axios.get(`${TOOTHROOT_PROXY_BASE}/`, { timeout: 20000 })).data;

/**
 * Upload both arches and queue a job. `roots` false stops after the segmentation.
 * @returns {{ jobId: string, uploadSeconds: number, sentBytes: number, rawBytes: number }}
 */
const submitToothRootJob = async ({ upper, lower, roots = true, res = 192, swap = 'auto', seed = 0, onStage = () => {} }) => {
  for (const [jaw, file] of [['上顎', upper], ['下顎', lower]]) {
    if (!file) throw new Error(`缺少${jaw}口掃：牙根軸向是用上下顎一起投票決定的，兩顎都要`);
    if (!TOOTHROOT_FORMATS.includes(getFileExtension(file.name))) {
      throw new Error(`${file.name}：只收 ${TOOTHROOT_FORMATS.map(f => `.${f}`).join(' / ')}`);
    }
  }
  onStage('正在壓縮口掃（gzip）…');
  const packed = await Promise.all([upper, lower].map(gzipFile));
  const rawBytes = upper.size + lower.size;
  const sentBytes = packed[0].size + packed[1].size;
  if (sentBytes > 95 * 1024 * 1024) {
    throw new Error(`壓縮後仍有 ${(sentBytes / 1048576).toFixed(0)} MB，超過 Cloudflare 的 100 MB 上限`);
  }

  const form = new FormData();
  form.append('upper', packed[0], `upper.${getFileExtension(upper.name)}.gz`);
  form.append('lower', packed[1], `lower.${getFileExtension(lower.name)}.gz`);
  form.append('roots', roots ? '1' : '0');
  form.append('res', String(res));
  form.append('swap', swap);
  form.append('seed', String(seed));

  onStage(`正在上傳 ${(sentBytes / 1048576).toFixed(1)} MB 到嘉義 5090（原檔 ${(rawBytes / 1048576).toFixed(1)} MB）…`);
  const startedAt = performance.now();
  try {
    const response = await axios.post(`${TOOTHROOT_PROXY_BASE}/v1/jobs`, form, { timeout: 10 * 60 * 1000 });
    return { jobId: response.data.job_id, uploadSeconds: (performance.now() - startedAt) / 1000, sentBytes, rawBytes };
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/** Step 2 again on a finished job's segmentation, e.g. at another resolution. */
const rerunToothRootRoots = async (jobId, { res, seed = 0 }) => {
  const form = new FormData();
  form.append('res', String(res));
  form.append('seed', String(seed));
  try {
    await axios.post(`${TOOTHROOT_PROXY_BASE}/v1/jobs/${jobId}/roots`, form, { timeout: 60000 });
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

const getToothRootJob = async jobId => {
  try {
    return (await axios.get(`${TOOTHROOT_PROXY_BASE}/v1/jobs/${jobId}`, { timeout: 30000 })).data;
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/**
 * Poll until the job leaves the queue/GPU. `onUpdate` gets every status document.
 * Resolves with the final one; throws on a failed job.
 */
const waitForToothRootJob = async (jobId, { onUpdate = () => {}, pollMs = 1000, timeoutMs = 20 * 60 * 1000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getToothRootJob(jobId);
    onUpdate(job);
    if (job.state === 'done') return job;
    if (job.state === 'failed') throw new Error(job.error || '工作失敗');
    if (Date.now() > deadline) throw new Error(`工作 ${jobId} 超過 ${timeoutMs / 60000} 分鐘沒有完成`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};

/** One output file as an ArrayBuffer. The service gzips PLY on the wire; the browser inflates it. */
const fetchToothRootFile = async (jobId, path) => {
  try {
    const response = await axios.get(`${TOOTHROOT_PROXY_BASE}/v1/jobs/${jobId}/files/${path}`, {
      responseType: 'arraybuffer',
      timeout: 5 * 60 * 1000,
    });
    return response.data;
  } catch (error) {
    throw new Error(`${path}：${describeHttpError(error)}`);
  }
};

const fetchToothRootArchive = async jobId => {
  try {
    const response = await axios.get(`${TOOTHROOT_PROXY_BASE}/v1/jobs/${jobId}/archive`, {
      responseType: 'arraybuffer',
      timeout: 10 * 60 * 1000,
    });
    return new Blob([response.data], { type: 'application/zip' });
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/** Fire and forget: the outputs are the patient's scan, and the box keeps them 2 h at most anyway. */
const deleteToothRootJob = jobId => axios.delete(`${TOOTHROOT_PROXY_BASE}/v1/jobs/${jobId}`, { timeout: 20000 }).catch(() => {});

export {
  TOOTHROOT_ACCEPT,
  TOOTHROOT_FORMATS,
  deleteToothRootJob,
  fetchToothRootArchive,
  fetchToothRootFile,
  getToothRootHealth,
  getToothRootInfo,
  rerunToothRootRoots,
  submitToothRootJob,
  waitForToothRootJob,
};
