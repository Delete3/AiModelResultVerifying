# AI排牙 API v2 串接說明

文件版本：2026-11-11 傍晚（試接版；加了只送分開的牙冠 `crowns`）。v2 現在在 AI 分派器的**測試站**；正式站換成 v2 的時間另行通知。舊版 v1（各主機的 `/toothssm/v1/...`，見「API v1 串接文件」）照常可用，換成 v2 之後在嘉義保留到約 2026-11-24。每次 API 更新的內容，見同一處的「更新內容」。

v2 把 AI排牙拆成三個步驟，可以任意組合：

| 步驟 | 代號 | 做什麼 | 需要 | 產出 |
|---|---|---|---|---|
| `segment` | a | 分牙：口掃的每個面標上牙位 | 上下顎口掃 | 分牙標記 labels（每個面 1 byte） |
| `generate` | b | 每顆牙冠下長出整顆牙（含牙根）和牙軸 | 口掃＋labels | 每顆整顆牙、牙軸 |
| `align` | c | AI 排牙：每顆牙一個 4×4 矩陣，排牙前後的 ABO | 口掃＋labels（整顆牙可以不給），或分開的牙冠 | `plan.json` |

- 一筆 job 用 `steps` 說要做哪幾步（一律照 a → b → c 的順序跑），用 `inputs` 給手上已有的檔案。共 7 種組合：a、ab、abc、ac、b、bc、c。
- 手上已經是一顆一顆分開的牙冠時，可以直接送牙冠排牙（c），不用合成口掃、也不用做標記：見〈只送分開的牙冠（`crowns`）〉。
- 每筆 job 的結果都是一個**結果包**（zip），格式和輸入包相同：可以直接當下一筆 job 的輸入，不用轉換。
- 透過 AI 分派器呼叫：檔案一律用網址交換；分派器挑一台有空的主機（嘉義、台中）做，一台出錯會自動換另一台重做一次。
- **在 eztest 上試**：「AI排牙」分頁上方的「API 版本」切到「v2（試接中）」，勾要做的步驟、主機選「分派器（測試站）」（就是這份文件的網址）。分開的牙冠：輸入選「只送牙冠（zip，只排牙）」。畫面直接畫出結果包裡的分牙、牙齒和排牙前後，結果包、`plan.json`、`axes.json` 都可以下載，和你們程式拿到的對照。

## 連線與認證

| 站 | 網址 | 什麼時候用 |
|---|---|---|
| 測試站 | `https://test-ai.inteware.com.tw` | 現在試接 |
| 正式站 | `https://ai.inteware.com.tw` | 換成 v2 之後（另行通知） |

每個請求都要帶下面三個 header：

| Header | 值 |
|---|---|
| `CF-Access-Client-Id` | 分派器 Service Token 的 Client ID（測試站那一組，另外提供） |
| `CF-Access-Client-Secret` | 分派器 Service Token 的 Client Secret（另外提供；只放在伺服器端，不要放進瀏覽器程式） |
| `User-Agent` | 自訂字串，例如 `ortho-team-test/1.0`（程式語言預設的 UA 會被 Cloudflare 擋，回 403 error code: 1010） |

- 沒帶憑證和帶錯憑證都回同一個 403 頁面。驗證連線用 `GET /v2/status`，拿到 200 才算通。
- 上傳、下載檔案用的網址（`put_url`、`get_url`、`result_url`）是 S3 的簽名網址，**不用**帶上面的 header。這些網址本身就是憑證：不要寫進 log 或分享。

## 流程

1. **上傳口掃**：每個檔案先 `POST /v2/uploads`，body `{"filename": "upper.stl.gz"}`，拿到 `put_url` 和 `get_url`。用 HTTP `PUT` 把檔案原樣送到 `put_url`（15 分鐘內）。`get_url` 留著建 job 用（1 小時內有效）。**檔名決定格式**：`.stl`、`.ply`、`.obj`、`.tri`，可再加 `.gz`。分開的牙冠打包成一個 `.zip` 上傳，見〈只送分開的牙冠（`crowns`）〉。
2. **建 job**：`POST /v2/jobs`，立刻回 202，回應的 `id` 就是 job id。
   - `job_id` 可以不給（由分派器產生）。job id 是每把 Service Token 自己的：別的 token 建的 job 查不到、取消不了，`job:<id>` 也只找自己的 job。測試站各團隊共用同一把 token，所以在測試站要用不會和別人重複的值（例如加上自己的前綴和亂數）。
   - 同一個 `job_id` 再送一次同樣的內容，拿到的是同一筆 job（網路斷了可以放心重送）；內容不同，就取消舊的、換成新的。

   ```json
   {"service": "toothssm",
    "job_id": "case-0001-a",
    "inputs": {"upper.scan": "<upper 的 get_url>", "lower.scan": "<lower 的 get_url>"},
    "params": {"steps": ["segment"]}}
   ```
3. **等結果**：`GET /v2/jobs/{id}?wait=20`，狀態有變化或 20 秒到了就回。`status` 依序是 `queued` → `running` → `succeeded` 或 `failed`。
4. **拿結果**：`succeeded` 時回應裡有：
   - `summary`：標記、矩陣、牙軸、問題回報（見〈狀態〉）。只要這些的話，不用下載結果包。
   - `result_url`：結果包（zip），簽 1 小時；過期就再 `GET` 一次 job，拿新簽的網址。另有 `result_bytes`、`result_sha256`。
5. **接著做**：下一筆 job 的 `inputs` 寫 `{"bundle": "job:<上一筆的 id>"}`，例如分牙完再排牙。只能引用同一個 Service Token 建的、已經 `succeeded` 的 v2 job，結果保存 24 小時。也可以把結果包（或改過的標記）上傳，用網址給。
6. **刪除**：`DELETE /v2/jobs/{id}`：還在跑的會取消，做完的會刪掉結果包。口掃是病人資料，用完就刪；沒刪的話，24 小時後自動刪除。

## 七種組合

| `steps` | 代號 | 最少要給的 `inputs` | 結果包裡新做的 | 嘉義的計算時間（中位數） |
|---|---|---|---|---|
| `["segment"]` | a | `upper.scan`、`lower.scan` | labels | 23 秒 |
| `["segment", "generate"]` | ab | 口掃 | labels、整顆牙、牙軸 | 約 72 秒（a＋b） |
| `["segment", "generate", "align"]` | abc | 口掃 | labels、整顆牙、牙軸、plan | 79 秒 |
| `["segment", "align"]` | ac | 口掃 | labels、plan | 28 秒 |
| `["generate"]` | b | 口掃＋labels（或 `bundle`） | 整顆牙、牙軸 | 51 秒 |
| `["generate", "align"]` | bc | 口掃＋labels（或 `bundle`） | 整顆牙、牙軸、plan | 58 秒 |
| `["align"]` | c | 口掃＋labels（或 `bundle`）；整顆牙可加 | plan | 7.4 秒 |
| `["align"]` | c | `crowns`（分開的牙冠，一個 zip） | 合成的口掃、labels、plan | 約 7 秒 |

- 時間是嘉義（RTX 5090）上一次一筆、8 個全口案例的中位數，不含上傳下載。經分派器的全程時間見〈時間〉。
- 兩顎都要：分牙把上下顎當一對處理，排牙模型也是雙顎。
- **c 不需要整顆牙**：排牙模型讀的是分牙標記從口掃切出的牙冠。有給整顆牙時，整顆牙跟著矩陣移動，ABO 才算得出 RA（牙根角度）。

## 輸入（`inputs`）

| 名稱 | 內容 | 格式 |
|---|---|---|
| `upper.scan`、`lower.scan` | 上、下顎口掃，原始解析度 | `.stl` `.ply` `.obj` `.tri`（可加 `.gz`） |
| `upper.labels`、`lower.labels` | 分牙標記 | TRIMP v1：每個面 1 byte（0 牙齦、FDI 牙位、254 未分），面的順序和同一顎的口掃相同（見 v1 文件〈分割標記檔 `.trimp`〉和 `trimp_read.cpp`） |
| `bundle` | 結果包，或 `job:<id>` | zip：v2 的結果包；v1 的精簡包（`contents=slim`）也收 |
| `crowns` | 分開的牙冠，每顆牙一個檔（只能排牙，見下節） | zip：檔名是 FDI 牙位，`.stl` `.ply` `.obj` `.tri`（可加 `.gz`） |

- 單一檔案的輸入會**取代**結果包裡同一顎的同一種資料，從它算出來的東西也一起丟掉。例如 `bundle` 加上改過的 `upper.labels`、`steps` 是 `["generate", "align"]`：上顎用新的標記重新生成，兩顎重新排牙。
- 用不到的輸入會被拒絕（`input_not_used`）：例如 `steps` 有 `segment` 又給了 `upper.labels`。要用自己的標記，就把 `segment` 從 `steps` 拿掉。

## 只送分開的牙冠（`crowns`）

手上已經是一顆一顆分開的牙冠（例如矯正軟體裡的牙）時，直接送牙冠排牙，不用合成口掃、也不用做標記。

- 一個 zip，每顆牙一個網格檔，**檔名是 FDI 牙位**：`11.stl`、`upper/11.stl`、`tooth_11.ply` 都可以，放在 zip 的哪一層都行。
  - 格式 `.stl` `.ply` `.obj` `.tri`，可再加 `.gz`。
  - 有 `upper/`、`lower/` 資料夾時，要和牙位一致。
  - 不是網格的檔案會略過，列在 `manifest.json` 的 `inputs.crowns.ignored`。
- 兩顎都要、單位 mm、兩顎在咬合位置、同一個座標系（就是你們軟體裡的位置）。
- 開口（只有牙冠表面）或封閉（底部補起來）的牙冠都可以，對排牙結果的影響很小。**不要帶牙根**：排牙還沒考慮牙根。帶牙根的整顆牙之後再支援。
- 只能做排牙：`steps` 要是 `["align"]`，`inputs` 只給 `crowns`。

  ```json
  {"service": "toothssm",
   "inputs": {"crowns": "<crowns.zip 的 get_url>"},
   "params": {"steps": ["align"]}}
  ```
- 服務把每一顎的牙冠合成一個網格（依牙位順序，每顆牙的面照原檔的順序），每個面標上它的牙位。接下來和「口掃＋labels 排牙」完全一樣。結果包裡：
  - `scan/<顎>.stl`：合成的網格。`labels/<顎>.trimp`：每個面的牙位。
  - `plan.json`：每顆牙的矩陣，在你送來的座標系（服務不移動牙冠）。把矩陣套在你們自己的牙冠上，就是排好的位置。
  - `manifest.json` 的 `inputs.crowns.teeth`：每個檔的牙位、面數、大小（mm）。
  - 結果包可以原樣當下一筆的 `bundle`。`arranged=true` 會附上每顆排好的牙冠。
- 只有牙冠，所以 ABO 的 RA 和 TOTAL 是 null（見〈plan.json〉）。
- 一顎少於 6 顆時有警告 `input.few_crowns`。
- 被拒絕時 job 是 `failed`、`error.code` 是 `input_rejected`，`message` 開頭是服務的錯誤碼：
  - `input_not_used`：`steps` 有 `segment` 或 `generate`。
  - `duplicate_input`：同時給了口掃、`labels` 或 `bundle`。
  - `invalid_input`：不是 zip、檔名不是牙位（例如 `19.stl`）、同一顆牙有兩個檔、牙位和資料夾不合、少一顎、牙冠大小的中位數不在 1–100 mm（單位不是 mm）。
- 時間：嘉義計算約 7 秒，不用先分牙或生成。經分派器的全程見〈時間〉。

## 參數（`params`）

除了 `steps`，都可以不給；不給就用預設。給了這筆 job 不會跑的步驟的參數，會被拒絕（`param_not_used`）。

| 名稱 | 步驟 | 可選值 | 預設 | 說明 |
|---|---|---|---|---|
| `steps` | — | `segment`、`generate`、`align` 的非空子集 | （必填） | 照 a → b → c 的順序跑 |
| `seg` | segment | `ssm`、`toothroot` | `ssm` | 誰分牙；`toothroot` 是另一個分牙服務，適合減面過的口掃（v2 還沒驗證，先不要用） |
| `res` | generate | `128`、`160`、`192` | `128` | 生成整顆牙的解析度 |
| `crown` | generate | `fit`、`exact`、`zhu` | `fit` | 整顆牙的牙冠：`fit` 生成後貼合口掃；`exact` 保留口掃的牙冠頂點；`zhu` 照生成 |
| `root` | generate | `virtual`、`generated`、`none` | `virtual` | 牙冠下面接什麼：`virtual` 沿牙軸的短虛擬牙根；`generated` AI 生成的牙根；`none` 只給開口的牙冠，接你自己的牙根（**不能排牙**） |
| `root_fix` | generate | `true`、`false` | `true` | 牙根方向修正 |
| `fast_roots` | generate | `true`、`false` | `true` | 牙根步驟的加速 |
| `arranged` | align | `true`、`false` | `false` | 也回傳排好的網格（`arranged/<顎>/<FDI>.*`）。它們就是矩陣套在牙上，多半不需要 |
| `mesh_format` | — | `tri`、`ply`、`stl` | `tri` | 這筆 job 寫出的網格格式（整顆牙、排好的網格）；你送來的檔案照原樣回傳 |

## 結果包（zip）

```
manifest.json             第一個檔：API 與程式版本、參數、每個檔的種類／顎／牙位／sha256、服務對口掃做了什麼
scan/<顎>.<副檔名>         你送來的口掃，逐位元組原樣
labels/<顎>.trimp         分牙標記，面的順序同 scan/<顎>
teeth/<顎>/<FDI>.tri      整顆牙（含牙根）
teeth/axes.json           牙軸（root=virtual 或 none 時）
plan.json                 排牙：每顆移動的牙一個 4×4 矩陣、排牙前後的 ABO
arranged/<顎>/<FDI>.tri   排好的網格（只在 arranged=true）
internal/<顎>.tri         只在服務移動過那一顎時才有，見下
```

- **座標系**：所有網格、矩陣、牙軸都在你送來的那份口掃的座標系。labels 照你那份口掃的面順序。
- 分牙前服務會做兩件事，都不改你的檔案：
  - 清掉漂浮的碎片：碎片的面在 labels 裡是 254，不會被刪掉。
  - 兩顎朝同一方向時，把上顎轉到咬合位置：轉動記在 `manifest.json` 的 `jaws.<顎>.scan.pose`（16 個數，上傳 → 內部），結果都已經轉回你的座標系。`internal/<顎>.tri` 是服務實際計算用的那份，面和 `scan/<顎>` 一一對應。
- 每個結果包都是完整的：這筆 job 沿用的東西（例如 c 用的口掃和標記）會原樣放進去，所以結果包可以直接當下一筆的 `bundle`。

### plan.json

```json
{"format": "toothssm-plan", "version": 1, "units": "mm", "frame": "scan",
 "jaws": {"upper": {"moved": "teeth",
                    "teeth": [{"fdi": 11, "matrix": [16 個數], "rot_deg": 3.2, "trans_mm": 1.1}],
                    "kept": [18, 28]},
          "lower": {}},
 "abo": {"before": {"TOTAL": 70, "RA": 15}, "after": {"TOTAL": 65, "RA": 15}, "ra_teeth": 24, "note": ""}}
```

- `matrix`：16 個數，列優先（row-major）的 4×4 齊次矩陣，在 `scan/<顎>` 的座標系：排好的位置 = M × [x, y, z, 1]ᵀ。對那顆牙的任何一點都適用：口掃上的牙冠、整顆牙都一樣。
- `kept`：沒有預測的牙（第三大臼齒），留在原位。`moved` 是 `teeth`（有整顆牙）或 `crowns`（只有牙冠）。
- ABO 是扣分，越低越好，用來比較排牙，不是 ABO 的及格標準。RA 只算有整顆牙的牙；完全沒有整顆牙時，RA 和 TOTAL 是 null。
- 同一份輸入重跑，矩陣會差到約 0.015 mm、0.06°；分牙在少數口掃上每次也會差幾十個面。要比較兩次結果，請用容許誤差，不要要求完全相同。

### 牙軸 teeth/axes.json

格式和 v1 的 `tooth_axes.json` 相同（見 v1 文件〈牙軸〉），座標系是你送來的口掃。

## 狀態（`GET /v2/jobs/{id}`）

| 欄位 | 說明 |
|---|---|
| `status` | `queued`、`running`、`succeeded`、`failed`、`cancelled` |
| `where`、`attempts` | 在哪台做、做了幾次（換台重做時是 2） |
| `progress` | 跑的時候：`step`（目前的步驟）、`step_elapsed_s`、生成時的 `teeth_done`／`teeth_total`、`waiting_for`（在等主機上的其他工作） |
| `predicted_finish_s` | 預估還要幾秒 |
| `timings` | `queued_s`（排隊）、`run_s`、`total_s`（建 job 到做完） |
| `summary` | 做完時：`manifest`、`labels`（每顎一個 base64 的 TRIMP）、`plan`、`axes`、`issues`、`warnings`、`steps_s`（每步秒數） |
| `result_url`、`result_bytes`、`result_sha256` | 結果包 |
| `warnings` | 例如 summary 太大沒放（上限 1 MB；結果包裡有同樣的東西） |
| `error` | 失敗時：`code`、`message` |

- `summary.labels` 的大小看口掃的面順序：面依空間排好的口掃一顎約 8 KB，面順序亂的一顎 50–110 KB。
- `issues` 是分牙和生成的問題清單，格式同 v1（見 v1 文件〈問題回報〉）。有問題 job 也不會停。

## 錯誤

建 job 時（HTTP 回應）：

| HTTP | `error.code` | 原因 |
|---|---|---|
| 400、422 | `invalid_request` | JSON 格式、欄位錯；`steps` 不是非空的 list；`job:<id>` 找不到、不是你的、不是 v2、還沒做完 |
| 409 | `conflict` | 這個 `job_id` 在分派器上剛好不能用（很少見），換一個 `job_id` 再送 |
| 503 | `no_capacity` | 現在沒有能做的主機（`Retry-After: 30`） |

job 失敗（`status` 是 `failed`）：

| `error.code` | 原因 | 要不要重送 |
|---|---|---|
| `input_rejected` | 主機拒絕輸入或參數；`message` 開頭是服務的錯誤碼和中文說明（下表） | 改了再送 |
| `input_fetch_failed` | 主機抓不到輸入網址（多半是過期） | 重新上傳再送 |
| `host_failed` | 主機出錯，已自動換一台重做一次，還是失敗 | 稍後再送 |
| `deadline_exceeded` | 超過建 job 時給的 `deadline_s` | — |

服務的錯誤碼（出現在 `input_rejected` 的 `message`）：`unknown_input`（沒有這個輸入名稱）、`missing_input`（缺哪些輸入）、`input_not_used`、`duplicate_input`（`crowns` 和口掃、labels、`bundle` 一起送）、`param_not_used`、`conflicting_params`（例如 `root=none` 又要排牙）、`invalid_params`、`invalid_input`（檔案讀不了，或標記和口掃對不上）、`step_failed`（某一步算失敗，例如分不出牙）。

## 時間

測試站實測（2026-11-11 下午）：一個去識別化的全口案例（上顎 1.7 MB、下顎 0.7 MB 的 `.tri.gz`），7 種組合各送一筆、一次一筆，都在嘉義算。

| `steps` | 全程（秒） | 其中主機計算 | 結果包 |
|---|---|---|---|
| `segment` | 26.2 | 24.9 | 2.5 MB |
| `generate`（`bundle`＝`job:<a>`） | 56.8 | 55.7 | 6.2 MB |
| `align`（`bundle`＝`job:<a>`） | 8.4 | 7.1 | 2.5 MB |
| `generate`＋`align`（`bundle`＝`job:<a>`） | 62.6 | 61.3 | 6.3 MB |
| `segment`＋`generate` | 80.3 | 78.9 | 6.3 MB |
| `segment`＋`align` | 31.1 | 29.8 | 2.5 MB |
| 三步 | 77.9 | 76.7 | 6.3 MB |

- 全程＝`POST /v2/jobs` 到狀態變成 `succeeded`，不含上傳口掃、下載結果包。
- 只送牙冠（`crowns`；同一個案例的牙冠，兩顎 24 顆、3.2 MB 的 zip；11-11 傍晚經 eztest 送一筆）：全程約 8.6 秒，其中服務計算 6.8 秒；上傳 zip 1.5 秒，結果包 3.3 MB。
- 全程比主機計算多 1.1–1.3 秒：主機從 S3 取輸入、把結果包放上 S3、通知分派器。
- 從台灣上傳兩顎（2.5 MB）約 2 秒，下載結果包 0.8–1.3 秒；實際看你們的網路。
- 同時有別的單、或嘉義的卡在忙時要排隊；`predicted_finish_s` 是分派器的預估。

## 從 v1 換到 v2

| v1 | v2 |
|---|---|
| `POST /v1/jobs`（預設一路做到排牙） | `steps: ["segment", "generate", "align"]` |
| `until=segment` | `["segment"]` |
| `until=generate` | `["segment", "generate"]` |
| `start=generate`＋`teeth` zip | `["generate"]`＋`bundle` |
| `start=align`＋`teeth` zip（要牙冠和整顆牙） | `["align"]`＋`bundle` 或口掃＋labels（整顆牙可以不給） |
| （沒有） | `["segment", "align"]`：分牙後直接排牙，約 28 秒 |
| `/run` 換參數重跑 | 新的 job，`inputs` 用 `job:<id>` |
| 精簡包 `contents=slim` | 結果包；v1 的精簡包也能當 v2 的 `bundle` |
| `result/tooth_axes.json` | `teeth/axes.json` |
| `aligned_transforms_world.json` | `plan.json` |
| 合併、上色的整顎網格 | 不提供 |
| 嘉義、台中兩個網址，自己備援 | 一個網址，分派器挑台、自動換台 |

## 範例（Python 標準函式庫）

```python
import json, os, time, urllib.request

B = "https://test-ai.inteware.com.tw"
H = {"CF-Access-Client-Id": os.environ["DISPATCHER_CF_ID"],
     "CF-Access-Client-Secret": os.environ["DISPATCHER_CF_SECRET"],
     "User-Agent": "ortho-team-test/1.0", "Content-Type": "application/json"}


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(B + path, data=data, headers=H, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def upload(path):
    u = call("POST", "/v2/uploads", {"filename": os.path.basename(path)})
    with open(path, "rb") as fh:          # S3 的簽名網址：不帶 Cloudflare 的 header
        req = urllib.request.Request(u["put_url"], data=fh.read(), method="PUT",
                                     headers={"User-Agent": H["User-Agent"]})
    urllib.request.urlopen(req, timeout=300).close()
    return u["get_url"]


def run(steps, inputs):
    job = call("POST", "/v2/jobs", {"service": "toothssm", "inputs": inputs,
                                    "params": {"steps": steps}})
    while True:
        s = call("GET", f"/v2/jobs/{job['id']}?wait=20")
        if s["status"] in ("succeeded", "failed", "cancelled"):
            return s


scans = {"upper.scan": upload("upper.stl.gz"), "lower.scan": upload("lower.stl.gz")}
a = run(["segment"], scans)                          # 分牙
assert a["status"] == "succeeded", a.get("error")
c = run(["align"], {"bundle": "job:" + a["id"]})     # 用分牙結果直接排牙
plan = c["summary"]["plan"]                          # 每顆牙的矩陣、ABO
urllib.request.urlretrieve(c["result_url"], "result.zip")
call("DELETE", f"/v2/jobs/{a['id']}")
call("DELETE", f"/v2/jobs/{c['id']}")
```

只送分開的牙冠（接上面的 `call`、`upload`、`run`）：

```python
import zipfile

with zipfile.ZipFile("crowns.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for fdi, path in my_crowns.items():           # {11: "out/11.stl", ..., 47: "out/47.stl"}：兩顎每顆牙一個檔
        z.write(path, f"{fdi}.stl")                    # zip 裡的檔名就是牙位
c = run(["align"], {"crowns": upload("crowns.zip")})
assert c["status"] == "succeeded", c.get("error")
plan = c["summary"]["plan"]                            # 矩陣在你們牙冠的座標系
call("DELETE", f"/v2/jobs/{c['id']}")
```
