# 牙冠設計 API 更新內容

最新的一版在最上面。每次 API 更新都會在這裡加一節，並同步更新「API 串接文件」。這裡的 API 是牙冠生成 pipeline（網址結尾 `/pipeline`）：上傳口掃與牙位，回傳牙冠。

## 2026-11-04　貼合鄰牙不再在牙冠側面留下折痕（兩台）

嘉義 10:55、台中 11:01 換版：pipeline 各約 1 秒不能用，當時沒有 job 在跑。牙冠服務沒有動。

- **只改有做貼合鄰牙的牙冠**（`contact_fit` 預設開，牙冠穿進鄰牙才會動）。以前整平穿進鄰牙的那面牆時，margin 上方 1 mm 的牙齦帶也跟著重算，再在 0.5 mm 內接回原位；牆被移動將近 1 mm 的地方，就在 margin 上方約 1 mm、靠鄰牙那一側折出一條線（v3、HeyGears 都會）。現在牙齦帶固定不動，牆從它的邊緣照原本的斜度接上去。
- **效果**（同一批牙冠只換這一步：100 例後牙 v3、同 100 例 HeyGears、118 顆前牙）：
  - 有折痕的牙冠：v3 65/84 → 0、HeyGears 65/82 → 0、前牙 29/92 → 0（分母是有做貼合的牙冠）。
  - 被移動的部分離技師的牙冠：v3 0.168 → 0.164 mm、HeyGears 0.197 → 0.183 mm、前牙 0.259 → 0.260 mm。
  - 推完還留下的重疊（中位數）多約 0.02 mm，照樣留給編修並發警告。
- **換版檢查**（兩台各 38 筆，換版前後一次一筆：13 個病例、單顎 FDI 13、5 個無支台齒病例，各送預設與 `contact_fit=false`）：
  - `contact_fit=false` 的 19 筆逐位元組相同（只有 `manifest.json` 的時間不同）。
  - 預設的 19 筆：沒穿進鄰牙的 3 筆、整平的地方碰不到牙齦帶的 1 筆也相同；其他 15 筆只有 `crown.ply` 變了。折痕 6 → 0，兩台結果一樣。
- **速度**：有做貼合的牙冠這一步快約 0.1–0.2 秒（13 個病例中位數：嘉義 0.84 → 0.63 秒、台中 0.85 → 0.72 秒）。
- **API 沒有變**：參數、回傳欄位都一樣。台中這次只換了貼合鄰牙，仍然不認得 `crown_model`、`occlusal_detail`。
- 不要貼合鄰牙時照舊送 `contact_fit=false`。

## 2026-11-04　咬合面細節：`occlusal_detail=1`（先上嘉義）

嘉義（`https://ezai2.inteware.com.tw/pipeline`）08:49–08:51 換版：牙冠服務約 14 秒、pipeline 約 2 秒不能用，當時沒有 job 在跑。台中還沒有換。

- **新參數 `occlusal_detail`**（網址參數，不是表單欄位）：`occlusal_detail=1` 讓牙冠服務在生成後沿窩溝、窩往下挖深，補回模型磨平的咬合面細節。也可以給 0–2 的強度（`0.5` 挖一半深、`2` 挖兩倍深）；不帶或 `0` 就是原本的牙冠。
- **只往下挖**：牙尖、接觸點、外壁和邊緣不動，牙冠不會更靠近對咬牙，`occlusal_clearance` 留的間隙照樣保留。v3、HeyGears 模型都能用。
- **只處理小臼齒和大臼齒**（牙位第二碼 4–7）：其他牙位帶了也照常生成，只是不補，`warnings` 會註明。
- **不帶新參數的呼叫完全不變**：換版前後用 13 個病例、單顎 FDI 13、5 個無支台齒病例比對，輸出逐位元組相同（只有 `manifest.json` 的時間不同）。
- **新欄位**（只有帶了這個參數的 job 才有）：`manifest.json` 的 `backends.crown.occlusal_detail` 是 `applied`（有補）、`skipped: …`（牙位不適用）或 `failed: …`（處理失敗，回傳模型原本的牙冠，job 仍然成功）；`backends.crown.occlusal_detail_info` 是移動了多少（`deepest_mm` 最深、`mean_mm` 平均、`moved` 頂點數、`seconds`）。`GET /` 的 `options` 多了 `occlusal_detail`。
- **台中還不認得 `occlusal_detail`**：送了不會報錯、也沒有警告，拿到的牙冠沒有補細節，`manifest.json` 也沒有這兩個欄位。要寫成兩台通用，先看 `GET /` 的 `options`。
- **效果**（第二批 75 例 HeyGears 病例，沒有參與訓練，一次一個請求，和 HeyGears 技師的牙冠比）：
  - 咬合面起伏（越大越銳利）：HeyGears＋0.2 mm 0.123 → 0.139（多 12.6%，74/75 例變銳利），技師 0.157；v3 0.132 → 0.148。
  - 窩溝深度 0.986 → 1.078 mm（技師 1.107）；牙尖斜度 18.1° → 19.1°（技師 21.3°）。
  - 形態誤差不變（HeyGears 0.181 → 0.182 mm，47/75 例更接近技師）。
  - 逐頂點量，沒有任何一顆牙冠更靠近對咬牙。移動量平均 0.04 mm，最深約 0.19 mm（最多 0.33 mm）。
- **速度**：每顆多約 0.1 秒（只用 CPU）。

## 2026-11-03　HeyGears 牙冠模型：`crown_model=heygears`（先上嘉義）

嘉義（`https://ezai2.inteware.com.tw/pipeline`）07:30–07:35 換版：牙冠服務約 15 秒、pipeline 約 2 秒不能用，當時沒有 job 在跑。台中還沒有換。

- **新參數 `crown_model`**（網址參數，不是表單欄位）：`crown_model=heygears` 用 HeyGears 風格的牙冠模型生成；不帶就是原本的模型（v3）。
- **不帶新參數的呼叫完全不變**：換版前後各送 19 筆檢查 job（13 筆全口、1 筆單顎、5 筆無支台齒），牙冠和其他結果檔逐位元組相同；每筆時間也一樣（6 筆合計 25.45 → 25.43 秒）。
- HeyGears 模型是用 HeyGears 技師的 exocad 牙冠（191 例中能用的 186 例，加上原本的訓練資料）再訓練 v3 而成。**只學過小臼齒和大臼齒**（牙位第二碼 4–7）：前牙、犬齒、智齒帶了 `heygears` 也會用 v3 生成，並在 `warnings` 註明。
- **建議一起送 `occlusal_clearance=0.2`**：HeyGears 的設計習慣是牙冠和對咬牙留約 0.2 mm，模型自己學不到，要靠這個參數在生成後調整。
- **新欄位**：`manifest.json` 的 `backends.crown.model` 是這顆牙冠實際用的模型（`heygears` 或 `default`）。所有 job 都有；沒帶 `crown_model` 時是 `default`。
- 名稱打錯（例如 `heygear`）時 job 會失敗，`error` 列出這台有哪些模型。`GET /` 的 `options` 多了 `crown_model`，可以用它判斷一台主機認不認得這個參數。
- **台中還不認得 `crown_model`**：送了不會報錯、也沒有警告，拿到的是 v3 牙冠，`manifest.json` 也沒有 `backends.crown.model`。HeyGears 的 job 請先只送嘉義，並檢查 `backends.crown.model`。
- **效果**（第二批 75 例 HeyGears 病例，沒有參與訓練，和 HeyGears 技師的牙冠比）：
  - 去掉大小差異後的形態誤差：v3 0.214 → HeyGears 0.181 mm，少 15%；83% 的病例變好。
  - 咬進對咬牙的病例：v3 36 例；HeyGears 30 例；HeyGears 加 0.2 mm 間隙 10 例。
  - 近心鄰接區的高度補上和 HeyGears 之間 77% 的差距；頰舌側外形的凸出量這批沒有改善。
- **速度**（牙冠服務每顆，75 例、一次一個）：v3 2.61 秒、HeyGears 2.48 秒、HeyGears＋0.2 mm 2.85 秒。
- 同時上線：牙冠服務每個請求後會釋放記憶體，長時間執行更穩定。結果不受影響。

## 2026-10-08　前牙參考對側牙（`contralateral=true`）、牙冠邊緣過渡（兩台）

- `contralateral=true`（表單欄位）：前牙（牙位第二碼 1–3）的形狀擬合另一側的同名牙，每顆約多 2 秒。對側缺牙、也是支台齒或只掃半邊時不套用，原因寫在 `warnings` 與 `manifest.json` 的 `backends.crown.contralateral`。
- 不用送參數：牙冠外壁邊緣往內拉回超過 1 mm 時，改用 5 mm 的過渡，去掉頸部的垂直牆和轉角。`manifest.json` 多 `backends.crown.rim_pull_mm`、`rim_falloff_mm`。

## 2026-10-06／10-07　無支台齒、貼合鄰牙預設開、上顎前牙單顎替身（台中 10-06、嘉義 10-07）

- `no_abutment=true`：還沒有支台齒的位置（例如植體），搭配 `mode=margin_override` 與你畫的 margin。服務在 margin 裡放一個虛擬支台齒再生成牙冠，多回傳 `virtual_prep.ply`；牙冠只用外表面。
- `contact_fit`：**所有 job 預設開**。牙冠穿進鄰牙的那面牆會被整平、往回推最多 0.3 mm；推完還重疊的留給編修，並在 `warnings` 說明。每個 job 約多 0.6–1 秒。送 `contact_fit=false` 就和之前逐位元組相同。
- 單顎（`single_arch=true`）的上顎前牙（11–13、21–23）改用舌側斜面當對咬替身，結果和之前不同。

## 2026-09-30　台中也收 `.tri` 與 gzip

台中和嘉義一樣：口掃可以是 `.tri`，任何輸入都可以再加 `.gz`。

## 2026-09-24　嘉義收 gzip（`.gz`）

任何輸入（口掃、margin）都可以 gzip 後上傳，檔名加 `.gz`，例如 `upper.tri.gz`。用網址傳檔時，檔案的路徑也要照這樣命名。

## 2026-09-18　嘉義收 `.tri` 口掃

口掃除了 `.stl`、`.ply`、`.obj`，也可以是公司的 `.tri`（V1、V2）。結果和同一份口掃用 STL 送逐位元組相同，檔案只有 STL 的約 0.4 倍大。

## 2026-09-16　單顎（`single_arch=true`，兩台）

只送備牙那一顎。對咬用鄰牙高度的平面代替，每顆牙冠都會有一則警告：咬合面不是照真實咬合做的。

## 2026-09-01　margin 模式與網址傳檔（台中；嘉義 8 月底起）

- `mode=margin_only`（只預測 margin）、`mode=margin_override`（用你的 margin 生成牙冠，不跑 margin 模型）。
- `upper_stl_url`、`lower_stl_url`、`margin_pts_url`：給 https 網址（例如 S3 的 presigned URL），服務自己去抓，不必上傳整個檔案。
