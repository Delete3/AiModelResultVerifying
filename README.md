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

4. 開啟 http://localhost:5174/。

## 畫面

左邊是面板，右邊是 3D 畫面。面板有三個分頁：

| 分頁 | 做什麼 |
|---|---|
| 牙冠設計 | 主要流程：病例 → Margin → 生成牙冠，全部走 `ezai-pipeline` |
| 直接呼叫 FlowTooth | 繞過 pipeline，直接打這台的 FlowToothSDF dev 8010 / prod 8013 做對照 |
| 舊工具 | 牙冠流程之前的擺正 / margin / task / GT 工具，原封不動搬過來 |

3D 畫面右上角可以切換上顎、下顎、牙冠、AI margin 是否顯示、口掃半透明、全部置中。
滑鼠：右鍵旋轉、中鍵平移、滾輪縮放；左鍵只給畫 margin 用。

### 牙冠設計

1. **病例**：FDI、上顎、下顎。FDI 決定哪一顎是「備牙顎」（面板會標出來）。
   **只上傳備牙顎也可以**，會以單顎模式生成（見下方）。
2. **Margin**，二選一：
   - **AI 自動預測**：pipeline `mode=full`。多顆備牙時可填「同顎所有備牙 FDI」
     （例如 `14,15`，須含目標 FDI），單顆留白。
     也可以按「先讓 AI 預測 margin，再手動修改」（`mode=margin_only`），結果會載入編輯器。
   - **自訂（繪製 / 上傳）**：pipeline `mode=margin_override`，用這裡的 margin 生成，
     margin 模型完全不跑。PEEK abutment 這類 AI 認不得的案例用這個。
     - 開始繪製：左鍵沿邊緣點選；點第一點（橘色）或 Enter 閉合；Backspace 退一點；Esc 取消
     - 修改：拖曳綠點；點紅線新增控制點；Shift + 點綠點刪除；Ctrl + Z 復原
     - 上傳 `.pts`（`BEGIN_<fdi>` 格式、`[[x,y,z],…]` JSON、或舊 job 的 `margin.json`）後同樣可以拖曳修改
     - 下載 `.pts` 可以把畫好的 margin 存下來
3. **生成牙冠**：選 Pipeline 目標，按「生成牙冠」。按鈕下方會列出還缺什麼。
   完成後可下載牙冠 PLY 或整包結果 ZIP；AI 模式另外有「用這條 AI margin 修改」。

**margin 的座標系就是上傳口掃的座標系。** 線是畫在口掃 mesh 上、以 mesh 的區域座標存的，
這正是 `margin_override` 要求的（`margin_pts` 必須和同一次上傳的口掃同座標系）。
上傳的 `.pts` 如果離口掃表面中位數超過 0.3 mm，面板會警告它可能是別的座標系
（例如 `margin_canonical.pts`）——pipeline 自己也用同一個門檻警告。

### 單顎模式

只有備牙顎、沒有對咬顎時自動使用；兩顎都有時也可以勾「忽略對咬顎」拿來比較。
送出時帶 `single_arch=true` 且不帶對咬顎。pipeline 會用一片「鄰牙高度的平面」當對咬，
**牙冠咬合面不是依照真實咬合做的**，結果會附警告。品質與選擇依據見
`ezai-pipeline` README 的 *One arch only* 一節（27 個 case：到技師牙冠的中位距離
單顎 0.32 mm、上下顎 0.18 mm）。

**兩台的正式 pipeline 都自 2026-09-16 起支援單顎**（台中 8031、嘉義 ezai2）。哪些目標支援是
`PIPELINE_TARGETS` 裡的 `singleArch` 旗標：沒有這個功能的部署會回 422，面板寧可在送出前就
擋下，所以旗標留著。

### Pipeline 目標

| 目標 | 送去 | 口掃怎麼傳 | 單顎 |
|---|---|---|---|
| z790 8031 | 本機正式 pipeline `:8031` | multipart | 是 |
| z790 8033 測試版 | 本機另一個 pipeline 容器，放還沒上線的 build。**目前沒有實例在跑**（單顎已上 8031），選單裡是灰的；要用時啟動實例並設 `PIPELINE_TEST_API_URL` | multipart | 是 |
| 5090 ezai2 | `ezai2.inteware.com.tw`，經 Cloudflare tunnel | multipart | 是 |
| 5090 ezai2 · S3 | 同上，同一個 proxy | 先上傳 S3，POST 只帶 URL | 是 |

選擇會記在瀏覽器（localStorage）。這個實例沒有設定的目標（例如沒有 Service Token）會在
選單裡變灰，來源是 `GET /api/viewer-config`（只回 true/false，不含任何網址或憑證）。
「檢查」按鈕打該目標的 `/health`，會列出三個後端是否連得到。

### 直接呼叫 FlowTooth

口掃沿用「牙冠設計」分頁上傳的檔案；margin 用這個分頁上傳的 `.pts`，沒有的話就用
「牙冠設計」分頁畫好的那條。**不會擺正**：Contacts、jaw matrix 與 abutment points 必須和
提交的 STL 在相同座標系。

這兩個按鈕送往這台機器上的兩個 FlowToothSDF 服務。dev 跟著目前在改的東西跑，prod 是釘住的正式版、有自己的工作目錄（`/opt/ai_services/FlowToothSDF-prod`），所以這兩顆按鈕回答的是「我現在看的版本跟正在出貨的差多少」。

```text
dev   /api/flowtooth       → FLOWTOOTH_API_URL       (8010)
prod  /api/flowtooth-prod  → FLOWTOOTH_PROD_API_URL  (8013)
```

prod 的下載檔名會多一個 `_prod` 後綴（`outer_crown_FDI45_prod.ply`），兩邊的 job id 也分別帶 `checkingviewer-dev-` 與 `checkingviewer-prod-`，所以下載檔與伺服器 log 都分得出是哪一個服務。「檢查 FlowTooth API」會一次檢查兩個服務。

### 為什麼有三個遠端 / S3 目標（原本的三顆一鍵按鈕）

2026-09-15 以前，這三個目標是面板上的三顆一鍵按鈕；現在收進「Pipeline」選單，行為不變。
它們跑的是同一條 `ezai-pipeline` 流程，差別只在**送去哪台機器、以及口掃檔怎麼送過去**：

| 按鈕 | 送去 | 口掃檔怎麼傳 |
|---|---|---|
| 一鍵：擺正 → Margin → 牙冠（台中 5080） | 本機 `:8031` | multipart 直接上傳 |
| 一鍵：擺正 → Margin → 牙冠（嘉義 5090） | `ezai2.inteware.com.tw`，經 Cloudflare tunnel | multipart 直接上傳 |
| 一鍵：口掃走 S3 → …（嘉義 5090） | 同上，同一個 proxy | 先上傳 S3，POST 只帶 URL |

前兩顆是為了比較兩張 GPU，所以除了位址以外**刻意共用同一段程式**——兩次執行只有在
其他條件都相同時才可比。第三顆是為了測 `ezai-pipeline` 的 URL 輸入路徑
（`upper_stl_url` / `lower_stl_url`），送出的 body 從 30 MB 變成約一千個位元組，改由
嘉義那台自己去 S3 拉檔。

**憑證都在 `.env`，由 `vite.config.js` 在伺服器端使用，不會進到瀏覽器。** 這條規則對
Cloudflare Service Token 和 AWS 金鑰都一樣：**不要移進 `src/` 底下任何檔案**。瀏覽器只會
拿到一個十分鐘有效、對應它自己剛送出那個檔案的 presigned GET URL。沒設定時按鈕會回報
「未設定」，而不是丟出難懂的錯誤。

三件實作上的取捨，改之前先看：

- **上傳是「瀏覽器 → 這個 Vite 程序 → S3」，不是瀏覽器直接送 S3。** 瀏覽器直接 PUT 進
  bucket 需要那個 bucket 有 CORS 規則，而 `pori-test` 是共用的。走這裡不必動這個
  checkout 以外的任何東西。**代價是面板上「S3 上傳」那一列不等於遠端呼叫端的上傳時間**，
  面板本身有寫這句話。誠實的那一半是嘉義那台自己的拉檔時間，來自 job 的 `sources`。
- **物件在 pipeline 回 202 的當下就刪除。** 它是在那個 POST 裡面就把檔案抓完才回應的，
  之後沒有人需要它們——而這些是真實臨床口掃，放在共用的測試 bucket 裡。
- **這顆按鈕只放在這個對外的 checkout，不放 `AiModelResultVerifyingDev`。**
  `/api/s3/upload` 是一個寫入 bucket 的端點，它的保護完全來自前面擋著的東西：這個實例
  綁 `127.0.0.1`、經 cloudflared，由 Cloudflare Access 把關；而 dev 那個實例是刻意綁
  `0.0.0.0:5174`，同一個端點放上去就等於讓同網段任何人不帶憑證就能寫進 bucket。
  **任何帶憑證的端點放上來之前，先確認前面擋著什麼。**

海外呼叫端請改用 `s3-accelerate.amazonaws.com` 端點簽章，實測上傳快 1.7–3.4 倍；
細節見 [ezai-pipeline/S3-TRANSFER.md](https://github.com/Delete3/ezai-pipeline/blob/main/S3-TRANSFER.md)。

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
