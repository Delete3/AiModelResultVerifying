/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Button, Checkbox } from 'antd';

import CaseScene from '../utils/function/CaseScene';
import MarginEditor from '../utils/function/margin-editor/MarginEditor';
import { useCaseScene, useMarginEditor } from '../utils/tool/useStores';

/**
 * What floats over the 3D view: visibility toggles top-right, and the mouse legend at the
 * bottom while a margin is being drawn or edited.
 */
const SceneOverlay = () => {
  const scene = useCaseScene();
  const editor = useMarginEditor();
  const anything = scene.hasUpper || scene.hasLower || scene.hasCrown || scene.hasAbutment;

  const toggle = (key, label, present) => present && <Checkbox
    checked={scene.visible[key]}
    onChange={e => CaseScene.setVisible(key, e.target.checked)}
  >{label}</Checkbox>;

  return <>
    {anything && <div className='scene-toolbar'>
      {toggle('upper', '上顎', scene.hasUpper)}
      {toggle('lower', '下顎', scene.hasLower)}
      {toggle('crown', '牙冠', scene.hasCrown)}
      {toggle('abutment', 'Abutment', scene.hasAbutment)}
      {toggle('reference', 'AI margin', scene.hasReference)}
      <Checkbox checked={scene.translucent} onChange={e => CaseScene.setTranslucent(e.target.checked)}>口掃半透明</Checkbox>
      <Button size='small' onClick={() => CaseScene.fitView()}>全部置中</Button>
    </div>}

    {editor.mode === 'draw' && <div className='scene-hint'>
      <b>繪製 margin</b>{' '}左鍵點選加點 · 點第一點（橘色）或 Enter 閉合 · Backspace 退一點 · Esc 取消
      <span className='hint-sub'>右鍵旋轉 · 中鍵平移 · 滾輪縮放</span>
      {editor.controlCount >= 3 && <Button size='small' type='primary' onClick={() => MarginEditor.finishDrawing()}>完成</Button>}
    </div>}
    {editor.mode === 'edit' && <div className='scene-hint'>
      <b>修改 margin</b>{' '}拖曳綠點移動 · 點紅線新增控制點 · Shift + 點綠點刪除 · Ctrl + Z 復原
      <Button size='small' onClick={() => MarginEditor.setEditing(false)}>完成修改</Button>
    </div>}
    {!anything && <div className='scene-empty'>在左側上傳口掃開始</div>}
  </>;
};

export default SceneOverlay;
