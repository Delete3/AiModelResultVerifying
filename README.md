## 安裝套件 `npm install`
## 啓動專案 `npm run dev`
## 瀏覽器開啓 http://localhost:5173/

## FlowToothSDF 一鍵牙冠生成

checkingViewer 會依序執行：

```text
原始 upper/lower STL → direction 擺正 → predict_margin_two_stage → margin .pts → FlowToothSDF crown PLY
```

所有瀏覽器請求都使用 checkingViewer 的同源 `/api/*` proxy，口掃不會因 CORS 修正而直接送往其他 origin。

1. 在同層的 `FlowToothSDF` 啟動 API：

   ```bash
   cd ../FlowToothSDF
   docker compose -f docker-compose.api.yml up -d
   curl http://localhost:8010/health
   ```

2. 確認本機 direction v6 雙模型 API 已啟動；若 health 失敗再執行啟動命令：

   ```bash
   curl http://localhost:8000/health

   docker exec -d -w /workspace ai-training-gpu-1 \
     python3 -m trainJawDirection6.api.main --device cpu --port 8000
   ```

3. Margin API 的正式配方是 `stage1_v6_sibseed` + `stage2_v8_plain`。若 8011 的
   `/health` 顯示兩個 stage-1 模型，請從 Margin 專案重新建立服務，使其讀取最新 Compose：

   ```bash
   cd ../trainAiMarginModel
   docker compose up -d --force-recreate training-env
   curl http://localhost:8011/health
   ```

4. 啟動 checkingViewer：

   ```bash
   docker compose -f docker-compose.yml up -d --build
   ```

4. 開啟 http://localhost:5174/，使用左側「AI Checking Viewer」面板。

一鍵流程只需：

- FDI
- 原始 `upper.stl`
- 原始 `lower.stl`

若同一顎有多顆備牙，請在「同顎所有備牙 FDI」填入完整清單（例如 `14,15`，須包含目標
FDI）。這會啟用 v6 的 competitor-seed conditioning；單顆備牙可留白。

按下「一鍵：擺正 → Margin → 牙冠」後，面板會顯示每一步狀態。生成完成後會顯示半透明上下顎與橘色牙冠，並可下載 PLY。若 margin API 回傳 validity flags，面板會以警告顯示。

「只用目前檔案生成（dev 8010）」與「只用目前檔案生成（prod 8013）」則是手動模式，另外需要 margin `.pts`。Contacts、jaw matrix 與 abutment points 必須和提交的 STL 在相同座標系；一鍵擺正流程目前不會帶入原座標的這些檔案。

這兩個按鈕送往這台機器上的兩個 FlowToothSDF 服務。dev 跟著目前在改的東西跑，prod 是釘住的正式版、有自己的工作目錄（`/opt/ai_services/FlowToothSDF-prod`），所以這兩顆按鈕回答的是「我現在看的版本跟正在出貨的差多少」。

```text
dev   /api/flowtooth       → FLOWTOOTH_API_URL       (8010)
prod  /api/flowtooth-prod  → FLOWTOOTH_PROD_API_URL  (8013)
```

prod 的下載檔名會多一個 `_prod` 後綴（`outer_crown_FDI45_prod.ply`），兩邊的 job id 也分別帶 `checkingviewer-dev-` 與 `checkingviewer-prod-`，所以下載檔與伺服器 log 都分得出是哪一個服務。「檢查 API」會一次檢查兩個服務。一鍵流程走 dev。

## predict_margin_two_stage CORS

不要在瀏覽器直接呼叫 `http://192.168.0.101:8011/8012`。不同 host/port 會觸發 CORS preflight；目前後端對 `OPTIONS /predict_margin_two_stage` 回 405，沒有 `Access-Control-Allow-Origin`。

前端應呼叫同源路徑：

```text
/api/margin-two-stage-v6/predict_margin_two_stage
/api/margin-two-stage-v8/predict_margin_two_stage
```

Vite 再由伺服器端代理到以下 targets：

```text
DIRECTION_API_URL=http://host.docker.internal:8000
MARGIN_V6_API_URL=http://host.docker.internal:8011
MARGIN_V8_API_URL=http://host.docker.internal:8012
FLOWTOOTH_API_URL=http://host.docker.internal:8010
```

如果未來改成正式 production server，需在 Nginx/後端建立相同 reverse proxy；另一種作法是在 FastAPI 加 `CORSMiddleware`，僅允許正式 viewer domain，但仍建議保留 reverse proxy，避免 mixed-content 和暴露內部模型 port。

# 查看日誌
docker compose -f docker-compose.yml logs -f
# 停止容器
docker compose -f docker-compose.yml down
# 重啟容器
docker compose -f docker-compose.yml restart
