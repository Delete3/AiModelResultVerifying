/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Cascader, Checkbox, InputNumber, Radio, Slider, Tag } from 'antd';

import { writeBinaryStl } from '../../utils/loader/meshConvert';
import { downloadBlob } from '../../utils/tool/useStores';
import { PEEK_DEFAULTS, PEEK_RANGES } from './peekParams';

// Below this the PEEK around the titanium is called thin. A placeholder, like the base.
const MIN_WALL_WARN_MM = 0.5;
// A rim vertex moved further than this to straighten the rim means the shell's rim was not
// much of a rim (the broken FDI 47 shell needed 4.2 mm).
const RIM_MOVE_WARN_MM = 0.5;

const SOURCE_LABEL = { tunnel: '依隧道估計', caller: '手動', default: '預設值' };

const fmt = (value, digits = 2) => (value == null ? '—' : Number(value).toFixed(digits));
const seconds = ms => `${(ms / 1000).toFixed(2)} 秒`;

const saveStl = (geometry, fileName) => {
  const bytes = writeBinaryStl(geometry.getAttribute('position').array, geometry.index?.array ?? null);
  downloadBlob(new Blob([bytes], { type: 'model/stl' }), fileName);
};

/** The library index as Cascader options: system → type → subtype. */
const libraryOptions = index => (index?.systems ?? []).map(system => ({
  value: system.name,
  label: system.name.replace(/^Inteware /, ''),
  children: system.types.map(type => ({
    value: type.name,
    label: type.name,
    children: type.subtypes.map(subtype => ({ value: subtype.name, label: subtype.name })),
  })),
}));

/**
 * Step 5 of the peek abut tab: the PEEK crown's lower part, built in this browser from the
 * outer shell the service returned, the way AIrDesign builds it (AbutmentLoft.js). The
 * implant position is an estimate (no scan body here), and the titanium base is either a
 * generic placeholder or a part from the implant library when this instance has one.
 * Every change rebuilds it; a change to the implant position re-fits the shell too.
 *
 * Props: enabled / setEnabled (build it after each job), params / setParams,
 * library / setLibrary (a {system, type, subtype} or null for the generic base),
 * libraryIndex (null when this instance has no library), state (the last build, or null),
 * busy, error, hasShell (a job's shell to build on), onRebuild, result (the job, for the
 * file names), running (a whole job in flight).
 */
const PeekLowerSection = ({
  enabled, setEnabled, params, setParams, library, setLibrary, libraryIndex, state, busy, error,
  hasShell, onRebuild, result, running,
}) => {
  const set = (key, value) => setParams(prev => ({ ...prev, [key]: value }));
  const placement = state?.placement;
  const disabled = Boolean(running);

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

  const slider = (key, label, marks) => <div key={key} className='peek-slider'>
    <div className='peek-slider-label'>{label}：{fmt(params[key], 1)} mm</div>
    <Slider
      min={PEEK_RANGES[key][0]}
      max={PEEK_RANGES[key][1]}
      step={0.1}
      value={params[key]}
      onChange={value => set(key, value)}
      marks={marks}
      disabled={disabled}
    />
  </div>;

  // What the shown result was built with, not what the form says now.
  const record = state?.record;
  const wall = record?.min_wall_mm;
  const ifCut = state && !state.cavity ? '若挖孔：' : '';
  const wallTag = wall == null ? null
    : wall < 0 ? <Tag color='red'>{ifCut}鈦基座穿出 PEEK {fmt(-wall)} mm</Tag>
      : wall < MIN_WALL_WARN_MM ? <Tag color='orange'>{ifCut}最薄 {fmt(wall)} mm</Tag>
        : <Tag color='green'>{ifCut}最薄 {fmt(wall)} mm</Tag>;
  // A library interface keeps its screw-channel hole open, as in AIrDesign: that one is expected.
  const expectedOpen = state && !state.generic ? 1 : 0;
  const openTag = record == null ? null
    : record.open_loops === expectedOpen
      ? <Tag>{expectedOpen ? '只剩螺絲通道開口（尚未做）' : '封閉實體'}</Tag>
      : <Tag color='red'>{record.open_loops - expectedOpen} 個非預期的開口</Tag>;
  const shell = state?.shell;
  const rimWarning = shell && shell.rim_max_move_mm > RIM_MOVE_WARN_MM;
  const fileBase = result?.fileName.replace('pipeline_crown', '%s').replace(/\.ply$/, '.stl');

  return <section className='panel-section'>
    <div className='section-title'><span className='step'>5</span>PEEK 下半部（在瀏覽器建置）</div>
    <Checkbox checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={disabled}>
      取回外壁後自動建置 PEEK 下半部
    </Checkbox>
    <Alert
      className='section-alert'
      type='info'
      showIcon
      message='pipeline 只回外壁；下半部在這裡用 AIrDesign 的同一套算法建置'
      description={<>
        外壁下緣先對齊 margin，再放樣接到鈦基座介面（airdental <code>AbutmentLoft.js</code>）。
        這裡沒有 scan body，<b>植體位置是從口掃估計的</b>；鈦基座可用通用的佔位尺寸，或模型庫的零件。只供看效果，不能拿去製作。
      </>}
    />

    <div className='peek-group-title'>鈦基座</div>
    <Radio.Group
      value={library ? 'library' : 'generic'}
      onChange={e => setLibrary(e.target.value === 'library' ? 'default' : null)}
      disabled={disabled}
      options={[
        { label: '通用（佔位尺寸）', value: 'generic' },
        { label: '模型庫', value: 'library', disabled: !libraryIndex },
      ]}
    />
    {!libraryIndex && <p className='panel-note'>這個實例沒有模型庫（public/implant-library），只能用通用尺寸。</p>}
    {library && libraryIndex && <Cascader
      className='peek-library'
      size='small'
      options={libraryOptions(libraryIndex)}
      value={[library.system, library.type, library.subtype]}
      onChange={value => value?.length === 3 && setLibrary({ system: value[0], type: value[1], subtype: value[2] })}
      allowClear={false}
      disabled={disabled}
    />}
    {!library && <>
      <Checkbox
        className='peek-cavity'
        checked={params.cavity}
        onChange={e => set('cavity', e.target.checked)}
        disabled={disabled}
      >
        在 PEEK 上挖出鈦基座的孔
      </Checkbox>
      <div className='field-row peek-grid'>
        {number('interface_diameter_mm', '介面直徑')}
        {number('chimney_diameter_mm', '煙囪直徑')}
        {number('chimney_height_mm', '煙囪高度')}
        {number('collar_height_mm', '領口高度')}
      </div>
    </>}

    <div className='peek-group-title'>植體位置與軸向</div>
    <div className='field-row peek-grid'>
      {auto('depth_mm', '平台深度', placement?.depth_mm)}
      {auto('offset_md_mm', '近遠心偏移', placement?.offset_md_mm)}
      {auto('offset_bl_mm', '頰舌偏移', placement?.offset_bl_mm)}
      {number('tilt_md_deg', '近遠心傾斜', 1, '°')}
      {number('tilt_bl_deg', '頰舌傾斜', 1, '°')}
    </div>
    <p className='panel-note'>深度是植體平台在 margin 環中心下方多少；偏移與傾斜都是近心、頰側為正。自動＝從口掃的軟組織隧道估計。</p>

    <div className='peek-group-title'>穿齦段（對應 AIrDesign 的 Abutment 設計）</div>
    {slider('radial_mm', '整體外擴（+）／內縮（−）', { '-1': '−1', 0: '0', 3: '+3' })}
    {slider('bone_avoid_mm', 'Bone avoidance（介面上方直上）', { 0: '0', 2: '2' })}

    <div className='button-row'>
      <Button onClick={onRebuild} loading={busy} disabled={!hasShell || disabled}>重新建置</Button>
      <Button onClick={() => setParams({ ...PEEK_DEFAULTS })} disabled={disabled}>恢復預設</Button>
    </div>
    {!hasShell && !running && <p className='panel-note'>
      先生成一次牙冠外壁；之後改這裡的參數會自動重建，不必再送 pipeline。
    </p>}
    {error && <Alert className='section-alert' type='error' showIcon message={error} />}

    {state && !state.error && <div className='peek-result'>
      <div>
        <Tag>植體深度 {fmt(placement.depth_mm)} mm · {SOURCE_LABEL[placement.depth_source] ?? placement.depth_source}</Tag>
        <Tag>近遠心 {fmt(placement.offset_md_mm)} · 頰舌 {fmt(placement.offset_bl_mm)} mm</Tag>
        <Tag>軸向傾斜 {fmt(placement.axis_tilt_deg, 1)}°</Tag>
        <Tag>{state.baseLabel}</Tag>
        {state.generic && !state.cavity && <Tag color='blue'>未挖鈦基座孔</Tag>}
        {wallTag}
        {openTag}
      </div>
      <div className='peek-meta'>
        建置 {seconds(state.prepareMs + record.build_ms)}
        {state.prepareMs > 0 && `（對齊外壁 ${seconds(state.prepareMs)}）`}
        {' · '}隧道：{placement.tunnel ? `深 ${fmt(placement.tunnel.depth_mm)} mm` : '未偵測到'}
        {' · '}介面直徑 {fmt(record.stitched_rim_mm)} mm
      </div>
      {shell && <div className='peek-meta'>
        外壁整理：合併 {shell.merged} 點、移除 {shell.dropped + shell.peeled} 面
        {shell.rim_backtracks > 0 && `；下緣 ${shell.rim_backtracks} 處逆行，轉正 ${shell.rim_moved} 點（最多 ${fmt(shell.rim_max_move_mm, 3)} mm）`}
      </div>}
      <div className='button-row'>
        <Button size='small' onClick={() => saveStl(state.solid, fileBase.replace('%s', 'peek_crown'))}>下載 PEEK 牙冠（STL）</Button>
        {state.tibase && <Button size='small' onClick={() => saveStl(state.tibase, fileBase.replace('%s', 'tibase'))}>下載鈦基座（STL）</Button>}
      </div>
    </div>}
    {rimWarning && <ul className='warning-list'>
      <li>外壁下緣很不規則（為了讓它繞軸單向，有點被移動了 {fmt(shell.rim_max_move_mm)} mm），外壁可能破損，請檢查。</li>
    </ul>}
  </section>;
};

export default PeekLowerSection;
