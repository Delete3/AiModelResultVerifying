## 安裝套件 `npm install`
## 啓動專案 `npm run dev`
## 瀏覽器開啓 http://localhost:5173/

# 查看日誌
docker compose -f docker-compose.dev.yml logs -f
# 停止容器
docker compose -f docker-compose.dev.yml down
# 重啟容器
docker compose -f docker-compose.dev.yml restart