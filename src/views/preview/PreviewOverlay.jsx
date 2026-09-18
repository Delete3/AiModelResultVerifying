import { useEffect, useState } from 'react';
import { Button } from 'antd';

import Editor from '../../utils/Editor';
import PreviewScene from '../../utils/function/PreviewScene';
import { usePreviewScene } from '../../utils/tool/useStores';

const carriesFiles = event => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * What floats over the 3D view while the model preview tab is open, in place of the case
 * toolbar: the whole view is a drop target, with a toolbar once there is something to frame.
 */
const PreviewOverlay = () => {
  const preview = usePreviewScene();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const viewport = Editor.container?.parentElement;
    if (!viewport) return undefined;

    const onDragOver = event => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    };
    const onDragLeave = event => {
      if (!viewport.contains(event.relatedTarget)) setDragging(false);
    };
    const onDrop = event => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      PreviewScene.addFiles(event.dataTransfer.files);
    };
    // A file dropped anywhere else on the page -- a near miss on the side panel -- would
    // otherwise make the browser open it in place of this page, and take every model with it.
    const swallow = event => {
      if (carriesFiles(event)) event.preventDefault();
    };

    viewport.addEventListener('dragover', onDragOver);
    viewport.addEventListener('dragleave', onDragLeave);
    viewport.addEventListener('drop', onDrop);
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      viewport.removeEventListener('dragover', onDragOver);
      viewport.removeEventListener('dragleave', onDragLeave);
      viewport.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  return <>
    {preview.loaded > 0 && <div className='scene-toolbar'>
      <span className='preview-toolbar-count'>{preview.loaded} 個模型</span>
      <Button size='small' onClick={() => PreviewScene.fitView()}>全部置中</Button>
    </div>}
    {!preview.items.length && !dragging && <div className='scene-empty'>把 STL / PLY / OBJ / TRI / PTS 拖曳到這裡（可一次多個）</div>}
    {dragging && <div className='preview-dropzone'>放開以載入模型</div>}
  </>;
};

export default PreviewOverlay;
