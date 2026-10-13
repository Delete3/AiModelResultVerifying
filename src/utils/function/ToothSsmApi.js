import axios from 'axios';

import { getFileExtension } from '../tool/StringProcessing.js';

// tooth_ssm (htyau/ssm_project), the orthodontic team's AI tooth arrangement: segmentation
// (YOLOv11-seg on 25 rendered views), whole teeth with DeepSDF pseudo roots, and the alignment
// model (a diffusion transformer) that moves every tooth, roots and all. Served by
// deploy/deploy_api.py, which runs the author's own scripts as viewer/server.py does.
//
// Two boxes. This one (z790, RTX 5080) is reached directly: the service is bound to docker0,
// and this viewer's container sees the host as host.docker.internal, so the proxy needs no
// credential. The Chiayi 5090 box is reached the way ToothRoot is, through ezai2 and
// Cloudflare Access, with the Service Token attached by the proxy in vite.config.js --
// server-side, never in this bundle.
const TOOTHSSM_TARGETS = {
  z790: { label: '台中 5080', base: '/api/toothssm-z790', box: '台中 5080' },
  rtx5090: { label: '嘉義 5090', base: '/api/toothssm-rtx5090', box: '嘉義 5090' },
};

// What the service reads (it picks the reader from the name). Every scan is sent gzipped as
// <name>.gz: an arch STL is 10-30 MB.
const TOOTHSSM_FORMATS = ['stl', 'ply', 'obj', 'tri'];
const TOOTHSSM_ACCEPT = TOOTHSSM_FORMATS.map(format => `.${format}`).join(',');

const baseOf = target => (TOOTHSSM_TARGETS[target] ?? TOOTHSSM_TARGETS.z790).base;

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
    detail = data.detail ?? data.error ?? data.status ?? null;
  } else if (typeof data === 'string' && data && !data.trimStart().startsWith('<')) {
    detail = data.slice(0, 300);
  }
  const status = error.response?.status;
  if (status === 403) return 'Cloudflare Access 拒絕（403）：這個 viewer 實例的 Service Token 可能失效';
  if (status === 502 || status === 504) return `${status}：服務沒有回應（容器沒有在跑？）`;
  return detail ? `${status ? `${status}：` : ''}${detail}` : (error.message || '連線失敗');
};

/** gzip in the browser. Roughly halves an STL or PLY for well under a second of CPU. */
const gzipFile = async file => {
  const stream = file.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
};

/** /health answers 503 with a body when the GPU is gone; that body is the useful part. */
const getToothSsmHealth = async target => {
  try {
    return (await axios.get(`${baseOf(target)}/health`, { timeout: 20000 })).data;
  } catch (error) {
    if (error.response?.status === 503 && error.response.data && typeof error.response.data === 'object') {
      return error.response.data;
    }
    throw new Error(describeHttpError(error));
  }
};

const getToothSsmInfo = async target => (await axios.get(`${baseOf(target)}/`, { timeout: 20000 })).data;

/**
 * Upload both arches and queue a job: segment, then generate (roots), then align, stopping
 * after `until`. Both are required -- the case is segmented and articulated as a pair, and
 * the alignment model is dual-arch.
 * @returns {{ jobId: string, uploadSeconds: number, sentBytes: number, rawBytes: number }}
 */
const submitToothSsmJob = async ({ target, upper, lower, res = 128, until = 'align', onStage = () => {} }) => {
  if (!upper || !lower) throw new Error('上下顎口掃都要：分牙與咬合是成對處理的，排牙模型也是上下顎一起看');
  const scans = [['upper', upper], ['lower', lower]];
  for (const [, file] of scans) {
    if (!TOOTHSSM_FORMATS.includes(getFileExtension(file.name))) {
      throw new Error(`${file.name}：只收 ${TOOTHSSM_FORMATS.map(f => `.${f}`).join(' / ')}`);
    }
  }
  onStage('正在壓縮口掃（gzip）…');
  const packed = await Promise.all(scans.map(([, file]) => gzipFile(file)));
  const rawBytes = scans.reduce((sum, [, file]) => sum + file.size, 0);
  const sentBytes = packed.reduce((sum, blob) => sum + blob.size, 0);
  if (sentBytes > 95 * 1024 * 1024) {
    throw new Error(`壓縮後仍有 ${(sentBytes / 1048576).toFixed(0)} MB，超過 100 MB 上限`);
  }

  const form = new FormData();
  scans.forEach(([jaw, file], i) => form.append(jaw, packed[i], `${jaw}.${getFileExtension(file.name)}.gz`));
  form.append('res', String(res));
  form.append('until', until);

  onStage(`正在上傳 ${(sentBytes / 1048576).toFixed(1)} MB 到${TOOTHSSM_TARGETS[target]?.box ?? ''}（原檔 ${(rawBytes / 1048576).toFixed(1)} MB）…`);
  const startedAt = performance.now();
  try {
    const response = await axios.post(`${baseOf(target)}/v1/jobs`, form, { timeout: 10 * 60 * 1000 });
    return { jobId: response.data.job_id, uploadSeconds: (performance.now() - startedAt) / 1000, sentBytes, rawBytes };
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/** `step` (generate or align) and the steps after it, on a finished job's earlier results. */
const rerunToothSsmStep = async (target, jobId, { step, res }) => {
  const form = new FormData();
  form.append('step', step);
  if (res) form.append('res', String(res));
  try {
    await axios.post(`${baseOf(target)}/v1/jobs/${jobId}/run`, form, { timeout: 60000 });
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

const getToothSsmJob = async (target, jobId) => {
  try {
    return (await axios.get(`${baseOf(target)}/v1/jobs/${jobId}`, { timeout: 30000 })).data;
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/**
 * Poll until the job leaves the queue/GPU. `onUpdate` gets every status document.
 * Resolves with the final one; throws on a failed job (with the log tail, which says why).
 */
const waitForToothSsmJob = async (target, jobId, { onUpdate = () => {}, pollMs = 1500, timeoutMs = 40 * 60 * 1000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getToothSsmJob(target, jobId);
    onUpdate(job);
    if (job.state === 'done') return job;
    if (job.state === 'failed') {
      const error = new Error(`${job.error || '工作失敗'}${job.log_tail ? `\n\n${job.log_tail}` : ''}`);
      error.job = job;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`工作 ${jobId} 超過 ${timeoutMs / 60000} 分鐘沒有完成`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};

/** One output file as an ArrayBuffer; `url` is relative to the job (`files/...`, as the status lists them). */
const fetchToothSsmFile = async (target, jobId, url) => {
  try {
    const response = await axios.get(`${baseOf(target)}/v1/jobs/${jobId}/${url}`, {
      responseType: 'arraybuffer',
      timeout: 5 * 60 * 1000,
    });
    return response.data;
  } catch (error) {
    throw new Error(`${url}：${describeHttpError(error)}`);
  }
};

const fetchToothSsmArchive = async (target, jobId) => {
  try {
    const response = await axios.get(`${baseOf(target)}/v1/jobs/${jobId}/archive`, {
      responseType: 'arraybuffer',
      timeout: 10 * 60 * 1000,
    });
    return new Blob([response.data], { type: 'application/zip' });
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/** Fire and forget: the outputs are the patient's scans, and the box keeps them 2 h at most anyway. */
const deleteToothSsmJob = (target, jobId) =>
  axios.delete(`${baseOf(target)}/v1/jobs/${jobId}`, { timeout: 20000 }).catch(() => {});

export {
  TOOTHSSM_ACCEPT,
  TOOTHSSM_FORMATS,
  TOOTHSSM_TARGETS,
  deleteToothSsmJob,
  fetchToothSsmArchive,
  fetchToothSsmFile,
  getToothSsmHealth,
  getToothSsmInfo,
  rerunToothSsmStep,
  submitToothSsmJob,
  waitForToothSsmJob,
};
