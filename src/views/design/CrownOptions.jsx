/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Checkbox, InputNumber, Select, Tooltip } from 'antd';

import { CROWN_MODELS, PIPELINE_TARGETS, isAnteriorFdi, isPosteriorFdi } from '../../utils/function/EzaiPipelineApi';
import targetWith from './targetWith';

const MODEL_TIP = '生成牙冠用的模型。「HeyGears 風格」（2026-11-11 換成新版）是用全部牙冠重新訓練、再用 HeyGears 技師的 exocad 牙冠微調的模型，只學過小臼齒、大臼齒，其他牙位會自動改用 v3（結果會註明）；勾「咬合面細節」時加上 HeyGears 咬合面紋路。盲評大多排第一，每顆比 v3 多約 0.5 秒。台中、嘉義（台中 11-17 起）、分派器、modal雲端都有。選它時會自動填咬合間隙 0.2、勾「咬合面細節」，改回 v3 時清空、取消勾選；都可以再手動改。';
const CLEARANCE_TIP = '牙冠咬合面和對咬牙之間至少留這個距離（mm），由牙冠服務在生成後調整。HeyGears 的設計習慣是 0.2，選 HeyGears 風格時自動填入。空白＝不另外留，其他客戶都是這樣。';
const CONTRA_TIP = '把整個口掃左右鏡射找出中線，讓牙冠的形狀接近另一側的同名牙（例如 11 參考 21）。位置仍照實際空間。對側缺牙、也是支台齒、或只掃半邊時會自動不套用，並說明原因。每顆約多 2 秒。';
const DETAIL_TIP = 'v3：生成後沿窩溝、窩往下挖深，補回模型磨平的咬合面細節；只往下挖，牙尖、接觸點、外壁和邊緣不動，每顆約多 0.1 秒。HeyGears 風格：改成 HeyGears 咬合面紋路（窩溝更細、更利，可升可降，升高的地方不碰到對咬牙），外壁和邊緣不動，每顆約多 0.4 秒；下顎第一小臼齒（34、44）還沒有紋路範本，不加。';

/**
 * The crown service's options -- model, clearance, contralateral, occlusal detail -- for whatever
 * builds a crown: a crown, a PEEK abut's shell, and the crown a cutback stump is cut back from.
 *
 * Props: site (the chosen target), fdi, prepJaw, busy, crownModel ('default' or a CROWN_MODELS
 * key), occlusalClearance, contralateral, occlusalDetail, onModel, onClearance, onContralateral,
 * onDetail, showContralateral (mode=stump refuses it), note (a line about what the crown is for).
 */
const CrownOptions = ({
  site, fdi, prepJaw, busy, crownModel, occlusalClearance, contralateral, occlusalDetail,
  onModel, onClearance, onContralateral, onDetail, showContralateral = true, note = null,
}) => {
  const model = CROWN_MODELS[crownModel] ?? null;
  const anterior = isAnteriorFdi(fdi);
  const posterior = isPosteriorFdi(fdi);
  // A tooth the model was not trained on is still sent; the crown service answers with v3.
  const modelSkipsTooth = Boolean(model && prepJaw && !model.teeth.includes(Number(fdi) % 10));
  const disabled = Boolean(busy);

  const modelOptions = [
    { value: 'default', label: <div className='target-option'><span>v3（預設）</span><span className='target-hint'>其他客戶都用這個</span></div> },
    ...Object.entries(CROWN_MODELS).map(([key, entry]) => {
      // Only selectable while the chosen pipeline serves it.
      const served = Boolean(site.crownModels?.includes(key));
      const where = PIPELINE_TARGETS[targetWith(s => s.crownModels?.includes(key))]?.label;
      return {
        value: key,
        disabled: !served,
        label: <div className='target-option'>
          <span>{entry.label}</span>
          <span className='target-hint'>{served ? entry.hint : where ? `pipeline 選「${where}」才能選` : '目前沒有主機'}</span>
        </div>,
      };
    }),
  ];

  return <>
    {note && <p className='panel-note'>{note}</p>}
    <div className='field-row'>
      <label>
        <Tooltip title={MODEL_TIP}>牙冠模型</Tooltip>
        <Select value={crownModel} onChange={onModel} options={modelOptions} disabled={disabled}
          popupMatchSelectWidth={false} labelRender={() => <span>{model ? model.label : 'v3（預設）'}</span>} />
      </label>
      <label>
        <Tooltip title={CLEARANCE_TIP}>咬合間隙 mm</Tooltip>
        <InputNumber min={-0.3} max={1} step={0.05} value={occlusalClearance} onChange={onClearance}
          placeholder='不指定' disabled={disabled} />
      </label>
    </div>
    {modelSkipsTooth && <Alert
      className='section-alert'
      type='info'
      showIcon
      message={`「${model.label}」只學過小臼齒、大臼齒：FDI ${fdi} 會用 v3 生成，結果會註明`}
    />}
    <div className='option-checks'>
      {showContralateral && <Tooltip title={anterior ? CONTRA_TIP : '只適用前牙（FDI x1–x3）'}>
        <Checkbox checked={contralateral} onChange={e => onContralateral(e.target.checked)} disabled={disabled || !anterior}>
          參考對側牙（前牙）
        </Checkbox>
      </Tooltip>}
      <Tooltip title={posterior ? DETAIL_TIP : '只適用小臼齒、大臼齒（FDI x4–x7）'}>
        <Checkbox checked={occlusalDetail} onChange={e => onDetail(e.target.checked)} disabled={disabled || !posterior}>
          咬合面細節（後牙）
        </Checkbox>
      </Tooltip>
    </div>
  </>;
};

export default CrownOptions;
