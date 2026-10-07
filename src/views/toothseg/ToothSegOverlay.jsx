import { Button } from 'antd';

import ToothSegScene from '../../utils/function/ToothSegScene';
import { useToothSegScene } from '../../utils/tool/useStores';

/** What floats over the 3D view on the AI分牙 tab, in place of the case toolbar. */
const ToothSegOverlay = () => {
  const view = useToothSegScene();
  const anything = view.hasRaw || view.hasSeg || view.teethCount > 0;
  return <>
    {anything && <div className='scene-toolbar'>
      {view.teethCount > 0 && <span className='preview-toolbar-count'>{view.teethCount} 顆牙</span>}
      <Button size='small' onClick={() => ToothSegScene.fitView()}>全部置中</Button>
    </div>}
    {!anything && <div className='scene-empty'>在左側選擇上下顎口掃</div>}
  </>;
};

export default ToothSegOverlay;
