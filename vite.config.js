import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'
import zlib from 'zlib'

const TRAINING_DATA_ROOT = '/trainingData'
// ezai-pipeline: the entry point production actually calls. It runs jaw, margin and crown
// itself, so the browser uploads once instead of shuttling meshes between three services.
const PIPELINE_API_URL = process.env.PIPELINE_API_URL || 'http://127.0.0.1:8031'
// A second ezai-pipeline on the same box, running a build that has not been promoted to
// :8031 -- today, the one that accepts single_arch (a crown from one arch alone). It calls
// the same jaw/margin/crown services as production; only the orchestrator differs, so
// trying the new build can never change what :8031 answers.
//
// Unset by default: single_arch, the build this was carrying, went to :8031 on 2026-09-16
// and that instance was stopped. The target then reports itself unavailable rather than
// failing at the proxy. Point PIPELINE_TEST_API_URL at the next unpromoted instance --
// http://host.docker.internal:8033 for one started from /opt/ai_services/ezai-pipeline-singlearch
// -- to bring it back.
const PIPELINE_TEST_API_URL = process.env.PIPELINE_TEST_API_URL || ''
// The same ezai-pipeline on the Chiayi box (CADCAM-RTX5090, 192.168.50.95), for comparing
// the two GPUs on identical input. Reached through its PUBLIC hostname, not its LAN
// address, because this box has no route into 192.168.50.0/24 -- there is no WARP client
// here, and the two networks are behind different routers. Verified: TCP 22 to
// 192.168.50.95 does not connect from here, while https://ezai2.inteware.com.tw answers in
// under a second.
//
// That path goes through Cloudflare Access, so every request needs a Service Token. The
// token is attached by the proxy below, which runs in THIS process on the server -- so it
// never reaches a browser. Putting it in the frontend bundle would hand a working key to
// anyone who opens devtools on eztest, and Access would then be protecting nothing.
//
// The target carries the /pipeline prefix because ezai2 is a gateway fronting four
// services; http-proxy prepends the target's path to the rewritten one.
const PIPELINE_RTX5090_API_URL = process.env.PIPELINE_RTX5090_API_URL
  || 'https://ezai2.inteware.com.tw/pipeline'
// FSAbutment on that same Chiayi box (added 2026-09-16). A different project from the ezai
// chain -- custom implant abutments -- that shares only the gateway, and it is here for one
// reason: this box cannot route to 192.168.50.0/24, so ezai2 is the only way to reach it.
//
// Same token, same reasoning as above: /fsabutment is behind the same Cloudflare Access
// application as /pipeline, and the prefix belongs in the target because ezai2 is a gateway.
const FSABUTMENT_RTX5090_API_URL = process.env.FSABUTMENT_RTX5090_API_URL
  || 'https://ezai2.inteware.com.tw/fsabutment'
// ToothRoot on that same box (added 2026-10-07): the orthodontic team's AI tooth
// segmentation and root generation (htyau/ToothRoot, served by its deploy/deploy_api.py).
// Not part of the ezai chain; it shares the gateway for FSAbutment's reason -- this box cannot
// route to 192.168.50.0/24 -- and sits behind the same Access application, so the same token.
// Only the "AI分牙" tab calls it.
const TOOTHROOT_RTX5090_API_URL = process.env.TOOTHROOT_RTX5090_API_URL
  || 'https://ezai2.inteware.com.tw/toothroot'
// The same ToothRoot on THIS box since 2026-10-12, as Chiayi's standby: bound to docker0
// (172.17.0.1:8035), which this container sees as host.docker.internal, so no credential.
const TOOTHROOT_Z790_API_URL = process.env.TOOTHROOT_Z790_API_URL || 'http://host.docker.internal:8035'
// tooth_ssm (added 2026-10-13): the orthodontic team's AI tooth arrangement (htyau/ssm_project,
// served by its deploy/deploy_api.py), for the "AI排牙" tab. On THIS box it is bound to docker0
// (172.17.0.1:8036) and this container sees the host as host.docker.internal, so it needs no
// credential. The Chiayi box's copy would be reached like ToothRoot's, through ezai2 and the same
// Access application and token.
const TOOTHSSM_Z790_API_URL = process.env.TOOTHSSM_Z790_API_URL || 'http://host.docker.internal:8036'
const TOOTHSSM_RTX5090_API_URL = process.env.TOOTHSSM_RTX5090_API_URL
  || 'https://ezai2.inteware.com.tw/toothssm'
// The Chiayi box's TEST tooth_ssm (added 2026-10-29): crown=exact by default (the scan's own crown
// on every tooth, neighbours parted), for the "AI排牙" tab's third target. Same Access application
// and token as the line above; it comes down when crown=exact reaches production.
const TOOTHSSM_FIT_API_URL = process.env.TOOTHSSM_FIT_API_URL
  || 'https://ezai2.inteware.com.tw/toothssm-fit'
// The library-stump test pipeline on the Chiayi box (added 2026-10-14): ezai-pipeline with
// mode=stump and stump_shape=library, for the 「AI支台齒」 tab and the peek tab's library-stump
// option. Same Access application and token as /pipeline.
const PIPELINE_STUMP_RTX5090_API_URL = process.env.PIPELINE_STUMP_RTX5090_API_URL
  || 'https://ezai2.inteware.com.tw/pipeline-stump'
const RTX5090_CF_CLIENT_ID = process.env.RTX5090_CF_CLIENT_ID || ''
const RTX5090_CF_CLIENT_SECRET = process.env.RTX5090_CF_CLIENT_SECRET || ''
const RTX5090_CONFIGURED = Boolean(RTX5090_CF_CLIENT_ID && RTX5090_CF_CLIENT_SECRET)
// Object storage for the third one-click button, which sends the scans to ezai-pipeline as
// URLs instead of as a multipart body (upper_stl_url / lower_stl_url, shipped 2026-08-28).
//
// These credentials are read here, in the Vite process on THIS host, for the same reason
// the Cloudflare token above is: putting them in the bundle would hand working S3 keys to
// anyone who opens devtools. The browser never sees them -- it sees only a presigned GET
// URL for the object it just supplied, which is what the pipeline is handed.
//
// Dev and test only. This is the shared `pori-test` bucket, and the objects written here
// are deleted as soon as the pipeline has read them.
const S3_BUCKET = process.env.S3_BUCKET || ''
const S3_REGION = process.env.S3_REGION || 'ap-northeast-1'
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || ''
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || ''
const S3_CONFIGURED = Boolean(S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY)
const S3_HOST = `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`

/**
 * A presigned S3 URL, SigV4 in the query string.
 *
 * Query-string auth rather than the header form on purpose: it needs no payload hash, so
 * the body can be streamed straight through without being buffered to compute one.
 */
const presignS3 = (method, key, expires = 600) => {
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const date = stamp.slice(0, 8)
  const scope = `${date}/${S3_REGION}/s3/aws4_request`
  const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${S3_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  }
  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${encode(k)}=${encode(query[k])}`).join('&')
  // Each path segment is encoded on its own so that the separators survive; encoding the
  // whole path would turn every '/' into %2F and sign a key that does not exist.
  const canonicalUri = `/${key}`.split('/').map(encode).join('/')
  const canonical = [
    method, canonicalUri, canonicalQuery, `host:${S3_HOST}\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n')
  const toSign = [
    'AWS4-HMAC-SHA256', stamp, scope,
    crypto.createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')

  let signingKey = Buffer.from(`AWS4${S3_SECRET_ACCESS_KEY}`)
  for (const part of [date, S3_REGION, 's3', 'aws4_request']) {
    signingKey = crypto.createHmac('sha256', signingKey).update(part).digest()
  }
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex')
  return `https://${S3_HOST}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** PUT or DELETE against a presigned URL. Resolves with the status code. */
const s3Request = (method, key, bodyStream, contentLength) => new Promise((resolve, reject) => {
  const url = new URL(presignS3(method, key))
  const request = https.request(url, {
    method,
    headers: contentLength != null ? { 'content-length': contentLength } : {},
  }, (response) => {
    const chunks = []
    response.on('data', c => chunks.push(c))
    response.on('end', () => resolve({
      status: response.statusCode,
      body: Buffer.concat(chunks).toString(),
    }))
  })
  request.on('error', reject)
  if (bodyStream) bodyStream.pipe(request)
  else request.end()
})

// The two FlowToothSDF instances on this box. dev tracks whatever is being worked on;
// prod is pinned and lives in its own checkout (/opt/ai_services/FlowToothSDF-prod), so
// these two answer "does the change I am looking at differ from what is shipping".
const FLOWTOOTH_API_URL = process.env.FLOWTOOTH_API_URL || 'http://127.0.0.1:8010'
const FLOWTOOTH_PROD_API_URL = process.env.FLOWTOOTH_PROD_API_URL || 'http://127.0.0.1:8013'
// ai-jaw-direction-prod. Not 8000: that port is published by the training container and has
// nothing listening behind it, so the old default answered every request with a proxy 500.
const DIRECTION_API_URL = process.env.DIRECTION_API_URL || 'http://127.0.0.1:8020'
// MARGIN_CURRENT_API_URL is kept as a compatibility fallback for older compose files.
const MARGIN_V6_API_URL = process.env.MARGIN_V6_API_URL || process.env.MARGIN_CURRENT_API_URL || 'http://127.0.0.1:8011'
// Vite 5.4.12+ refuses any request whose Host header it does not recognise, so reaching
// this server by name rather than by IP — through the Cloudflare tunnel — needs the name
// listed here. localhost and bare IPs are allowed by Vite regardless.
const ALLOWED_HOSTS = (process.env.VITE_ALLOWED_HOSTS || 'eztest.inteware.com.tw')
  .split(',').map((h) => h.trim()).filter(Boolean)
// An instance published through the tunnel is reached by browsers nowhere near this host,
// so an HMR client pointed at localhost dials the visitor's own machine, fails, and retries
// for as long as the tab is open. Naming the public host sends it back through the tunnel
// instead, which carries websockets. Note that `hmr: false` is not the fix it looks like:
// Vite 5.4 injects the client and its connection constants either way.
const HMR = process.env.VITE_HMR_PUBLIC_HOST
  ? { protocol: 'wss', host: process.env.VITE_HMR_PUBLIC_HOST, clientPort: 443 }
  : { host: 'localhost' }

// The Fussen workbench page (fussen-workbench/, opened from the app switcher at the top
// left). Fussen -- airdental's customised edition -- has no login or order pages, so its
// orders are reached with an API key instead; this is airdental's tools/fussenWorkbench,
// whose own local server did the same job on one engineer's machine.
//
// The keys stay on this server, exactly like the Cloudflare token above: the browser asks
// /api/fussen/<site>/..., and the middleware below adds X-API-Key on the way out. They are
// read from .env (gitignored) rather than through docker-compose.yml, so adding or changing
// one needs no container rebuild -- Vite restarts by itself when .env changes. Only VITE_*
// variables ever reach client code, so FUSSEN_* do not.
//
// Who can use them is whoever can log in to eztest through Cloudflare Access. Clear a key
// to switch that site off; the page then says the key is missing.
const FUSSEN_DOTENV = loadEnv('development', process.cwd(), 'FUSSEN_')
const fussenSetting = (name, fallback = '') => process.env[name] || FUSSEN_DOTENV[name] || fallback
const FUSSEN_SITES = {
  prod: {
    label: '正式站',
    baseUrl: fussenSetting('FUSSEN_PROD_BASE_URL', 'https://crown.dentalx.com'),
    keyName: 'FUSSEN_PROD_API_KEY',
  },
  test: {
    label: '測試站',
    baseUrl: fussenSetting('FUSSEN_TEST_BASE_URL', 'https://test-fussen.inteware.com.tw'),
    keyName: 'FUSSEN_TEST_API_KEY',
  },
}
for (const site of Object.values(FUSSEN_SITES)) site.apiKey = fussenSetting(site.keyName).trim()
// Cloudflare refuses a request body over 100 MB before it reaches this server, so the
// original tool's 512 MB is not reachable through eztest. A little under, for the multipart
// framing.
const FUSSEN_MAX_UPLOAD = 99 * 1000 * 1000
// Cloudflare also gives up on a response after ~100 s, so a slower answer is a 524 in the
// browser whatever this says; it only bounds how long the upstream socket is held.
const FUSSEN_TIMEOUT_MS = 180 * 1000
const FUSSEN_PREFIX = '/api/v2/airdesign/externalProject/'

// The AI dispatcher (added 2026-11-06), for the 「分派器」 and 「modal雲端」 hosts of the 牙冠設計 and
// AI排牙 tabs (src/utils/function/DispatcherApi.js): ai-dispatcher v2's TEST site on the 226 box,
// which queues each job and hands it to whichever box (95, 101) or Modal cloud container will
// finish it first, or to the cloud alone (route=cloud).
//
// It takes inputs as S3 URLs only and never holds a file itself. So a scan goes browser -> this
// server -> S3 (dispatcher-upload below asks the dispatcher where, and streams the body there),
// and a result S3 -> this server -> browser (dispatcher-result streams the job's zip;
// dispatcher-zip reads one member of it with byte ranges, which is what the AI排牙 tab needs from
// a 60-130 MB archive). The bucket needs no CORS rule for this origin, and the browser never holds
// a credential: it sees presigned URLs only, for its own files.
//
// Behind Cloudflare Access like ezai2, with its own service token. Read from .env like the Fussen
// keys -- deploy/put-secret.py eztest writes DISPATCHER_CF_CLIENT_ID / _SECRET there, and Vite
// restarts by itself when .env changes -- and only ever sent to DISPATCHER_URL. The three Access
// fixes of the ezai2 routes apply to its proxy route for the same reasons.
const DISPATCHER_DOTENV = loadEnv('development', process.cwd(), 'DISPATCHER_')
const dispatcherSetting = (name, fallback = '') => (process.env[name] || DISPATCHER_DOTENV[name] || fallback).trim()
const DISPATCHER_URL = dispatcherSetting('DISPATCHER_URL', 'https://test-ai.inteware.com.tw').replace(/\/+$/, '')
const DISPATCHER_CF_CLIENT_ID = dispatcherSetting('DISPATCHER_CF_CLIENT_ID')
const DISPATCHER_CF_CLIENT_SECRET = dispatcherSetting('DISPATCHER_CF_CLIENT_SECRET')
// A dispatcher reached without Access (an SSH tunnel to the test site, for testing this file)
// needs no token: DISPATCHER_NO_ACCESS=1.
const DISPATCHER_NO_ACCESS = dispatcherSetting('DISPATCHER_NO_ACCESS') === '1'
const DISPATCHER_CONFIGURED = DISPATCHER_NO_ACCESS || Boolean(DISPATCHER_CF_CLIENT_ID && DISPATCHER_CF_CLIENT_SECRET)
const DISPATCHER_HEADERS = DISPATCHER_NO_ACCESS ? {} : {
  'CF-Access-Client-Id': DISPATCHER_CF_CLIENT_ID,
  'CF-Access-Client-Secret': DISPATCHER_CF_CLIENT_SECRET,
}
// One file per request, through Cloudflare (100 MB at most); the scans arrive gzipped.
const DISPATCHER_MAX_UPLOAD = 99 * 1000 * 1000

/** A same-origin request from an eztest page, not one another site's page makes with eztest's Access cookie. */
const sameOrigin = (req) => {
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false
    } catch {
      return false
    }
  }
  return !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])
}

/** One JSON request to the dispatcher, with the token. Resolves { status, data (null if not JSON) }. */
const dispatcherJson = (method, apiPath, body) => new Promise((resolve, reject) => {
  const url = new URL(DISPATCHER_URL + apiPath)
  const payload = body == null ? null : Buffer.from(JSON.stringify(body))
  const request = (url.protocol === 'https:' ? https : http).request(url, {
    method,
    headers: {
      ...DISPATCHER_HEADERS,
      Accept: 'application/json',
      'User-Agent': 'eztest-dispatcher',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    },
    timeout: 30000,
  }, (response) => {
    const chunks = []
    response.on('data', c => chunks.push(c))
    response.on('end', () => {
      let data = null
      try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* an Access page, a proxy error */ }
      resolve({ status: response.statusCode, data })
    })
    response.on('error', reject)
  })
  request.on('timeout', () => request.destroy(new Error('分派器沒有回應（30 秒）')))
  request.on('error', reject)
  request.end(payload ?? undefined)
})

/** What the dispatcher said, for an error message (never a URL: presigned ones are credentials). */
const dispatcherWords = (got) => {
  if (got.status === 403) return 'Cloudflare Access 拒絕（403）：eztest 的分派器 Service Token 失效，或還沒加進測試站的 Access policy'
  const message = got.data?.error?.message
  return message ? `${got.status} ${got.data.error.code ?? ''}：${message}` : `分派器回應 ${got.status}`
}

/** A request to a presigned S3 URL. Resolves { status, headers, body (Buffer) }; `send` pipes a body in. */
const s3Call = (presigned, { method = 'GET', headers = {}, send = null, timeoutMs = 120000 } = {}) =>
  new Promise((resolve, reject) => {
    const request = https.request(new URL(presigned), { method, headers, timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', c => chunks.push(c))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error(`S3 ${method} 沒有回應`)))
    request.on('error', reject)
    if (send) send.pipe(request)
    else request.end()
  })

/** A finished job's view, or an error with the status to answer. */
const finishedJob = async (id) => {
  const got = await dispatcherJson('GET', `/v2/jobs/${encodeURIComponent(id)}`)
  if (got.status !== 200 || !got.data) {
    const error = new Error(dispatcherWords(got))
    error.status = got.status === 404 ? 404 : 502
    throw error
  }
  if (got.data.status !== 'succeeded' || !got.data.result_url) {
    const error = new Error(`job ${id} 沒有結果可取（${got.data.status}）`)
    error.status = 409
    throw error
  }
  return got.data
}

// A result zip's central directory by job id, read from S3 by byte range (the end of central
// directory record, then the directory if it is not in the same read), kept a few minutes: the
// result_url it was read with is good for an hour (RESULT_GET_TTL_S) and a new view signs a new one.
const ZIP_INDEX = new Map()
const ZIP_INDEX_MS = 5 * 60 * 1000
const zipIndex = async (id) => {
  const hit = ZIP_INDEX.get(id)
  if (hit && Date.now() - hit.at < ZIP_INDEX_MS) return hit
  for (const [key, entry] of ZIP_INDEX) if (Date.now() - entry.at > ZIP_INDEX_MS) ZIP_INDEX.delete(key)
  const view = await finishedJob(id)
  const url = view.result_url
  // the record is 22 bytes plus a comment of up to 64 KB
  const tail = await s3Call(url, { headers: { Range: 'bytes=-65558' } })
  if (tail.status !== 206 && tail.status !== 200) throw new Error(`S3 讀結果尾端回應 ${tail.status}`)
  const total = tail.status === 206 ? Number(/\/(\d+)$/.exec(tail.headers['content-range'] || '')?.[1]) : tail.body.length
  const tailStart = total - tail.body.length
  let eocd = -1
  for (let at = tail.body.length - 22; at >= 0; at -= 1) {
    if (tail.body.readUInt32LE(at) === 0x06054b50) { eocd = at; break }
  }
  if (eocd < 0) throw new Error('結果不是有效的 zip（找不到 end-of-central-directory）')
  const count = tail.body.readUInt16LE(eocd + 10)
  const cdSize = tail.body.readUInt32LE(eocd + 12)
  const cdOffset = tail.body.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('結果是 zip64，這裡不支援')
  let cd
  if (cdOffset >= tailStart) {
    cd = tail.body.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
  } else {
    const got = await s3Call(url, { headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` } })
    if (got.status !== 206 && got.status !== 200) throw new Error(`S3 讀結果目錄回應 ${got.status}`)
    // a 200 is the whole file (the range was ignored)
    cd = got.status === 200 ? got.body.subarray(cdOffset, cdOffset + cdSize) : got.body
  }
  const entries = new Map()
  for (let at = 0, i = 0; i < count; i += 1) {
    if (cd.readUInt32LE(at) !== 0x02014b50) throw new Error('結果 zip 的 central directory 損毀')
    const nameLength = cd.readUInt16LE(at + 28)
    const extraLength = cd.readUInt16LE(at + 30)
    const commentLength = cd.readUInt16LE(at + 32)
    const entry = {
      method: cd.readUInt16LE(at + 10),
      crc: cd.readUInt32LE(at + 16),
      compressedSize: cd.readUInt32LE(at + 20),
      size: cd.readUInt32LE(at + 24),
      offset: cd.readUInt32LE(at + 42),
      nameLength,
      extraLength,
    }
    if ([entry.compressedSize, entry.size, entry.offset].includes(0xffffffff)) {
      throw new Error('結果裡有 zip64 的檔案，這裡不支援')
    }
    entries.set(cd.toString('utf8', at + 46, at + 46 + nameLength), entry)
    at += 46 + nameLength + extraLength + commentLength
  }
  const index = { at: Date.now(), url, total, entries }
  ZIP_INDEX.set(id, index)
  return index
}

/** One member's stored bytes (as compressed in the zip) and its entry, by byte range. */
const zipMember = async (index, entry) => {
  // The local header repeats the name and an extra field whose length can differ from the
  // central one's: read a little more than the central one says, and again if that was short.
  let span = 30 + entry.nameLength + entry.extraLength + 512 + entry.compressedSize
  for (let tries = 0; tries < 2; tries += 1) {
    const got = await s3Call(index.url, { headers: { Range: `bytes=${entry.offset}-${entry.offset + span - 1}` } })
    if (got.status !== 206 && got.status !== 200) throw new Error(`S3 讀結果回應 ${got.status}`)
    // a 200 is the whole file (the range was ignored): it has the member, wherever it ends
    const body = got.status === 200 ? got.body.subarray(entry.offset) : got.body
    if (body.length < 30 || body.readUInt32LE(0) !== 0x04034b50) throw new Error('結果 zip 的檔頭損毀')
    const start = 30 + body.readUInt16LE(26) + body.readUInt16LE(28)
    if (start + entry.compressedSize <= body.length) return body.subarray(start, start + entry.compressedSize)
    if (got.status === 200) break
    span = start + entry.compressedSize
  }
  throw new Error('結果 zip 的檔頭比預期長')
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      // The Fussen workbench's backend, ported from airdental's tools/fussenWorkbench/
      // server.js: the same route allowlist, no cookies or client headers forwarded, no
      // redirects followed, and the key only ever sent to its own site's origin.
      name: 'fussen-workbench-api',
      configureServer(server) {
        const json = (res, status, body) => {
          if (res.headersSent) { res.destroy(); return }
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        const configured = Object.entries(FUSSEN_SITES).filter(([, s]) => s.apiKey).map(([id]) => id)
        server.config.logger.info(`[fussen] sites with a key: ${configured.join(', ') || 'none'}`)

        server.middlewares.use('/api/fussen', (req, res) => {
          res.setHeader('Cache-Control', 'no-store')
          // eztest's Access cookie rides along on any request to this host, including one a
          // different site's page makes. A same-origin fetch from the workbench is the only
          // caller: refuse cross-site requests, and require a header a plain cross-site
          // form post cannot set.
          const origin = req.headers.origin
          let crossOrigin = false
          if (origin) {
            try { crossOrigin = new URL(origin).host !== req.headers.host } catch { crossOrigin = true }
          }
          if (crossOrigin || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])
            || req.headers['x-fussen-workbench'] !== '1') {
            return json(res, 403, { error: { message: 'Fussen workbench requests only.' } })
          }
          const url = new URL(req.url, 'http://eztest')
          if (req.method === 'GET' && url.pathname === '/config') {
            return json(res, 200, {
              sites: Object.entries(FUSSEN_SITES).map(([id, s]) => ({
                id, label: s.label, baseUrl: s.baseUrl, keyName: s.keyName,
                configured: Boolean(s.apiKey), maxUploadBytes: FUSSEN_MAX_UPLOAD,
              })),
            })
          }
          const [, siteId, ...rest] = url.pathname.split('/')
          if (!Object.hasOwn(FUSSEN_SITES, siteId)) return json(res, 404, { error: { message: 'Unknown Fussen site.' } })
          const site = FUSSEN_SITES[siteId]
          if (!site.apiKey) {
            return json(res, 503, { error: { message: `eztest 沒有設定${site.label}的 API key（.env 的 ${site.keyName}）。` } })
          }
          const operation = rest.join('/')
          const allowed = req.method === 'GET' && (operation === 'list' || /^(status|viewerLink|download|marginLine)\/[^/]+$/.test(operation))
            || req.method === 'POST' && operation === 'project'
          if (!allowed || /%2f|%5c|%2e/i.test(operation)) return json(res, 403, { error: { message: 'API route is not allowed.' } })
          if (req.method === 'POST' && !/^multipart\/form-data;\s*boundary=/i.test(req.headers['content-type'] || '')) {
            return json(res, 415, { error: { message: 'Expected multipart/form-data.' } })
          }
          if (Number(req.headers['content-length'] || 0) > FUSSEN_MAX_UPLOAD) {
            return json(res, 413, { error: { message: '上傳上限約 95 MB（Cloudflare 的單次上限是 100 MB）。' } })
          }

          const target = new URL(FUSSEN_PREFIX + operation + url.search, site.baseUrl)
          const headers = {
            'X-API-Key': site.apiKey,
            Accept: 'application/json, application/zip',
            'User-Agent': 'eztest-fussen-workbench',
          }
          if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type']
          if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length']
          const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
              response.resume()
              return json(res, 502, { error: { message: `${site.label}回應轉址（HTTP ${response.statusCode}），請確認站點網址。` } })
            }
            res.statusCode = response.statusCode
            for (const name of ['content-type', 'content-disposition']) {
              if (response.headers[name]) res.setHeader(name, response.headers[name])
            }
            response.on('error', () => json(res, 502, { error: { message: 'Backend response interrupted. Check the original serial before retrying creation.' } }))
            response.pipe(res)
          })
          const deadline = setTimeout(() => {
            json(res, 504, { error: { message: 'Backend request timed out. Creation may have succeeded. Query the original external serial before retrying.' } })
            upstream.destroy()
          }, FUSSEN_TIMEOUT_MS)
          res.on('close', () => { clearTimeout(deadline); upstream.destroy() })
          upstream.on('error', () => {
            clearTimeout(deadline)
            if (!res.writableEnded) json(res, 502, { error: { message: `連不到${site.label}（${site.baseUrl}）。若正在建單，請先查詢原序號再重試。` } })
          })
          let bytes = 0
          req.on('data', (chunk) => {
            bytes += chunk.length
            if (bytes > FUSSEN_MAX_UPLOAD) {
              json(res, 413, { error: { message: 'Upload limit exceeded. Query the original serial before retrying.' } })
              upstream.destroy()
            }
          })
          req.on('aborted', () => upstream.destroy())
          req.pipe(upstream)
        })
      },
    },
    {
      // Without this, an instance started with no Service Token still routes /api/
      // pipeline-rtx5090 through the proxy, Cloudflare Access answers 403 with an HTML
      // login page, and axios reports a parse failure on the JSON it expected. The button
      // then looks like the Chiayi box is broken when the only thing missing is a
      // credential on THIS host. Middlewares added here run before the proxy, so this
      // intercepts first. Say what is wrong and where to fix it.
      name: 'rtx5090-pipeline-guard',
      configureServer(server) {
        if (RTX5090_CONFIGURED) return
        server.config.logger.warn(
          '[rtx5090] RTX5090_CF_CLIENT_ID / RTX5090_CF_CLIENT_SECRET are not set; '
          + 'the Chiayi one-click button and the FSAbutment tab are disabled on this instance'
        )
        const unconfigured = (req, res) => {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            detail: '這個實例沒有設定 ezai2 的 Service Token，無法呼叫嘉義 5090。'
              + '請在 docker-compose.yml 補上 RTX5090_CF_CLIENT_ID 與 RTX5090_CF_CLIENT_SECRET，'
              + '然後 docker compose up -d 重建容器。',
          }))
        }
        server.middlewares.use('/api/pipeline-rtx5090', unconfigured)
        // FSAbutment goes through the same Access application and the same token, so it is
        // disabled by exactly the same missing credential and deserves the same message
        // rather than a 403 HTML page the frontend cannot parse.
        server.middlewares.use('/api/fsabutment-rtx5090', unconfigured)
        server.middlewares.use('/api/toothroot-rtx5090', unconfigured)
        server.middlewares.use('/api/toothssm-rtx5090', unconfigured)
        server.middlewares.use('/api/toothssm-fit', unconfigured)
        server.middlewares.use('/api/pipeline-stump', unconfigured)
      },
    },
    {
      // Object storage for the third one-click button. The browser hands the file to this
      // middleware, which streams it to S3 and answers with a presigned GET URL; the
      // browser then gives that URL to ezai-pipeline instead of the bytes.
      //
      // Why the file goes through this process rather than straight from the browser to
      // S3: a browser PUT to a bucket needs a CORS rule on that bucket, and `pori-test` is
      // shared. Routing it here needs no change to anything outside this checkout. The
      // cost is that the upload is measured on the browser -> this host -> S3 path, so the
      // seconds it reports are NOT a remote caller's upload time. The button says so.
      name: 's3-upload-api',
      configureServer(server) {
        if (!S3_CONFIGURED) {
          server.config.logger.warn(
            '[s3-upload-api] S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not '
            + 'set; the S3 one-click button is disabled on this instance'
          )
          server.middlewares.use('/api/s3', (req, res) => {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              detail: '這個實例沒有設定 S3 憑證，無法測試 S3 這條路。'
                + '請在 .env 補上 S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / '
                + 'S3_SECRET_ACCESS_KEY，然後 docker compose up -d 重建容器。',
            }))
          })
          return
        }

        server.config.logger.info(`[s3-upload-api] uploads go to s3://${S3_BUCKET} (${S3_REGION})`)

        const json = (res, status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }

        // Keys are confined to one prefix and stripped of anything that could climb out of
        // it. The extension has to survive, because ezai-pipeline reads the file type from
        // the URL path and refuses a key without one.
        const cleanKey = (raw) => {
          const safe = String(raw || '').replace(/[^A-Za-z0-9/._-]/g, '_').replace(/\.\./g, '_')
          return `viewer/${safe.replace(/^\/+/, '')}`
        }

        server.middlewares.use('/api/s3/upload', async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { detail: 'POST only' })
          const key = cleanKey(new URL(req.url, 'http://x').searchParams.get('key'))
          const startedAt = Date.now()
          try {
            const length = req.headers['content-length']
            const result = await s3Request('PUT', key, req, length)
            if (result.status !== 200) {
              return json(res, 502, {
                detail: `S3 PUT ${key} 回應 ${result.status}：${result.body.slice(0, 300)}`,
              })
            }
            return json(res, 200, {
              key,
              // Ten minutes is far longer than this needs to live: ezai-pipeline fetches
              // during the POST, before it answers 202, so the object is only read once
              // and within seconds.
              get: presignS3('GET', key, 600),
              bytes: Number(length) || 0,
              ms: Date.now() - startedAt,
            })
          } catch (error) {
            return json(res, 502, { detail: `S3 上傳失敗：${error.message}` })
          }
        })

        // Called as soon as the pipeline has answered 202, which is after it has read the
        // objects. These are real clinical scans and the bucket is shared, so they are not
        // left lying in it for a lifecycle rule to deal with eventually.
        server.middlewares.use('/api/s3/cleanup', async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { detail: 'POST only' })
          const chunks = []
          req.on('data', c => chunks.push(c))
          req.on('end', async () => {
            let keys = []
            try {
              keys = JSON.parse(Buffer.concat(chunks).toString()).keys || []
            } catch {
              return json(res, 400, { detail: 'body must be {"keys": [...]}' })
            }
            const deleted = []
            for (const key of keys.slice(0, 16)) {
              try {
                const result = await s3Request('DELETE', cleanKey(key.replace(/^viewer\//, '')))
                deleted.push({ key, status: result.status })
              } catch (error) {
                deleted.push({ key, error: error.message })
              }
            }
            return json(res, 200, { deleted })
          })
        })
      },
    },
    {
      // The AI dispatcher's files (see DISPATCHER_URL above). Middlewares added here run before
      // the proxy, so /api/dispatcher/ (its own API, proxied) is guarded here as well: same-origin
      // requests only, and only the calls the two tabs make.
      name: 'dispatcher-api',
      configureServer(server) {
        const json = (res, status, body) => {
          if (res.headersSent) { res.destroy(); return }
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        const routes = ['/api/dispatcher', '/api/dispatcher-upload', '/api/dispatcher-result', '/api/dispatcher-zip']
        if (!DISPATCHER_CONFIGURED) {
          server.config.logger.warn('[dispatcher] DISPATCHER_CF_CLIENT_ID / _SECRET are not set; '
            + 'the 分派器 and modal雲端 hosts are disabled on this instance')
          for (const route of routes) {
            server.middlewares.use(route, (req, res) => json(res, 503, {
              detail: '這個實例沒有設定分派器的 Service Token：請在筆電執行 deploy/put-secret.py eztest（寫進 .env，Vite 會自己重新載入）。',
            }))
          }
          return
        }
        server.config.logger.info(`[dispatcher] ${DISPATCHER_URL}${DISPATCHER_NO_ACCESS ? ' (no Access token: a tunnel)' : ''}`)
        for (const route of routes) {
          server.middlewares.use(route, (req, res, next) => {
            if (!sameOrigin(req)) return json(res, 403, { detail: 'eztest 頁面自己的請求才收' })
            return next()
          })
        }

        // The dispatcher's own API, before the proxy: what the panels call, nothing else.
        server.middlewares.use('/api/dispatcher', (req, res, next) => {
          const pathname = new URL(req.url, 'http://eztest').pathname
          const allowed = (req.method === 'GET' && pathname === '/v2/status')
            || (req.method === 'POST' && pathname === '/v2/jobs')
            || (['GET', 'DELETE'].includes(req.method) && /^\/v2\/jobs\/[A-Za-z0-9_.-]{1,64}$/.test(pathname))
          if (!allowed) return json(res, 403, { detail: `分派器的 ${req.method} ${pathname} 不經 eztest` })
          return next()
        })

        // POST /api/dispatcher-upload?name=upper.stl.gz, the file as the body -> { key, get_url, bytes, ms }.
        // get_url is what the job's inputs take; the box fetches it from S3.
        server.middlewares.use('/api/dispatcher-upload', async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { detail: 'POST only' })
          const name = new URL(req.url, 'http://eztest').searchParams.get('name') || 'file.bin'
          const length = Number(req.headers['content-length'])
          if (!Number.isFinite(length) || length <= 0) return json(res, 411, { detail: '需要 Content-Length' })
          if (length > DISPATCHER_MAX_UPLOAD) return json(res, 413, { detail: '一個檔案最多約 95 MB（Cloudflare 的單次上限是 100 MB）' })
          const startedAt = Date.now()
          try {
            const signed = await dispatcherJson('POST', '/v2/uploads', { filename: name })
            if (signed.status !== 200 || !signed.data?.put_url) return json(res, 502, { detail: dispatcherWords(signed) })
            const put = await s3Call(signed.data.put_url, {
              method: 'PUT', headers: { 'Content-Length': length }, send: req, timeoutMs: 10 * 60 * 1000,
            })
            if (put.status !== 200) return json(res, 502, { detail: `S3 PUT 回應 ${put.status}` })
            return json(res, 200, { key: signed.data.key, get_url: signed.data.get_url, bytes: length, ms: Date.now() - startedAt })
          } catch (error) {
            return json(res, 502, { detail: `上傳失敗：${error.message}` })
          }
        })

        // GET /api/dispatcher-result/<job id>: the job's whole result zip, from S3.
        server.middlewares.use('/api/dispatcher-result', async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { detail: 'GET only' })
          const id = decodeURIComponent(new URL(req.url, 'http://eztest').pathname.slice(1))
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) return json(res, 400, { detail: 'job id?' })
          try {
            const view = await finishedJob(id)
            const upstream = https.request(new URL(view.result_url), { method: 'GET', timeout: 10 * 60 * 1000 }, (response) => {
              if (response.statusCode !== 200) {
                response.resume()
                return json(res, 502, { detail: `S3 GET 回應 ${response.statusCode}` })
              }
              res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Cache-Control': 'no-store',
                ...(response.headers['content-length'] ? { 'Content-Length': response.headers['content-length'] } : {}),
              })
              response.pipe(res)
            })
            upstream.on('timeout', () => upstream.destroy(new Error('S3 沒有回應')))
            upstream.on('error', (error) => json(res, 502, { detail: `取回結果失敗：${error.message}` }))
            // the browser went away before the end: stop reading S3
            res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
            upstream.end()
          } catch (error) {
            return json(res, error.status ?? 502, { detail: error.message })
          }
        })

        // GET /api/dispatcher-zip/<job id>/<member path>: one file of the job's result zip. A deflated
        // member goes out as it is stored, wrapped as gzip (its CRC-32 and size are in the zip's
        // directory), so the browser inflates it and nothing is recompressed here.
        server.middlewares.use('/api/dispatcher-zip', async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { detail: 'GET only' })
          const [rawId, ...rest] = new URL(req.url, 'http://eztest').pathname.slice(1).split('/')
          const id = decodeURIComponent(rawId || '')
          const member = rest.map(decodeURIComponent).join('/')
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || !member) return json(res, 400, { detail: 'job id 和檔名？' })
          try {
            const index = await zipIndex(id)
            const entry = index.entries.get(member)
            if (!entry) return json(res, 404, { detail: `結果裡沒有 ${member}` })
            const stored = await zipMember(index, entry)
            let body = stored
            const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }
            if (entry.method === 8) {
              const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '')
              if (acceptsGzip) {
                const trailer = Buffer.alloc(8)
                trailer.writeUInt32LE(entry.crc, 0)
                trailer.writeUInt32LE(entry.size >>> 0, 4)
                body = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]), stored, trailer])
                headers['Content-Encoding'] = 'gzip'
              } else {
                body = zlib.inflateRawSync(stored)
              }
            } else if (entry.method !== 0) {
              return json(res, 500, { detail: `不支援的 zip 壓縮方式 ${entry.method}` })
            }
            headers['Content-Length'] = body.length
            res.writeHead(200, headers)
            return res.end(body)
          } catch (error) {
            return json(res, error.status ?? 502, { detail: error.message })
          }
        })
      },
    },
    {
      // What this instance is configured to reach, so the panel can grey out a target
      // before the user picks it instead of after a job fails. Booleans only: never the
      // URLs, and never anything from .env.
      name: 'viewer-config',
      configureServer(server) {
        server.middlewares.use('/api/viewer-config', (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({
            targets: {
              z790: true,
              z790_test: Boolean(PIPELINE_TEST_API_URL),
              rtx5090: RTX5090_CONFIGURED,
              rtx5090_s3: RTX5090_CONFIGURED && S3_CONFIGURED,
              toothroot: RTX5090_CONFIGURED,
              toothssm_rtx5090: RTX5090_CONFIGURED,
              rtx5090_stump: RTX5090_CONFIGURED,
              // the AI dispatcher's two hosts, in both tabs
              dispatcher: DISPATCHER_CONFIGURED,
              cloud: DISPATCHER_CONFIGURED,
            },
          }))
        })
        if (!PIPELINE_TEST_API_URL) {
          server.middlewares.use('/api/pipeline-test', (req, res) => {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: '這個實例沒有設定 PIPELINE_TEST_API_URL，測試版 pipeline 無法使用。' }))
          })
        }
      },
    },
    {
      name: 'training-data-api',
      configureServer(server) {
        // Instances that serve people outside the lab mount no corpus. Answer those
        // plainly rather than letting every listing die on readdirSync, and rather than
        // falling through to the SPA, which would hand axios an index.html it cannot parse.
        if (!fs.existsSync(TRAINING_DATA_ROOT)) {
          server.config.logger.warn(
            `[training-data-api] ${TRAINING_DATA_ROOT} is not mounted; GT browsing is disabled`
          )
          server.middlewares.use('/api/training-data', (req, res) => {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `${TRAINING_DATA_ROOT} is not mounted on this instance` }))
          })
          return
        }

        // GET /api/training-data/:dataset  → 列出該資料集下所有 case 資料夾名稱
        // GET /api/training-data/:dataset/:id  → 列出該 case 內的檔案/子目錄
        server.middlewares.use('/api/training-data', (req, res) => {
          const urlPath = req.url.split('?')[0].replace(/^\//, '')
          const parts = urlPath.split('/').filter(Boolean)

          if (parts.length === 0) {
            // 列出所有資料集（TRAINING_DATA_ROOT 下的子目錄）
            try {
              const datasets = fs.readdirSync(TRAINING_DATA_ROOT, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ datasets }))
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: e.message }))
            }
            return
          }

          const dataset = parts[0]
          const datasetDir = path.join(TRAINING_DATA_ROOT, dataset)

          // 安全檢查：防止路徑穿越
          const resolvedDataset = path.resolve(datasetDir)
          const resolvedRoot = path.resolve(TRAINING_DATA_ROOT)
          if (!resolvedDataset.startsWith(resolvedRoot + path.sep) && resolvedDataset !== resolvedRoot) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Forbidden' }))
            return
          }

          if (parts.length === 1) {
            // 列出資料集下所有 case 資料夾
            try {
              const cases = fs.readdirSync(datasetDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ dataset, cases }))
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: e.message }))
            }
            return
          }

          // parts.length >= 2：存取指定 case 內的路徑（目錄列表或檔案內容）
          const subParts = parts.slice(1) // [caseId, ...filePath]
          const targetPath = path.join(datasetDir, ...subParts)
          const resolvedTarget = path.resolve(targetPath)
          if (!resolvedTarget.startsWith(resolvedDataset + path.sep)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Forbidden' }))
            return
          }

          let stat
          try {
            stat = fs.statSync(resolvedTarget)
          } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
            return
          }

          if (stat.isDirectory()) {
            // 目錄 → 回傳子項目列表
            try {
              const entries = fs.readdirSync(resolvedTarget, { withFileTypes: true }).map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'dir' : 'file',
                size: e.isDirectory() ? null : fs.statSync(path.join(resolvedTarget, e.name)).size,
              }))
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ path: subParts.join('/'), entries }))
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: e.message }))
            }
          } else {
            // 檔案 → 回傳檔案內容
            const ext = path.extname(resolvedTarget).toLowerCase()
            const CONTENT_TYPES = {
              '.json': 'application/json',
              '.stl':  'application/octet-stream',
              '.obj':  'text/plain',
              '.mtl':  'text/plain',
              '.txt':  'text/plain',
              '.ply':  'application/octet-stream',
            }
            const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': stat.size,
              'Cache-Control': 'no-store',
            })
            fs.createReadStream(resolvedTarget).pipe(res)
          }
        });
      }
    }
  ],
  server: {
    host: '0.0.0.0', // 允許外部訪問
    port: 5173,
    allowedHosts: ALLOWED_HOSTS,
    watch: {
      usePolling: true, // Docker 環境需要使用輪詢來監聽文件變化
    },
    hmr: HMR,
    // 添加代理配置，將前端 API 請求轉發到主機的 localhost 端口
    proxy: {
      // Before '/api/flowtooth': these keys are matched as prefixes in declaration order,
      // so the shorter one would claim '/api/flowtooth-prod/...' first and forward it to the
      // DEV service under a mangled path. Same reason the margin-two-stage keys precede
      // '/api/margin'.
      // Before '/api/pipeline', for the prefix-order reason above: the shorter key would
      // otherwise claim '/api/pipeline-rtx5090/...' and quietly send it to the LOCAL
      // pipeline under a mangled path -- which is the worst possible failure here, because
      // the comparison would still return a crown and the numbers would be z790's.
      '/api/pipeline-rtx5090': {
        target: PIPELINE_RTX5090_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pipeline-rtx5090/, ''),
        // http-proxy's own `headers` option, which it applies when it BUILDS the outgoing
        // request.
        //
        // This was originally written as a configure()/proxyReq hook calling
        // proxyReq.setHeader(), which is the obvious way to do it and is wrong here. The
        // hook does run -- but for a request whose headers are already on the wire by the
        // time it fires, setHeader() is too late and the credentials never leave. That is
        // exactly the case for the one request that matters: the multipart POST of two
        // arch scans, ~30 MB, which a client sends with `Expect: 100-continue`. Measured:
        // GET /health through the hook version returned 200, POST /v1/jobs returned 403.
        //
        // The failure mode is what makes this worth the paragraph. A request with NO
        // credentials and a request with WRONG ones both come back as a 403 HTML page from
        // Access, so "403 from the right hostname" proves the request arrived and nothing
        // else. Verify a change here by asserting a 200 through the proxy on a real POST,
        // never on a GET and never on a 403's shape.
        headers: {
          'CF-Access-Client-Id': RTX5090_CF_CLIENT_ID,
          'CF-Access-Client-Secret': RTX5090_CF_CLIENT_SECRET,
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // The browser is on eztest.inteware.com.tw, which is itself behind Access, so
            // it attaches that application's CF_Authorization session JWT to these
            // same-origin XHRs, and the proxy would forward it to ezai2 -- a different
            // Access application that has no business seeing it. This request authenticates
            // with the Service Token above and needs no cookie at all, so drop it.
            //
            // removeHeader is safe where setHeader was not: dropping a header that was
            // never going to be read costs nothing if it happens too late to matter.
            proxyReq.removeHeader('cookie')
          })

          // THE IMPORTANT ONE. Access answers every service-token request with
          //
          //   Set-Cookie: CF_Authorization=<JWT for ezai2's app>; Path=/; Secure; SameSite=none
          //
          // and without this line the proxy hands that straight to the browser -- which is
          // sitting on eztest.inteware.com.tw. Same cookie name, same path, so it
          // OVERWRITES this page's own Access session with a token minted for a different
          // application. The very next request to eztest presents the wrong `aud`, Access
          // reports auth_status NONE, and answers 302 to its login page; the browser cannot
          // follow that cross-origin, so it surfaces as a bare "Network Error".
          //
          // The signature is distinctive and worth recognising: the FIRST call after
          // pressing the button succeeds, and the one right after it fails. That is the
          // success response poisoning the cookie that the next request needs.
          //
          // The browser never talks to ezai2 directly and this proxy re-authenticates with
          // the Service Token on every single request, so that cookie is of no use to
          // anyone downstream. Drop every Set-Cookie this route would return; nothing
          // behind it legitimately sets one.
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // FSAbutment on the same Chiayi box, through the same Access application (added
      // 2026-09-16). No shorter '/api/fsabutment' key exists, so declaration order does not
      // matter for this one -- it sits here because everything it needs is explained above
      // and the two routes should be read together.
      //
      // The `headers` option and both configure() hooks are the same three fixes, and for
      // the same reasons: setHeader() in a proxyReq hook is too late for a multipart POST
      // and the credentials never leave; the browser's eztest CF_Authorization cookie must
      // not be forwarded to a different Access application; and the Set-Cookie coming BACK
      // must be dropped or it overwrites this page's own session and the NEXT request dies
      // as a bare "Network Error". Do not simplify any of the three away.
      '/api/fsabutment-rtx5090': {
        target: FSABUTMENT_RTX5090_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fsabutment-rtx5090/, ''),
        headers: {
          'CF-Access-Client-Id': RTX5090_CF_CLIENT_ID,
          'CF-Access-Client-Secret': RTX5090_CF_CLIENT_SECRET,
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // ToothRoot on the Chiayi box (2026-10-07), for the "AI分牙" tab. No shorter key
      // matches it, so its place in this list is free. The same three Access fixes as the
      // routes above, for the same reasons; do not simplify any of them away. Its uploads are
      // two gzipped arch scans and its downloads are gzipped PLYs (Content-Encoding passes
      // straight through to the browser, which inflates them).
      '/api/toothroot-rtx5090': {
        target: TOOTHROOT_RTX5090_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/toothroot-rtx5090/, ''),
        headers: {
          'CF-Access-Client-Id': RTX5090_CF_CLIENT_ID,
          'CF-Access-Client-Secret': RTX5090_CF_CLIENT_SECRET,
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // ToothRoot on this box (2026-10-12), Chiayi's standby. On docker0, like tooth_ssm below:
      // nothing but the address, and no shorter key matches it.
      '/api/toothroot-z790': {
        target: TOOTHROOT_Z790_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/toothroot-z790/, ''),
      },
      // tooth_ssm (2026-10-13), for the "AI排牙" tab. No shorter key matches either route. This
      // box's copy is on docker0 and needs nothing but the address; the Chiayi one goes through
      // Access and gets the same three fixes as the routes above, for the same reasons.
      '/api/toothssm-z790': {
        target: TOOTHSSM_Z790_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/toothssm-z790/, ''),
      },
      '/api/toothssm-rtx5090': {
        target: TOOTHSSM_RTX5090_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/toothssm-rtx5090/, ''),
        headers: {
          'CF-Access-Client-Id': RTX5090_CF_CLIENT_ID,
          'CF-Access-Client-Secret': RTX5090_CF_CLIENT_SECRET,
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // The Chiayi TEST tooth_ssm (2026-10-29, crown=exact). Named so that no other key is a prefix
      // of it ('/api/toothssm-rtx5090-fit' would be caught by the route above); the same three
      // Access fixes, for the same reasons.
      '/api/toothssm-fit': {
        target: TOOTHSSM_FIT_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/toothssm-fit/, ''),
        headers: {
          'CF-Access-Client-Id': RTX5090_CF_CLIENT_ID,
          'CF-Access-Client-Secret': RTX5090_CF_CLIENT_SECRET,
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // Before '/api/pipeline' (prefix order, as above). The library-stump test pipeline on the
      // Chiayi box, with the same three Access fixes as '/api/pipeline-rtx5090' for the same
      // reasons; do not simplify any of them away.
      '/api/pipeline-stump': {
        target: PIPELINE_STUMP_RTX5090_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pipeline-stump/, ''),
        headers: {
          'CF-Access-Client-Id': RTX5090_CF_CLIENT_ID,
          'CF-Access-Client-Secret': RTX5090_CF_CLIENT_SECRET,
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // The AI dispatcher's own API (2026-11-06; guarded by the dispatcher-api plugin above). The
      // trailing slash keeps '/api/dispatcher-upload' and the other middleware paths out of it.
      // The same three Access fixes as '/api/pipeline-rtx5090', for the same reasons.
      '/api/dispatcher/': {
        target: DISPATCHER_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/dispatcher/, ''),
        headers: DISPATCHER_HEADERS,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie']
          })
        },
      },
      // Also before '/api/pipeline', for the same prefix-order reason.
      '/api/pipeline-test': {
        target: PIPELINE_TEST_API_URL || 'http://127.0.0.1:9',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pipeline-test/, ''),
      },
      '/api/pipeline': {
        target: PIPELINE_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pipeline/, ''),
      },
      '/api/flowtooth-prod': {
        target: FLOWTOOTH_PROD_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/flowtooth-prod/, ''),
      },
      '/api/flowtooth': {
        target: FLOWTOOTH_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/flowtooth/, ''),
      },
      '/api/margin-two-stage-v6': {
        target: MARGIN_V6_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/margin-two-stage-v6/, ''),
      },
      // Preserve the previous same-origin endpoint for bookmarks and local tools.
      '/api/margin-two-stage-current': {
        target: MARGIN_V6_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/margin-two-stage-current/, ''),
      },
      '/api/direction': {
        target: DIRECTION_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/direction/, '')
      },
      '/api/margin': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/margin/, '')
      },
      '/api/abutment': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/abutment/, '')
      }
    }
  },
})
