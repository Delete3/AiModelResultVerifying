# 牙冠設計 API 串接說明

文件版本：2026-11-18 傍晚（PEEK abut 的外壁下緣也整理成一圈）。之前：2026-11-18 下午（支台齒 `mode=stump`：預設多回牙冠外壁、`outputs` 選要哪些檔、收掃描桿的位置與軸向、送回改過的支台齒重做外壁（`stump_shape=supplied`）、回報外壁厚度；外壁下緣整理成一圈）；2026-11-18 呼叫方式改以 **AI 分派器**為主，直連主機的方式移到最後一節「直連主機（舊方式）」；2026-11-18 補上支台齒 `mode=stump` 與無支台齒的 `stump_shape`；2026-11-17 台中也有 `crown_model=heygears`、`occlusal_detail`；2026-11-11 `crown_model=heygears` 換成新版模型，`occlusal_detail=1` 改上 HeyGears 咬合面紋路，舊版暫時保留為 `heygears_v1`；2026-11-04 貼合鄰牙不再留下折痕、新增 `occlusal_detail`；2026-11-03 新增 `crown_model=heygears`。每次 API 更新的內容，見同一處的「更新內容」（changelog.md）。

上傳一組上下顎口掃和要做牙冠的牙位（FDI），服務會自動擺正口掃、預測 margin（也可以用你畫好的 margin）、生成牙冠，最後回傳一個 zip。還沒有支台齒的位置（例如植體）也能做牙冠外壁（`no_abutment`），或做支台齒加上面的牙冠外壁（`mode=stump`），也能送回你們改過的支台齒重做牙冠外壁，見「無支台齒與支台齒」。

**請呼叫 AI 分派器 `https://ai.inteware.com.tw`。** 分派器把每個 job 交給有空的主機：嘉義（RTX 5090）或台中（RTX 5080）；兩台都忙到讓 job 明顯變慢時，再開雲端 GPU（Modal）一起做。你只要記一個網址，排隊、換台、出錯重做都由分派器處理。兩台主機和雲端跑的是同一版程式與模型。

直連主機的網址（`https://ezai2.inteware.com.tw/pipeline`、`https://ezai.inteware.com.tw/pipeline`）在現有呼叫端改接完成以前照常開著、行為不變，但之後只給內部用；**新的串接請不要再用**。

## 經分派器和直連主機的差別

| | 經分派器（請用這個） | 直連主機（舊方式） |
|---|---|---|
| 網址 | 一個：`https://ai.inteware.com.tw` | 嘉義、台中各一個，要自己決定送哪台 |
| 主機忙或壞掉 | 自動交給另一台；兩台都忙時開雲端 | 回 429／503，要自己換台、重新上傳 |
| 排隊 | 分派器排隊，不會回 429 | 一台最多 100 筆，滿了回 429 |
| 主機出錯 | 自動換一台重做一次 | job 失敗 |
| 口掃 | 用網址交：向分派器要上傳網址，或給你自己 S3 的網址 | 可以直接夾帶在表單裡 |
| 參數 | 全部放在 JSON 的 `params` | 有的是表單欄位、有的是網址參數，放錯會被忽略 |
| 多花的時間 | 每個 job 約 0.3–0.4 秒（結果放上 S3） | — |

## 連線與認證

| 站 | 網址 | 用途 |
|---|---|---|
| 正式站 | `https://ai.inteware.com.tw` | 正式流量 |
| 測試站 | `https://test-ai.inteware.com.tw` | 串接測試。比正式站多一個 `route` 欄位，可以指定嘉義、台中或雲端 |

每個請求都要帶下面三個 header，缺一個就會被 Cloudflare 擋下：

| Header | 值 | 說明 |
|---|---|---|
| `CF-Access-Client-Id` | 你們團隊那把分派器 Service Token 的 Client ID | 每個團隊一把，另外提供，不寫在文件裡。**直連主機用的 token 不能用在分派器** |
| `CF-Access-Client-Secret` | 同一把的 Client Secret | 另外提供；只放在伺服器端，不要放進瀏覽器程式 |
| `User-Agent` | 自訂字串，例如 `heygears-integration/1.0` | 程式語言預設的 UA（例如 `Python-urllib/3.x`）會被 Cloudflare 直接回 403 error code: 1010 |

- 沒帶憑證和帶錯憑證都回同一個 403 頁面，所以 403 只代表請求有送到 Cloudflare，不代表網址錯。驗證連線請用 `GET /v2/status`，拿到 200 才算通。
- 上傳網址、`result_url` 是 S3 的簽名網址，**不用**帶上面的 header；網址本身就是憑證，不要寫進 log。
- 分派器連不上時 Cloudflare 回 **530**：請當成「連不上」處理（和 502／503／504 一樣），稍後再試。
- Cloudflare 的一個請求最長約 100 秒，所以要用輪詢等結果（`?wait=20` 的長輪詢），不能開著連線等。

## 使用流程

一顆牙冠就是一個 job：

1. **放口掃**：`POST /v2/uploads`，body `{"filename": "upper.tri.gz"}`，回 `put_url`、`get_url`。15 分鐘內把檔案原樣 `PUT` 到 `put_url`，建 job 時給 `get_url`（1 小時內有效）。上下顎各要一組。
2. **建 job**：`POST /v2/jobs`，JSON（見「建立 job」），立刻回 202 與 job 狀態，`id` 是 job id。
3. **等結果**：`GET /v2/jobs/{id}?wait=20`，狀態有變或 20 秒到了就回；一直重複，直到 `status` 是 `succeeded`、`failed` 或 `cancelled`。進行中是 `queued`（排隊）→ `running`。
4. **拿結果**：`succeeded` 時下載 `result_url`（結果 zip，見「結果 zip」）。網址 1 小時內有效，過期就再 `GET` 一次狀態拿新的。
5. **刪除**：`DELETE /v2/jobs/{id}`，回 204。口掃是病人資料，用完就刪；沒刪的話，上傳的口掃與結果 24 小時後自動刪除。

口掃：

- **檔名決定格式**：`.stl`、`.ply`、`.obj`、`.tri`（公司格式 V1、V2），都可以再加 `.gz`。其他壓縮（`.zip`、`.zst`）不收。檔名請不要含病人姓名。
- 建議先 gzip（檔名加 `.gz`）或用公司的 `.tri` 格式：同一份口掃的 `.tri.gz` 約只有 STL 的四分之一大。
- 也可以不用 `/v2/uploads`，給你們自己 S3 的簽名網址（主機名稱在 `amazonaws.com` 底下、路徑要有檔名）；請簽 1 小時以上。

其他：

- 一顆牙一個 job。同一顎有好幾顆備牙時，每顆各送一個 job（可以同時送），並在 `all_tooth_numbers` 填整顎的備牙牙位（幫助 margin 模型分辨）。
- **重送是安全的**：同一個 `job_id`、同樣的內容（簽名網址的簽名不算內容）再送，拿到的是同一筆；內容不同就取消舊的、換成新的。
- `job_id` 是每把 Service Token 自己的：別人的 job 查不到（404）。測試站各團隊共用一把 token，`job_id` 請加自己的前綴。

## 端點一覽

| 方法 | 路徑 | 做什麼 | 成功時回傳 |
|---|---|---|---|
| POST | `/v2/uploads` | 要一組上傳網址，body `{"filename": …}` | 200 `{"key", "put_url", "get_url", "expires_in"}` |
| POST | `/v2/jobs` | 建立 job（JSON） | 202，job 狀態 |
| GET | `/v2/jobs/{id}?wait=20` | job 狀態；有變或 `wait` 秒到了才回（最多 25） | 200 |
| DELETE | `/v2/jobs/{id}` | 取消還在跑的 job、刪除做完的結果 | 204 |
| GET | `/v2/status` | 連線檢查、各服務的佇列 | 200 |

## 建立 job

`POST /v2/jobs` 的 JSON：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `service` | 是 | 固定 `crown` |
| `inputs` | 是 | 口掃、margin、支台齒的網址（下表） |
| `params` | 是 | 參數，至少要有 `fdi`（下表） |
| `job_id` | 否 | 你們自己的 id（英數、`_`、`.`、`-`，最多 64 字）；不給就由分派器產生 |
| `deadline_s` | 否 | 這個 job 最多等幾秒（5–3600，預設 330）；超過就 `failed`（`deadline_exceeded`） |
| `route` | 否 | 只有測試站：`auto`（預設）、`95`（嘉義）、`101`（台中）、`cloud`。指定的地方現在不能做就馬上回 503 |

`inputs`：

| 名稱 | 說明 |
|---|---|
| `upper_stl_url`、`lower_stl_url` | 上、下顎口掃的網址。名稱沿用舊 API：`.tri.gz` 也用這兩個名稱。兩顎都要給，除非 `single_arch=true` |
| `margin_pts` | margin 檔的**文字內容**（≤64 KB），直接放在 JSON 裡，不用另外上傳。`mode=margin_override` 或 `stump` 時必填（`stump_shape=supplied` 除外），其他模式不能給 |
| `margin_pts_url` | 同上，改用網址（檔名決定格式：`.pts`、`.json`、`.txt`，可加 `.gz`）。和 `margin_pts` 二選一 |
| `stump_url` | 只配 `mode=stump`＋`stump_shape=supplied`：你們的支台齒，齦線以上、沿 margin 開口，**原始口掃的座標**；檔名決定格式（`.stl`、`.ply`、`.obj`、`.tri`，可加 `.gz`）。上一筆 `mode=stump` 結果的 `stump.ply` 就是這種形狀。開口的邊就是 margin，所以不能再給 `margin_pts` |

- margin 要在**你送來的口掃的座標系**（就是結果裡 `margin_original.pts` 的座標）。
- `.pts` 格式：`BEGIN_<FDI>`、每行 `x y z`、`END_<FDI>`；JSON 可以是 `[[x,y,z], …]`，或之前 job 的 `margin.json`。

`params`（**全部放在 `params` 裡**；值可以是字串、數字或 true／false，`true` 和 `"true"` 一樣）：

| 名稱 | 值 | 不帶時 | 說明 |
|---|---|---|---|
| `fdi` | 兩位數 FDI（11–48），**必填** | — | 要做牙冠的牙位 |
| `mode` | `full`、`margin_only`、`margin_override`、`stump` | `full` | `full`：預測 margin 再生成牙冠。`margin_only`：只預測 margin，不生成牙冠。`margin_override`：用你給的 `margin_pts`，不跑 margin 模型。`stump`：支台齒和上面的牙冠外壁（`outputs` 選要哪些），見「無支台齒與支台齒」 |
| `all_tooth_numbers` | 例如 `"14,15"` | 空白 | 同一顎所有備牙的牙位（含這一顆），給 margin 模型參考；單顆可不送。`margin_override` 時沒有作用 |
| `single_arch` | `true`、`false` | `false` | 只送備牙那一顎（另一顎不要給）。對咬用鄰牙高度的平面代替，咬合面不是照真實咬合做的，每顆都會有一則警告 |
| `contact_fit` | `true`、`false` | `true` | 牙冠穿進鄰牙的那面牆整平、往回推最多 0.3 mm；margin 上方 1 mm 內（牙齦帶）不動。推完還重疊的留給編修並發警告。`false` 回傳模型原樣 |
| `contralateral` | `true`、`false` | `false` | 只對前牙（牙位第二碼 1–3）：形狀擬合另一側的同名牙，每顆約多 2 秒。不適用時不套用，原因寫在 `warnings` |
| `crown_model` | `heygears`（`heygears_v1`：舊版，暫時保留） | v3 | 用哪個牙冠模型，見「牙冠模型」 |
| `occlusal_clearance` | −0.3–1.0（mm） | 不另外留 | 牙冠咬合面和對咬牙之間至少留這個距離。HeyGears 建議 `0.2` |
| `occlusal_detail` | 0–2 | 不補 | 生成後補回模型磨平的咬合面細節；`1` 是建議值。只對小臼齒、大臼齒，見「咬合面細節」 |
| `no_abutment` | `true`、`false` | `false` | 還沒有支台齒的位置（例如植體）：要搭配 `mode=margin_override`。服務放一個支台齒再生成牙冠，多回傳 `virtual_prep.ply`；**牙冠只用外表面** |
| `stump_height_mm`、`stump_shoulder_mm`、`stump_shape`、`insertion_axis`、`stump_clearance_mm`、`cutback_style`、`cutback_mm`、`cutback_occlusal_mm` | 見「無支台齒與支台齒」 | 服務決定 | 只能和 `no_abutment=true` 或 `mode=stump` 一起送 |
| `outputs`、`implant_position`、`implant_axis` | 見「無支台齒與支台齒」 | 服務決定 | 只能和 `mode=stump` 一起送 |

- **名稱打錯**（例如 `no_abutement`）時，建 job 就回 422 `invalid_request`，`message` 列出不認得的名稱和 `crown` 收的所有名稱；不會被默默忽略。
- 值不對（例如 `occlusal_detail` 不是 0–2、`mode` 和 `margin_pts` 不搭）由主機檢查：job 會 `failed`，`error.code` 是 `input_rejected`，`message` 是主機的原話。
- 其他名稱（`res`、`steps`、`guide`、`frame`、`chamfer`、`shell`、`contact_clearance`、`jaw_samples`）是模型的內部設定，照收但不承諾以後不變，請維持預設；改了以後，結果就和其他客戶的不一樣。

## 牙冠模型：`crown_model`

| | 不帶（`default`，v3） | `heygears` |
|---|---|---|
| 是什麼 | 所有客戶目前用的模型 | 2026-11-11 起：用全部訓練牙冠重新訓練的較大模型，再用 HeyGears 技師的 exocad 牙冠微調，學 HeyGears 的牙冠風格。之前（11-03 到 11-10）是 v3 再訓練的版本，現在叫 `heygears_v1` |
| 牙位 | 全部 | **只有小臼齒、大臼齒**（牙位第二碼 4–7）。前牙、犬齒、智齒帶了 `heygears` 也會用 v3 生成，並在 `warnings` 註明 |
| 建議一起送 | — | `occlusal_clearance=0.2`：HeyGears 的牙冠和對咬牙通常留約 0.2 mm，模型自己學不到。`occlusal_detail=1`：HeyGears 咬合面紋路（見「咬合面細節」） |

- 嘉義、台中、雲端都有（台中 2026-11-17 起）。分派器交給哪裡做，拿到的都是同一版 HeyGears 模型。
- `heygears_v1` 是 11-10 以前的 `heygears`，只為了比對暫時保留，之後會拿掉；新的串接請用 `heygears`。

HeyGears 的 job 像這樣：

```json
{"service": "crown",
 "inputs": {"upper_stl_url": "<get_url>", "lower_stl_url": "<get_url>"},
 "params": {"fdi": "36", "crown_model": "heygears", "occlusal_clearance": 0.2, "occlusal_detail": 1}}
```

**怎麼確認真的用了 HeyGears 模型**：

- 結果 zip 裡 `manifest.json` 的 `backends.crown.model` 是 `heygears`。前牙等沒學過的牙位是 `default`，同時 `warnings` 有一則 `crown_model: asked for 'heygears', the crown service used 'default'`。
- 值打錯（例如 `heygear`）時 job 會 `failed`（`input_rejected`），`message` 有 `unknown model 'heygear'; this server has default, heygears, heygears_v1`。

**2026-11-11 新版和舊版比**（第二批 75 例 HeyGears 病例，沒有參與訓練，和 HeyGears 技師的牙冠比；兩版都帶 `occlusal_clearance=0.2&occlusal_detail=1`，同一個病例前後接著送；中位數）：

| | 舊版（`heygears_v1`） | 新版（`heygears`） |
|---|---|---|
| 形態誤差（去掉大小差異，mm） | 0.182 | 0.180（47/75 例更接近技師） |
| 咬合面的形態誤差（mm） | 0.218 | 0.214 |
| 和對咬牙的最近距離（mm） | 0.132 | 0.136 |
| 咬進對咬牙超過 0.02 mm 的病例 | 11 / 75 | 12 / 75 |
| 牙冠服務每顆秒數 | — | 比舊版多約 0.5 秒（同一病例相比的中位數） |

- 數字上的差別小；差在看起來：新版的窩溝比較細、比較利，比較像技師的牙冠。我們內部的目視盲評（20 例，看不出是哪一版）新版大多排第一。
- 新版的咬合面紋路只在帶 `occlusal_detail=1` 時才有（見下一節）；不帶時只換了模型。

**11-03 那一版（現在的 `heygears_v1`）的效果**（同一批 75 例；一次一個請求）：

| | v3 | HeyGears | HeyGears＋0.2 mm |
|---|---|---|---|
| 形態誤差（去掉大小差異，mm） | 0.214 | 0.181（少 15%，83% 的病例變好） | 0.181 |
| 咬進對咬牙的病例 | 36 / 75 | 30 / 75 | 10 / 75 |
| 牙冠服務每顆秒數 | 2.61 | 2.48 | 2.85 |

- 形態差最多的是鄰接面（0.182 → 0.148 mm）、咬合面（0.252 → 0.215 mm）、頰舌面（0.185 → 0.161 mm）。
- 近心鄰接區的高度補上和 HeyGears 之間 77% 的差距；頰舌側外形的凸出量這批沒有改善。

## 咬合面細節：`occlusal_detail`

模型生成的牙冠，咬合面最細的起伏（例如窩溝底的 V 形）比技師設計的平滑。`occlusal_detail=1` 讓牙冠服務在生成後把它補回來。做法看牙冠模型：

| | v3、`heygears_v1` | `heygears`（2026-11-11 起） |
|---|---|---|
| 做什麼 | 沿窩溝、窩往下挖深；挖多少，依技師牙冠量出的「模型平均磨掉多少」 | 換上 HeyGears 咬合面紋路：從 HeyGears 技師的牙冠學來，窩溝更細、更利；可升可降 |
| 不動的地方 | 牙尖、接觸點、外壁、邊緣。只往下挖，所以不會更靠近對咬牙 | 外壁、邊緣。升高的地方不會碰到對咬牙（但可能吃掉一點 `occlusal_clearance` 留的間隙），往下離支台齒至少留 0.5 mm |
| 牙位 | 小臼齒、大臼齒（牙位第二碼 4–7） | 同左，但**下顎第一小臼齒（34、44）還沒有紋路範本，不加**，`warnings` 會註明 |
| 值 | `1`＝量出來的強度；可給 0–2（`0.5` 挖一半深、`2` 挖兩倍深） | 大於 0 就加上同樣的紋路，數值不影響強度 |
| 時間 | 每顆約多 0.1 秒 | 每顆約多 0.4 秒（只用 CPU） |

- 不適用的牙位照常生成、不補，`warnings` 會註明。`0` 或不帶＝不補；超出 0–2 或不是數字，job 會 `failed`（`input_rejected`）。
- 嘉義、台中、雲端都有（台中 2026-11-17 起）。

**怎麼確認有補**：

- 結果 zip 裡 `manifest.json` 的 `backends.crown.occlusal_detail` 是 `applied`。`backends.crown.occlusal_detail_info`：
  - v3、`heygears_v1`：`deepest_mm`（最深挖了幾 mm）、`mean_mm`（平均）、`moved`（動了幾個頂點）、`seconds`。
  - `heygears`：`method` 是 `texture`；`dz_max`、`dz_min`（最多升高、降低幾 mm）、`dz_mean_abs`（平均移動）、`seconds`。
- 不是 `applied` 時 `warnings` 會有一則 `occlusal_detail: …`：`skipped: FDI 13 (premolars and molars only)` 是牙位不適用；`skipped: no template for L4` 是 `heygears` 在下顎第一小臼齒沒有紋路範本；`failed: …` 是處理失敗，回傳模型原本的牙冠，job 仍然成功。

**`heygears` 的紋路效果**（第二批 75 例，73 例有範本；除以技師牙冠的值，1＝和技師一樣；中位數）：

- 窩溝寬度 1.10 倍、窩溝深度 1.10 倍、銳利度 0.90、窩溝總長 0.75。
- 咬合面的形態誤差沒有變差；技師那種很細的副溝還是補不齊（窩溝總長只到技師的 75%）。
- 和對咬牙的距離見上一節的新舊版比較：帶 `occlusal_clearance=0.2` 時，最近距離中位 0.136 mm。

**v3、`heygears_v1` 的挖深效果**（同一批 75 例，和 HeyGears 技師的牙冠比；一次一個請求；中位數）：

| | HeyGears（v1）＋0.2 mm | 加 `occlusal_detail=1` | 技師 |
|---|---|---|---|
| 咬合面起伏（mm，越大越銳利） | 0.123 | 0.139（74/75 例變銳利） | 0.157 |
| 窩溝深度（mm） | 0.986 | 1.078 | 1.107 |
| 牙尖斜度 | 18.1° | 19.1° | 21.3° |
| 形態誤差（去掉大小差異，mm） | 0.181 | 0.182（47/75 例更接近技師） | — |

- v3 也一樣：起伏 0.132 → 0.148，形態不變。
- 看起來是「窩溝清楚一點」，不是大改；技師那種很細的副溝補不出來。
- 逐頂點量，沒有任何一顆更靠近對咬牙；移動量平均 0.04 mm，最深約 0.19 mm。

## 無支台齒與支台齒

還沒有支台齒的位置（例如植體）有兩種做法。兩種都**一定要你畫的 margin**（`margin_pts`，畫在牙齦上牙冠或支台齒要落的位置）：沒有支台齒時 margin 模型找不到邊緣線。支台齒還可以**送回你們改過的支台齒，重做牙冠外壁**（`stump_shape=supplied`，這時不給 margin）。

| | PEEK abut：`mode=margin_override`＋`no_abutment=true` | 支台齒＋牙冠外壁：`mode=stump` |
|---|---|---|
| 做什麼 | 在 margin 裡放一個支台齒，再生成牙冠；**牙冠只用外表面**（內側是配合那顆支台齒的），例如給 PEEK 牙冠的上半部 | 沿 margin 把口掃切開，縫進一顆支台齒（abutment 的上半部），再在支台齒上生成牙冠外壁；**牙冠內面由你們做** |
| 回傳 | `crown.ply`（外壁）、`virtual_prep.ply`（牙冠底下的支台齒） | 由 `outputs` 決定；不帶＝`stump.ply`＋`crown.ply`（`supplied`＝`crown.ply`） |
| `stump_shape` | 不帶＝一般的虛擬支台齒（預設）；`library`、`cutback`：牙冠改長在那種支台齒上 | `library`（預設）、`cutback`、`virtual`、`supplied` |
| 可以一起送 | `contralateral`、`crown_model`、`occlusal_clearance`、`occlusal_detail` | `crown_model`、`occlusal_clearance`、`occlusal_detail`、`contact_fit`、`contralateral`（要有牙冠） |
| 主機上的時間 | 和 `margin_override` 差不多（3–5 秒） | 有牙冠 4.4–5 秒；只要 `library` 支台齒、不要牙冠約 1 秒（見「速度」） |

支台齒的形狀：

| `stump_shape` | 做法 |
|---|---|
| 不帶（只有 `no_abutment`） | 一般的虛擬支台齒：高度＝牙齦到對咬的距離減 1.5 mm（限制在 1.5–4.0 mm），錐度 8°。牙齦到對咬不到 3 mm 時放不下牙冠，`warnings` 會說明 |
| `library` | 形狀取自 EZCAD 支台齒資料庫；高度、傾斜、寬度取同牙位真實支台齒的中位數，不會比 margin 寬；對咬太近時自動降低（最低 2.0 mm），`warnings` 會說明 |
| `cutback` | 先在 `library` 支台齒上生成牙冠，再把牙冠往內縮一層牙冠的厚度，剩下的就是支台齒。`mode=stump` 回的 `crown.ply` 就是這顆牙冠（整平鄰接後），支台齒是從它內縮來的。`scaled`（預設）：肩台與牆照 `ring`，咬合面用牙冠自己的咬合面等比縮進來，植體牙冠比 margin 寬很多時咬合面的起伏留得比較多；`ring`：牆和咬合面分開內縮。空間不夠切不出來時改回 `library` 支台齒並在 `warnings` 說明 |
| `virtual`（`mode=stump`） | 和 PEEK abut 同一種虛擬支台齒 |
| `supplied`（`mode=stump`） | **你們的支台齒**（`inputs.stump_url`），例如上一筆的 `stump.ply` 在你們的軟體改過後送回來。它的開口邊緣就是 margin（不收 `margin_pts`）：服務沿這條邊把口掃切開、縫上這顆支台齒，再**重新生成**牙冠外壁。支台齒本身不會被改動（只在開口邊緣多了和口掃共用的頂點）。要給齦線以上的部分、只有一個開口、開口至少 8 點；封閉的整顆支台齒（含齦線以下）還不收，另一個超過 3 mm 的開口也不收（都是 `input_rejected`）；小於 3 mm 的小洞照收並加警告 |

支台齒的參數（放在 `params`；不帶＝服務決定）：

| 名稱 | 能配什麼 | 值 | 說明 |
|---|---|---|---|
| `outputs` | `mode=stump` | 逗號分隔：`stump`、`crown`、`scan_with_stump` | zip 裡要哪些檔。不帶＝`stump,crown`（`supplied`＝`crown`）。只有不要 `crown` 的 `library`／`virtual` 支台齒會跳過牙冠（約 1 秒）；`cutback` 一定會做牙冠（支台齒從它內縮），不要 `crown` 只是不放進 zip。沒有 `crown` 又送 `contralateral`：`input_rejected` |
| `implant_position` | `mode=stump` | `"x,y,z"`（原始口掃的座標，mm） | 掃描桿量到的植體平台中心。**只記錄**（`manifest.json` 的 `stump.implant`：在 margin 下方多深、離 margin 中心多遠），不影響形狀；離 margin 太遠（可能是別的座標系）加警告 |
| `implant_axis` | `mode=stump` 的 `library`、`cutback` | `"x,y,z"`（原始口掃的座標，正負都可） | 掃描桿量到的植體軸向。沒送 `insertion_axis` 時支台齒沿這個方向立起（`stump.axis_source` 寫 `implant_axis`），也記下它和實際插入方向的夾角 |
| `stump_height_mm` | `no_abutment` 或 `mode=stump` | 虛擬支台齒 1.0–6.0；`library` 1.5–8.0 | 支台齒高度（從 margin 平均高度量到頂端） |
| `stump_shoulder_mm` | 同上 | 0.3–1.5（虛擬支台齒不帶＝0.8，`library`／`cutback` 不帶＝0.6） | 肩台寬（從 margin 往內） |
| `stump_shape` | 同上 | `library`、`cutback`；`mode=stump` 還有 `virtual`、`supplied` | 見上表 |
| `insertion_axis` | `library`、`cutback` | `"x,y,z"`（原始口掃的座標，正負都可） | 支台齒立起的方向。不帶＝有 `implant_axis` 就用它，否則牙位自然的傾斜。離咬合方向超過 60° 時 job 會 `failed`（`input_rejected`），超過 30° 加警告 |
| `stump_clearance_mm` | `library`、`cutback` | 0.5–3.0（不帶＝1.0） | 和對咬牙至少保留的距離 |
| `cutback_style` | `cutback` | `scaled`（預設）、`ring` | 其他值 `input_rejected` |
| `cutback_mm`、`cutback_occlusal_mm` | `cutback` | 0.5–2.5（不帶＝1.0）、0.5–3.0（不帶＝1.8） | 牆內縮多少、咬合面沿插入方向往下降多少（mm） |

`mode=stump` 做了牙冠時：

- 貼合鄰牙（`contact_fit`）預設開，和一般牙冠一樣。
- `manifest.json` 的 `stump.fit` 給你們做牙冠內面時參考：
  - `thickness`：牙冠外壁到支台齒表面的距離（mm），分咬合面 `occlusal_mm`、軸面 `axial_mm`（最小、第 5 百分位、中位數），離 margin 1 mm 以內不算。外壁穿進支台齒（`inside_points` > 0）或比 0.3 mm 薄時加警告。
  - `rim`：牙冠外壁下緣離 margin 多遠。下緣刻意放在 margin 外約 **0.2 mm**（模型的倒角寬度），不在 margin 上；做內面時要接到這條邊。
- **外壁下緣是一圈**（`mode=stump` 有牙冠時，以及 PEEK abut）：服務把下緣的頂點沿 margin 排好順序，下緣不會沿 margin 往回走，也沒有座標完全相同的點，所以用座標焊接（例如 0.0001 mm）之後還是一圈。下緣還在原本那條線上（margin 外約 0.2 mm），只改了順序；每筆約多 0.02 秒。`manifest.json` 的 `stump.crown_rim.result`（PEEK abut 是 `no_abutment.crown_rim.result`）：`clean`（本來就是一圈）、`reseated`（重排過）、`skipped: …`（下緣沒有繞 margin 一圈，例如咬合空間不夠時的退化外殼：原樣回傳並加警告）、`closed`（外壁沒分離出來，見「結果 zip」）。PEEK abut 的外壁拿去放樣到植體（AbutmentLoft）時，不經 `cleanShell` 下緣也是一圈；外壁內部還有很短的邊，`cleanShell` 請照舊留著。
- `manifest.json` 的 `stump` 也記錄這顆支台齒：形狀、高度與怎麼決定的、離對咬、插入方向（`insertion_axis_original`，原始座標）和它的來源（`axis_source`）、要了哪些檔（`outputs`）；`supplied` 時另有口掃怎麼切、縫合（`cut`、`seam`）。PEEK abut（`no_abutment`）的支台齒記在 `no_abutment`。

範例 `params`：

| 要做什麼 | `params` | `inputs` 另外要給 |
|---|---|---|
| 支台齒＋牙冠外壁（cutback，沿掃描桿的軸） | `{"fdi": "26", "mode": "stump", "stump_shape": "cutback", "implant_axis": "0.1,-0.2,0.97"}` | `margin_pts` |
| 只要資料庫支台齒（約 1 秒） | `{"fdi": "26", "mode": "stump", "outputs": "stump"}` | `margin_pts` |
| 改過的支台齒，重做牙冠外壁 | `{"fdi": "26", "mode": "stump", "stump_shape": "supplied"}` | `stump_url`（不給 margin） |
| PEEK abut（資料庫支台齒） | `{"fdi": "21", "mode": "margin_override", "no_abutment": true, "stump_shape": "library"}` | `margin_pts` |

## job 狀態

`GET /v2/jobs/{id}`（以及 `POST /v2/jobs` 的 202 回應）是 JSON：

| 欄位 | 說明 |
|---|---|
| `id`、`service` | job id、`crown` |
| `status` | `queued` → `running` → `succeeded`／`failed`／`cancelled` |
| `where` | 在哪做：`95`（嘉義）、`101`（台中）、`cloud`（雲端） |
| `attempts` | 做了幾次。主機出錯會自動換一台重做一次，這時是 2 |
| `predicted_finish_s` | 還沒做完時，預估還要幾秒 |
| `timings` | `queued_s`（排隊）、`run_s`（主機上的計算）、`total_s`（建 job 到做完） |
| `result_url`、`result_bytes`、`result_sha256` | 成功時的結果 zip（S3 簽名網址，1 小時內有效） |
| `meta` | 主機回的摘要：`fdi`、`mode`、`has_crown`（`1`／`0`）、`output_frame`、`warnings`（警告的筆數） |
| `warnings` | 警告（英文），例如單顎、margin 離口掃太遠、牙冠還和鄰牙重疊、模型改用 v3。有警告不等於失敗，結果還是可以用；請顯示給使用者或記錄下來 |
| `error` | 失敗時：`code`、`message`、`retryable`（見「錯誤與限制」） |

## 結果 zip

| 檔案 | 座標系 | 內容 |
|---|---|---|
| `crown.ply` | **原始口掃** | 牙冠外壁（`margin_only` 沒有；`mode=stump` 看 `outputs`，預設有）：一片開口在 margin 的外表面，不含內側的黏著面 |
| `margin_original.pts` | **原始口掃** | 這次用的 margin（預測的或你給的） |
| `margin_canonical.pts` | 擺正後 | 同一條 margin，擺正座標 |
| `margin.json` | 兩者 | 兩條 margin 的 JSON，加上 margin 是否有效；`margin_override` 時另有你的 margin 離口掃多遠（`surface_check`，超過 0.3 mm 會警告） |
| `alignment.json` | — | 擺正用的旋轉矩陣：`p_canonical = rotation_matrix @ p_original` |
| `manifest.json` | — | 參數、每步耗時、警告，以及各 AI 服務回報的資訊（見下） |
| `virtual_prep.ply` | **原始口掃** | 只有 `no_abutment=true`：牙冠底下的支台齒（帶 `stump_shape` 時是那種支台齒） |
| `stump.ply` | **原始口掃** | 只有 `mode=stump` 且 `outputs` 有 `stump`（預設有，`supplied` 預設沒有）：支台齒本身（肩台＋支台齒），開口的邊就是 margin；`supplied` 時是縫進口掃之後的樣子 |
| `scan_with_stump.ply` | **原始口掃** | 只有 `mode=stump` 且 `outputs` 有 `scan_with_stump`（2026-11-18 以前一律有）：口掃沿 margin 切開、縫上支台齒（共用頂點，沒有縫隙、沒有重疊） |
| `cutback_crown.ply` | — | 2026-11-18 起**沒有這個檔**：`cutback` 內縮之前的那顆牙冠改成 `crown.ply`（整平鄰接後）送出 |

回傳的牙冠和 margin 都在**你送來的口掃的座標系**，不必另外轉換。

外壁偶爾分離不出來（第二批 75 例 HeyGears 病例：v3 2 例、HeyGears 1 例，不同病例）。這時 `crown.ply` 是**封閉的整顆牙冠**，`warnings` 有一則 `requested shell=outer but received shell=full; …`，貼合鄰牙（`contact_fit`）也會跳過並另有一則警告。請用這兩則警告判斷，不要假設 `crown.ply` 一定有開口。

`manifest.json` 裡值得讀的欄位：

- `backends.crown.model`：實際用的牙冠模型（`default`、`heygears` 或 `heygears_v1`）。
- `crown_params`：送給牙冠服務的參數（含 `model`、`occlusal_clearance`、`occlusal_detail`）。
- `backends.crown.occlusal_detail`、`occlusal_detail_info`：只有帶了 `occlusal_detail` 才有；有沒有補、補了多少（見「咬合面細節」）。
- `backends.crown.antagonist_relief`：大於 0 表示備牙的咬合空間不夠，服務把對咬往外移了這麼多 mm 才做得出牙冠，`warnings` 也會說明；這種牙冠的咬合要另外處理。
- `backends.crown.antagonist`：單顎時用的對咬替身。
- `contact_fit`：和鄰牙的重疊處理前後的數字。
- `stump`、`no_abutment`：支台齒的紀錄；`stump.fit`（外壁厚度、下緣離 margin 多遠）、`stump.crown_rim`、`no_abutment.crown_rim`（下緣整理），見「無支台齒與支台齒」。
- `request`：收到哪些參數（`sent`）、每個選項實際用的值，含預設（`applied`）、這個 `mode` 下沒有作用的參數（`no_effect`）。
- `warnings`、`timings_ms`：警告與每一步的毫秒數（`jaw_ms`、`margin_ms`、`crown_ms`、`contact_fit_ms`、`total_ms`…）。
- 同一份輸入在同一台得到逐位元組相同的牙冠。嘉義和台中之間只有浮點誤差等級的差異（牙冠中位數 ≤0.02 mm）。雲端的顯示卡不同，而 AI 預測的 margin（`full`、`margin_only`）對極小的數值差很敏感：少數病例和主機的 margin 差 0.5 mm 以上（13 例中 4–5 例），牙冠也跟著不同；哪一邊比較好沒有比過。在哪裡做的看 job 的 `where`。

## 錯誤與限制

建 job 時（HTTP 回應，body `{"error": {"code", "message", "retryable"}}`；Cloudflare 擋下的是 HTML 頁面）：

| 狀態碼 | `code` | 原因 | 怎麼處理 |
|---|---|---|---|
| 403 | — | Cloudflare：沒帶或帶錯 Service Token，或用了預設 User-Agent（error code: 1010） | 檢查三個 header |
| 400、422 | `invalid_request` | JSON 或欄位錯：不認得的參數名稱、一顎口掃都沒給、網址不是 https／不在 `amazonaws.com`／快過期、`margin_pts` 超過 64 KB、`stump_shape=supplied` 沒給 `stump_url` 或又給了 margin、`stump_url` 沒配 `supplied` | 看 `message`，改了再送 |
| 409 | `conflict` | 這個 `job_id` 剛好不能用（很少見） | 換一個 `job_id` |
| 503 | `no_capacity` | 現在沒有能做這種 job 的地方；回 `Retry-After: 30` | 稍後再送 |
| 404 | `not_found` | 查詢、刪除的 job 不存在、已刪除，或不是你們的 | — |
| 530 | — | 分派器連不上（Cloudflare） | 當成連不上，稍後再試 |

job 失敗（`status` 是 `failed`，看 `error.code`；`GET` 仍然回 200）：

| `code` | 原因 | 要不要重送 |
|---|---|---|
| `input_rejected` | 主機拒絕輸入或參數，`message` 是主機的原話：沒有 `fdi`、缺一顎或 `single_arch` 又給了對咬顎、不支援的副檔名、讀不出檔案、牙位不對、`margin_pts` 和 `mode` 不搭、`no_abutment` 沒有搭配 `margin_override`、`occlusal_detail` 不是 0–2、支台齒參數超出範圍或配錯模式、`mode=stump` 不做牙冠又帶了 `contralateral`、送來的支台齒是封閉的或有另一個大開口、`insertion_axis` 離咬合方向超過 60°、`cutback_style` 不是 `scaled` 或 `ring`、`crown_model` 打錯 | 改了再送；原樣重送一樣會失敗 |
| `input_fetch_failed` | 主機抓不到口掃網址（多半是過期或 403） | 重新上傳或重新簽網址再送 |
| `host_failed` | 主機出錯，已自動換一台重做一次，還是失敗 | 稍後再送 |
| `deadline_exceeded` | 超過 `deadline_s` | 視情況加長 `deadline_s` 再送 |

限制：

- 牙冠模型只學過有支台齒的牙；沒有支台齒的位置請用 `no_abutment=true`（或用 `mode=stump` 先做支台齒）。
- 每個 job 只做一顆牙冠；牙橋要拆成單顆送。
- 每個口掃檔最大 200 MB；`margin_pts` 放文字時最大 64 KB。

## 速度

主機上的時間（嘉義，一次一個 job）：

| 模式 | 一個 job | 說明 |
|---|---|---|
| `full`（預測 margin＋牙冠） | 約 6.5–7.5 秒 | 擺正 0.4–0.7、margin 約 3、牙冠約 2.5–3、貼合鄰牙約 0.6 秒 |
| `margin_override`（用你的 margin） | 約 3–5 秒 | 不跑 margin 模型 |
| `margin_only` | 約 4 秒 | 不生成牙冠 |
| `stump`（`library`＋牙冠，預設） | 約 4.5 秒（台中約 4.8） | 支台齒約 1 秒、牙冠、貼合鄰牙、厚度檢查 0.1–0.2 秒 |
| `stump`（`cutback`） | 約 5 秒（台中約 5.1） | 牙冠做一次，支台齒從它內縮 |
| `stump`（`supplied`） | 約 4.4 秒（台中約 4.5） | 沿支台齒邊緣切口掃、縫合 0.3–0.9 秒 |
| `stump`（`library`，`outputs=stump`） | 約 1 秒（台中約 1.2） | 不生成牙冠 |

- `crown_model=heygears` 每顆比 v3 多約 0.2 秒（`heygears_v1` 和 v3 差不多快）；`occlusal_clearance=0.2` 每顆約多 0.3–0.4 秒；`occlusal_detail=1` 每顆約多 0.1 秒（`heygears` 的紋路約 0.4 秒）；`contralateral=true` 每顆約多 2 秒。
- 經分派器比直連多約 0.3–0.4 秒（主要是把結果放上 S3）。另外要加上你上傳口掃、輪詢與下載結果的時間，主要看口掃大小與你的網路。
- 每台主機同時做 8 個 job。兩台都忙到雲端能早 10 秒以上做完時，分派器才開雲端：雲端一個 job 約 7–9 秒，開機後的第一個約 17 秒。所以平常都在主機上做，大量同時送的時候才會用到雲端。

## 範例程式

Python（`pip install requests`），一顆牙冠從上傳到刪除。Service Token 從環境變數讀，不要寫死在程式裡。

```python
import gzip, io, json, os, time, zipfile, requests

BASE = "https://ai.inteware.com.tw"          # 測試站：https://test-ai.inteware.com.tw
H = {"CF-Access-Client-Id": os.environ["AI_CF_CLIENT_ID"],
     "CF-Access-Client-Secret": os.environ["AI_CF_CLIENT_SECRET"],
     "User-Agent": "heygears-integration/1.0"}

def upload(path, name):
    """gzip 後放到分派器的 S3，回傳建 job 用的 get_url。"""
    with open(path, "rb") as f:
        data = gzip.compress(f.read(), compresslevel=6)
    u = requests.post(f"{BASE}/v2/uploads", headers=H, json={"filename": name}, timeout=30)
    u.raise_for_status()
    u = u.json()
    requests.put(u["put_url"], data=data, timeout=300).raise_for_status()   # S3：不帶 H
    return u["get_url"]

# 1. 放口掃
inputs = {"upper_stl_url": upload("upper.stl", "upper.stl.gz"),
          "lower_stl_url": upload("lower.stl", "lower.stl.gz"),
          "margin_pts": open("margin.pts").read()}         # 沒有 margin：拿掉這行，mode 用 full

# 2. 建 job：參數全部放在 params
r = requests.post(f"{BASE}/v2/jobs", headers=H, timeout=60, json={
    "service": "crown", "job_id": "case123-36",
    "inputs": inputs,
    "params": {"fdi": "36", "mode": "margin_override",
               "crown_model": "heygears", "occlusal_clearance": 0.2,
               "occlusal_detail": 1}})                     # 不要 HeyGears：拿掉後三個
r.raise_for_status()
job = r.json()["id"]

# 3. 長輪詢
while True:
    s = requests.get(f"{BASE}/v2/jobs/{job}", headers=H, params={"wait": 20}, timeout=60).json()
    if s["status"] in ("succeeded", "failed", "cancelled"):
        break
print(s["status"], s.get("where"), s.get("error"), s.get("timings"))
for w in s.get("warnings") or []:
    print("warning:", w)

# 4. 下載結果，確認用了哪個模型
if s["status"] == "succeeded":
    z = requests.get(s["result_url"], timeout=120)        # S3：不帶 H
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    crown = json.loads(zf.read("manifest.json"))["backends"]["crown"]
    print("crown model:", crown.get("model"))              # 後牙應該是 heygears；前牙等是 default
    print("occlusal detail:", crown.get("occlusal_detail"))   # 後牙應該是 applied（34、44 是 skipped: no template for L4）
    open(f"crown_{job}.ply", "wb").write(zf.read("crown.ply"))

# 5. 刪除
requests.delete(f"{BASE}/v2/jobs/{job}", headers=H, timeout=60)
```

curl：

```bash
H=(-H "CF-Access-Client-Id: $AI_CF_CLIENT_ID" -H "CF-Access-Client-Secret: $AI_CF_CLIENT_SECRET" -A "heygears-integration/1.0")
B=https://ai.inteware.com.tw

curl -s "${H[@]}" $B/v2/status                                          # 200 才算通
curl -s "${H[@]}" $B/v2/uploads -H "Content-Type: application/json" -d '{"filename": "upper.stl.gz"}'
curl -s -T upper.stl.gz "<put_url>"                                     # 下顎同樣再做一次
curl -s "${H[@]}" $B/v2/jobs -H "Content-Type: application/json" -d '{
  "service": "crown", "job_id": "case123-36",
  "inputs": {"upper_stl_url": "<上顎 get_url>", "lower_stl_url": "<下顎 get_url>"},
  "params": {"fdi": "36", "crown_model": "heygears", "occlusal_clearance": 0.2, "occlusal_detail": 1}}'
curl -s "${H[@]}" "$B/v2/jobs/case123-36?wait=20"                       # 重複到 succeeded
curl -s -o result.zip "<result_url>"
unzip -p result.zip manifest.json | python3 -c "import sys,json; print(json.load(sys.stdin)['backends']['crown'].get('model'))"
curl -s "${H[@]}" -X DELETE $B/v2/jobs/case123-36
```

## 直連主機（舊方式）

現有直連主機的呼叫端在改接完成以前照常可用、行為不變；新的串接請用上面的分派器。改接時，下表是對照：

| 直連主機 | 分派器 |
|---|---|
| `POST https://ezai2.inteware.com.tw/pipeline/v1/jobs?job_id=X`，multipart | `POST /v2/jobs`，`{"service": "crown", "job_id": "X", "inputs": {…}, "params": {…}}` |
| 表單欄位 `fdi`、`mode`、`all_tooth_numbers`、`single_arch`、`contact_fit`、`contralateral`、`no_abutment`、支台齒的欄位 | 原名放進 `params` |
| 網址參數 `crown_model`、`occlusal_clearance`、`occlusal_detail` | 原名放進 `params`（不用分表單或網址參數） |
| 表單欄位 `upper_stl_url`、`lower_stl_url`、`margin_pts_url` | 原名放進 `inputs` |
| 夾帶檔案 `upper_stl`、`lower_stl` | 不收夾帶：`POST /v2/uploads` 拿上傳網址，建 job 時給 `get_url` |
| 夾帶檔案 `margin_pts` | `inputs.margin_pts` 放檔案的文字（≤64 KB），或 `margin_pts_url` |
| 夾帶檔案 `stump`（`stump_shape=supplied` 的支台齒），或表單欄位 `stump_url` | `inputs.stump_url`（先 `POST /v2/uploads`） |
| 輪詢 `GET …/v1/jobs/X`，要送回同一台 | `GET /v2/jobs/X?wait=20`，不用管在哪做 |
| `GET …/v1/jobs/X/result` | 下載 `result_url`（S3，不用帶 header） |
| `DELETE …/v1/jobs/X` | `DELETE /v2/jobs/X` |
| 主嘉義、備台中，自己 `GET /health`、遇到 502／503／504 換台 | 一個網址；換台由分派器做。530 當成連不上 |
| 429（佇列滿） | 分派器排隊，不回 429 |
| 422（參數錯）、500 | 參數名稱錯：建 job 時 422；值錯：job `failed`（`input_rejected`）；主機出錯：自動重做一次，再失敗才 `host_failed` |
| 每台主機各一把 Service Token | 每個團隊一把分派器的 Service Token |

直連主機的細節（給還沒改接的呼叫端）：

- 基底網址：嘉義 `https://ezai2.inteware.com.tw/pipeline`、台中 `https://ezai.inteware.com.tw/pipeline`，兩台各用一把 Service Token，header 同上。兩台的程式、模型和參數預設值都一樣。
- 端點：`POST /v1/jobs`（multipart/form-data，回 202 與 `job_id`）、`GET /v1/jobs/{job_id}`、`GET /v1/jobs/{job_id}/result`（zip）、`DELETE /v1/jobs/{job_id}`、`GET /health`、`GET /`（認得哪些選項）。
- 參數名稱和上面 `params` 相同，但 **`crown_model`、`occlusal_clearance`、`occlusal_detail`、`job_id` 是網址參數**（接在 `/v1/jobs?` 後面），放在表單裡會被忽略；其他是表單欄位。口掃可以夾帶（`upper_stl`、`lower_stl`），`margin_pts`、`stump`（`supplied` 的支台齒；或用 `stump_url`）是檔案欄位。
- 狀態回應的欄位是 `job_id`、`status`、`stage`（`jaw`、`margin`、`crown`、`packaging`）、`queue_position`、`timings_ms`、`warnings`、`error`、`error_stage`、`links.result`。結果 zip 的內容和經分派器相同。
- 每台同時跑 8 個 job、最多 100 個排隊（滿了回 429 與 `Retry-After: 30`）；job 結束 1 小時後自動刪除。job 只存在收到它的那一台，輪詢、下載、刪除都要送回同一台；一台在 job 進行中掛掉時要重新上傳到另一台。
- 錯誤回 JSON `{"detail": …}`：404 job 不存在、409 結果還沒好、410 結果已清掉、413 上傳超過 100 MB、422 參數或檔案不對（原因同上面的 `input_rejected`）、429 排隊已滿、503 `/health` 有服務連不上。
