import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const TRAINING_DATA_ROOT = '/trainingData'
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
