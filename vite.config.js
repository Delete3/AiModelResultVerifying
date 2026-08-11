import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'

const TRAINING_DATA_ROOT = '/trainingData'
const FLOWTOOTH_API_URL = process.env.FLOWTOOTH_API_URL || 'http://127.0.0.1:8010'
const DIRECTION_API_URL = process.env.DIRECTION_API_URL || 'http://127.0.0.1:8000'
// MARGIN_CURRENT_API_URL is kept as a compatibility fallback for older compose files.
const MARGIN_V6_API_URL = process.env.MARGIN_V6_API_URL || process.env.MARGIN_CURRENT_API_URL || 'http://127.0.0.1:8011'
const MARGIN_V8_API_URL = process.env.MARGIN_V8_API_URL || 'http://127.0.0.1:8012'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'training-data-api',
      configureServer(server) {
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
    },
    {
      name: 'dynamic-proxy',
      configureServer(server) {
        server.middlewares.use('/api/proxy', (req, res) => {
          const targetUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
          if (!targetUrl) {
            res.statusCode = 400;
            res.end('Missing url param');
            return;
          }
          const client = targetUrl.startsWith('https') ? https : http;
          client.get(targetUrl, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            proxyRes.pipe(res);
          }).on('error', (err) => {
            res.statusCode = 500;
            res.end(err.message);
          });
        });
      }
    }
  ],
  server: {
    host: '0.0.0.0', // 允許外部訪問
    port: 5173,
    watch: {
      usePolling: true, // Docker 環境需要使用輪詢來監聽文件變化
    },
    hmr: {
      host: 'localhost', // 熱模組替換的主機
    },
    // 添加代理配置，將前端 API 請求轉發到主機的 localhost 端口
    proxy: {
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
      '/api/margin-two-stage-v8': {
        target: MARGIN_V8_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/margin-two-stage-v8/, ''),
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
