import axios from 'axios';

import { getFileExtension } from '../tool/StringProcessing.js';
import {
  boxLabel,
  createDispatcherJob,
  deleteDispatcherJob,
  describeDispatcherFailure,
  fetchDispatcherMember,
  fetchDispatcherResult,
  getDispatcherJob,
  getDispatcherStatus,
  summarizeDispatcher,
  uploadToDispatcher,
} from './DispatcherApi.js';

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
//
// The third target (2026-10-29) is the Chiayi box's TEST service, ezai2 /toothssm-fit/: the same
// API with the crown on the scan by default -- since 2026-10-30 pm crown=fit, the generated tooth
// remeshed and fitted onto the scan crown, neighbours parted (ssm_project branch fit/crown-exact).
// Same Access token as Chiayi.
//
// The last two (2026-11-06) go through the AI dispatcher's test site (DispatcherApi.js): 「分派器」
// lets it choose the box or cloud container (route=auto), 「modal雲端」 runs in a Modal cloud
// container only (route=cloud: RTX PRO 6000, Chiayi's production tooth_ssm image). A job there is
// the whole chain from the scans in S3 to a zip in S3 -- the service's archive plus its status
// document (ezai/job.json) -- so a rerun is a new job on that zip (start=generate|align), and the
// files are read out of it here. The cloud has no ToothRoot: `segs` limits 分牙＋牙根 to tooth_ssm.
const TOOTHSSM_TARGETS = {
  z790: { label: '台中 5080', base: '/api/toothssm-z790', box: '台中 5080' },
  rtx5090: { label: '嘉義 5090', base: '/api/toothssm-rtx5090', box: '嘉義 5090' },
  dispatcher: { label: '分派器', box: '分派器', dispatcher: true, route: 'auto' },
  cloud: { label: 'modal雲端', box: 'modal雲端', dispatcher: true, route: 'cloud', segs: ['ssm'] },
};
const isDispatched = target => Boolean(TOOTHSSM_TARGETS[target]?.dispatcher);

// Who segments the scans and grows the roots; either way tooth_ssm's alignment model arranges the
// teeth. The orthodontic project files' scans are decimated to ~12k faces: tooth_ssm's own
// segmentation finds a few teeth on them and its roots step refuses every crown under 300
// vertices, while ToothRoot segments them fully. The author's pipeline is the default all the same
// (user, 2026-10-13), so that QC tests it first; ToothRoot is one click away.
const TOOTHSSM_SEG_OPTIONS = [
  { value: 'ssm', label: 'tooth_ssm 原作者流程（預設）' },
  { value: 'toothroot', label: 'ToothRoot 分牙＋牙根' },
];

// What goes under the crown (`root`): both production boxes take it since 2026-11-02 (the test
// target /api/toothssm-fit of 10-30..11-02 is gone); the default is virtual. `none` returns the
// crowns alone, with each tooth's axis, and makes no arrangement.
const TOOTHSSM_ROOT_OPTIONS = [
  { value: 'virtual', label: '矯正式虛擬牙根（預設）' },
  { value: 'generated', label: 'AI 生成牙根' },
  { value: 'none', label: '不接牙根：只回牙冠＋牙軸（不排牙）' },
];
const TOOTHSSM_ROOT_TARGETS = ['z790', 'rtx5090', 'dispatcher', 'cloud'];
// How the crown is made (`crown`): `fit` (the default) the generated tooth fitted onto the scan, an
// even mesh with no seam; `exact` the scan crown as segmented; `zhu` the author's whole regenerated
// tooth -- with root=generated, what production returned until 2026-11-01.
const TOOTHSSM_CROWN_OPTIONS = [
  { value: 'fit', label: 'AI 牙齒擬合口掃（預設）' },
  { value: 'exact', label: '口掃牙冠原樣' },
  { value: 'zhu', label: '整顆 AI 重新生成（舊預設，配 AI 生成牙根）' },
];

// The roots step (`fast_roots`, both boxes since 2026-11-05): the cheaper latent fits that went to
// production on 2026-11-02 (TF32, a 250-step first fit, the anchored fit carried on from it), or
// the fits as before. A switch so that the user can test the difference for a report; the boxes'
// default is `1`.
const TOOTHSSM_FAST_ROOTS_OPTIONS = [
  { value: '1', label: '加速版（預設）' },
  { value: '0', label: '加速前（原本的擬合）' },
];

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

// --- through the dispatcher -----------------------------------------------------------------
// What each dispatcher job was asked to do (its view does not repeat the params), and the status
// document of each finished one (ezai/job.json in its zip), by dispatcher job id.
const dispatcherParams = new Map();
const dispatcherDocs = new Map();
// The status document's file URLs -> where the worker put the same files in the zip (the
// document's own zip_paths says so; this is what the worker wrote on 2026-11-06).
const DEFAULT_ZIP_PATHS = { 'files/seg/': 'segmentation/', 'files/result/': 'result/', 'files/raw/': 'raw/' };

/** Every string in the document that is one of its file URLs, as that file's path in the zip. */
const remapZipPaths = (value, paths) => {
  if (typeof value === 'string') {
    const prefix = Object.keys(paths).find(p => value.startsWith(p));
    return prefix ? paths[prefix] + value.slice(prefix.length) : value;
  }
  if (Array.isArray(value)) return value.map(v => remapZipPaths(v, paths));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapZipPaths(v, paths)]));
  }
  return value;
};

/**
 * A dispatcher job's view as the status document the panel reads from a box: state queued /
 * starting (on a box, before tooth_ssm has it) / segmenting / generating / aligning, from the
 * progress the worker reports; done is the job's own ezai/job.json, with its file URLs turned into
 * paths in the zip. `dispatcher` says where it ran.
 */
const docFromView = async view => {
  const base = {
    job_id: view.id,
    params: dispatcherParams.get(view.id),
    dispatcher: { where: view.where, attempts: view.attempts, timings: view.timings ?? {}, route: view.route ?? 'auto' },
  };
  if (view.status === 'queued') return { ...base, state: 'queued', predicted_finish_s: view.predicted_finish_s };
  if (view.status === 'running') {
    const p = view.progress;
    if (!p?.state || p.state === 'queued') return { ...base, state: 'starting', queue_position: p?.queue_position };
    return {
      ...base,
      state: p.state,
      step: p.step,
      step_elapsed_s: p.step_elapsed_s,
      progress: p.teeth_total ? { teeth_done: p.teeth_done ?? 0, teeth_total: p.teeth_total } : null,
    };
  }
  if (view.status === 'succeeded') {
    if (!dispatcherDocs.has(view.id)) {
      const raw = JSON.parse(new TextDecoder().decode(await fetchDispatcherMember(view.id, 'ezai/job.json')));
      const { zip_paths: zipPaths, ...doc } = raw;
      dispatcherDocs.set(view.id, {
        ...remapZipPaths(doc, zipPaths ?? DEFAULT_ZIP_PATHS),
        ...base,
        params: doc.params ?? base.params,
        box_job_id: doc.job_id,
        state: 'done',
      });
    }
    return dispatcherDocs.get(view.id);
  }
  return { ...base, state: 'failed', error: describeDispatcherFailure(view) };
};

// --- the API ----------------------------------------------------------------------------------

/**
 * /health answers 503 with a body when the GPU is gone; that body is the useful part. Through the
 * dispatcher: what its /v2/status says about 排牙, as { status, summary }.
 */
const getToothSsmHealth = async target => {
  if (isDispatched(target)) {
    try {
      const { ok, text } = summarizeDispatcher(await getDispatcherStatus(), 'toothssm', TOOTHSSM_TARGETS[target].route);
      return { status: ok ? 'ok' : 'unavailable', summary: text };
    } catch (error) {
      throw new Error(error.message);
    }
  }
  try {
    return (await axios.get(`${baseOf(target)}/health`, { timeout: 20000 })).data;
  } catch (error) {
    if (error.response?.status === 503 && error.response.data && typeof error.response.data === 'object') {
      return error.response.data;
    }
    throw new Error(describeHttpError(error));
  }
};

/** The service's GET / (its tooth colours). The dispatcher has none of its own: a box answers. */
const getToothSsmInfo = async target => {
  if (!isDispatched(target)) return (await axios.get(`${baseOf(target)}/`, { timeout: 20000 })).data;
  for (const box of ['z790', 'rtx5090']) {
    try {
      return (await axios.get(`${baseOf(box)}/`, { timeout: 20000 })).data;
    } catch {
      // the other box
    }
  }
  return {};
};

/**
 * Upload both arches and queue a job: segment, then generate (roots), then align, stopping
 * after `until`. Both are required -- the case is segmented and articulated as a pair, and
 * the alignment model is dual-arch.
 * @returns {{ jobId: string, uploadSeconds: number, sentBytes: number, rawBytes: number }}
 */
const submitToothSsmJob = async ({ target, upper, lower, res = 128, until = 'align', seg = 'ssm', root = null, crown = null, fastRoots = null, onStage = () => {} }) => {
  if (!upper || !lower) throw new Error('上下顎口掃都要：分牙與咬合是成對處理的，排牙模型也是上下顎一起看');
  const scans = [['upper', upper], ['lower', lower]];
  for (const [, file] of scans) {
    if (!TOOTHSSM_FORMATS.includes(getFileExtension(file.name))) {
      throw new Error(`${file.name}：只收 ${TOOTHSSM_FORMATS.map(f => `.${f}`).join(' / ')}`);
    }
  }
  const site = TOOTHSSM_TARGETS[target];
  if (site?.segs && !site.segs.includes(seg)) {
    throw new Error(`${site.label} 沒有「${TOOTHSSM_SEG_OPTIONS.find(o => o.value === seg)?.label ?? seg}」：雲端只有 tooth_ssm 自己的分牙`);
  }
  onStage('正在壓縮口掃（gzip）…');
  const packed = await Promise.all(scans.map(([, file]) => gzipFile(file)));
  const rawBytes = scans.reduce((sum, [, file]) => sum + file.size, 0);
  const sentBytes = packed.reduce((sum, blob) => sum + blob.size, 0);
  // Cloudflare refuses a body over 100 MB: one POST of both here, one upload each through the dispatcher.
  const largest = isDispatched(target) ? Math.max(...packed.map(blob => blob.size)) : sentBytes;
  // (the dispatcher's upload route on this server takes 99 MB at most: vite.config.js)
  if (largest > (isDispatched(target) ? 94 : 95) * 1024 * 1024) {
    throw new Error(`壓縮後仍有 ${(largest / 1048576).toFixed(0)} MB，超過 100 MB 上限`);
  }

  if (isDispatched(target)) {
    onStage(`正在經這台主機把 ${(sentBytes / 1048576).toFixed(1)} MB 放上 S3（原檔 ${(rawBytes / 1048576).toFixed(1)} MB）…`);
    const startedAt = performance.now();
    const [up, low] = await Promise.all(scans.map(([jaw, file], i) => uploadToDispatcher(packed[i], `${jaw}.${getFileExtension(file.name)}.gz`)));
    const uploadSeconds = (performance.now() - startedAt) / 1000;
    const params = { res: String(res), until, seg };
    if (root) params.root = root;
    if (crown) params.crown = crown;
    if (fastRoots) params.fast_roots = fastRoots;
    onStage(`上傳完成（${uploadSeconds.toFixed(1)} 秒），正在送出 job 給${site.label}…`);
    const view = await createDispatcherJob({
      service: 'toothssm', route: site.route, inputs: { upper_url: up.get_url, lower_url: low.get_url }, params,
    });
    dispatcherParams.set(view.id, params);
    return { jobId: view.id, uploadSeconds, sentBytes, rawBytes };
  }

  const form = new FormData();
  scans.forEach(([jaw, file], i) => form.append(jaw, packed[i], `${jaw}.${getFileExtension(file.name)}.gz`));
  form.append('res', String(res));
  form.append('until', until);
  form.append('seg', seg);
  if (root && TOOTHSSM_ROOT_TARGETS.includes(target)) form.append('root', root);
  if (crown && TOOTHSSM_ROOT_TARGETS.includes(target)) form.append('crown', crown);
  if (fastRoots && TOOTHSSM_ROOT_TARGETS.includes(target)) form.append('fast_roots', fastRoots);

  onStage(`正在上傳 ${(sentBytes / 1048576).toFixed(1)} MB 到${TOOTHSSM_TARGETS[target]?.box ?? ''}（原檔 ${(rawBytes / 1048576).toFixed(1)} MB）…`);
  const startedAt = performance.now();
  try {
    const response = await axios.post(`${baseOf(target)}/v1/jobs`, form, { timeout: 10 * 60 * 1000 });
    return { jobId: response.data.job_id, uploadSeconds: (performance.now() - startedAt) / 1000, sentBytes, rawBytes };
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/**
 * `step` (generate or align) and the steps after it, up to `until`, on a finished job's earlier
 * results. Without `until` the service goes on to align, whatever the job was created with.
 *
 * Through the dispatcher there is no job to rerun in place: this makes a NEW job whose input is
 * the finished one's result zip (teeth_url, start=step), with its seg, and resolves with
 * { jobId } of the new job -- the old one stays until the caller forgets it.
 */
const rerunToothSsmStep = async (target, jobId, { step, res, until = null, root = null, crown = null, fastRoots = null }) => {
  if (isDispatched(target)) {
    // A fresh view signs a fresh result_url.
    const previous = await getDispatcherJob(jobId);
    if (previous.status !== 'succeeded' || !previous.result_url) {
      throw new Error(`job ${jobId} 沒有結果可以接著做（${previous.status}）`);
    }
    const seg = dispatcherDocs.get(jobId)?.params?.seg ?? dispatcherParams.get(jobId)?.seg;
    const params = { start: step };
    if (res) params.res = String(res);
    if (until) params.until = until;
    if (seg) params.seg = seg;
    if (root) params.root = root;
    if (crown) params.crown = crown;
    if (fastRoots) params.fast_roots = fastRoots;
    const view = await createDispatcherJob({
      service: 'toothssm', route: TOOTHSSM_TARGETS[target].route, inputs: { teeth_url: previous.result_url }, params,
    });
    dispatcherParams.set(view.id, params);
    return { jobId: view.id };
  }
  const form = new FormData();
  form.append('step', step);
  if (res) form.append('res', String(res));
  if (until) form.append('until', until);
  if (root && TOOTHSSM_ROOT_TARGETS.includes(target)) form.append('root', root);
  if (crown && TOOTHSSM_ROOT_TARGETS.includes(target)) form.append('crown', crown);
  if (fastRoots && TOOTHSSM_ROOT_TARGETS.includes(target)) form.append('fast_roots', fastRoots);
  try {
    await axios.post(`${baseOf(target)}/v1/jobs/${jobId}/run`, form, { timeout: 60000 });
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
  return null;
};

const getToothSsmJob = async (target, jobId) => {
  if (isDispatched(target)) return docFromView(await getDispatcherJob(jobId));
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

/**
 * One output file as an ArrayBuffer; `url` is relative to the job (`files/...`, as the status lists
 * them) -- through the dispatcher, the file's path in the job's zip (as docFromView rewrote it).
 */
const fetchToothSsmFile = async (target, jobId, url) => {
  if (isDispatched(target)) return fetchDispatcherMember(jobId, url);
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

/**
 * The job's zip. `contents`: 'full' (the default, everything) or 'slim' (since 2026-11-10 on both
 * boxes: the processed scans as .tri, the segmentation as one label byte per scan face (.trimp), the
 * whole teeth as .tri, the JSON -- ~1/9 of full, lossless; ssm_project deploy/slim.py). The
 * dispatcher hands back the box's full zip only, so there is no slim archive through it.
 */
const hasSlimArchive = target => !isDispatched(target);

const fetchToothSsmArchive = async (target, jobId, contents = 'full') => {
  if (contents === 'slim' && !hasSlimArchive(target)) throw new Error(`${TOOTHSSM_TARGETS[target]?.label ?? target}沒有精簡包，請下載全部結果`);
  if (isDispatched(target)) return new Blob([await fetchDispatcherResult(jobId)], { type: 'application/zip' });
  try {
    const query = contents === 'slim' ? '?contents=slim' : '';
    const response = await axios.get(`${baseOf(target)}/v1/jobs/${jobId}/archive${query}`, {
      responseType: 'arraybuffer',
      timeout: 10 * 60 * 1000,
    });
    return new Blob([response.data], { type: 'application/zip' });
  } catch (error) {
    throw new Error(describeHttpError(error));
  }
};

/**
 * Fire and forget: the outputs are the patient's scans, and the box keeps them 2 h at most anyway.
 * Through the dispatcher this cancels a running job, or deletes a finished one's zip from S3.
 */
const deleteToothSsmJob = (target, jobId) => {
  if (isDispatched(target)) {
    dispatcherDocs.delete(jobId);
    dispatcherParams.delete(jobId);
    return deleteDispatcherJob(jobId);
  }
  return axios.delete(`${baseOf(target)}/v1/jobs/${jobId}`, { timeout: 20000 }).catch(() => {});
};

export {
  TOOTHSSM_ACCEPT,
  TOOTHSSM_CROWN_OPTIONS,
  TOOTHSSM_FAST_ROOTS_OPTIONS,
  TOOTHSSM_FORMATS,
  TOOTHSSM_ROOT_OPTIONS,
  TOOTHSSM_ROOT_TARGETS,
  TOOTHSSM_SEG_OPTIONS,
  TOOTHSSM_TARGETS,
  boxLabel,
  deleteToothSsmJob,
  fetchToothSsmArchive,
  fetchToothSsmFile,
  getToothSsmHealth,
  getToothSsmInfo,
  hasSlimArchive,
  isDispatched,
  rerunToothSsmStep,
  submitToothSsmJob,
  waitForToothSsmJob,
};
