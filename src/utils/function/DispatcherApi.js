import axios from 'axios';

// The AI dispatcher (ai-dispatcher v2), for the 「分派器」 and 「modal雲端」 hosts of the 牙冠設計
// and AI排牙 tabs (2026-11-06). Its TEST site, test-ai.inteware.com.tw on the 226 box, queues each
// job and hands it to whichever of the two boxes (嘉義 5090 = 95, 台中 5080 = 101) or a Modal cloud
// container (RTX PRO 6000) will finish it first -- route=auto -- or only to a cloud container,
// route=cloud. A box that lacks a parameter the job sets (101 has no crown_model or
// occlusal_detail yet) is never given it.
//
// It takes files as S3 URLs only and never holds one itself, so everything goes through this
// server (vite.config.js): /api/dispatcher-upload asks it for an upload URL and streams the file
// there, /api/dispatcher-result streams a job's result zip back, /api/dispatcher-zip/<id>/<member>
// reads one member of it with byte-range requests, and /api/dispatcher/ is the dispatcher's own
// API. Its Cloudflare Access token is added there, server-side; this bundle never holds it, and
// the bucket needs no CORS rule for this origin.
const DISPATCHER_BASE = '/api/dispatcher';

/** Where a job ran, as the panels name the boxes. */
const BOX_LABEL = { 95: '嘉義 5090', 101: '台中 5080', cloud: 'Modal 雲端' };
const boxLabel = name => BOX_LABEL[name] ?? name ?? '?';

const SERVICE_LABEL = { crown: '牙冠', jaw: '擺正', toothssm: '排牙' };

/** axios hands an arraybuffer request's error body over as an ArrayBuffer: read it as JSON if it is. */
const errorBody = error => {
  const data = error.response?.data;
  if (data instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(data);
    try {
      return JSON.parse(text);
    } catch {
      return { detail: text.slice(0, 300) };
    }
  }
  return data;
};

const describeDispatcherError = error => {
  const status = error.response?.status;
  const data = errorBody(error);
  if (status === 403) {
    return 'Cloudflare Access 拒絕（403）：eztest 的分派器 Service Token 失效，或還沒加進測試站的 Access policy';
  }
  const message = data?.error?.message ?? (typeof data?.detail === 'string' ? data.detail : null);
  const code = data?.error?.code;
  if (message) return `${status ? `${status} ` : ''}${code ? `${code}：` : ''}${message}`;
  if (status === 502 || status === 504) return `${status}：分派器沒有回應`;
  return error.message || '連線失敗';
};

/** gzip in the browser: an STL roughly halves, for well under a second of CPU. Every box reads .gz. */
const gzipBlob = async blob => new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();

/**
 * One file to S3 through this server. `name` is the file name the box sees (it reads the format
 * from it: upper.stl.gz). Resolves { key, get_url, bytes, ms }: get_url goes in the job's inputs.
 */
const uploadToDispatcher = async (blob, name, timeoutMs = 10 * 60 * 1000) => {
  try {
    const { data } = await axios.post(`/api/dispatcher-upload?name=${encodeURIComponent(name)}`, blob, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: timeoutMs,
    });
    return data;
  } catch (error) {
    throw new Error(`上傳 ${name}：${describeDispatcherError(error)}`);
  }
};

/** POST /v2/jobs: { service, route, inputs, params }. Resolves with the job's view. */
const createDispatcherJob = async body => {
  try {
    return (await axios.post(`${DISPATCHER_BASE}/v2/jobs`, body, { timeout: 60000 })).data;
  } catch (error) {
    throw new Error(describeDispatcherError(error));
  }
};

/** GET /v2/jobs/<id>; `wait` (≤ 25 s) answers as soon as the status changes. */
const getDispatcherJob = async (id, wait = 0) => {
  try {
    return (await axios.get(`${DISPATCHER_BASE}/v2/jobs/${encodeURIComponent(id)}`, {
      params: wait ? { wait } : undefined,
      timeout: 30000 + wait * 1000,
    })).data;
  } catch (error) {
    throw new Error(describeDispatcherError(error));
  }
};

/** Cancel a job, or forget a finished one (its result is deleted from S3). Fire and forget. */
const deleteDispatcherJob = id => axios.delete(`${DISPATCHER_BASE}/v2/jobs/${encodeURIComponent(id)}`, { timeout: 20000 })
  .catch(() => {});

/** A finished job's whole result zip, as an ArrayBuffer. */
const fetchDispatcherResult = async (id, timeoutMs = 10 * 60 * 1000) => {
  try {
    return (await axios.get(`/api/dispatcher-result/${encodeURIComponent(id)}`, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
    })).data;
  } catch (error) {
    throw new Error(`取回結果：${describeDispatcherError(error)}`);
  }
};

/** One member of a finished job's result zip (read from S3 by byte range on the server), as an ArrayBuffer. */
const fetchDispatcherMember = async (id, member, timeoutMs = 5 * 60 * 1000) => {
  const path = member.split('/').map(encodeURIComponent).join('/');
  try {
    return (await axios.get(`/api/dispatcher-zip/${encodeURIComponent(id)}/${path}`, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
    })).data;
  } catch (error) {
    throw new Error(`${member}：${describeDispatcherError(error)}`);
  }
};

const getDispatcherStatus = async () => {
  try {
    return (await axios.get(`${DISPATCHER_BASE}/v2/status`, { timeout: 15000 })).data;
  } catch (error) {
    throw new Error(describeDispatcherError(error));
  }
};

/**
 * What the dispatcher can do for `service` right now: { ok, text }. `route` 'cloud' asks about the
 * cloud alone. Read from /v2/status: its workers (state, GPU, slots in use) and the cloud's month.
 */
const summarizeDispatcher = (status, service, route = 'auto') => {
  const name = SERVICE_LABEL[service] ?? service;
  if (!(status.services ?? []).includes(service)) {
    return { ok: false, text: `分派器（${status.instance}）沒有開放${name}` };
  }
  const boxes = Object.entries(status.workers ?? {}).filter(([, w]) => w.kind === 'box');
  const ready = boxes.filter(([, w]) => w.state === 'ready' && w.services?.[service] && w.gpu?.ok !== false);
  const parts = boxes.map(([box, w]) => {
    const s = w.services?.[service];
    if (!s) return `${boxLabel(box)} 不接${name}`;
    const up = w.state === 'ready' && w.gpu?.ok !== false;
    const outside = s.external?.running ? `，外部 ${s.external.running}` : '';
    const lacking = w.unsupported_params?.[service]?.length ? `，沒有 ${w.unsupported_params[service].join('、')}` : '';
    return `${boxLabel(box)} ${up ? '✓' : `✗ ${w.state}`}（${s.running}/${s.cap}${outside}${lacking}）`;
  });
  const cloud = status.cloud ?? {};
  const month = cloud.month?.[service];
  const live = (cloud.containers ?? []).filter(c => !c.ended && c.service === service).length;
  const cloudOn = cloud.mode && cloud.mode !== 'off';
  const overBudget = month?.budget_usd != null && month.usd >= month.budget_usd;
  const cloudText = !cloudOn ? '雲端關閉'
    : `雲端 ${live} 台${month ? `，本月 US$${month.usd.toFixed(2)} / ${month.budget_usd}` : '，本月還沒用'}${overBudget ? '（預算用完）' : ''}`;
  const queue = status.queues?.[service];
  const ok = route === 'cloud' ? Boolean(cloudOn && !overBudget) : Boolean(ready.length || (cloudOn && !overBudget));
  const scope = route === 'cloud' ? [cloudText] : [...parts, cloudText];
  return {
    ok,
    text: `分派器（${status.instance}）${name}：${scope.join(' · ')} · 排隊 ${queue?.queued ?? 0}、執行中 ${queue?.running ?? 0}`,
  };
};

/** The progress line for a job that is not done yet. */
const describeDispatcherProgress = (view, { cloud = false } = {}) => {
  if (view.status === 'queued') {
    const eta = view.predicted_finish_s != null ? `，預計 ${Math.round(view.predicted_finish_s)} 秒後完成` : '';
    return `分派器排隊中${cloud ? '（等雲端容器開機）' : ''}${eta}…`;
  }
  const again = view.attempts > 1 ? `（第 ${view.attempts} 次）` : '';
  return `正在 ${boxLabel(view.where)} 執行${again}…`;
};

/** Why a job ended without a result, in one line. */
const describeDispatcherFailure = view => {
  const error = view.error ?? {};
  const where = view.where ? `（${boxLabel(view.where)}${view.attempts > 1 ? `，試了 ${view.attempts} 次` : ''}）` : '';
  if (view.status === 'cancelled') return `工作已取消${where}`;
  return `${error.code ?? view.status}：${error.message ?? '分派器沒有說明'}${where}`;
};

export {
  BOX_LABEL,
  boxLabel,
  createDispatcherJob,
  deleteDispatcherJob,
  describeDispatcherFailure,
  describeDispatcherProgress,
  fetchDispatcherMember,
  fetchDispatcherResult,
  getDispatcherJob,
  getDispatcherStatus,
  gzipBlob,
  summarizeDispatcher,
  uploadToDispatcher,
};
