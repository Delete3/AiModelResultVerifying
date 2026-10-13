import { Button } from 'antd';

import ToothAlignScene from '../../utils/function/ToothAlignScene';
import { useToothAlignScene } from '../../utils/tool/useStores';

const STAGE_NAME = { raw: '原始口掃', seg: '分牙', teeth: '排牙前', aligned: '排牙後', compare: '排牙前（灰）／排牙後' };

/** What floats over the 3D view on the AI排牙 tab, in place of the case toolbar. */
const ToothAlignOverlay = () => {
  const view = useToothAlignScene();
  const anything = view.hasRaw || view.crownCount > 0 || view.teethCount > 0;
  return <>
    {anything && <div className='scene-toolbar'>
      <span className='preview-toolbar-count'>{STAGE_NAME[view.stage]}</span>
      <Button size='small' onClick={() => ToothAlignScene.fitView()}>全部置中</Button>
    </div>}
    {!anything && <div className='scene-empty'>在左側選擇上下顎口掃</div>}
  </>;
};

export default ToothAlignOverlay;
