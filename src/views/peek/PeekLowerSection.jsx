/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Checkbox, InputNumber, Slider, Tag } from 'antd';

import { downloadBlob } from '../../utils/tool/useStores';
import { PEEK_DEFAULTS } from './peekParams';

// ezai-pipeline app/peek_lower.py RANGES -- keep the two in step.
const PEEK_RANGES = {
  interface_diameter_mm: [3.0, 6.5],
  chimney_diameter_mm: [2.0, 5.0],
  chimney_height_mm: [1.5, 8.0],
  collar_height_mm: [0.0, 4.0],
  depth_mm: [0.5, 7.0],
  offset_md_mm: [-4.0, 4.0],
  offset_bl_mm: [-4.0, 4.0],
  tilt_md_deg: [-30, 30],
  tilt_bl_deg: [-30, 30],
};
// The service's own warning threshold for PEEK around the chimney (MIN_WALL_WARN_MM).
const MIN_WALL_WARN_MM = 0.5;

const SOURCE_LABEL = { tunnel: '依隧道估計', caller: '手動', default: '預設值' };

const fmt = (value, digits = 2) => (value == null ? '—' : Number(value).toFixed(digits));

/**
 * Step 5 of the peek abut tab: the PEEK crown's lower part, from the outer shell down onto a
 * titanium base. FIRST VERSION: the base is a placeholder cylinder and where it sits is an
 * estimate, so every value is adjustable and a finished job re-runs in about a second.
 *
 * Props: enabled / setEnabled (build it with the next job), params / setParams, state
 * ({record, warnings, seconds} | null), canRerun, busy, error, onRerun, result (the job, for
 * the downloads and the job id), running (a whole job in flight).
 */
const PeekLowerSection = ({
  enabled, setEnabled, params, setParams, state, canRerun, busy, error, onRerun, result, running,
}) => {
  const set = (key, value) => setParams(prev => ({ ...prev, [key]: value }));
  const iface = state?.record?.interface;
  const disabled = Boolean(running) || busy;

  const number = (key, label, step = 0.1, unit = 'mm') => <label key={key}>
    {label}（{unit}）
    <InputNumber
      size='small'
      min={PEEK_RANGES[key][0]}
      max={PEEK_RANGES[key][1]}
      step={step}
      value={params[key]}
      onChange={value => set(key, value ?? PEEK_DEFAULTS[key])}
      disabled={disabled}
    />
  </label>;

  // A value that defaults to auto: a checkbox, and a number that is only used when it is off.
  // While auto, the field shows what the last result actually used, as a hint.
  const auto = (key, label, used) => <label key={key}>
    <span>
      {label}（mm）
      <Checkbox
        className='peek-auto'
        checked={params[key] == null}
        onChange={e => set(key, e.target.checked ? null : Number((used ?? 0).toFixed(2)))}
        disabled={disabled}
      >自動</Checkbox>
    </span>
    <InputNumber
      size='small'
      min={PEEK_RANGES[key][0]}
      max={PEEK_RANGES[key][1]}
      step={0.1}
      value={params[key]}
      placeholder={used != null ? `自動：${fmt(used)}` : '自動'}
      onChange={value => set(key, value)}
      disabled={disabled || params[key] == null}
    />
  </label>;

  // What the shown result was built with, not what the form says now.
  const cut = state?.record?.parameters?.cavity !== false;
  const wall = state?.record?.min_wall_mm;
  // With the cavity off the wall is still measured: how much PEEK a later cut would leave.
  const ifCut = cut ? '' : '若挖孔：';
  const wallTag = wall == null ? null
    : wall < 0 ? <Tag color='red'>{ifCut}煙囪穿出牙冠 {fmt(-wall)} mm</Tag>
      : wall < MIN_WALL_WARN_MM ? <Tag color='orange'>{ifCut}最薄 {fmt(wall)} mm</Tag>
        : <Tag color='green'>{ifCut}最薄 {fmt(wall)} mm</Tag>;
  const warnings = (state?.warnings ?? []).filter(w => !w.includes('first version'));

  return <section className='panel-section'>
    <div className='section-title'><span className='step'>5</span>PEEK 下半部（初版）</div>
    <Checkbox checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={Boolean(running)}>
      生成牙冠時一併生成 PEEK 下半部與鈦基座
    </Checkbox>
    <Alert
      className='section-alert'
      type='warning'
      showIcon
      message='鈦基座的尺寸是佔位值，位置是從口掃估計的，只供看效果，不能拿去製作。'
    />

    <div className='peek-group-title'>鈦基座</div>
    <Checkbox
      className='peek-cavity'
      checked={params.cavity}
      onChange={e => set('cavity', e.target.checked)}
      disabled={disabled}
    >
      在 PEEK 上挖出鈦基座的孔
    </Checkbox>
    {!params.cavity && <p className='panel-note'>
      {'不挖孔：PEEK 底部在介面圓上封平。鈦基座仍會顯示在原位（可在畫面的圖層開關隱藏），'
        + '「最薄」量的是之後挖孔會剩下多少 PEEK。'}
    </p>}
    <div className='field-row peek-grid'>
      {number('interface_diameter_mm', '介面直徑')}
      {number('chimney_diameter_mm', '煙囪直徑')}
      {number('chimney_height_mm', '煙囪高度')}
      {number('collar_height_mm', '領口高度')}
    </div>
    <div className='peek-group-title'>位置與軸向</div>
    <div className='field-row peek-grid'>
      {auto('depth_mm', '深度（邊緣線下）', iface?.depth_mm)}
      {auto('offset_md_mm', '近遠心偏移（近心 +）', iface?.offset_md_mm)}
      {auto('offset_bl_mm', '頰舌偏移（頰側 +）', iface?.offset_bl_mm)}
      {number('tilt_md_deg', '近遠心傾斜（近心 +）', 1, '°')}
      {number('tilt_bl_deg', '頰舌傾斜（頰側 +）', 1, '°')}
    </div>
    <div className='peek-group-title'>出齦輪廓</div>
    <Slider
      min={-1}
      max={1}
      step={0.1}
      value={params.profile}
      onChange={value => set('profile', value)}
      marks={{ '-1': '凹', 0: '直', 1: '凸' }}
      disabled={disabled}
    />

    <div className='button-row'>
      <Button type='primary' onClick={onRerun} loading={busy} disabled={!canRerun || Boolean(running)}>
        套用參數（重算下半部）
      </Button>
      <Button onClick={() => setParams({ ...PEEK_DEFAULTS })} disabled={disabled}>恢復預設</Button>
    </div>
    {!canRerun && !running && <p className='panel-note'>
      先生成一次牙冠外壁（勾選上面的選項），之後調整參數只需重算下半部，約 1 秒。
    </p>}
    {error && <Alert className='section-alert' type='error' showIcon message={error} />}

    {state?.record && <div className='peek-result'>
      <div>
        <Tag>深度 {fmt(iface.depth_mm)} mm · {SOURCE_LABEL[iface.depth_source] ?? iface.depth_source}</Tag>
        <Tag>近遠心 {fmt(iface.offset_md_mm)} · 頰舌 {fmt(iface.offset_bl_mm)} mm</Tag>
        <Tag>軸向傾斜 {fmt(iface.axis_tilt_from_ring_normal_deg, 1)}°</Tag>
        {!cut && <Tag color='blue'>未挖鈦基座孔</Tag>}
        {wallTag}
        <Tag color={state.record.watertight ? 'default' : 'red'}>{state.record.watertight ? '封閉實體' : '不封閉'}</Tag>
      </div>
      <div className='peek-meta'>
        隧道：{state.record.tunnel ? `深 ${fmt(state.record.tunnel.depth_mm)} mm` : '未偵測到'}
        {' · '}下半部高 {fmt(state.record.emergence_height_mm)} mm
        {state.seconds != null && ` · 重算 ${state.seconds.toFixed(1)} 秒`}
      </div>
      <div className='button-row'>
        {result?.peekCrown && <Button size='small' onClick={() => downloadBlob(result.peekCrown, result.fileName.replace('pipeline_crown', 'peek_crown'))}>
          下載 PEEK 牙冠
        </Button>}
        {result?.tibase && <Button size='small' onClick={() => downloadBlob(result.tibase, result.fileName.replace('pipeline_crown', 'tibase_proxy'))}>
          下載鈦基座
        </Button>}
      </div>
    </div>}
    {warnings.length > 0 && <ul className='warning-list'>
      {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
    </ul>}
  </section>;
};

export default PeekLowerSection;
