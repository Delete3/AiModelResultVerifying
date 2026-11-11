/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Button, Checkbox, Radio, Slider } from 'antd';

import ToothAlignScene, { CROWN_HEX, ROOT_HEX } from '../../utils/function/ToothAlignScene';
import { useToothAlignScene } from '../../utils/tool/useStores';

/**
 * The AI排牙 tab's 顯示 section, for API v1 and v2 alike: which stage of the case is drawn, which
 * jaws, the gum, the ghost's opacity and how the teeth are coloured. `sourceColors` false hides
 * the crown / root colouring (v2's teeth carry no colours).
 */
const ToothAlignDisplay = ({ sourceColors = true, teethLabel = '排牙前' }) => {
  const view = useToothAlignScene();
  return <section className='panel-section'>
    <div className='section-title'>顯示</div>
    <Radio.Group size='small' value={view.stage} onChange={e => ToothAlignScene.setStage(e.target.value)}>
      <Radio.Button value='raw' disabled={!view.hasRaw}>原始口掃</Radio.Button>
      <Radio.Button value='seg' disabled={!view.crownCount}>分牙</Radio.Button>
      <Radio.Button value='teeth' disabled={!view.teethCount}>{teethLabel}</Radio.Button>
      <Radio.Button value='aligned' disabled={!view.alignedCount}>排牙後</Radio.Button>
      <Radio.Button value='compare' disabled={!view.alignedCount}>前後對照</Radio.Button>
    </Radio.Group>
    <div className='toothseg-switches'>
      <Checkbox checked={view.show.upper} onChange={e => ToothAlignScene.setShow('upper', e.target.checked)}>上顎</Checkbox>
      <Checkbox checked={view.show.lower} onChange={e => ToothAlignScene.setShow('lower', e.target.checked)}>下顎</Checkbox>
      {view.stage === 'seg' && <Checkbox checked={view.show.gum} onChange={e => ToothAlignScene.setShow('gum', e.target.checked)}>牙齦</Checkbox>}
      <Button size='small' onClick={() => ToothAlignScene.fitView()}>全部置中</Button>
    </div>
    {view.stage === 'compare' && <div className='preview-opacity'>
      <span>排牙前（灰）透明度</span>
      <Slider min={0} max={100} value={Math.round(view.ghostOpacity * 100)} onChange={v => ToothAlignScene.setGhostOpacity(v / 100)} />
      <span className='preview-percent'>{Math.round(view.ghostOpacity * 100)}%</span>
    </div>}
    {sourceColors && ['teeth', 'aligned', 'compare'].includes(view.stage) && <>
      <div className='toothseg-switches'>
        <span>牙齒顏色</span>
        <Radio.Group size='small' value={view.teethColor} onChange={e => ToothAlignScene.setTeethColor(e.target.value)}>
          <Radio.Button value='source'>牙冠／牙根</Radio.Button>
          <Radio.Button value='fdi'>依 FDI</Radio.Button>
        </Radio.Group>
      </div>
      {view.teethColor === 'source' && <div className='panel-note'>
        <span className='fdi-swatch' style={{ background: CROWN_HEX }} />距掃描牙冠 0.5 mm 內
        <span className='fdi-swatch' style={{ background: ROOT_HEX, marginLeft: 10 }} />模型生成的牙根
      </div>}
    </>}
  </section>;
};

export default ToothAlignDisplay;
