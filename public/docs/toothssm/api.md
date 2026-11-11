# AI排牙 API 串接說明

文件版本：2026-11-11（v1 本身沒有變；另有 API v2 開始試接，見「API v2 串接文件」）。2026-11-10 新增精簡包 `contents=slim`（處理後的口掃、每個面一個 byte 的分割標記 `.trimp`、每顆牙 `.tri`，約整包 zip 的九分之一；修改過的標記可以送回來重跑）。每次 API 更新的內容，見同一處的「更新內容」（changelog.md）。

上傳一組上下顎口掃，服務會自動分牙、替每顆牙生成牙根、用 AI 排牙，並回傳排牙前後的 ABO 評分；也可以只分牙＋生成牙齒、不排牙。這是非同步 API。嘉義、台中兩台主機提供同一個 API、互為備援，一筆全口在嘉義約 2 分鐘、台中約 3 分鐘。

## 連線與認證

兩個基底網址的 API 完全相同。嘉義和台中各用一組 Service Token（兩個 Cloudflare Access 應用）。

| 端點 | 基底網址 | 建議用途 |
|---|---|---|
| 嘉義（RTX 5090） | `https://ezai2.inteware.com.tw/toothssm` | 正式版，平時送這台 |
| 台中（RTX 5080） | `https://ezai.inteware.com.tw/toothssm` | 正式版，嘉義不能用時改送這台 |

每個請求都要帶下面三個 header，缺一個就會被 Cloudflare 擋下。

| Header | 值 | 說明 |
|---|---|---|
| `CF-Access-Client-Id` | 那台主機 Service Token 的 Client ID | 另外提供，不寫在文件裡 |
| `CF-Access-Client-Secret` | 那台主機 Service Token 的 Client Secret | 另外提供，不寫在文件裡；只放在伺服器端，不要放進瀏覽器程式 |
| `User-Agent` | 自訂字串，例如 `ortho-team-test/1.0` | 程式語言預設的 UA（例如 `Python-urllib/3.x`）會被 Cloudflare 直接回 403 error code: 1010 |

- 沒帶憑證和帶錯憑證都回同一個 403 頁面，所以 403 只代表請求有送到 Cloudflare，不代表網址錯。驗證連線請用 `GET /health`，拿到 200 才算通。
- Cloudflare 的上限：一個請求的 body 最大 100 MB，一個請求最長約 100 秒。所以上傳後要用輪詢等結果，不能開著連線等。
- 口掃建議先 gzip 再上傳（檔名加 `.gz`），全口 STL 約可從 25 MB 縮到 12 MB。

## 使用流程

一筆病例就是一個 job，走四步：

1. `POST /v1/jobs` 上傳上顎和下顎口掃，立刻回 202 與 `job_id`。
2. 每 2–5 秒 `GET /v1/jobs/{job_id}`，直到 `state` 是 `done` 或 `failed`。進行中依序是 `queued` → `segmenting`（分牙）→ `generating`（生成牙根）→ `aligning`（排牙）→ `done`；任何一步出錯就是 `failed`，原因在 `error`。
3. 下載結果：`GET /v1/jobs/{job_id}/archive?contents=slim` 拿精簡包（建議，Case 1 約 7 MB，見「精簡包」）；不帶 `contents` 是整包 zip（約 69 MB）；也可以照 `results` 裡的路徑一個一個拿。
4. `DELETE /v1/jobs/{job_id}`。口掃是病人資料，用完就刪；沒刪的話，job 結束 2 小時後會自動刪除。

- 只要分牙＋生成牙齒、不排牙，建立 job 時帶 `until=generate`，見下一節。只要分牙，帶 `until=segment`。job 會在那一步做完就是 `done`；之後可以用 `POST /v1/jobs/{job_id}/run` 接著跑後面的步驟，或換參數重跑。
- 想用自己的牙冠或牙齒直接從生成牙根或排牙開始，見下面「從中間開始」一節。
- 服務重新啟動時，所有 job 與檔案都會清掉；輪詢拿到 404 就表示 job 已經不在了，要重新上傳。

## 只分牙＋生成牙齒、不排牙

建立 job 時加 `until=generate`：服務做完分牙和生成整顆牙就結束，不跑排牙模型。`state` 從 `generating` 直接變成 `done`，不會出現 `aligning`。其他參數照常可用，預設也一樣：`crown=fit`、`root=virtual`。

```bash
curl -s "${H[@]}" -F upper=@upper.stl.gz -F lower=@lower.stl.gz -F until=generate $B/v1/jobs
```

| | 完整流程（預設，`until=align`） | 不排牙（`until=generate`） |
|---|---|---|
| 分牙結果 `results.crowns`、問題回報 `issues` | 有 | 有 |
| 整顆牙 `results.teeth`（`result/{jaw}/teeth/`）、整顎 `full_jaw.ply` | 有 | 有 |
| 牙軸 `tooth_axes.json`（`root=virtual`、`none`） | 有 | 有 |
| 排牙後的牙 `results.aligned`、`full_jaw_aligned.ply` | 有 | 沒有（`results.aligned` 是空列表） |
| 排牙矩陣、`results.align`、`results.transforms_url` | 有 | 沒有（null） |
| ABO `results.abo` | 排牙前、排牙後 | 沒有（兩項都是 null） |
| 整包 zip（Case 1） | 約 69 MB（精簡包約 7 MB） | 約 25 MB |
| 時間（嘉義，Case 1，`res=128`，27 顆） | 多排牙這一步（約 10–15 秒） | 120 秒（分牙 18 秒、生成 102 秒；2026-11-02 生成牙根加快前量的） |

- 拿到的牙和完整流程裡「排牙前」的牙相同：都在 `results.teeth`，排牙不會改動它們。
- 之後想排牙：在 job 還在的 2 小時內，對同一個 job 送 `POST /v1/jobs/{job_id}/run`、`step=align`，就用這筆生成的牙齒排牙，不必重新上傳。
- 換參數重新生成（例如換 `root` 或 `res`）而且仍然不排牙：`/run` 送 `step=generate` 時**要帶 `until=generate`**。沒帶的話，服務會接著排牙（`/run` 的 `until` 預設是 `align`，不看 job 原本的設定）。
- `root=none`（只回開口的牙冠＋牙軸）本來就不排牙，等於自動帶 `until=generate`。
- 用自己的牙冠只生成牙齒（`start=generate` 加 `until=generate`），見「從中間開始」。

## 兩台備援怎麼用

平時送嘉義；嘉義不能用時，把新的 job 送台中。兩台不共用任何東西，規則如下：

- 送出前先 `GET /health`：回 200 且 `status` 是 `ok` 才送。回 503、5xx、連不上或逾時，就改用另一台。
- job 只存在收到它的那一台：輪詢、下載、重跑、刪除都要送回同一台。請把 `job_id` 和基底網址一起記下來。
- 一台在 job 進行中掛掉（輪詢一直失敗、拿到 404，或 `state` 是 `failed` 且 `error` 說 GPU 有問題），那個 job 不會轉到另一台，要把口掃重新上傳到另一台。
- 兩台各自一次跑一個 job、各自最多 4 個在跑或排隊。一台回 429 時可以送另一台。
- 兩台的程式、參數預設值、模型權重都一樣；結果不會逐位元組相同（顯示卡不同，分牙本身每次跑也有極小的差異）。
- 嘉義測試版（`https://ezai2.inteware.com.tw/toothssm-fit`）在 2026-11-02 關閉，它的功能已經在兩台正式版上；請改用上面兩個網址。

## 端點一覽

下表的路徑都接在基底網址後面，兩台完全相同。

| 方法 | 路徑 | 做什麼 | 成功時回傳 |
|---|---|---|---|
| POST | `/v1/jobs` | 建立 job（multipart/form-data）：上傳上下顎口掃、自己的牙冠／牙齒 zip，或精簡包的口掃＋標記 | 202 `{job_id, state, status_url}` |
| GET | `/v1/jobs/{job_id}` | 狀態、每步秒數、進度、結果檔案路徑、評分 | 200 JSON |
| GET | `/v1/jobs/{job_id}/files/{path}` | 下載一個結果檔（path 照 `results` 裡的寫）；`.ply`、`.stl` 加 `?format=tri` 拿 `.tri` | 200 檔案 |
| GET | `/v1/jobs/{job_id}/archive` | 結果 zip：預設整包；`?contents=slim` 是精簡包（見「精簡包」）。job 還在跑時回 409 | 200 zip |
| POST | `/v1/jobs/{job_id}/run` | 從某一步重跑（`step=generate` 或 `align`）；`step=generate` 可以附修改過的標記 | 202 `{job_id, state, steps}` |
| DELETE | `/v1/jobs/{job_id}` | 刪除 job 與所有檔案（還在跑時回 409） | 200 `{deleted}` |
| GET | `/health` | 服務與 GPU 是否可用、排隊數 | 200；GPU 或模型檔有問題時 503 |
| GET | `/` | 支援的格式、參數選項與預設值、FDI 配色 | 200 JSON |

## 建立 job 的參數

`POST /v1/jobs` 是 multipart/form-data，上顎和下顎都要送：分牙時兩顎要一起對合，排牙模型也是雙顎的。其他欄位都可以省略。

| 欄位 | 類型 | 預設 | 說明 |
|---|---|---|---|
| `upper` | 檔案（必填） | — | 上顎口掃。格式看檔名的副檔名：`.stl`、`.ply`、`.obj`、`.tri`（公司格式 V1/V2），都可以再加 `.gz`，例如 `upper.tri.gz` |
| `lower` | 檔案（必填） | — | 下顎口掃，格式同上 |
| `seg` | `ssm` 或 `toothroot` | `ssm` | 誰來分牙、生成牙根。`ssm`：tooth_ssm 原作者的流程。`toothroot`：改用 ToothRoot 分牙與生成牙根，排牙仍是 tooth_ssm；口掃被減面過（例如矯正專案檔裡約 1.2 萬面的口掃）時要用這個 |
| `crown` | `fit`、`exact` 或 `zhu` | `fit`（2026-11-02 起；之前是 `zhu`） | 整顆牙的牙冠怎麼來，只對 `seg=ssm` 有效，見下一節 |
| `root` | `virtual`、`generated`、`none` | `virtual`（2026-11-02 起；之前沒有這個參數，等於 `generated`） | 牙冠下面接什麼，只對 `seg=ssm` 有效，見「牙根」一節。`virtual` 和 `none` 的牙冠：`crown=fit` 是擬合後的 AI 牙齒，`exact` 是口掃原樣；送 `zhu` 當成 `exact` |
| `root_fix` | `1` 或 `0` | `1` | 牙根歪斜修正（只對 `seg=ssm` 有效）。`0` 是修正前的做法，留著給比對用 |
| `fast_roots` | `1` 或 `0` | `1`（主機的預設，`GET /info` 的 `fast_roots`） | 生成牙根用哪一種擬合（只對 `seg=ssm` 有效，2026-11-05 起）。`1`＝2026-11-02 上線的加速版；`0`＝加速前，生成牙根約慢一倍，留著給比對用。分牙、接牙冠、排牙不受影響 |
| `res` | `128`、`160`、`192` | `128` | 牙齒網格的解析度。192 細一點，每筆多約 10 秒 |
| `until` | `segment`、`generate`、`align` | `align` | 做到哪一步為止。`generate`＝只分牙＋生成牙齒、不排牙（見「只分牙＋生成牙齒、不排牙」） |

- `POST /v1/jobs/{job_id}/run` 收 `step`（必填，`generate` 或 `align`）以及 `res`、`until`、`root_fix`、`crown`、`root`、`fast_roots`；沒送的沿用這個 job 原本的值，只有 `until` 例外（沒送就是 `align`）。分牙不能重跑，要換分牙就建新的 job。`root=none` 的 job 沒有排牙，`step=align` 會回 422。
- `/run` 的 `step=generate` 另外收 `labels_upper`、`labels_lower`（`.trimp`）：照修改過的分割標記重新切牙冠，見「精簡包」的「把修改過的標記送回來」。
- 口掃上很小的漂浮碎片（每塊小於表面積 0.5%）若會讓分牙誤判，服務會先移掉並在 `warnings` 說明。兩顎沒有對合（咬合方向不平行，或兩顎朝同一邊而被重新擺位）時，也會在 `warnings` 提醒。
- `seg=toothroot` 另外會自動偵測上下顎檔案送反並對調，同樣寫在 `warnings`；`seg=ssm` 不會，請確認欄位沒放反。

## 牙冠：`crown=fit`、`exact`、`zhu`

| | `zhu`（原作者流程，2026-11-01 以前的預設） | `exact` | `fit`（預設，2026-11-02 起） |
|---|---|---|---|
| 牙冠 | 整顆牙（含牙冠）由 AI 重新生成，牙冠離口掃平均 0.05–0.14 mm、最遠 0.7–3.1 mm（多在牙齦線附近） | 口掃原本的網格，一個點都不動；只修掉分割邊界上的鋸齒三角形（約 2–5% 的點，最遠 0.3–0.6 mm） | AI 生成的牙重新網格化後，牙冠拉到口掃上：修整後的口掃牙冠 96.5–98.7% 在 0.05 mm 內（0.01 mm 內 70–87%；`exact` 都是 100%）；偏最多的是分牙邊緣最外一圈翻到牙齦上的口掃 |
| 網格 | marching cubes，13% 的三角形最小角小於 10°（都很小） | 口掃原本的網格，加上接合處的三角形帶：細長三角形每筆數百到九千多個（一邊超過 1 mm） | 均勻，邊長約 0.2 mm：最小角小於 10° 的不到 0.05%，沒有一邊超過 1 mm 的（例外見下） |
| 鄰接面接觸點下方 | AI 生成 | 分牙切出的凹口；`root=none`、`virtual` 用三角形帶縫起來 | AI 生成的牙面，平順 |
| 牙根 | AI 生成 | AI 生成，接在牙冠邊緣下方（`root=generated`） | 擬合後的整顆牙，沒有縫線（`root=generated`） |
| 鄰牙干涉 | 幾乎每對相鄰牙都互相穿插（8 個測試病例：每筆 10–26 對，最深 0.7–3.1 mm） | 生成的部分被推開、緊接觸點的薄膜切掉；8 個測試病例重疊體積都是 0 | 擬合之後推開（只動不在口掃上的部分）；8 個測試病例重疊 0（兩筆各一對 0.001–0.002 mm³，屬數值誤差） |
| 自我交叉三角形（每筆） | 50–130 對 | `root=generated` 8,700–24,000 對 | 0–89 對 |
| 多花的時間 | — | 每筆多 11–38 秒 | Case 1：比 `exact` 多約 6–7 秒 |

`crown=exact` 的已知限制：

- 牙冠與牙根接合帶有自我交叉的三角形（`root=generated` 每筆數千到兩萬多對；`root=virtual` 降到每筆幾百到三千多對）。畫面上看不出來、牙齒也都是封閉的，但需要乾淨實體的運算（布林、偏移）可能在那一帶出問題。
- 分牙若把一顆牙切錯（例如切成一大片），生成的牙會長到鄰牙的位置；服務會用鄰牙把它切開，並列在 `results.exact_crown.{jaw}.engulfed`（以及 `issues` 的 `seg.engulfed`），請檢查那顆牙的分牙。
- 排牙之後兩顆牙會不會再碰到，還沒有量過（排牙模型是把整顆牙剛體移動）。

`crown=fit` 怎麼做、要注意什麼：

- 從 AI 生成的整顆牙出發：重新網格化成邊長約 0.2 mm 的均勻三角形，再把對得到口掃牙冠的部分拉到口掃上（非剛性擬合），其他部分只求平順地跟著動；最後再整理一次網格，把擬合到的頂點放到口掃面上。
- 擬合之後才推開鄰牙；口掃面上的頂點不動，只有兩顆牙在緊接觸點互搶的那一小塊口掃面會一起放開推（最多移動約 0.4 mm）。
- 牙冠不是口掃原本的頂點，而是貼在口掃上的新網格。不是口掃的部分：鄰接面接觸點下方、牙齦線到切口之間（`root=none`、`virtual`），以及被推開的接觸面。
- 分牙邊緣最外一圈常翻到牙齦上（法向和牙面差 60° 以上），擬合刻意不跟過去；0.05 mm 以外的點約九成在那裡。
- 分牙若把一顆牙切錯（例如切成一大片），生成的牙會長到鄰牙的位置：和 `crown=exact` 一樣用鄰牙把它切開、列在 `results.exact_crown.{jaw}.engulfed`（以及 `issues` 的 `seg.engulfed`），請檢查那顆牙的分牙（8 個病例中 1 顆）。
- 例外：Case 6（分牙把下顎 46 切錯的那一筆）在 `root=virtual` 時，46 接不上虛擬牙根、改接整顆牙後被推開變形：細長三角形 0.25%、一邊超過 1 mm 的 141 個、和 47 重疊 1.1 mm³。`none`、`generated` 沒有這個問題。
- 個別牙擬合或切開失敗時：`root=none` 照 `crown=exact` 的做法回傳那顆，列在 `results.exact_crown.{jaw}.fallback`；`root=virtual` 改接擬合後的整顆牙，列在 `generated_root`。

## 牙根：`root=virtual`、`generated`、`none`

牙冠由 `crown` 決定（預設 `fit`，見上一節），差別在牙冠下面接什麼。要 2026-11-01 以前正式版的結果，送 `crown=zhu`、`root=generated`。

| | `virtual`（預設） | `generated` | `none` |
|---|---|---|---|
| 牙根 | 矯正軟體的虛擬牙根演算法（ToothRootLoft）：牙冠邊緣沿牙軸往牙根方向延伸 3 mm，收成牙冠一半大的圓再封底 | AI 生成的牙根 | 不接，由你們接自己的牙根 |
| 牙根方向 | 沿 AI 生成牙齒的牙軸 | AI 生成 | 牙軸照樣給（`tooth_axes.json`） |
| 封閉 | 是 | 是 | 否：每顆牙冠在牙齦線處有一個開口邊緣 |
| 鄰牙干涉（8 個測試病例） | 0 | 0 | 牙冠在切開前已推開 |
| 自我交叉三角形（8 個病例，每筆） | `fit` 0–62 對（`exact` 348–3,539 對） | `fit` 5–89 對（`exact` 6,700–24,000 對） | `fit` 0–62 對（`exact` 116–713 對） |
| 排牙 | 有 | 有 | 沒有：job 做完 generate 就是 `done`，沒有 `aligning` |
| 牙軸 `tooth_axes.json` | 有 | 沒有 | 有 |

`root=none`（只回牙冠，讓你們自己縫合牙根）：

- 牙冠在 `result/{jaw}/teeth/tooth_{FDI}.ply`（`results.teeth` 列的就是它們），每顆只有一個開口邊緣。
- `crown=fit`（預設）：擬合後的 AI 牙齒，在平滑的牙齦線處切開。切線是口掃牙冠的邊緣，但鄰接面不再沿凹口爬到接觸點，而是用牙齦的高度橫過去（切在 AI 的鄰接面上），再沿牙軸平滑：牙冠邊緣離鄰牙 1.5 mm 以內的部分當成凹口，切線也從不高於該處牙冠邊緣的最低點，所以不會切到口掃牙冠。切口附近的頂點先移到切線上，所以切口不會留下細長三角形。
- `crown=exact`：口掃原本的網格，分割邊界上的鋸齒修掉、細縫與小洞補起來、鄰接面窄而深的凹口用一條三角形帶縫起來（這條帶子就是細長三角形的來源）。少數修整不成的會照分牙原樣回傳，列在 `results.exact_crown.{jaw}.fallback`，內容寫「crown as segmented」。
- `crown=fit` 的牙冠在切開前已和鄰牙推開；接上你們的牙根後，牙根之間的干涉請你們的流程處理。
- 不排牙：`until` 會自動停在 `generate`；`start=align` 或 `/run` 的 `step=align` 回 422。ABO 是排牙那一步算的，所以這個模式沒有 ABO（`results.abo` 兩項都是 null）。
- 想要排牙，就用 `root=virtual` 或 `generated`；要把自己的整顆牙拿去排牙，用 `start=align`（見「從中間開始」）。

`root=virtual`：

- 牙軸方向取自 AI 生成的整顆牙，所以牙根朝向和 AI 生成的牙根一致；長度固定 3 mm（短牙根）。
- 接不上虛擬牙根的牙列在 `results.exact_crown.{jaw}.generated_root`：`crown=fit` 改接擬合後的整顆牙（8 個病例中 2 顆，都在 Case 6：根分叉剛好在牙齦線高度，切口繞不過牙軸）；`crown=exact` 改接 AI 生成的牙根（1 顆）。
- 排牙時虛擬牙根和牙冠一起剛體移動；`tooth_axes.json` 是排牙前的位置，排牙後的牙軸要再乘上那顆牙的排牙矩陣。

### 牙軸（tooth_axes.json）

`root=virtual` 和 `none` 會多一個 `result/tooth_axes.json`（`results.axes_url`），內容也直接放在狀態回應的 `results.axes`：

```json
{
 "frame": "scan",
 "units": "mm",
 "convention": "per tooth: origin = crown centre; z = unit tooth axis from the root to the crown ...",
 "teeth": {
  "11": {
   "origin": [2.36916, 11.63278, 3.65872],
   "x": [-0.96774, 0.25028, -0.02885],
   "y": [0.21426, 0.87785, 0.42833],
   "z": [0.13252, 0.40833, -0.90316],
   "apex": [1.26514, 8.23111, 11.18262],
   "matrix": [[-0.96774, 0.21426, 0.13252, 2.36916],
              [0.25028, 0.87785, 0.40833, 11.63278],
              [-0.02885, 0.42833, -0.90316, 3.65872],
              [0.0, 0.0, 0.0, 1.0]]
  },
  "12": {...}
 }
}
```

- 座標系和上傳的口掃相同，單位 mm；鍵是 FDI 字串。
- `origin`：牙冠中心。
- `z`：單位向量，從牙根指向牙冠（矯正軟體的 CROWN − ROOT）。牙根要往 −z 方向長。
- `y`：朝牙弓外側（唇頰側）；`x` = `y` × `z`。三個軸互相垂直，是右手座標系。
- `apex`：AI 生成牙齒的牙根尖（沿牙軸最深 5% 頂點的中心；多根牙是幾個根尖的中間），可以當牙根長度的參考。
- `matrix`：4×4、第一層是列，把牙齒座標系的點換到口掃座標系：p口掃 = M · [u, v, w, 1]ᵀ，四行依序是 `x`、`y`、`z`、`origin`。反過來（口掃 → 牙齒座標系）是 Rᵀ · (p − origin)。
- 沒有分到牙冠的牙不會出現。

## 從中間開始：用自己的牙冠或牙齒

生成牙根、排牙都可以單獨執行，不必先經過我們的分牙。一樣是 `POST /v1/jobs`，改送 `start` 和一個 zip（欄位名 `teeth`），不送口掃。

| start | 做什麼 | zip 裡要有（兩顎都要） |
|---|---|---|
| `segment`（預設） | 分牙 → 牙根 → 排牙，送口掃 `upper`、`lower` | 不用 zip |
| `generate` | 用你的牙冠生成牙根 → 排牙 | 牙冠、牙齦 |
| `align` | 用你的牙冠和整顆牙排牙 | 牙冠、整顆牙 |
| `generate`（精簡包） | 用精簡包的口掃＋標記生成牙根 → 排牙 | 不用 zip：送 `upper`、`lower`（`scan/{jaw}.tri`）與 `labels_upper`、`labels_lower`，見「精簡包」 |

- 只要生成牙根、不排牙，就加 `until=generate`。`res`、`root_fix`、`crown`、`root` 照常可用；這種 job 一律用 tooth_ssm，不能送 `seg=toothroot`。
- zip 的資料夾結構和我們回傳的 zip 一樣，所以可以拿一個 job 的結果修改後直接送回來：

| zip 裡的路徑 | 內容 | 哪個 start 要 |
|---|---|---|
| `segmentation/{jaw}/tooth_{FDI}.ply` | 從口掃切下來的牙冠，在牙齦線處是開口的（不是封閉的） | generate、align |
| `segmentation/{jaw}/gum.ply` | 切掉牙冠後剩下的牙齦；用來判斷咬合方向 | generate |
| `result/{jaw}/teeth/tooth_{FDI}.ply` | 含牙根的整顆牙 | align |

- `{jaw}` 是 `upper` 或 `lower`，`{FDI}` 是兩位數的 FDI；牙位要和顎對得上（上顎 1x、2x，下顎 3x、4x）。第三大臼齒（x8）排牙時不動。
- 格式可以是 `.ply`、`.stl`、`.obj`，單位 mm。同一顎的牙冠、牙齦、整顆牙在同一個座標系，上下顎是咬合的位置（和口掃匯出時一樣）。
- zip 外面可以再包一層資料夾；其他檔案會被忽略。
- 牙冠要是原始解析度：少於 300 個頂點的牙冠長不出牙根；一顎少於 6 顆時，牙根歪斜修正對這一顎不生效。這兩種情況都會寫在 `warnings`。
- 排牙模型讀的是牙冠，移動的是整顆牙；只有牙冠或只有整顆牙的牙位會寫在 `warnings`。
- 缺一顎、缺牙齦（generate）、缺整顆牙（align）、牙位放錯顎、`until` 在 `start` 之前，都會直接回 422 並說明原因。

```bash
curl -s "${H[@]}" -F start=generate -F until=generate -F teeth=@crowns_and_gum.zip $B/v1/jobs   # 只生成牙根
curl -s "${H[@]}" -F start=align -F teeth=@crowns_and_teeth.zip $B/v1/jobs                     # 只排牙
```

## 狀態與結果

`GET /v1/jobs/{job_id}` 回傳一個 JSON，常用的欄位如下。所有結果檔都和上傳的口掃在同一個座標系（單位 mm），可以直接疊在原始口掃上；唯一的例外是 `results.articulation.articulated` 為 true 時（兩顎朝同一邊，上顎被重新擺位）。

| 欄位 | 內容 |
|---|---|
| `state` | `queued`、`segmenting`、`generating`、`aligning`、`done`、`failed` |
| `error` | 失敗原因（成功時為 null） |
| `warnings` | 提醒列表：移除了碎片、某顎分到的牙少於 6 顆、兩顎沒有對合……（`issues` 的每筆錯誤與警告也會寫成一行） |
| `issues` | 服務檢查到的分牙與生成問題，每筆有固定代碼、等級與相關牙位，見「問題回報」 |
| `params` | 這個 job 實際用的 `seg`、`res`、`until`、`root_fix`、`crown`、`root`、`fast_roots`、`start` |
| `timings` | 每步秒數（`segment_s`、`generate_s`、`align_s`、`total_s`）與更細的 `detail` |
| `progress` | 生成牙根時的 `{teeth_done, teeth_total}`，其他時候是 null |
| `queue_position` | 排隊中時，前面還有幾個 job |
| `results.scans` | 上傳的口掃（已轉成 STL） |
| `results.crowns` | 分牙結果：每顆牙冠 `{jaw, fdi, color, url}`，fdi 為 0 的是牙齦 |
| `results.teeth` | 排牙前、含牙根的整顆牙 `{jaw, fdi, color, coloured, url}`；`root=none` 時是開口的牙冠 |
| `results.aligned` | 排牙後的整顆牙，同上；沒有排牙（`until=generate`、`root=none`）時是空列表 |
| `results.align` | 每顎每顆牙的排牙旋轉角（°）與位移（mm），以及平均、最大、超過 20° 的顆數；沒有排牙時是 null |
| `results.abo` | 排牙前（`input`）與排牙後（`aligned`）的 ABO 各項與 ABO7、TOTAL（越低越好）；兩項都在排牙那一步算，沒有排牙時都是 null |
| `results.crown_stats` | AI 生成的牙冠離原口掃多遠（平均、p95，mm）、封閉的顆數、失敗的牙。`crown=exact`、`fit` 時描述的是擬合或換回口掃前的生成牙冠 |
| `results.exact_crown` | `crown=exact` 或 `fit`，或 `root` 不是 `generated` 時：每顎的 `crown`（`exact` 或 `fit`）、`scan_crown`（用上口掃牙冠或擬合成功的顆數）、`fallback`（沒做成的牙與原因）、`shared_mm3_generated` 與 `shared_mm3_after_parting`（推開前後鄰牙重疊的體積，mm³；`fit` 只有推開後的）、`contact_films_cut`（`exact` 在緊接觸點切掉的薄膜）、`engulfed`（生成的牙佔到鄰牙位置而被切開的牙，請檢查分牙）、`generated_root`（`root=virtual` 時改接 AI 生成牙根的牙）、`triangles`（`fit`：這一顎交出去的牙的面數 `faces`、最小角小於 10° 的 `min_angle_lt10`、一邊超過 1 mm 的 `edge_gt1mm`） |
| `results.root` | 這個 job 的 `root` |
| `results.fast_roots` | 這筆的生成牙根是否用加速版（`fast_roots` 參數；沒送時是主機的預設，兩台都是 `true`） |
| `results.axes`、`results.axes_url` | `root=virtual` 或 `none`：每顆牙的牙軸，與 `tooth_axes.json` 的路徑（見「牙軸」） |
| `log_tail` | 紀錄檔最後 15 行（除錯用） |

- `results` 裡的 `url` 是相對於 job 的路徑，例如 `files/result/viewer/aligned/upper/tooth_11.ply`，完整網址是 `…/v1/jobs/{job_id}/` 再接上它。
- `coloured` 為 true 的是頂點帶顏色的版本（牙冠、牙根分色）；不帶顏色的同一顆牙在 `files/result/{jaw}/teeth/` 與 `files/result/{jaw}/aligned/`。

`/archive` 的 zip 裡主要是：

| zip 裡的路徑 | 內容 |
|---|---|
| `segmentation/{jaw}/tooth_{FDI}.ply`、`gum.ply` | 分牙後的牙冠與牙齦 |
| `result/{jaw}/teeth/tooth_{FDI}.ply` | 排牙前、含牙根的整顆牙 |
| `result/{jaw}/aligned/tooth_{FDI}.ply` | 排牙後的整顆牙 |
| `result/{jaw}/full_jaw.ply`、`full_jaw_aligned.ply` | 整顎（排牙前、後） |
| `result/both_jaws.ply`、`both_jaws_aligned.ply` | 上下顎合在一起 |
| `result/aligned_transforms_world.json`、`.npz` | 每顆牙的排牙變換（口掃座標系） |
| `result/tooth_axes.json` | 每顆牙的牙軸（只有 `root=virtual`、`none`） |
| `result/aligned_report.json`、`abo_input.json`、`abo_aligned.json` | 排牙報告與 ABO |
| `result/viewer/...` | 帶顏色的顯示用版本 |

一筆全口的 zip 約 69 MB（Case 1 68.8 MB、307 個檔；`result/_aligned/` 是排牙模型的中間檔，可以忽略）。要省傳輸時間請用精簡包（約 7 MB，見「精簡包」）；只需要幾個檔案時，照 `results` 個別下載。

### 排牙矩陣

每顆牙的排牙移動有三個拿法，內容相同：

| 拿法 | 在哪裡 | 適合 |
|---|---|---|
| 狀態回應 | `results.align.{jaw}.teeth[].matrix`（和該顆牙的 `fdi`、`rot_deg`、`trans_mm` 放在一起） | 不用另外下載 |
| JSON 檔 | `GET /v1/jobs/{job_id}/files/result/aligned_transforms_world.json`（`results.transforms_url`），也在 zip 裡 | C++ 等不想裝 NumPy 讀取器的程式 |
| npz 檔 | `.../files/result/aligned_transforms_world.npz` | Python（NumPy） |

JSON 檔的樣子：

```json
{
 "frame": "scan",
 "units": "mm",
 "convention": "4x4 row-major homogeneous matrix per moved tooth ...",
 "teeth": {
  "11": [[0.9873, 0.1354, -0.0829, 3.7969],
         [-0.1403, 0.9885, -0.0557, -1.5544],
         [0.0745, 0.0666, 0.9950, 1.7499],
         [0.0, 0.0, 0.0, 1.0]],
  "12": [[...]]
 },
 "kept": []
}
```

- 每個矩陣是 4 列（row）× 4 行，第一層是列。
- 每顆被排牙模型移動的牙一筆，鍵是 FDI 字串（例如 `"11"`、`"47"`），值是 4×4 齊次矩陣（float64）。
- 座標系和上傳的口掃相同，單位 mm。用法是 p排牙後 = M · [x, y, z, 1]ᵀ，也就是 R · p + t：R 是左上 3×3，t 是第 4 行的前三個數。
- 矩陣作用在排牙前的整顆牙（`result/{jaw}/teeth/tooth_{FDI}.ply`），套上後就是 `result/{jaw}/aligned/tooth_{FDI}.ply`。一筆 27 顆的全口實測，差距都在 0.000002 mm 以下。
- 排牙模型沒有移動的牙，檔案裡沒有那一筆，要當成不動（單位矩陣）；這些牙列在 `results.align.{jaw}.kept`。
- 原始口掃上的牙冠和它在同一個座標系，也能直接套用。例外是 `results.articulation.articulated` 為 true 時：兩顎朝同一邊、上顎被重新擺位過，上顎已不在原始口掃的座標系。

C++（以 header-only 的 nlohmann/json 為例，用別的 JSON 函式庫也一樣）：

```cpp
#include <nlohmann/json.hpp>
using json = nlohmann::json;

json j = json::parse(text);                    // aligned_transforms_world.json 的內容
double M[4][4];
if (j["teeth"].contains("11")) {
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c)
            M[r][c] = j["teeth"]["11"][r][c].get<double>();
} // 沒有這一筆 = 沒移動（單位矩陣）

// 套用到一個頂點 (x, y, z)
x2 = M[0][0]*x + M[0][1]*y + M[0][2]*z + M[0][3];
y2 = M[1][0]*x + M[1][1]*y + M[1][2]*z + M[1][3];
z2 = M[2][0]*x + M[2][1]*y + M[2][2]*z + M[2][3];
```

## 精簡包：`contents=slim`（2026-11-10 起，建議）

`GET /v1/jobs/{job_id}/archive?contents=slim` 只放「從其他檔案推不出來」的東西，其餘都可以從裡面算回來，而且**無損**：還原出來的牙冠、牙齦、牙齒和整包 zip 裡的逐位元相同。不帶 `contents`（或 `contents=full`）仍是原本的整包 zip，內容不變。

| | 整包 zip（`full`，預設） | 精簡包（`slim`） |
|---|---|---|
| Case 1（27 顆，排牙完成） | 68.8 MB、307 個檔 | 7.4 MB、38 個檔 |
| 其中的分割（牙冠＋牙齦） | 29 個 `.ply` | 兩個標記檔，合計約 15 KB（依口掃不同，一顎約 4–70 KB） |
| 服務端打包 | 約 1.3 秒 | 嘉義 0.12 秒、台中 0.16 秒 |

精簡包裡的檔案：

| zip 裡的路徑 | 內容 |
|---|---|
| `manifest.json` | 格式版本；每顎口掃的面數、頂點數、指紋，以及上下顎對調、上顎移動、移掉的碎片；每顎標記的統計；整顆牙列表；檔案列表 |
| `scan/{jaw}.tri` | 服務實際使用的口掃（`.tri` V1，見下） |
| `labels/{jaw}.trimp` | 分割標記：`scan/{jaw}.tri` 的每個面屬於哪顆牙或牙齦（TRIMP v1，見下） |
| `result/{jaw}/teeth/tooth_{FDI}.tri` | 排牙前、含牙根的整顆牙；頂點與面和整包 zip 的 `.ply` 完全相同 |
| `result/*.json` | `aligned_transforms_world.json`（排牙矩陣）、`aligned_report.json`、`abo_input.json`、`abo_aligned.json`、`articulation.json`、`tooth_axes.json`（`root=virtual`、`none`） |

整包 zip 裡其他的東西，從精簡包這樣得到：

| 整包 zip 裡的 | 從精簡包怎麼得到 |
|---|---|
| `segmentation/{jaw}/tooth_{FDI}.ply`、`gum.ply` | 口掃裡標記等於那個 FDI（牙齦是 0）的面 |
| `result/{jaw}/aligned/tooth_{FDI}.ply` | 排牙矩陣 × 整顆牙（見「排牙矩陣」；沒有那一筆就是沒動），差 0.000002 mm 以下 |
| `result/{jaw}/full_jaw*.ply`、`both_jaws*.ply` | 把整顆牙合在一起 |
| `result/viewer/...`、`result/_aligned/...` | 顯示用的上色版本與排牙模型的中間檔，不需要 |

### 口掃：服務實際使用的那一份

`scan/{jaw}.tri` 不是上傳的原檔，而是服務分牙時用的口掃，標記、牙齒、排牙矩陣、牙軸都以它為準、在它的座標系。和上傳檔不同的地方寫在 `manifest.json` 的 `scan.{jaw}`：

| 欄位 | 意思 |
|---|---|
| `uploaded_as` | 這一顎來自哪個上傳欄位（`upper` 或 `lower`）。`seg=toothroot` 偵測到上下顎送反而對調時，`upper` 會寫 `lower`，而且 `manifest.json` 的 `swapped` 是 true |
| `moved`、`pose` | 上顎是否被重新擺位（即 `results.articulation.articulated`），以及 4×4 矩陣（第一層是列）：p回傳 = pose · [x, y, z, 1]ᵀ，[x, y, z] 是上傳檔的座標。沒移動時是單位矩陣 |
| `debris_faces_removed` | 移掉的漂浮碎片面數（見 `warnings`） |
| `faces`、`vertices`、`fingerprint` | 面數、頂點數、指紋（和標記檔檔頭裡的相同） |

- 上傳 STL 的每個三角形都原樣保留：座標逐位元相同、面的順序相同、每個面的第一個角點相同，只把座標完全相同的頂點合併。
- 用牙冠 zip 建的 job（`start=generate`、`align`）沒有口掃：精簡包裡沒有 `scan/`、`labels/`，`manifest.json` 的 `scan.{jaw}` 是 null。

### `.tri` V1

little-endian：`uint32` 頂點數 V、`uint32` 面數 F、`float32[V][3]` 頂點座標（mm）、`uint32[F][3]` 每個面的三個頂點索引（從 0 開始）。上傳口掃時也收這個格式。

### 分割標記檔 `.trimp`（TRIMP v1，TRI Mark Per-face）

每個面一個 byte，依 `scan/{jaw}.tri` 的面順序：`0`＝牙齦、`11`–`48`＝那顆牙的 FDI、`254`＝不屬於任何部分。檔案是 32 byte 的檔頭、標記資料、（選用的）延伸區塊，little-endian：

| 位移 | 大小 | 欄位 | 內容 |
|---|---|---|---|
| 0 | 4 | magic | `TRMP` |
| 4 | 1 | version | `1`；不認得的版本要拒絕 |
| 5 | 1 | element | `0`＝每個面一個標記（精簡包都是 0）、`1`＝每個頂點一個 |
| 6 | 1 | jaw | `0`＝未指定、`1`＝上顎、`2`＝下顎 |
| 7 | 1 | codec | `0`＝不壓縮、`1`＝zlib（RFC 1950，zlib 的 `uncompress` 直接解） |
| 8 | 4 | count | `uint32`，標記數＝口掃的面數 |
| 12 | 8 | fingerprint | 口掃的指紋（見下） |
| 20 | 4 | payload_len | `uint32`，標記資料（壓縮後）的 byte 數 |
| 24 | 4 | crc32 | `uint32`，解壓後 `count` 個標記的 CRC-32（zlib 的 `crc32`） |
| 28 | 4 | reserved | `0` |
| 32 | payload_len | payload | 標記資料 |
| … | | chunks | 到檔尾為止：4 個 ASCII 字元的 tag、`uint32` 長度、資料。v1 沒有定義任何區塊；讀取時跳過不認得的 |

- **指紋**：把口掃每個面的三個角點座標（`float32`，依面的順序，角點照面裡存的順序，每個面 36 byte）接起來算 SHA-256，取前 8 byte。`-0.0` 當成 `+0.0`（服務寫出的 `.tri` 裡沒有 `-0.0`）。讀取時用手上的口掃算一次，面數或指紋對不上就不要用：表示標記屬於另一份口掃，或口掃被重新匯出、面的順序變了。
- 口掃被移動、減面、重新排序後指紋就會變：標記只屬於產生它的那一份口掃。
- 改標記後寫回：改標記資料裡的值，重算 CRC-32、重新 zlib 壓縮、更新 `payload_len`；`count` 和 `fingerprint` 不變（同一份口掃）。
- C++ 讀取範例：[trimp_read.cpp](/docs/toothssm/trimp_read.cpp)（全文在本文件最後的附錄），只需要 zlib。讀 `.tri` 和 `.trimp`、檢查面數和指紋、印出每個標記有幾個面，也可以把一顆牙的面輸出成 OBJ：

```bash
g++ -std=c++17 -O2 trimp_read.cpp -lz -o trimp_read
./trimp_read scan/upper.tri labels/upper.trimp tooth_11.obj 11
```

### 把修改過的標記送回來

分牙不對時，改標記比改網格簡單；送回來就從生成牙根重跑：

| 情況 | 怎麼送 | 說明 |
|---|---|---|
| job 還在（結束後 2 小時內） | `POST /v1/jobs/{job_id}/run`：`step=generate`，加 `labels_upper` 和／或 `labels_lower`（`.trimp` 檔） | 用這筆 job 自己的口掃照標記切出牙冠與牙齦，再生成牙根、排牙（不排牙就加 `until=generate`）。只送一顎就只換那一顎；那一顎上次生成的牙會先清掉。只限 `seg=ssm` 的 job |
| job 已經不在 | `POST /v1/jobs`：`start=generate`，`upper`、`lower`＝精簡包的 `scan/{jaw}.tri`（可加 `.gz`），`labels_upper`、`labels_lower`＝標記 | 口掃照原樣使用：不再對調、不再擺位、不再移碎片。兩顎都要 |

```bash
# job 還在：只改上顎的標記
curl -s "${H[@]}" -F step=generate -F labels_upper=@upper.trimp $B/v1/jobs/<job_id>/run
# job 已經不在：用精簡包的口掃和標記建新的 job
curl -s "${H[@]}" -F start=generate -F upper=@scan/upper.tri -F lower=@scan/lower.tri \
     -F labels_upper=@labels/upper.trimp -F labels_lower=@labels/lower.trimp $B/v1/jobs
```

- 回 422 的情況：標記和口掃的面數、指紋或顎對不上；值不是牙齦、254 或那一顎的 FDI；某一顎沒有牙齦或沒有任何牙；帶標記但 `step` 不是 `generate`。`seg=toothroot` 的 job、用牙冠 zip 建的 job（沒有口掃）回 409。
- 同一份標記，從標記建 job 和從牙冠 zip 建 job，生成的牙逐位元相同；排牙本身每次跑都有極小的差異（實測最多 0.007 mm、0.03°）。
- 單一檔案也能拿 `.tri`：`GET /v1/jobs/{job_id}/files/{path}?format=tri`（只限 `.ply`、`.stl`，其他回 422）。

## 問題回報：`issues`

job 狀態有一個 `issues` 列表（2026-11-02 起，兩台都有），列出服務自己檢查到的分牙與生成問題。發現問題時 job 不會停下來，會照常跑完；要怎麼顯示、要不要擋下這筆結果，由呼叫端決定。

- **分牙做完就有分牙的問題**：`state` 變成 `generating` 時，`issues` 裡已經有 `stage: "segment"` 的項目，不必等整筆跑完。要放棄這筆，可以直接 `DELETE`。
- `start=generate` 用自己的牙冠時，同樣的分牙檢查會在生成前跑一次。
- 生成做完後，會加上 `stage: "generate"` 的項目。用 `/run` 重跑某一步時，那一步的項目會重算、取代舊的。
- 每筆 `error` 和 `warning` 也會以 `[代碼] 顎: 說明` 的格式加進 `warnings`，只讀 `warnings` 的程式不用改。
- 檢查只看分牙結果的幾何，和用哪個程式分牙無關；兩顎合計不到 1 秒。

每一筆的欄位：

| 欄位 | 內容 |
|---|---|
| `code` | 固定的英文代碼（見下表），程式用它判斷 |
| `level` | `error`：幾乎確定有錯；`warning`：可能有錯，請看一下；`info`：提醒，不一定是錯 |
| `stage` | `segment` 或 `generate` |
| `jaw` | `upper`、`lower`；和兩顎都有關時是 null |
| `teeth` | 相關的 FDI 牙位（服務標的號碼） |
| `message` | 中文說明，可以直接顯示 |
| `details` | 數字依據（寬度、高度、重疊體積……），各代碼不同 |

範例（Case 6）：

```json
{"code": "seg.merged", "level": "error", "stage": "segment", "jaw": "upper", "teeth": [25, 26],
 "message": "26 寬 21.2 mm，約一般 26 的 1.8 倍，像兩顆牙被分成同一顆（25 沒有分到）",
 "details": {"width_mm": 21.2, "typical_mm": 11.7}}
```

代碼：

| `code` | `level` | 意思 | `details` |
|---|---|---|---|
| `seg.merged` | error | 這顆的寬度像兩顆牙：兩顆牙冠被分成同一個號碼。`teeth` 是這顆和沒分到的鄰牙 | `width_mm`、`typical_mm` |
| `seg.number` | error 或 warning | 依牙寬和牙弓上的順序，這幾顆的號碼比較像另一組。最常見的是缺牙（例如拔掉的 15）時沒有跳號，臼齒被標成 15、16 | `suggested`（每顆建議的號碼；兩個號碼表示可能是兩顆黏在一起）、`extra_cost`（號碼不合的程度，越大越確定；≥ 10 時是 error）、`widths_mm`、`scale`（這位病人的牙比平均大多少） |
| `seg.order` | error | 號碼順序和牙弓上的位置不一致 | `arch_order`（沿牙弓實際的排列） |
| `seg.boundary_on_crown` | error | 相鄰兩顆的分界線越過牙冠的咬合面，不是在接觸點分開：一顆牙被切成兩半，或一顆長到鄰牙上 | `below_higher_top_mm`、`above_lower_top_mm` |
| `seg.unlabelled_tooth` | warning | 兩顆之間有空隙，但那裡的牙齦和牙冠差不多高：可能有一顆牙沒分到 | `gap_mm`、`below_crown_top_mm` |
| `seg.pieces` | warning | 同一個號碼分成好幾塊 | `pieces_mm2` |
| `seg.small` | warning | 牙冠太小，可能是碎片 | `area_mm2` |
| `seg.few_teeth` | warning | 一顎分到的牙少於 6 顆 | `n_teeth` |
| `seg.space` | info | 兩顆之間有一顆牙大小的空隙（缺牙或拔牙的空間） | `gap_mm`、`below_crown_top_mm` |
| `input.not_in_bite` | warning | 兩顎的咬合方向不平行 | `cos_occlusal_dirs` |
| `input.jaws_reposed` | info | 兩顎朝同一邊，上顎已擺到估計的咬合位置 | |
| `seg.engulfed` | error | 生成後：生成的牙長到鄰牙的位置，已用鄰牙切開，多半是分牙錯。`stage` 是 `generate` | `cut`、`neighbour`、`overlap_mm3` |
| `gen.failed` | error | 有牙冠，但沒有生成整顆牙 | `why` |
| `gen.crown_not_fitted` | warning | `crown=fit` 或 `exact`：這顆的牙冠沒能貼到口掃上 | `why` |
| `gen.generated_root` | info | `root=virtual`：做不出虛擬牙根，改接 AI 生成的牙根 | |
| `gen.overlap_left` | warning | 推開鄰牙後仍有重疊 | `overlap_mm3` |

之後可能會增加新的代碼。遇到不認得的代碼，請照它的 `level` 處理、顯示 `message`。

### 分牙檢查怎麼判斷、準確度如何

- **牙寬**：每顆牙沿牙弓的寬度，先除以這位病人整體的牙齒大小，再和每種牙的平均寬度比。各種牙寬度的離散程度，是用技師分好的牙實際量的（3–10%）。
- **號碼**：把整排牙依牙弓順序重新編一次號，允許缺牙跳號、也允許一塊是兩顆黏在一起，找出最合理的一組，再比較每顆牙用服務的號碼要多付多少代價。
- **分界線**：真正的鄰接面，分界線至少比較高那顆的牙冠頂低 1.1 mm；被切成兩半的牙，分界線會到牙冠頂附近。
- **空隙**：缺牙處的牙床，至少比牙冠頂低 2 mm；有牙沒分到時，空隙裡的牙齦會和牙冠一樣高。

**驗證**（裁判是技師，不是這個檢查本身）：嘉義主機上有一批 CBCT 牙根萃取的設計案例，裡面有原始口掃，以及技師分好、標了 FDI 的每顆牙。用服務的 AI 分牙跑這些口掃，再逐點和技師的牙比對，就知道 AI 哪裡真的分錯或標錯。可用的有 53 例；另有 17 例技師的牙不在口掃的座標系，沒有使用。門檻只用其中 33 例訂，訂好後固定，再拿另外 20 例測：

| | 訂門檻用的 33 例 | 沒看過的 20 例 |
|---|---|---|
| AI 真的分錯或標錯的顎 | 20 顎（共 65 處） | 19 顎（共 65 處） |
| `error` 標到的顎 | 17 顎（85%） | 15 顎（79%） |
| `error` 抓到的錯處 | 58 處（89%） | 55 處（85%） |
| `error` 的誤報（AI 分牙上，標到沒有錯的牙） | 0 | 0 |
| 技師分好的牙拿來檢查，`error` 的誤報 | 59 顎中 1 個 | 34 顎中 0 個 |

AI 最常見的錯，是有牙拔掉或缺牙時沒有跳號：例如拔掉 15、25 後，臼齒被標成 15、16、17（應為 16、17、18）。這類錯在兩組裡都佔八成以上。

8 個測試病例：Case 6 的兩個錯都以 `error` 回報。另外 Case 8 上顎報了 `seg.number`（標成 15 的那顆寬 12.1 mm，是臼齒的寬度），Case 5 下顎報了 `seg.unlabelled_tooth`（35 與 37 之間），這兩筆還沒有人確認對錯。其餘 5 例沒有 `error` 或 `warning`。

**看不出來的錯**：

- 寬度差不多的牙互相標錯：47／48、16／17、下顎門牙 31／32、上顎 12／13，以及 14／15。
- 牙弓最後面那顆臼齒整顆沒分到（後面沒有鄰牙可以比）。
- 31 和 41 左右對調（目前沒有可靠的中線）。
- 留存的乳臼齒寬度像大臼齒，會被當成號碼錯，以 `seg.number` 的 warning 回報。

## 錯誤碼與限制

服務自己的錯誤都回 JSON `{"detail": "…"}`；Cloudflare 擋下的是 HTML 頁面。

| 狀態碼 | 代表 | 怎麼處理 |
|---|---|---|
| 403 | Cloudflare：沒帶或帶錯 Service Token，或用了預設 User-Agent（error code: 1010） | 檢查三個 header |
| 404 | job 不存在：已刪除、已過 2 小時，或服務重新啟動過 | 重新上傳 |
| 409 | job 還在跑（不能下載 zip、刪除或重跑），或重跑的前一步還沒有結果；送標記給 `seg=toothroot` 或沒有口掃的 job | 等 job 結束再做 |
| 413 | 上傳太大（Cloudflare 上限 100 MB） | 先 gzip |
| 422 | 參數或檔案不對：缺一顎、不支援的副檔名、讀不出檔案、`res`／`seg`／`until`／`root_fix`／`crown`／`root` 的值不對、`root=none` 搭配 `start=align` 或 `step=align`、`contents`／`format` 的值不對、標記和口掃對不上（見「精簡包」） | 看 `detail` |
| 429 | 已經有 4 個 job 在跑或排隊 | 稍後再送，或改送另一台 |
| 500 | 服務內部錯誤 | 把 `job_id` 與時間告訴我們 |
| 503 | `/health`：GPU 或模型檔不可用 | 改送另一台 |

job 本身失敗（`state` 是 `failed`）仍然回 200，原因在 `error` 與 `log_tail`。最常見的是分牙沒分出牙來（口掃解析度太低、不是原始口掃、兩顎放反），後面的步驟就沒有東西可做。

限制：

- 每台一次只跑一個 job，其他的排隊。GPU 和公司正式的牙冠服務共用，請不要同時送一大批。
- job 結束 2 小時後自動刪除，最多保留 20 個。
- 口掃要是原始解析度的上下顎口掃；只有約 1.2 萬面的減面檔用 `seg=ssm` 只會分到幾顆牙，要改用 `seg=toothroot`。
- 檔名會記在 job 裡（`inputs`），請用不含病人姓名的檔名。

速度（一筆 27–28 顆牙的全口，服務端時間；經 Cloudflare 再加上傳與輪詢約 5–10 秒；下載另計：整包 zip 約 69 MB、精簡包約 7 MB）：

| 設定 | 嘉義 RTX 5090 | 台中 RTX 5080 |
|---|---|---|
| `seg=ssm`，預設（`crown=fit`、`root=virtual`、`root_fix=1`，含排牙） | Case 1（`res=128`）83 秒（生成牙根加快前 128 秒；`res=192` 加快前 135 秒） | Case 1（`res=128`）127 秒（加快前 187 秒） |
| `seg=ssm`，預設，`until=generate`（只分牙＋生成牙齒，不排牙） | Case 1（`res=128`）120 秒 | 未量（少掉的排牙這一步約 16 秒） |
| `seg=ssm`，`crown=fit`，`root=none`（不排牙） | Case 1（`res=192`）115 秒 | 未量 |
| `seg=ssm`，`crown=exact`，`root=virtual`／`none` | Case 1（`res=192`）`virtual` 145 秒、`none` 116 秒；接牙冠這一步比 `fit` 少約 6–7 秒（每筆時間的差異主要來自生成牙根本身的起伏） | 未量 |
| `seg=ssm`，`crown=exact`，`root=generated` | 比 `crown=zhu` 每筆多 11–38 秒 | 未量 |
| `seg=ssm`，`crown=zhu`，`root=generated`（2026-11-01 以前的預設） | 121–138 秒 | 185 秒 |
| 同上，`root_fix=0` | 87–102 秒 | 約 141 秒 |
| `seg=toothroot` | 未量 | 約 50–60 秒 |
| `start=generate`（牙根＋排牙；以下三列是舊預設 `crown=zhu` 量的，新預設多接牙冠這一步約 20–30 秒） | 100 秒 | 約 145 秒 |
| `start=generate`，`until=generate`（只有牙根） | 約 90 秒 | 132 秒 |
| `start=align`（只有排牙） | 10–14 秒 | 16 秒 |

2026-11-02 傍晚生成牙根這一步加快後，只重量了第一列（Case 1 的生成牙根：嘉義 74 → 31 秒，台中 113 → 58 秒）；其他列是加快前量的，有生成牙根的設定應該也會變快，但沒有量。

## 範例程式

Python（先檢查哪一台可用，`pip install requests`），一筆病例從上傳到刪除。Service Token 從環境變數讀，不要寫死在程式裡。

```python
import gzip, os, time, requests

# 兩台主機，各自的 Service Token 從環境變數讀；嘉義優先、台中備援。
HOSTS = [
    ("https://ezai2.inteware.com.tw/toothssm", "CHIAYI"),
    ("https://ezai.inteware.com.tw/toothssm", "TAICHUNG"),
]

def headers(tag):
    return {"CF-Access-Client-Id": os.environ[f"{tag}_CF_CLIENT_ID"],
            "CF-Access-Client-Secret": os.environ[f"{tag}_CF_CLIENT_SECRET"],
            "User-Agent": "ortho-team-test/1.0"}

def pick_host():
    for base, tag in HOSTS:
        try:
            r = requests.get(f"{base}/health", headers=headers(tag), timeout=10)
            if r.status_code == 200 and r.json().get("status") == "ok":
                return base, headers(tag)
        except requests.RequestException:
            pass
    raise RuntimeError("兩台都不能用")

def gz(path):
    with open(path, "rb") as f:
        return gzip.compress(f.read(), compresslevel=6)

BASE, H = pick_host()          # job 之後的每個請求都用同一台

# 1. 上傳（檔名的副檔名決定格式：.stl/.ply/.obj/.tri，可加 .gz）
r = requests.post(f"{BASE}/v1/jobs", headers=H, timeout=300,
                  files={"upper": ("upper.stl.gz", gz("upper.stl")),
                         "lower": ("lower.stl.gz", gz("lower.stl"))},
                  data={"seg": "ssm", "res": "128"})   # 另可送 "crown"（fit／exact／zhu）、"root"（virtual／generated／none），不排牙加 "until": "generate"
r.raise_for_status()
job = r.json()["job_id"]

# 2. 輪詢
while True:
    s = requests.get(f"{BASE}/v1/jobs/{job}", headers=H, timeout=60).json()
    if s["state"] in ("done", "failed"):
        break
    time.sleep(3)
print(s["state"], s["error"], s["timings"])
for i in s.get("issues", []):           # 分牙與生成的問題（見「問題回報」）
    print(i["level"], i["code"], i["jaw"], i["teeth"], i["message"])

# 3. 下載：精簡包（約 7 MB；整包 zip 就不帶 params），或照 results 裡的路徑一個一個拿
if s["state"] == "done":
    z = requests.get(f"{BASE}/v1/jobs/{job}/archive", params={"contents": "slim"}, headers=H, timeout=600)
    open(f"toothssm-{job}-slim.zip", "wb").write(z.content)
    for t in s["results"]["aligned"]:          # 排牙後的每顆牙（until=generate、root=none 沒有排牙：改用 results["teeth"]）
        url = f"{BASE}/v1/jobs/{job}/{t['url']}"   # t['url'] 是 files/... 開頭的相對路徑
        open(f"aligned_{t['jaw']}_{t['fdi']}.ply", "wb").write(
            requests.get(url, headers=H, timeout=120).content)
    axes = s["results"].get("axes")            # root=virtual／none：{"11": {"origin", "x", "y", "z", "apex", "matrix"}, ...}

# 4. 刪除
requests.delete(f"{BASE}/v1/jobs/{job}", headers=H, timeout=60)
```

curl：

```bash
# 嘉義；台中備援時把 B 換成 https://ezai.inteware.com.tw/toothssm，token 換台中那組
H=(-H "CF-Access-Client-Id: $CF_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" -A "ortho-team-test/1.0")
B=https://ezai2.inteware.com.tw/toothssm

curl -s "${H[@]}" $B/health
curl -s "${H[@]}" -F upper=@upper.stl.gz -F lower=@lower.stl.gz -F seg=ssm $B/v1/jobs
curl -s "${H[@]}" -F upper=@upper.stl.gz -F lower=@lower.stl.gz -F until=generate $B/v1/jobs   # 只分牙＋生成牙齒，不排牙
curl -s "${H[@]}" -F step=align $B/v1/jobs/<job_id>/run                                      # 之後再用同一筆的牙齒排牙
curl -s "${H[@]}" -F upper=@upper.stl.gz -F lower=@lower.stl.gz -F root=none $B/v1/jobs   # 只回牙冠＋牙軸，不排牙（牙冠預設 crown=fit；要口掃原樣加 -F crown=exact）
curl -s "${H[@]}" $B/v1/jobs/<job_id>
curl -s "${H[@]}" -o result.zip $B/v1/jobs/<job_id>/archive
curl -s "${H[@]}" -o result-slim.zip "$B/v1/jobs/<job_id>/archive?contents=slim"           # 精簡包
curl -s "${H[@]}" -X DELETE $B/v1/jobs/<job_id>
```

requests 會自動解開服務端的 gzip 回應；用 curl 下載單一檔案時加 `--compressed` 會比較快。

## 附錄：C++ 讀取精簡包（trimp_read.cpp）

「精簡包」一節的讀取範例全文（也可以從 eztest 下載 [trimp_read.cpp](/docs/toothssm/trimp_read.cpp)）。只需要 zlib；`.tri` 與 `.trimp` 都是 little-endian。

```cpp
// Reading tooth_ssm's slim archive in C++: scan/<jaw>.tri + labels/<jaw>.trimp -> which tooth each face is.
//
//     g++ -std=c++17 -O2 trimp_read.cpp -lz -o trimp_read
//     ./trimp_read scan/upper.tri labels/upper.trimp [tooth_11.obj 11]
//
// Prints the label counts after checking that the labels belong to this scan (face count and
// fingerprint), and optionally writes the faces of one label (an FDI, or 0 for the gum) as an OBJ.
// Needs only zlib. The formats are specified in deploy/trimp.py (TRIMP v1) and deploy/slim.py (.tri V1);
// both are little-endian, as is every machine this is likely to run on.
#include <zlib.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

static std::vector<uint8_t> read_file(const char* path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error(std::string("cannot open ") + path);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

template <class T> static T get(const std::vector<uint8_t>& b, size_t at) {
    if (at + sizeof(T) > b.size()) throw std::runtime_error("file is truncated");
    T v;
    std::memcpy(&v, b.data() + at, sizeof(T));
    return v;
}

// ---------------------------------------------------------------- .tri V1
struct Mesh {
    std::vector<float> v;      // 3 per vertex
    std::vector<uint32_t> f;   // 3 per face
};

static Mesh read_tri(const std::vector<uint8_t>& b) {
    uint32_t nv = get<uint32_t>(b, 0), nf = get<uint32_t>(b, 4);
    if (8 + 12ull * nv + 12ull * nf > b.size()) throw std::runtime_error("not a .tri V1 file, or truncated");
    Mesh m;
    m.v.resize(3ull * nv);
    m.f.resize(3ull * nf);
    std::memcpy(m.v.data(), b.data() + 8, 12ull * nv);
    std::memcpy(m.f.data(), b.data() + 8 + 12ull * nv, 12ull * nf);
    for (uint32_t i : m.f)
        if (i >= nv) throw std::runtime_error("a face uses a vertex the file does not have");
    return m;
}

// ---------------------------------------------------------------- SHA-256 (for the fingerprint)
struct Sha256 {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint8_t buf[64];
    size_t used = 0;
    uint64_t total = 0;
    static uint32_t ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void block(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) w[i] = uint32_t(p[4 * i]) << 24 | uint32_t(p[4 * i + 1]) << 16 | uint32_t(p[4 * i + 2]) << 8 | p[4 * i + 3];
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t t1 = hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            uint32_t t2 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    void add(const void* data, size_t n) {
        const uint8_t* p = static_cast<const uint8_t*>(data);
        total += n;
        while (n) {
            size_t take = std::min(n, sizeof(buf) - used);
            std::memcpy(buf + used, p, take);
            used += take; p += take; n -= take;
            if (used == 64) { block(buf); used = 0; }
        }
    }
    std::array<uint8_t, 32> done() {
        uint64_t bits = total * 8;
        uint8_t pad = 0x80, zero = 0;
        add(&pad, 1);
        while (used != 56) add(&zero, 1);
        uint8_t len[8];
        for (int i = 0; i < 8; ++i) len[i] = uint8_t(bits >> (56 - 8 * i));
        add(len, 8);
        std::array<uint8_t, 32> out;
        for (int i = 0; i < 8; ++i)
            for (int j = 0; j < 4; ++j) out[4 * i + j] = uint8_t(h[i] >> (24 - 8 * j));
        return out;
    }
};

// The scan's fingerprint: SHA-256 over its triangle corners as float32, face by face, corners in
// stored order (36 bytes a face), first 8 bytes. -0.0 counts as +0.0 (the server writes +0.0).
static std::array<uint8_t, 8> fingerprint(const Mesh& m) {
    Sha256 s;
    for (size_t i = 0; i < m.f.size(); ++i) {     // every corner of every face, in order
        float c[3];
        for (int k = 0; k < 3; ++k) c[k] = m.v[3ull * m.f[i] + k] + 0.0f;
        s.add(c, sizeof c);
    }
    auto full = s.done();
    std::array<uint8_t, 8> fp;
    std::memcpy(fp.data(), full.data(), 8);
    return fp;
}

// ---------------------------------------------------------------- TRIMP v1
static std::vector<uint8_t> read_trimp(const std::vector<uint8_t>& b, const Mesh& scan) {
    if (b.size() < 32 || std::memcmp(b.data(), "TRMP", 4) != 0) throw std::runtime_error("not a TRIMP file");
    uint8_t version = b[4], element = b[5], codec = b[7];
    uint32_t count = get<uint32_t>(b, 8), plen = get<uint32_t>(b, 20), crc = get<uint32_t>(b, 24);
    if (version != 1) throw std::runtime_error("TRIMP version " + std::to_string(version) + "; this reader knows 1");
    if (element != 0) throw std::runtime_error("labels are per vertex; this example reads per-face labels");
    if (count != scan.f.size() / 3)
        throw std::runtime_error("labels are for a scan of " + std::to_string(count) + " faces, this one has " +
                                 std::to_string(scan.f.size() / 3));
    if (std::memcmp(b.data() + 12, fingerprint(scan).data(), 8) != 0)
        throw std::runtime_error("labels are for another scan (fingerprint differs)");
    if (32ull + plen > b.size()) throw std::runtime_error("TRIMP payload is truncated");
    std::vector<uint8_t> labels(count);
    if (codec == 1) {
        uLongf n = count;
        if (uncompress(labels.data(), &n, b.data() + 32, plen) != Z_OK || n != count)
            throw std::runtime_error("TRIMP payload does not inflate to the declared count");
    } else if (codec == 0) {
        if (plen != count) throw std::runtime_error("TRIMP stored payload has the wrong length");
        std::memcpy(labels.data(), b.data() + 32, count);
    } else {
        throw std::runtime_error("unknown TRIMP codec");
    }
    if (crc32(0L, labels.data(), count) != crc) throw std::runtime_error("TRIMP labels fail their CRC-32");
    // Chunks after the payload (tag, uint32 length, data) are optional; skipping them is always allowed.
    return labels;
}

int main(int argc, char** argv) {
    if (argc != 3 && argc != 5) {
        std::fprintf(stderr, "usage: %s scan.tri labels.trimp [out.obj LABEL]\n", argv[0]);
        return 2;
    }
    try {
        Mesh scan = read_tri(read_file(argv[1]));
        std::vector<uint8_t> labels = read_trimp(read_file(argv[2]), scan);
        std::map<int, size_t> n;
        for (uint8_t l : labels) ++n[l];
        std::printf("%zu faces, fingerprint checked\n", labels.size());
        for (auto& [l, c] : n)
            std::printf("  %s %d: %zu faces\n", l == 0 ? "gum" : l == 254 ? "none" : "tooth", l, c);
        if (argc == 5) {
            int want = std::stoi(argv[4]);
            std::vector<int64_t> remap(scan.v.size() / 3, -1);
            std::vector<uint32_t> verts;
            std::string faces;
            for (size_t i = 0; i < labels.size(); ++i) {
                if (labels[i] != want) continue;
                faces += "f";
                for (int k = 0; k < 3; ++k) {
                    uint32_t v = scan.f[3 * i + k];
                    if (remap[v] < 0) { remap[v] = int64_t(verts.size()); verts.push_back(v); }
                    faces += " " + std::to_string(remap[v] + 1);
                }
                faces += "\n";
            }
            std::FILE* o = std::fopen(argv[3], "w");
            if (!o) throw std::runtime_error("cannot write the OBJ");
            for (uint32_t v : verts) std::fprintf(o, "v %.9g %.9g %.9g\n", scan.v[3ull * v], scan.v[3ull * v + 1], scan.v[3ull * v + 2]);
            std::fputs(faces.c_str(), o);
            std::fclose(o);
            std::printf("label %d: %zu vertices -> %s\n", want, verts.size(), argv[3]);
        }
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
    return 0;
}
```
