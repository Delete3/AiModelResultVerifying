/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */

const formatAxis = values => values.map(v => Number(v).toFixed(3)).join(', ');

/** The record's occlusal_scale ([least, median, most] over the directions round the ring). */
const formatScale = scale => (Array.isArray(scale) && scale.length === 3
  ? `${Number(scale[1]).toFixed(2)} 倍（各方向 ${Number(scale[0]).toFixed(2)}–${Number(scale[2]).toFixed(2)}）`
  : '—');

/**
 * A mode=stump job's own record (manifest `stump`), line by line: what the service chose and
 * measured -- the library group and cap, heights, the axis, the stitching into the scan, and for a
 * cutback its style, thicknesses and the scale of the occlusal form.
 *
 * Props: record (manifest.stump) or null.
 */
const StumpRecord = ({ record }) => {
  if (!record) return null;
  const lines = record.kind === 'cutback' ? [
    record.style === 'scaled'
      ? `Cutback（等比縮小）：軸面 ${record.cutback_mm} mm · 咬合面 ${record.occlusal_mm} mm · 肩台 ${record.shoulder_mm} mm · 軸面傾斜 ${record.taper_deg}°（體素 ${record.voxel_mm} mm）`
      : record.style === 'ring'
        ? `Cutback（舊版）：軸面 ${record.cutback_mm} mm · 咬合面 ${record.occlusal_mm} mm · 肩台 ${record.shoulder_mm} mm · 軸面傾斜 ${record.taper_deg}°（體素 ${record.voxel_mm} mm）`
        : `Cutback（${record.style}）：內縮 ${record.cutback_mm} mm · 肩台 ${record.shoulder_mm ?? '—'} mm（體素 ${record.voxel_mm} mm）`,
    record.style === 'scaled' ? `咬合面縮放：${formatScale(record.occlusal_scale)}（牙冠外形對肩台內緣，只縮平面、不縮高度）` : '',
    `高度 ${record.height_mm} mm · 離對咬 ${record.antagonist_gap_mm ?? '—'} mm · 沒縫合的邊 ${record.open_margin_edges}`,
    `插入方向 ${record.axis_source === 'occlusal' ? '咬合方向（沿原本的方向切不出來）' : record.base?.axis_source === 'caller' ? '指定' : '自然傾斜'}，離咬合方向 ${record.axis_from_occlusal_deg}° · 原座標 [${formatAxis(record.insertion_axis_original ?? [])}]`,
    record.base ? `牙冠先長在資料庫支台齒上：${record.base.group} · ${record.base.cap} · ${record.base.height_mm} mm` : '',
  ] : [
    `牙位群組 ${record.group}（${record.group_source}）· 資料庫 ${record.cap}`,
    `高度 ${record.height_mm} mm（自然 ${record.natural_height_mm} mm）· 肩台 ${record.shoulder_mm} mm · 離對咬 ${record.antagonist_gap_mm ?? '—'} mm（要求 ${record.clearance_mm}）`,
    `插入方向 ${record.axis_source === 'caller' ? '指定' : '自然傾斜'}，離咬合方向 ${record.axis_from_occlusal_deg}° · 原座標 [${formatAxis(record.insertion_axis_original ?? [])}]`,
    `cap 縮放 ${record.cap_scale?.join(' / ')} · margin 環 ${record.ring_md_bl_mm?.join(' × ')} mm（近遠心 × 頰舌）`,
    `洞口 ${record.hole_edge_vertices} 點，吸附到 margin ${record.hole_snapped?.moved} 點（最多 ${record.hole_snapped?.max_move_mm} mm）· 沒縫合的邊 ${record.open_margin_edges}`,
  ];
  return <pre className='flow-message'>{lines.filter(Boolean).join('\n')}</pre>;
};

export default StumpRecord;
