import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
      '/api/direction': {
        target: 'http://localhost:8002',
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
