import { useSyncExternalStore } from 'react';

import CaseScene from '../function/CaseScene';
import MarginEditor from '../function/margin-editor/MarginEditor';
import PreviewScene from '../function/PreviewScene';

/** What is on screen: which scans, crown and reference ring exist, and what is visible. */
const useCaseScene = () => useSyncExternalStore(CaseScene.subscribe, CaseScene.getSnapshot);

/** The margin being drawn or edited. */
const useMarginEditor = () => useSyncExternalStore(MarginEditor.subscribe, MarginEditor.getSnapshot);

/** The model preview tab's models. */
const usePreviewScene = () => useSyncExternalStore(PreviewScene.subscribe, PreviewScene.getSnapshot);

/** Save a Blob under a file name. */
const downloadBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export { useCaseScene, useMarginEditor, usePreviewScene, downloadBlob };
