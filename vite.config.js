import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import fs from 'fs'
import https from 'https'
import path from 'path'

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

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
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
          '[rtx5090-pipeline] RTX5090_CF_CLIENT_ID / RTX5090_CF_CLIENT_SECRET are not set; '
          + 'the Chiayi one-click button is disabled on this instance'
        )
        server.middlewares.use('/api/pipeline-rtx5090', (req, res) => {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            detail: '這個實例沒有設定 ezai2 的 Service Token，無法呼叫嘉義 5090。'
              + '請在 docker-compose.yml 補上 RTX5090_CF_CLIENT_ID 與 RTX5090_CF_CLIENT_SECRET，'
              + '然後 docker compose up -d 重建容器。',
          }))
        })
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
