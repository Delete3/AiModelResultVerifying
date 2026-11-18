/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Button, InputNumber, Radio, Tooltip } from 'antd';

import {
  CLEARANCE_RANGE, CUTBACK_RANGE, CUTBACK_STYLES, DEFAULT_CLEARANCE, DEFAULT_CUTBACK, DEFAULT_OCCLUSAL, DEFAULT_SHOULDER,
  HEIGHT, OCCLUSAL_RANGE, SHAPE_LABEL, SHOULDER_RANGE, family, isLibrary, withShape,
} from './stumpSpec';

const formatAxis = values => values.map(v => Number(v).toFixed(3)).join(', ');

const SHAPE_TIP = {
  virtual: '一般的虛擬支台齒：高度＝牙齦到對咬的距離減 1.5 mm（限制在 1.5–4.0 mm），錐度 8°。AIrDesign 的 PEEK 流程用的就是這個。',
  library: '形狀取自 EZCAD 支台齒資料庫；高度、傾斜、寬度用 101 trainingData 同一牙位真實支台齒的中位數，不超出 margin、離對咬至少 1.0 mm，沿 margin 縫進口掃（沒有縫隙）。',
  cutback: '先在資料庫支台齒上生成牙冠，再把牙冠往內縮一層牙冠的厚度，剩下的就是支台齒（EZCAD 從解剖形牙冠做 abutment 的做法）。高度由牙冠決定；空間不夠切不出來時改回資料庫支台齒並說明。',
};

const STYLE_TIP = {
  scaled: '肩台與軸面和舊版一樣（軸面內縮、每邊往內傾 6°），咬合面改用牙冠自己的咬合面在平面上等比縮進來（高度不縮），再沿插入方向降下，牙尖和溝留在支台齒頂部。縮放比例寫在紀錄裡（植體常見 1.5–2.5 倍，自然牙約 1.2–1.6 倍）。',
  ring: '軸面從 margin 內縮（靠近 margin 的 2 mm 內逐漸收到肩台寬），咬合面沿插入方向內縮，軸面每邊往內傾 6°。不是等距內縮：margin 比牙冠窄很多時（植體），支台齒大半是錐面、牙尖會被切掉。',
};

/**
 * The stump's controls: shape, size, and (library shapes) the insertion direction. For 「支台齒」
 * this is the result; for 「PEEK abut」 it is what the crown is built over.
 *
 * Props: spec / setSpec (stumpSpec.js; setSpec takes an updater), shapes (the shapes offered, the
 * first being the default), product ('stump' | 'peek', for the wording), busy, hasPrep, hasRing,
 * shownAxis (the arrow's axis, or null), onCaptureView, onLookAlong.
 */
const StumpOptions = ({ spec, setSpec, shapes, product, busy, hasPrep, hasRing, shownAxis, onCaptureView, onLookAlong }) => {
  const set = patch => setSpec(prev => ({ ...prev, ...patch }));
  const cutback = spec.shape === 'cutback';
  const library = isLibrary(spec);
  const height = HEIGHT[family(spec.shape)];
  const disabled = Boolean(busy);

  return <>
    <Radio.Group
      className='option-radios'
      value={spec.shape}
      onChange={e => setSpec(prev => withShape(prev, e.target.value))}
      disabled={disabled}
      options={shapes.map(shape => ({
        value: shape,
        label: <Tooltip title={SHAPE_TIP[shape]}>{SHAPE_LABEL[shape]}{shape === shapes[0] ? '（預設）' : ''}</Tooltip>,
      }))}
    />
    {cutback && <Radio.Group
      className='option-radios'
      value={spec.cutbackStyle}
      onChange={e => set({ cutbackStyle: e.target.value, cutbackMm: DEFAULT_CUTBACK[e.target.value] })}
      disabled={disabled}
      options={CUTBACK_STYLES.map(({ value, label }) => ({
        value,
        label: <Tooltip title={STYLE_TIP[value]}>{label}</Tooltip>,
      }))}
    />}
    {!cutback && <Radio.Group
      className='option-radios'
      value={spec.heightMode}
      onChange={e => set({ heightMode: e.target.value })}
      disabled={disabled}
      options={[{ label: library ? '自然高度' : '自動高度', value: 'auto' }, { label: '指定高度', value: 'manual' }]}
    />}
    <div className='field-row'>
      {spec.heightMode === 'manual' && !cutback && <label>
        高度（mm）
        <InputNumber min={height.range[0]} max={height.range[1]} step={0.5} value={spec.height}
          onChange={v => set({ height: v ?? height.initial })} disabled={disabled} />
      </label>}
      {cutback && <label>
        軸面內縮（mm）
        <InputNumber min={CUTBACK_RANGE[0]} max={CUTBACK_RANGE[1]} step={0.1} value={spec.cutbackMm}
          onChange={v => set({ cutbackMm: v ?? DEFAULT_CUTBACK[spec.cutbackStyle] })} disabled={disabled} />
      </label>}
      {cutback && <label>
        咬合面內縮（mm）
        <InputNumber min={OCCLUSAL_RANGE[0]} max={OCCLUSAL_RANGE[1]} step={0.1} value={spec.occlusalMm}
          onChange={v => set({ occlusalMm: v ?? DEFAULT_OCCLUSAL })} disabled={disabled} />
      </label>}
      <label>
        肩台寬（mm）
        <InputNumber min={SHOULDER_RANGE[0]} max={SHOULDER_RANGE[1]} step={0.1} value={spec.shoulder}
          onChange={v => set({ shoulder: v ?? DEFAULT_SHOULDER[family(spec.shape)] })} disabled={disabled} />
      </label>
      {library && !cutback && <label>
        離對咬（mm）
        <InputNumber min={CLEARANCE_RANGE[0]} max={CLEARANCE_RANGE[1]} step={0.1} value={spec.clearance}
          onChange={v => set({ clearance: v ?? DEFAULT_CLEARANCE })} disabled={disabled} />
      </label>}
    </div>
    <p className='panel-note'>
      {spec.shape === 'virtual' && <>自動高度：牙齦到對咬的距離減 1.5 mm（1.5–4.0 mm）。牙齦到對咬不到 3 mm 時放不下牙冠，結果會標示。</>}
      {spec.shape === 'library' && <>自然高度＝同牙位真實支台齒的中位數；對咬太近時自動降低（不低於 2 mm），結果會標示。高度從 margin 平均高度量到頂端。</>}
      {cutback && (product === 'peek'
        ? <>牙冠照樣長在資料庫支台齒上（外壁和選「資料庫支台齒」相同），回傳的支台齒是這顆牙冠往內縮剩下的部分。</>
        : <>先用資料庫支台齒（自然高度、離對咬 {DEFAULT_CLEARANCE} mm）生成牙冠再往內縮；牙冠半透明畫在支台齒外面。</>)}
      {' '}選項的做法：把滑鼠移到選項上。
    </p>

    {library && <>
      <Radio.Group
        className='option-radios'
        value={spec.axisMode}
        onChange={e => set({ axisMode: e.target.value })}
        disabled={disabled}
        options={[
          { label: '插入方向：自然傾斜', value: 'natural' },
          { label: '目前視角', value: 'view' },
          { label: '指定（scan body）', value: 'manual' },
        ]}
      />
      {spec.axisMode === 'view' && <div className='button-row'>
        <Tooltip title='和 AIrDesign 的 insertion operation 一樣：把畫面轉到從插入方向看過去的角度（看不到倒凹）再按；插入方向＝相機視線的反方向。轉畫面不會自動更新，要再按一次。'>
          <Button size='small' type={spec.viewAxis ? 'default' : 'primary'} onClick={onCaptureView} disabled={disabled || !hasPrep}>
            設為目前視角
          </Button>
        </Tooltip>
        <span className='target-hint'>{spec.viewAxis ? `[${formatAxis(spec.viewAxis)}]` : '還沒設定'}</span>
      </div>}
      {spec.axisMode === 'manual' && <div className='field-row three'>
        {['x', 'y', 'z'].map((name, index) => <label key={name}>
          {name}
          <InputNumber step={0.1} value={spec.axis[index]} disabled={disabled}
            onChange={v => set({ axis: spec.axis.map((p, i) => (i === index ? (v ?? 0) : p)) })} />
        </label>)}
      </div>}
      {shownAxis && <div className='button-row'>
        <Button size='small' onClick={onLookAlong} disabled={!hasPrep || !hasRing}>從插入方向看</Button>
        {spec.axisMode === 'natural' && <span className='target-hint'>綠色箭頭：上次結果用的自然傾斜</span>}
      </div>}
      <p className='panel-note'>插入方向用口掃上傳時的座標（正負都可以）；離咬合方向超過 60° 服務會拒絕，超過 30° 會警告。</p>
    </>}
  </>;
};

export default StumpOptions;
