# 牙冠設計 API 串接說明

文件版本：2026-11-04（新增咬合面細節 `occlusal_detail=1`，目前只有嘉義；2026-11-03 新增 HeyGears 牙冠模型 `crown_model=heygears`，也只有嘉義）。每次 API 更新的內容，見同一處的「更新內容」（changelog.md）。

上傳一組上下顎口掃和要做牙冠的牙位（FDI），服務會自動擺正口掃、預測 margin（也可以用你畫好的 margin）、生成牙冠，最後回傳一個 zip。這是非同步 API：上傳後立刻拿到 `job_id`，再輪詢結果。嘉義、台中兩台主機提供同一個 API、互為備援；一個 job 在服務端約 3–8 秒。

## 連線與認證

| 端點 | 基底網址 | `crown_model=heygears` | `occlusal_detail` |
|---|---|---|---|
| 嘉義（RTX 5090） | `https://ezai2.inteware.com.tw/pipeline` | 有（2026-11-03 起） | 有（2026-11-04 起） |
| 台中（RTX 5080） | `https://ezai.inteware.com.tw/pipeline` | **還沒有**：送了不會報錯，拿到的是 v3 牙冠（見「牙冠模型」） | **還沒有**：送了不會報錯，牙冠沒有補細節（見「咬合面細節」） |

兩台各用一組 Service Token（兩個 Cloudflare Access 應用）。每個請求都要帶下面三個 header，缺一個就會被 Cloudflare 擋下。

| Header | 值 | 說明 |
|---|---|---|
| `CF-Access-Client-Id` | 那台主機 Service Token 的 Client ID | 另外提供，不寫在文件裡 |
| `CF-Access-Client-Secret` | 那台主機 Service Token 的 Client Secret | 另外提供，不寫在文件裡；只放在伺服器端，不要放進瀏覽器程式 |
| `User-Agent` | 自訂字串，例如 `heygears-integration/1.0` | 程式語言預設的 UA（例如 `Python-urllib/3.x`）會被 Cloudflare 直接回 403 error code: 1010 |

- 沒帶憑證和帶錯憑證都回同一個 403 頁面，所以 403 只代表請求有送到 Cloudflare，不代表網址錯。驗證連線請用 `GET /health`，拿到 200 才算通。
- Cloudflare 的上限：一個請求的 body 最大 100 MB，一個請求最長約 100 秒。所以上傳後要用輪詢等結果，不能開著連線等。
- 口掃建議先 gzip 再上傳（檔名加 `.gz`），或用公司的 `.tri` 格式：同一份口掃的 `.tri.gz` 約只有 STL 的四分之一大；從台中辦公室經 Cloudflare 上傳，22 MB 的 STL 約 8 秒，`.tri.gz` 約 3 秒。

## 使用流程

一顆牙冠就是一個 job，走四步：

1. `POST /v1/jobs` 上傳上下顎口掃與牙位，立刻回 202 與 `job_id`。
2. 每 1–2 秒 `GET /v1/jobs/{job_id}`，直到 `status` 是 `succeeded` 或 `failed`。進行中是 `queued`（排隊，`queue_position` 是前面還有幾筆）→ `running`（`stage` 是正在跑的步驟：`jaw` 擺正、`margin` 預測 margin、`crown` 生成牙冠、`packaging` 打包等）。
3. `GET /v1/jobs/{job_id}/result` 下載結果 zip（見「結果 zip」）。
4. `DELETE /v1/jobs/{job_id}`。口掃是病人資料，用完就刪；沒刪的話，job 結束 1 小時後自動刪除，做完的 job 超過 200 個時最舊的會先被清掉。

- 一顆牙一個 job。同一顎有好幾顆備牙時，每顆各送一個 job，並在 `all_tooth_numbers` 填整顎的備牙牙位（幫助 margin 模型分辨）。
- 上傳的口掃在 job 做完後就刪除，主機上只留結果 zip 與狀態。
- 每台同時跑 8 個 job，最多 100 個排隊。呼叫端同時保持大約 8 個 job 在跑，整體最快。

## 端點一覽

下表的路徑都接在基底網址後面，兩台完全相同。

| 方法 | 路徑 | 做什麼 | 成功時回傳 |
|---|---|---|---|
| POST | `/v1/jobs` | 建立 job（multipart/form-data） | 202，job 狀態 JSON（含 `job_id`） |
| GET | `/v1/jobs/{job_id}` | 狀態、每步耗時、警告、錯誤 | 200 JSON |
| GET | `/v1/jobs/{job_id}/result` | 結果 zip（job 還沒成功時回 409） | 200 zip |
| DELETE | `/v1/jobs/{job_id}` | 刪除 job 與結果 | 204 |
| GET | `/health` | 服務和它後面三個 AI 服務是否都可用、排隊數 | 200；有一個連不上時 503 |
| GET | `/` | 這台收哪些口掃格式、壓縮格式、認得哪些選項（`options`） | 200 JSON |

## 建立 job 的參數

`POST /v1/jobs` 是 multipart/form-data。下表是**表單欄位**：

| 欄位 | 類型 | 預設 | 說明 |
|---|---|---|---|
| `upper_stl` | 檔案 | — | 上顎口掃。格式看檔名的副檔名：`.stl`、`.ply`、`.obj`、`.tri`（公司格式 V1、V2），都可以再加 `.gz`，例如 `upper.tri.gz`。欄位名稱雖然是 `_stl`，四種格式都收 |
| `lower_stl` | 檔案 | — | 下顎口掃，格式同上 |
| `fdi` | 文字（必填） | — | 要做牙冠的牙位，兩位數 FDI（11–48） |
| `mode` | `full`、`margin_only`、`margin_override` | `full` | `full`：預測 margin 再生成牙冠。`margin_only`：只預測 margin，不生成牙冠。`margin_override`：用你上傳的 `margin_pts`，不跑 margin 模型 |
| `margin_pts` | 檔案 | — | `mode=margin_override` 時必填，其他模式送了會回 422。`.pts`（`BEGIN_<FDI>`、每行 `x y z`、`END_<FDI>`）、`.json`（`[[x,y,z], …]`，或之前 job 的 `margin.json`）或 `.txt`，可以再加 `.gz`。座標要和一起上傳的口掃同一個座標系 |
| `all_tooth_numbers` | 文字，例如 `14,15` | 空白 | 同一顎所有備牙的牙位（含這一顆），給 margin 模型參考；單顆可留白。`margin_override` 時沒有作用 |
| `single_arch` | `true`、`false` | `false` | 只送備牙那一顎（另一顎的欄位要留空，送了會回 422）。對咬用鄰牙高度的平面代替，咬合面不是照真實咬合做的，每顆都會有一則警告 |
| `contact_fit` | `true`、`false` | `true` | 牙冠穿進鄰牙的那面牆整平、往回推最多 0.3 mm；推完還重疊的留給編修並發警告。`false` 回傳模型原樣 |
| `contralateral` | `true`、`false` | `false` | 只對前牙（牙位第二碼 1–3）：形狀擬合另一側的同名牙，每顆約多 2 秒。不適用時不套用，原因寫在 `warnings` |
| `no_abutment` | `true`、`false` | `false` | 還沒有支台齒的位置（例如植體）：要搭配 `mode=margin_override`。服務放一個虛擬支台齒再生成牙冠，多回傳 `virtual_prep.ply`；**牙冠只用外表面** |
| `stump_height_mm`、`stump_shoulder_mm` | 數字 | 服務決定 | 只能和 `no_abutment=true` 一起送：虛擬支台齒的高度（1.0–6.0）與肩台寬（0.3–1.5） |
| `upper_stl_url`、`lower_stl_url`、`margin_pts_url` | https 網址 | — | 用網址代替上傳（例如 S3 的 presigned URL），每個欄位只能二選一。格式看網址**路徑**的副檔名（例如 `…/upper.tri.gz?X-Amz-…`）；目前只收 `amazonaws.com` 的網址、每個檔案最大 200 MB，要用別的儲存空間請先跟我們說 |

下表是**網址參數**（接在 `/v1/jobs?` 後面，**不是表單欄位**；放在表單裡會被忽略）：

| 參數 | 值 | 預設 | 說明 |
|---|---|---|---|
| `crown_model` | `heygears` | 不帶＝v3 | 用哪個牙冠模型，見下一節。**目前只有嘉義認得** |
| `occlusal_clearance` | −0.3–1.0（mm） | 不帶＝不另外留 | 牙冠咬合面和對咬牙之間至少留這個距離，由牙冠服務在生成後調整。HeyGears 建議 `0.2`。兩台都有 |
| `occlusal_detail` | 0–2 | 不帶＝不補 | 生成後沿窩溝往下挖深，補回模型磨平的咬合面細節；`1` 是建議值。只對小臼齒、大臼齒，見「咬合面細節」。**目前只有嘉義認得** |
| `job_id` | 英數字、`_`、`.`、`-`，最多 64 字 | 服務產生 | 自訂 job id，方便追蹤。**要保證不重複**：重複的 id 會蓋掉同名的 job |

其他網址參數（`res`、`steps`、`guide`、`frame`、`chamfer`、`shell`、`contact_clearance`、`jaw_samples`）是模型的內部設定，請維持預設；改了以後，結果就和其他客戶的不一樣。

## 牙冠模型：`crown_model`

| | 不帶（`default`，v3） | `heygears` |
|---|---|---|
| 是什麼 | 所有客戶目前用的模型 | v3 再用 HeyGears 技師的 exocad 牙冠訓練（186 例，加上 v3 原本的訓練資料），學 HeyGears 的牙冠風格 |
| 牙位 | 全部 | **只有小臼齒、大臼齒**（牙位第二碼 4–7）。前牙、犬齒、智齒帶了 `heygears` 也會用 v3 生成，並在 `warnings` 註明 |
| 建議一起送 | — | `occlusal_clearance=0.2`：HeyGears 的牙冠和對咬牙通常留約 0.2 mm，模型自己學不到 |
| 哪台有 | 兩台 | 嘉義（2026-11-03 起）；台中之後再上 |

HeyGears 的呼叫要像這樣（網址參數）：

```
POST https://ezai2.inteware.com.tw/pipeline/v1/jobs?crown_model=heygears&occlusal_clearance=0.2
```

**怎麼確認真的用了 HeyGears 模型**：

- 結果 zip 裡 `manifest.json` 的 `backends.crown.model` 是 `heygears`。前牙等沒學過的牙位是 `default`，同時 `warnings` 有一則 `crown_model: asked for 'heygears', the crown service used 'default'`。
- 名稱打錯（例如 `heygear`）時 job 會失敗（`status` 是 `failed`），`error` 是 `crown generation failed: unknown model 'heygear'; this server has default, heygears`。
- **台中還不認得這個參數：不會報錯、沒有警告，`manifest.json` 也沒有 `backends.crown.model`，拿到的是 v3 牙冠。** 所以 HeyGears 的 job 請先只送嘉義；要寫成兩台通用，就先看 `GET /` 回傳的 `options` 有沒有 `crown_model`，並在結果裡檢查 `backends.crown.model`。

**效果**（第二批 75 例 HeyGears 病例，沒有參與訓練，和 HeyGears 技師的牙冠比；一次一個請求）：

| | v3 | HeyGears | HeyGears＋0.2 mm |
|---|---|---|---|
| 形態誤差（去掉大小差異，mm） | 0.214 | 0.181（少 15%，83% 的病例變好） | 0.181 |
| 咬進對咬牙的病例 | 36 / 75 | 30 / 75 | 10 / 75 |
| 牙冠服務每顆秒數 | 2.61 | 2.48 | 2.85 |

- 形態差最多的是鄰接面（0.182 → 0.148 mm）、咬合面（0.252 → 0.215 mm）、頰舌面（0.185 → 0.161 mm）。
- 近心鄰接區的高度補上和 HeyGears 之間 77% 的差距；頰舌側外形的凸出量這批沒有改善。

## 咬合面細節：`occlusal_detail`

模型生成的牙冠，咬合面最細的起伏（例如窩溝底的 V 形）比技師設計的平滑。`occlusal_detail=1` 讓牙冠服務在生成後把它補回來。

| | |
|---|---|
| 做什麼 | 沿窩溝、窩往下挖深；挖多少，依技師牙冠量出的「模型平均磨掉多少」 |
| 不動的地方 | 牙尖、接觸點、外壁、邊緣。只往下挖，所以不會更靠近對咬牙，`occlusal_clearance` 照樣有效 |
| 牙位 | 只有小臼齒、大臼齒（牙位第二碼 4–7）；其他牙位照常生成、不補，`warnings` 會註明 |
| 值 | `1`＝量出來的強度；可給 0–2（`0.5` 挖一半深、`2` 挖兩倍深）；`0` 或不帶＝不補；超出範圍或不是數字回 422 |
| 模型 | v3、`heygears` 都可以 |
| 哪台有 | 嘉義（2026-11-04 起）；台中之後再上 |
| 時間 | 每顆約多 0.1 秒 |

HeyGears 的呼叫要像這樣（網址參數）：

```
POST https://ezai2.inteware.com.tw/pipeline/v1/jobs?crown_model=heygears&occlusal_clearance=0.2&occlusal_detail=1
```

**怎麼確認有補**：

- 結果 zip 裡 `manifest.json` 的 `backends.crown.occlusal_detail` 是 `applied`；`backends.crown.occlusal_detail_info` 有 `deepest_mm`（最深挖了幾 mm）、`mean_mm`（平均）、`moved`（動了幾個頂點）、`seconds`。
- 不是 `applied` 時 `warnings` 會有一則 `occlusal_detail: …`：`skipped: FDI 13 (premolars and molars only)` 是牙位不適用；`failed: …` 是處理失敗，回傳模型原本的牙冠，job 仍然成功。
- **台中還不認得這個參數：不會報錯、沒有警告，也沒有這兩個欄位，牙冠沒有補細節。** 要寫成兩台通用，就先看 `GET /` 回傳的 `options` 有沒有 `occlusal_detail`。

**效果**（第二批 75 例 HeyGears 病例，沒有參與訓練，和 HeyGears 技師的牙冠比；一次一個請求；中位數）：

| | HeyGears＋0.2 mm | 加 `occlusal_detail=1` | 技師 |
|---|---|---|---|
| 咬合面起伏（mm，越大越銳利） | 0.123 | 0.139（74/75 例變銳利） | 0.157 |
| 窩溝深度（mm） | 0.986 | 1.078 | 1.107 |
| 牙尖斜度 | 18.1° | 19.1° | 21.3° |
| 形態誤差（去掉大小差異，mm） | 0.181 | 0.182（47/75 例更接近技師） | — |

- v3 也一樣：起伏 0.132 → 0.148，形態不變。
- 看起來是「窩溝清楚一點」，不是大改；技師那種很細的副溝補不出來。
- 逐頂點量，沒有任何一顆更靠近對咬牙；移動量平均 0.04 mm，最深約 0.19 mm。

## 狀態回應

`GET /v1/jobs/{job_id}`（以及 `POST` 的 202 回應）是 JSON，主要欄位：

| 欄位 | 說明 |
|---|---|
| `job_id` | job 的 id |
| `status` | `queued`、`running`、`succeeded`、`failed` |
| `stage` | `running` 時正在跑的步驟；其他時候是 null |
| `queue_position` | `queued` 時前面還有幾筆 |
| `fdi`、`mode`、`arches` | 這個 job 的牙位、模式，以及收到哪幾顎（`scan` 或 `absent`） |
| `crown_params` | 送給牙冠服務的參數，包括 `model`（有帶 `crown_model` 時）、`occlusal_clearance`、`occlusal_detail` |
| `timings_ms` | 每一步的毫秒數，`total_ms` 是總計 |
| `warnings` | 警告（英文），例如單顎、margin 離口掃太遠、牙冠還和鄰牙重疊、模型改用 v3。請顯示給使用者或記錄下來 |
| `error`、`error_stage` | 失敗時的原因與哪一步 |
| `created_at`、`started_at`、`finished_at` | Unix 時間（秒） |
| `links.result` | 成功時的結果下載網址 |

## 結果 zip

| 檔案 | 座標系 | 內容 |
|---|---|---|
| `crown.ply` | **原始口掃** | 牙冠外壁（`margin_only` 沒有）：一片開口在 margin 的外表面，不含內側的黏著面 |
| `margin_original.pts` | **原始口掃** | 這次用的 margin（預測的或你上傳的） |
| `margin_canonical.pts` | 擺正後 | 同一條 margin，擺正座標 |
| `margin.json` | 兩者 | 兩條 margin 的 JSON，加上 margin 是否有效；`margin_override` 時另有你的 margin 離口掃多遠（`surface_check`，超過 0.3 mm 會警告） |
| `alignment.json` | — | 擺正用的旋轉矩陣：`p_canonical = rotation_matrix @ p_original` |
| `manifest.json` | — | 參數、每步耗時、警告，以及各 AI 服務回報的資訊（見下） |
| `virtual_prep.ply` | **原始口掃** | 只有 `no_abutment=true`：虛擬支台齒 |

回傳的牙冠和 margin 都在**你上傳的口掃的座標系**，不必另外轉換。

外壁偶爾分離不出來（第二批 75 例 HeyGears 病例：v3 2 例、HeyGears 1 例，不同病例）。這時 `crown.ply` 是**封閉的整顆牙冠**，`warnings` 有一則 `requested shell=outer but received shell=full; …`，貼合鄰牙（`contact_fit`）也會跳過並另有一則警告。請用這兩則警告判斷，不要假設 `crown.ply` 一定有開口。

`manifest.json` 裡值得讀的欄位：

- `backends.crown.model`：實際用的牙冠模型（`default` 或 `heygears`）。
- `crown_params`：送給牙冠服務的參數（含 `model`、`occlusal_clearance`、`occlusal_detail`）。
- `backends.crown.occlusal_detail`、`occlusal_detail_info`：只有帶了 `occlusal_detail` 才有；有沒有補、挖了多少（見「咬合面細節」）。
- `backends.crown.antagonist_relief`：大於 0 表示備牙的咬合空間不夠，服務把對咬往外移了這麼多 mm 才做得出牙冠，`warnings` 也會說明；這種牙冠的咬合要另外處理。
- `backends.crown.antagonist`：單顎時用的對咬替身。
- `contact_fit`：和鄰牙的重疊處理前後的數字。
- `warnings`、`timings_ms`：同狀態回應。

## 兩台備援怎麼用

- 送出前先 `GET /health`：回 200 且 `status` 是 `ok` 才送。回 503、5xx、連不上或逾時，就改用另一台。
- job 只存在收到它的那一台：輪詢、下載、刪除都要送回同一台。請把 `job_id` 和基底網址一起記下來。
- 一台在 job 進行中掛掉（輪詢一直失敗或拿到 404），那個 job 不會轉到另一台，要重新上傳到另一台。
- 兩台的程式、參數預設值、模型權重都一樣（`crown_model`、`occlusal_detail` 例外：台中還沒有）；結果不會逐位元組相同（顯示卡不同），差異只在浮點誤差的等級。
- **HeyGears 的 job 目前只能送嘉義。** 嘉義不能用時，送台中只會拿到 v3 牙冠；要等嘉義恢復，或明確接受 v3。

## 錯誤碼與限制

服務自己的錯誤都回 JSON `{"detail": …}`；Cloudflare 擋下的是 HTML 頁面。

| 狀態碼 | 代表 | 怎麼處理 |
|---|---|---|
| 403 | Cloudflare：沒帶或帶錯 Service Token，或用了預設 User-Agent（error code: 1010） | 檢查三個 header |
| 404 | job 不存在：已刪除，或已超過保留時間 | 重新上傳 |
| 409 | job 還沒成功就要下載結果 | 等 `status` 是 `succeeded` |
| 410 | 結果已經被清掉 | 重新上傳 |
| 413 | 上傳太大（Cloudflare 上限 100 MB） | 先 gzip、用 `.tri`，或改用網址傳檔 |
| 422 | 參數或檔案不對：缺一顎、不支援的副檔名、讀不出檔案、牙位不對、`margin_pts` 和 `mode` 不搭、`single_arch` 又送了對咬顎、`no_abutment` 沒有搭配 `margin_override`、`occlusal_detail` 不是 0–2 的數字 | 看 `detail` |
| 429 | 排隊已滿（100 筆） | 等 `Retry-After`（30 秒）再送，或改送另一台 |
| 503 | `/health`：後面的 AI 服務有一個連不上 | 改送另一台 |

job 本身失敗（`status` 是 `failed`）時 `GET` 仍然回 200，原因在 `error` 與 `error_stage`。

限制：

- 牙冠模型只學過有支台齒的牙；沒有支台齒的位置請用 `no_abutment=true`。
- 每個 job 只做一顆牙冠；牙橋要拆成單顆送。
- 檔名會記在 job 裡，請用不含病人姓名的檔名。

## 速度

服務端時間（嘉義，一次一個 job）：

| 模式 | 一個 job | 說明 |
|---|---|---|
| `full`（預測 margin＋牙冠） | 約 6.5–7.5 秒 | 擺正 0.4–0.7、margin 約 3、牙冠約 2.5–3、貼合鄰牙約 0.6 秒 |
| `margin_override`（用你的 margin） | 約 3–5 秒 | 不跑 margin 模型 |
| `margin_only` | 約 4 秒 | 不生成牙冠 |

- `crown_model=heygears` 和 v3 差不多快；`occlusal_clearance=0.2` 每顆約多 0.3–0.4 秒；`occlusal_detail=1` 每顆約多 0.1 秒；`contralateral=true` 每顆約多 2 秒。
- 經 Cloudflare 還要加上傳與輪詢的時間，主要看口掃大小與你的網路。

## 範例程式

Python（`pip install requests`），一顆牙冠從上傳到刪除。Service Token 從環境變數讀，不要寫死在程式裡。

```python
import gzip, io, json, os, time, zipfile, requests

BASE = "https://ezai2.inteware.com.tw/pipeline"     # HeyGears 模型目前只有嘉義
H = {"CF-Access-Client-Id": os.environ["CHIAYI_CF_CLIENT_ID"],
     "CF-Access-Client-Secret": os.environ["CHIAYI_CF_CLIENT_SECRET"],
     "User-Agent": "heygears-integration/1.0"}

def gz(path):
    with open(path, "rb") as f:
        return gzip.compress(f.read(), compresslevel=6)

# 1. 建立 job：crown_model、occlusal_clearance、occlusal_detail 是網址參數；其他是表單欄位
r = requests.post(f"{BASE}/v1/jobs", headers=H, timeout=300,
                  params={"crown_model": "heygears", "occlusal_clearance": "0.2",
                          "occlusal_detail": "1"},              # 不要補咬合面細節就拿掉這行
                  files={"upper_stl": ("upper.stl.gz", gz("upper.stl")),
                         "lower_stl": ("lower.stl.gz", gz("lower.stl")),
                         "margin_pts": ("margin.pts", open("margin.pts", "rb").read())},
                  data={"fdi": "36", "mode": "margin_override"})   # 沒有 margin：拿掉 margin_pts，mode 用 full
r.raise_for_status()
job = r.json()["job_id"]

# 2. 輪詢
while True:
    s = requests.get(f"{BASE}/v1/jobs/{job}", headers=H, timeout=60).json()
    if s["status"] in ("succeeded", "failed"):
        break
    time.sleep(1)
print(s["status"], s["error"], s["timings_ms"].get("total_ms"))
for w in s["warnings"]:
    print("warning:", w)

# 3. 下載結果，確認用了哪個模型
if s["status"] == "succeeded":
    z = requests.get(f"{BASE}/v1/jobs/{job}/result", headers=H, timeout=120)
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    crown = json.loads(zf.read("manifest.json"))["backends"]["crown"]
    print("crown model:", crown.get("model"))       # 後牙應該是 heygears；前牙等是 default
    print("occlusal detail:", crown.get("occlusal_detail"))   # 後牙應該是 applied
    open(f"crown_{job}.ply", "wb").write(zf.read("crown.ply"))

# 4. 刪除
requests.delete(f"{BASE}/v1/jobs/{job}", headers=H, timeout=60)
```

curl：

```bash
# 嘉義；台中備援時把 B 換成 https://ezai.inteware.com.tw/pipeline，token 換台中那組（台中還沒有 crown_model）
H=(-H "CF-Access-Client-Id: $CF_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" -A "heygears-integration/1.0")
B=https://ezai2.inteware.com.tw/pipeline

curl -s "${H[@]}" $B/health
curl -s "${H[@]}" $B/                                                   # options 裡有 crown_model 才認得
curl -s "${H[@]}" "$B/v1/jobs?crown_model=heygears&occlusal_clearance=0.2&occlusal_detail=1" \
  -F upper_stl=@upper.stl.gz -F lower_stl=@lower.stl.gz -F fdi=36 \
  -F mode=margin_override -F margin_pts=@margin.pts                     # HeyGears＋0.2 mm＋咬合面細節，用你的 margin
curl -s "${H[@]}" $B/v1/jobs -F upper_stl=@upper.stl.gz -F lower_stl=@lower.stl.gz -F fdi=36   # v3，AI 預測 margin
curl -s "${H[@]}" $B/v1/jobs/<job_id>
curl -s "${H[@]}" -o result.zip $B/v1/jobs/<job_id>/result
unzip -p result.zip manifest.json | python3 -c "import sys,json; print(json.load(sys.stdin)['backends']['crown'].get('model'))"
curl -s "${H[@]}" -X DELETE $B/v1/jobs/<job_id>
```
