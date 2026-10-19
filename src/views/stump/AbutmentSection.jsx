/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Cascader, Checkbox, InputNumber, Radio, Slider, Tag } from 'antd';

import { writeBinaryStl } from '../../utils/loader/meshConvert';
import { downloadBlob } from '../../utils/tool/useStores';
import { PEEK_DEFAULTS, PEEK_RANGES } from '../peek/peekParams';

// Below this the material around the interface is called thin. A placeholder, like the base.
const MIN_WALL_WARN_MM = 0.5;

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
 * Step 5 of the 「產生支台齒」 tab: a custom abutment, built in this browser from the job's
 * stump the way EZCAD's abutment design builds one -- the stump down to the margin, the
 * emergence lofted from the margin to the implant interface, the interface stitched on
 * (abutmentBuilder.js). The implant stands on the stump's insertion axis; its depth and
 * offsets come from the scan's soft-tissue tunnel unless set. Every change rebuilds it.
 *
 * Props: enabled / setEnabled, params / setParams (peekParams.js's keys), library /
 * setLibrary (a {system, type, subtype} or null for the generic base), libraryIndex (null
 * when this instance has none), state (the last build, or null), busy, error, hasStump,
 * onRebuild, result (the job, for the file names), running.
 */
const AbutmentSection = ({
  enabled, setEnabled, params, setParams, library, setLibrary, libraryIndex, state, busy, error,
  hasStump, onRebuild, result, running,
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

  const record = state?.record;
  const wall = record?.min_wall_mm;
  const ifCut = state && !state.cavity ? '若挖孔：' : '';
  const wallTag = wall == null ? null
    : wall < 0 ? <Tag color='red'>{ifCut}介面穿出支台齒 {fmt(-wall)} mm</Tag>
      : wall < MIN_WALL_WARN_MM ? <Tag color='orange'>{ifCut}介面周圍最薄 {fmt(wall)} mm</Tag>
        : <Tag color='green'>{ifCut}介面周圍最薄 {fmt(wall)} mm</Tag>;
  const chimney = record?.chimney_wall_mm;
  const chimneyTag = chimney == null ? null
    : chimney < 0 ? <Tag color='red'>鈦基座煙囪穿出支台齒 {fmt(-chimney)} mm</Tag>
      : <Tag color={chimney < MIN_WALL_WARN_MM ? 'orange' : 'green'}>煙囪周圍最薄 {fmt(chimney)} mm</Tag>;
  // A library interface keeps its screw-channel hole open: that one is expected.
  const expectedOpen = state && !state.generic ? 1 : 0;
  const openTag = record == null ? null
    : record.open_loops === expectedOpen
      ? <Tag>{expectedOpen ? '只剩螺絲通道開口（尚未做）' : '封閉實體'}</Tag>
      : <Tag color='red'>{record.open_loops - expectedOpen} 個非預期的開口</Tag>;
  const fileBase = result ? `FDI${result.manifest?.fdi ?? ''}_${result.jobId}` : 'abutment';

  return <section className='panel-section'>
    <div className='section-title'><span className='step'>5</span>客製化支台齒（縫到植體 interface）</div>
    <Checkbox checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={disabled}>
      生成支台齒後自動建置
    </Checkbox>
    <Alert
      className='section-alert'
      type='info'
      showIcon
      message='照 EZCAD 的 abutment design：上半部（支台齒）→ 穿齦段 → 縫到 interface'
      description={<>
        上半部就是上面生成的支台齒（到 margin 的肩台為止）；從 margin 往下放樣到植體 interface（和 peek 分頁同一套算法，airdental <code>AbutmentLoft.js</code>），
        再和 interface 縫成一個實體。<b>沒有 scan body</b>：植體軸＝支台齒的插入方向，平台深度與偏移從口掃的軟組織隧道估計，都可以改。只供看效果，不能拿去製作。
      </>}
    />

    <div className='peek-group-title'>Interface</div>
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
    {library && libraryIndex && <>
      <Cascader
        className='peek-library'
        size='small'
        options={libraryOptions(libraryIndex)}
        value={[library.system, library.type, library.subtype]}
        onChange={value => value?.length === 3 && setLibrary({ system: value[0], type: value[1], subtype: value[2] })}
        allowClear={false}
        disabled={disabled}
      />
      <p className='panel-note'>
        1-Piece：直接接在植體上（鈦客製化支台齒，預設）；2-Piece：黏在鈦基座上（interface 是鈦基座的孔）。
        2-Piece 的鈦基座煙囪在支台齒裡要有孔（和螺絲通道同一個，這裡沒做），支台齒比牙冠小，煙囪常會從側面穿出，結果會標示出來。
      </p>
    </>}
    {!library && <>
      <Checkbox
        className='peek-cavity'
        checked={params.cavity}
        onChange={e => set('cavity', e.target.checked)}
        disabled={disabled}
      >
        在支台齒上挖出鈦基座的孔
      </Checkbox>
      <div className='field-row peek-grid'>
        {number('interface_diameter_mm', '介面直徑')}
        {number('chimney_diameter_mm', '煙囪直徑')}
        {number('chimney_height_mm', '煙囪高度')}
        {number('collar_height_mm', '領口高度')}
      </div>
    </>}

    <div className='peek-group-title'>植體位置</div>
    <div className='field-row peek-grid'>
      {auto('depth_mm', '平台深度', placement?.depth_mm)}
      {auto('offset_md_mm', '近遠心偏移', placement?.offset_md_mm)}
      {auto('offset_bl_mm', '頰舌偏移', placement?.offset_bl_mm)}
      {number('tilt_md_deg', '相對插入方向：近遠心傾斜', 1, '°')}
      {number('tilt_bl_deg', '相對插入方向：頰舌傾斜', 1, '°')}
    </div>
    <p className='panel-note'>
      植體軸預設和支台齒的插入方向同一條（第 3 步：自然傾斜、目前視角或指定）。深度是植體平台沿這條軸在 margin 環中心下方多少；
      偏移與傾斜都是近心、頰側為正，傾斜＝植體軸和插入方向的夾角（角度支台齒）。自動＝從口掃的軟組織隧道估計。
    </p>

    <div className='peek-group-title'>穿齦段（EZCAD 的 tissue）</div>
    {slider('radial_mm', '整體外擴（+）／內縮（−）', { '-1': '−1', 0: '0', 3: '+3' })}
    {slider('bone_avoid_mm', 'Bone avoidance（介面上方直上）', { 0: '0', 2: '2' })}

    <div className='button-row'>
      <Button onClick={onRebuild} loading={busy} disabled={!hasStump || disabled}>重新建置</Button>
      <Button onClick={() => setParams({ ...PEEK_DEFAULTS })} disabled={disabled}>恢復預設</Button>
    </div>
    {!hasStump && !running && <p className='panel-note'>
      先生成一次支台齒；之後改這裡的參數會自動重建，不必再送 pipeline。改插入方向要重新生成支台齒。
    </p>}
    {error && <Alert className='section-alert' type='error' showIcon message={error} />}

    {state && !state.error && <div className='peek-result'>
      <div>
        <Tag>植體深度 {fmt(placement.depth_mm)} mm · {SOURCE_LABEL[placement.depth_source] ?? placement.depth_source}</Tag>
        <Tag>近遠心 {fmt(placement.offset_md_mm)} · 頰舌 {fmt(placement.offset_bl_mm)} mm</Tag>
        <Tag>植體軸離咬合方向 {fmt(placement.axis_tilt_deg, 1)}°{placement.implant_to_insertion_deg > 0.05 ? ` · 和插入方向夾 ${fmt(placement.implant_to_insertion_deg, 1)}°` : ''}</Tag>
        <Tag>{state.baseLabel}</Tag>
        {state.generic && !state.cavity && <Tag color='blue'>未挖鈦基座孔</Tag>}
        {wallTag}
        {chimneyTag}
        {openTag}
      </div>
      <div className='peek-meta'>
        建置 {seconds(state.prepareMs + record.build_ms)}
        {state.prepareMs > 0 && `（對齊支台齒 ${seconds(state.prepareMs)}）`}
        {' · '}隧道：{placement.tunnel ? `深 ${fmt(placement.tunnel.depth_mm)} mm` : '未偵測到'}
        {' · '}縫合處直徑 {fmt(record.stitched_rim_mm)} mm
      </div>
      <div className='button-row'>
        <Button size='small' onClick={() => saveStl(state.solid, `custom_abutment_${fileBase}.stl`)}>下載客製化支台齒（STL）</Button>
        {state.tibase && <Button size='small' onClick={() => saveStl(state.tibase, `tibase_${fileBase}.stl`)}>下載鈦基座（STL）</Button>}
      </div>
    </div>}
  </section>;
};

export default AbutmentSection;
