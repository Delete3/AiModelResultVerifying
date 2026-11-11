import axios from 'axios';
import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { getFileExtension } from '../tool/StringProcessing.js';
import { parseTRIGeometry } from '../loader/TRILoader.js';
import {
  boxLabel,
  createDispatcherJob,
  deleteDispatcherJob,
  fetchDispatcherResult,
  getDispatcherJob,
  getDispatcherStatus,
  summarizeDispatcher,
  uploadToDispatcher,
} from './DispatcherApi.js';

// tooth_ssm's API v2 (2026-11-11; ssm_project deploy/DOCKER.md "API v2", the team's guide in
// public/docs/toothssm/api-v2.md): one kind of job, `params.steps` any non-empty subset of
// segment (a), generate (b) and align (c), run in that order; every job returns a bundle (zip,
// manifest.json first) laid out like an input bundle, so a result goes back in as the next
// job's `bundle`, or as "job:<id>" while the server keeps it. Everything in a bundle is in the
// frame of the scans as uploaded and the labels follow their face order -- so this tab draws a
// result on the very files it sent.
//
// Or, for 排牙 (c) alone, `crowns` (2026-11-11): a zip of crowns already apart, one mesh per tooth
// named by its FDI. The service merges each jaw into one mesh and labels its faces by FDI; that
// merged scan comes back in the bundle (scan/<jaw>.stl), so a crowns result is drawn on it.
//
// Two ways in, both reached through this server (vite.config.js, credentials server-side):
//   dispatcher  the AI dispatcher's test site, the address the orthodontic team integrates
//               against: scans to S3 first, inputs as URLs, it picks the box (Chiayi has v2)
//   rtx5090     Chiayi's v2 service itself (ezai2 /toothssm/v2/, production since 2026-11-11),
//               multipart in, the bundle out; the existing /api/toothssm-rtx5090 route carries
//               it, since the gateway serves v2 under the same /toothssm/ prefix
// A "job:<id>" names a job of the same way in (the box's ids and the dispatcher's differ).
const V2_TARGETS = {
  dispatcher: { label: '分派器（測試站）', dispatcher: true },
  rtx5090: { label: '嘉義 5090（直接）', base: '/api/toothssm-rtx5090' },
};
const isV2Dispatched = target => Boolean(V2_TARGETS[target]?.dispatcher);

const V2_STEPS = [
  { key: 'segment', letter: 'a', label: '分牙' },
  { key: 'generate', letter: 'b', label: '生成牙齒' },
  { key: 'align', letter: 'c', label: '排牙' },
];
const STEP_NAME = Object.fromEntries(V2_STEPS.map(s => [s.key, s.label]));
const combinationOf = steps => V2_STEPS.filter(s => steps.includes(s.key)).map(s => s.letter).join('');

// What a scan may be (the service reads the format from the part's name); sent gzipped.
const V2_SCAN_FORMATS = ['stl', 'ply', 'obj', 'tri'];

const gzip = async blob => new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();

/** The service's refusal ({code, detail, missing}) or the dispatcher's ({error: {code, message}}). */
const describeV2Error = error => {
  const status = error.response?.status;
  let data = error.response?.data;
  if (data instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(data);
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 300) };
    }
  }
  if (status === 403) return 'Cloudflare Access 拒絕（403）：這個 viewer 的 Service Token 失效';
  if (data?.code) {
    return `${status ?? ''} ${data.code}：${data.detail ?? ''}${data.missing?.length ? `（缺 ${data.missing.join('、')}）` : ''}`.trim();
  }
  if (data?.error?.code) return `${status ?? ''} ${data.error.code}：${data.error.message ?? ''}`.trim();
  if (status === 502 || status === 504) return `${status}：服務沒有回應`;
  return error.message || '連線失敗';
};

// --- the two ways in, behind one shape --------------------------------------------------------

/**
 * A job's status in one shape, whichever way it went: { id, state (queued | running | succeeded |
 * failed | cancelled), step, waitingFor, progress {done, total} | null, summary, bundleBytes,
 * where, attempts, timings, error (one line) | null, errorCode, logTail, warnings }.
 */
const fromBox = s => ({
  id: s.job_id,
  state: s.state,
  combination: s.combination,
  step: s.step,
  waitingFor: s.waiting_for ? 'v1' : null,
  queuePosition: s.queue_position,
  progress: s.progress?.teeth_total ? { done: s.progress.teeth_done ?? 0, total: s.progress.teeth_total } : null,
  summary: s.summary,
  bundleBytes: s.bundle_bytes,
  bundleSha256: s.bundle_sha256,
  where: '95',
  error: s.error ? `${s.error.code}${s.error.step ? `（${STEP_NAME[s.error.step] ?? s.error.step}）` : ''}：${s.error.detail}` : null,
  errorCode: s.error?.code,
  logTail: s.error?.log_tail,
  warnings: [],
});

const fromDispatcher = v => {
  const p = v.progress ?? {};
  return {
    id: v.id,
    state: v.status === 'running' && !p.step ? 'starting' : v.status,
    step: p.step,
    waitingFor: p.waiting_for ? 'v1' : null,
    elapsed: p.step_elapsed_s,
    progress: p.teeth_total ? { done: p.teeth_done ?? 0, total: p.teeth_total } : null,
    predicted: v.predicted_finish_s,
    summary: v.summary,
    bundleBytes: v.result_bytes,
    bundleSha256: v.result_sha256,
    where: v.where,
    attempts: v.attempts,
    timings: v.timings,
    error: v.error ? `${v.error.code}：${v.error.message ?? ''}` : null,
    errorCode: v.error?.code,
    warnings: v.warnings ?? [],
  };
};

/** Health in one line: { ok, text }. */
const getV2Health = async target => {
  if (isV2Dispatched(target)) {
    const { ok, text } = summarizeDispatcher(await getDispatcherStatus(), 'toothssm');
    return { ok, text };
  }
  try {
    const h = (await axios.get(`${V2_TARGETS[target].base}/v2/health`, { timeout: 20000 })).data;
    const gpu = h.gpu?.name ? `${h.gpu.name}（已用 ${(h.gpu.memory_used_mb / 1024).toFixed(1)} / ${(h.gpu.memory_total_mb / 1024).toFixed(1)} GB）` : 'GPU 無法使用';
    return {
      ok: h.status === 'ok',
      text: `${V2_TARGETS[target].label} · ${h.api} ${h.version} · ${h.status} · ${gpu} · v2 佇列 ${h.queue}／${h.queue_max} · 同卡 v1 佇列 ${h.v1_queue ?? 0}`,
    };
  } catch (error) {
    if (error.response?.status === 503 && error.response.data?.status) {
      return { ok: false, text: `${V2_TARGETS[target].label} · ${error.response.data.status}` };
    }
    throw new Error(describeV2Error(error));
  }
};

/**
 * Queue one job. `scans` {upper: File, lower: File} when it segments (or wants the scans), `ref`
 * (an earlier job's id, same target) for its bundle, or `crowns` (a zip File, steps ['align']).
 * `params` holds steps and the rest. Resolves { id, uploadSeconds, sentBytes }.
 */
const submitV2Job = async ({ target, steps, params = {}, scans = null, ref = null, crowns = null, onStage = () => {} }) => {
  const body = { params: { steps, ...params } };
  if (ref) body.inputs = { bundle: `job:${ref}` };
  const files = [];
  if (scans) {
    for (const jaw of ['upper', 'lower']) {
      const file = scans[jaw];
      if (!file) throw new Error('上下顎口掃都要');
      const ext = getFileExtension(file.name);
      if (!V2_SCAN_FORMATS.includes(ext)) throw new Error(`${file.name}：只收 ${V2_SCAN_FORMATS.map(f => `.${f}`).join(' / ')}`);
      files.push({ name: `${jaw}.scan`, file: `${jaw}.${ext}.gz`, blob: null, raw: file });
    }
    onStage('正在壓縮口掃（gzip）…');
    for (const f of files) f.blob = await gzip(f.raw);
  }
  // a zip is compressed already: sent as it is
  if (crowns) files.push({ name: 'crowns', file: 'crowns.zip', blob: crowns });
  const sentBytes = files.reduce((sum, f) => sum + f.blob.size, 0);
  const startedAt = performance.now();

  if (isV2Dispatched(target)) {
    if (files.length) {
      onStage(`正在經這台主機把 ${(sentBytes / 1048576).toFixed(1)} MB 放上 S3…`);
      const ups = await Promise.all(files.map(f => uploadToDispatcher(f.blob, f.file)));
      body.inputs = { ...(body.inputs ?? {}), ...Object.fromEntries(files.map((f, i) => [f.name, ups[i].get_url])) };
    }
    const uploadSeconds = (performance.now() - startedAt) / 1000;
    onStage('正在送出 job 給分派器…');
    const view = await createDispatcherJob({ service: 'toothssm', route: 'auto', ...body });
    return { id: view.id, uploadSeconds, sentBytes };
  }

  onStage(files.length ? `正在上傳 ${(sentBytes / 1048576).toFixed(2)} MB 到${V2_TARGETS[target].label}…` : '正在送出 job…');
  try {
    let response;
    if (files.length) {
      const form = new FormData();
      form.append('request', JSON.stringify(body));
      for (const f of files) form.append(f.name, f.blob, f.file);
      response = await axios.post(`${V2_TARGETS[target].base}/v2/jobs`, form, { timeout: 10 * 60 * 1000 });
    } else {
      response = await axios.post(`${V2_TARGETS[target].base}/v2/jobs`, body, { timeout: 60000 });
    }
    return { id: response.data.job_id, uploadSeconds: (performance.now() - startedAt) / 1000, sentBytes };
  } catch (error) {
    throw new Error(describeV2Error(error));
  }
};

const getV2Job = async (target, id, wait = 20) => {
  if (isV2Dispatched(target)) return fromDispatcher(await getDispatcherJob(id, wait));
  try {
    return fromBox((await axios.get(`${V2_TARGETS[target].base}/v2/jobs/${encodeURIComponent(id)}`, {
      params: { wait }, timeout: (wait + 30) * 1000,
    })).data);
  } catch (error) {
    throw new Error(describeV2Error(error));
  }
};

/** Long-poll until the job ends; `onUpdate` sees every status. Resolves the last one. */
const waitForV2Job = async (target, id, { onUpdate = () => {}, timeoutMs = 40 * 60 * 1000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getV2Job(target, id);
    onUpdate(s);
    if (['succeeded', 'failed', 'cancelled'].includes(s.state)) return s;
    if (Date.now() > deadline) throw new Error(`job ${id} 超過 ${timeoutMs / 60000} 分鐘沒有完成`);
  }
};

/** The job's bundle (zip) as an ArrayBuffer. */
const fetchV2Bundle = async (target, id) => {
  if (isV2Dispatched(target)) return fetchDispatcherResult(id);
  try {
    return (await axios.get(`${V2_TARGETS[target].base}/v2/jobs/${encodeURIComponent(id)}/bundle`, {
      responseType: 'arraybuffer', timeout: 10 * 60 * 1000,
    })).data;
  } catch (error) {
    throw new Error(`結果包：${describeV2Error(error)}`);
  }
};

/** Fire and forget: the scans are the patient's; both ways delete them after a while anyway. */
const deleteV2Job = (target, id) => (isV2Dispatched(target)
  ? deleteDispatcherJob(id)
  : axios.delete(`${V2_TARGETS[target].base}/v2/jobs/${encodeURIComponent(id)}`, { timeout: 20000 }).catch(() => {}));

// --- reading a bundle ---------------------------------------------------------------------------

/** A zip's members by name, read from its central directory: { name -> Promise<Uint8Array> }. */
const readZip = (buffer, label = '結果包') => {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${label}不是 zip`);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const members = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`${label}的目錄壞了（或是 zip64，請用一般的 zip）`);
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    members.set(name, { method, size, start });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async name => {
    const m = members.get(name);
    if (!m) return null;
    const data = bytes.subarray(m.start, m.start + m.size);
    if (m.method === 0) return data;
    if (m.method !== 8) throw new Error(`${name}：不支援的壓縮方式 ${m.method}`);
    return new Uint8Array(await new Response(new Blob([data]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  };
  return { names: [...members.keys()], read };
};

/** TRIMP v1 (public/docs/toothssm/api.md): one byte per face. Returns the labels as a Uint8Array. */
const decodeTrimp = async data => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (String.fromCharCode(...data.subarray(0, 4)) !== 'TRMP') throw new Error('標記檔不是 TRIMP');
  if (data[4] !== 1) throw new Error(`TRIMP 版本 ${data[4]} 看不懂`);
  const codec = data[7];
  const count = view.getUint32(8, true);
  const payloadLen = view.getUint32(20, true);
  const payload = data.subarray(32, 32 + payloadLen);
  const labels = codec === 0 ? payload : new Uint8Array(await new Response(new Blob([payload]).stream()
    .pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (labels.length !== count) throw new Error(`TRIMP 標記數 ${labels.length}，檔頭寫 ${count}`);
  return labels;
};

const base64Bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/** A mesh member of a bundle (.tri / .ply / .stl) as a BufferGeometry. */
const parseMesh = (name, data) => {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const ext = getFileExtension(name);
  if (ext === 'tri') return parseTRIGeometry(buffer);
  if (ext === 'ply') return new PLYLoader().parse(buffer);
  if (ext === 'stl') return new STLLoader().parse(buffer);
  throw new Error(`${name}：看不懂的網格格式`);
};

// --- the crowns input ----------------------------------------------------------------------------

// The service's rules for a crowns zip (ssm_project deploy/ssm_v2/artifacts.read_crowns), checked
// here before sending so that a wrong name shows at once: a mesh file's name without its suffixes
// is the FDI (11, tooth_11, tooth-11); an upper/ or lower/ folder must agree with it.
const CROWN_FILE = /^(.*?)\.(stl|ply|obj|tri)(\.gz)?$/i;
const CROWN_STEM = /^(?:tooth[_-]?)?(\d{2})$/i;
const CROWN_FEW = 6;
const jawOfFdi = fdi => {
  const quadrant = Math.floor(fdi / 10);
  if (fdi % 10 < 1 || fdi % 10 > 8) return null;
  return quadrant === 1 || quadrant === 2 ? 'upper' : quadrant === 3 || quadrant === 4 ? 'lower' : null;
};

/**
 * A crowns zip read as the service will read it: { teeth {jaw: [{fdi, name}]}, ignored [names],
 * problems [what the service would refuse], notes [what it would warn about] }, and
 * `geometry(name)` for the preview (.stl .ply .tri, + .gz; null for .obj, which only the service reads).
 */
const readCrownsZip = async file => {
  const zip = readZip(await file.arrayBuffer(), '牙冠檔');
  const teeth = { upper: [], lower: [] };
  const ignored = [];
  const problems = [];
  const seen = new Map();
  for (const name of zip.names) {
    const base = name.split('/').pop();
    if (name.endsWith('/') || name.includes('__MACOSX') || base.startsWith('.')) continue;
    const hit = base.match(CROWN_FILE);
    if (!hit) {
      ignored.push(name);
      continue;
    }
    const stem = hit[1].match(CROWN_STEM);
    const fdi = stem ? Number(stem[1]) : null;
    const jaw = fdi ? jawOfFdi(fdi) : null;
    if (!jaw) {
      problems.push(`${name}：檔名要是牙位（上顎 11–18、21–28，下顎 31–38、41–48），例如 11.stl、upper/11.stl`);
      continue;
    }
    const folders = name.split('/').slice(0, -1).map(d => d.toLowerCase()).filter(d => d === 'upper' || d === 'lower');
    if (folders.some(d => d !== jaw)) {
      problems.push(`${name}：${fdi} 是${jaw === 'upper' ? '上顎' : '下顎'}的牙，卻放在 ${folders.join('、')} 資料夾`);
      continue;
    }
    if (seen.has(fdi)) {
      problems.push(`${fdi} 有兩個檔：${seen.get(fdi)}、${name}`);
      continue;
    }
    seen.set(fdi, name);
    teeth[jaw].push({ fdi, name });
  }
  const notes = [];
  for (const jaw of ['upper', 'lower']) {
    teeth[jaw].sort((a, b) => a.fdi - b.fdi);
    const word = jaw === 'upper' ? '上顎' : '下顎';
    if (!teeth[jaw].length) problems.push(`沒有${word}的牙冠：排牙要兩顎都有`);
    else if (teeth[jaw].length < CROWN_FEW) notes.push(`${word}只有 ${teeth[jaw].length} 顆牙冠（少於 ${CROWN_FEW} 顆，服務會警告 input.few_crowns）`);
  }
  const geometry = async name => {
    const m = name.split('/').pop().match(CROWN_FILE);
    if (!m || m[2].toLowerCase() === 'obj') return null;
    let data = await zip.read(name);
    if (m[3]) {
      data = new Uint8Array(await new Response(new Blob([data]).stream()
        .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    return parseMesh(`${m[1]}.${m[2].toLowerCase()}`, data);
  };
  return { teeth, ignored, problems, notes, geometry };
};

/** A bundle's scan of one jaw as a File (setRaw reads it by name), or null. */
const bundleScanFile = async (bundle, jaw) => {
  const name = bundle.names.find(n => new RegExp(`^scan/${jaw}\\.(stl|ply|tri)$`).test(n));
  if (!name) return null;
  return new File([await bundle.read(name)], name.split('/').pop());
};

/**
 * Everything the tab draws from a bundle: { manifest, labels {jaw: Uint8Array}, teeth [{jaw, fdi,
 * geometry}], plan, axes, names }. The labels come from the bundle (the summary may have been left
 * out of a large status), and are checked against the face count when they are used.
 */
const readV2Bundle = async buffer => {
  const zip = readZip(buffer);
  const json = async name => {
    const data = await zip.read(name);
    return data ? JSON.parse(new TextDecoder().decode(data)) : null;
  };
  const labels = {};
  for (const jaw of ['upper', 'lower']) {
    const data = await zip.read(`labels/${jaw}.trimp`);
    if (data) labels[jaw] = await decodeTrimp(data);
  }
  const teeth = [];
  for (const name of zip.names) {
    const m = name.match(/^teeth\/(upper|lower)\/(\d+)\.(tri|ply|stl)$/);
    if (m) teeth.push({ jaw: m[1], fdi: Number(m[2]), geometry: parseMesh(name, await zip.read(name)) });
  }
  return {
    manifest: await json('manifest.json'),
    labels,
    teeth,
    plan: await json('plan.json'),
    axes: await json('teeth/axes.json'),
    names: zip.names,
    read: zip.read,
  };
};

/**
 * One geometry per label of a scan: { label -> BufferGeometry } (0 the gum, 11-48 a tooth, 254
 * none), cut by face from the very geometry that was uploaded (its face order is the labels').
 */
const splitByLabels = (geometry, labels) => {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const faces = index ? index.count / 3 : position.count / 3;
  if (faces !== labels.length) {
    throw new Error(`標記有 ${labels.length.toLocaleString()} 個，這份口掃有 ${faces.toLocaleString()} 個面：標記不屬於畫面上的口掃`);
  }
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const out = new Map();
  const cursor = new Map();
  for (const [label, n] of counts) {
    out.set(label, new Float32Array(n * 9));
    cursor.set(label, 0);
  }
  const src = position.array;
  for (let f = 0; f < faces; f++) {
    const label = labels[f];
    const dst = out.get(label);
    let c = cursor.get(label);
    for (let k = 0; k < 3; k++) {
      const v = index ? index.array[3 * f + k] : 3 * f + k;
      dst[c++] = src[3 * v];
      dst[c++] = src[3 * v + 1];
      dst[c++] = src[3 * v + 2];
    }
    cursor.set(label, c);
  }
  return new Map([...out].map(([label, array]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(array, 3));
    return [label, g];
  }));
};

/** plan.json's 16 numbers (row-major, the scan's frame) as a Matrix4. */
const planMatrix = numbers => new THREE.Matrix4().set(...numbers);

export {
  STEP_NAME,
  V2_SCAN_FORMATS,
  V2_STEPS,
  V2_TARGETS,
  base64Bytes,
  boxLabel,
  bundleScanFile,
  combinationOf,
  decodeTrimp,
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
};
