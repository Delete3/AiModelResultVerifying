import './App.scss';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ConfigProvider, Spin, Tabs } from 'antd';

import Editor from '../utils/Editor';
import CaseScene, { jawOfFdi } from '../utils/function/CaseScene';
import CheckGroundTrue from '../utils/function/CheckGroundTrue';
import MarginEditor from '../utils/function/margin-editor/MarginEditor';
import PreviewScene from '../utils/function/PreviewScene';
import ToothSegScene from '../utils/function/ToothSegScene';
import { useCaseScene } from '../utils/tool/useStores';
import DesignPanel from './design/DesignPanel';
import DirectFlowToothPanel from './advanced/DirectFlowToothPanel';
import DirectFSAbutmentPanel from './advanced/DirectFSAbutmentPanel';
import LegacyTools from './legacy/LegacyTools';
import PeekAbutPanel from './peek/PeekAbutPanel';
import PreviewOverlay from './preview/PreviewOverlay';
import PreviewPanel from './preview/PreviewPanel';
import SceneOverlay from './SceneOverlay';
import ToothSegOverlay from './toothseg/ToothSegOverlay';
import ToothSegPanel from './toothseg/ToothSegPanel';

function App() {
  const containerRef = useRef();
  const [isLoading, setIsLoading] = useState(false);
  const [fdi, setFdi] = useState(null);
  const [allToothFdi, setAllToothFdi] = useState('');
  const [tab, setTab] = useState('design');
  const scene = useCaseScene();
  const prepJaw = jawOfFdi(fdi);

  useEffect(() => {
    // Guarded rather than run-once-by-trick: StrictMode mounts effects twice in development,
    // and the editor owns a WebGL context that must only ever be created once.
    if (!containerRef.current || Editor.container) return;
    Editor.setEditor(containerRef.current);
    // Neutral, so the tinted scans and the orange crown read against it.
    Editor.scene.background = new THREE.Color(0xeef1f5);
    Editor.scene.add(new THREE.AxesHelper(10));
    CheckGroundTrue.init();
    // After the lights and the axes exist: each puts them on its own layer too.
    PreviewScene.init();
    ToothSegScene.init();
  }, []);

  // The model preview and AI分牙 tabs each have the view to themselves, on their own layer;
  // every other tab shows the case. Leave before entering: each one saves the camera view it
  // hands back, so the tab being left has to go first.
  useEffect(() => {
    if (tab !== 'preview') PreviewScene.setActive(false);
    if (tab !== 'toothseg') ToothSegScene.setActive(false);
    if (tab === 'preview') PreviewScene.setActive(true);
    if (tab === 'toothseg') ToothSegScene.setActive(true);
    MarginEditor.setSuspended(tab === 'preview' || tab === 'toothseg');
  }, [tab]);

  // The margin is drawn on the arch that holds the tooth. While the FDI field holds
  // something that is not an FDI yet -- "3" on the way to "36" -- keep whatever is attached,
  // or every keystroke would throw the ring away.
  useEffect(() => {
    if (!prepJaw) return;
    MarginEditor.attach(CaseScene.meshes[prepJaw] ?? null);
  }, [prepJaw, scene.revision]);

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#d9480f', borderRadius: 6 } }}>
      <Spin spinning={isLoading}>
        <div className='app-shell'>
          <aside className='side-panel'>
            <header className='side-header'>
              <strong>AI Checking Viewer</strong>
              <span>口掃 → margin → 牙冠</span>
            </header>
            <Tabs
              className='side-tabs'
              size='small'
              activeKey={tab}
              onChange={setTab}
              items={[
                {
                  key: 'design',
                  label: '牙冠設計',
                  children: <DesignPanel
                    fdi={fdi}
                    setFdi={setFdi}
                    allToothFdi={allToothFdi}
                    setAllToothFdi={setAllToothFdi}
                    prepJaw={prepJaw}
                    scene={scene}
                  />,
                },
                {
                  // Crowns for scans with no abutment yet, through the no-abutment test
                  // endpoint on the Chiayi box. Shares the case (scans, FDI, margin) with
                  // the design tab.
                  key: 'peek',
                  label: 'peek abut設計',
                  children: <PeekAbutPanel fdi={fdi} setFdi={setFdi} prepJaw={prepJaw} scene={scene} />,
                },
                {
                  key: 'preview',
                  label: '模型預覽',
                  children: <PreviewPanel />,
                },
                {
                  key: 'direct',
                  label: '直接呼叫 FlowTooth',
                  children: <DirectFlowToothPanel fdi={fdi} prepJaw={prepJaw} />,
                },
                {
                  // A different project from the ezai chain, on the Chiayi box only, and
                  // it takes its own four uploads rather than the design tab's scans --
                  // see the panel for why.
                  key: 'fsabutment',
                  label: 'Abutment（5090）',
                  children: <DirectFSAbutmentPanel />,
                },
                {
                  // The orthodontic team's ToothRoot on the Chiayi box: AI tooth
                  // segmentation and root generation. Its own layer and its own pair of
                  // scans (or the design tab's, one click away).
                  key: 'toothseg',
                  label: 'AI分牙',
                  children: <ToothSegPanel />,
                },
                {
                  key: 'legacy',
                  label: '舊工具',
                  children: <LegacyTools setIsLoading={setIsLoading} />,
                },
              ]}
            />
          </aside>
          <main className='viewport'>
            <div ref={containerRef} className='editor' />
            {tab === 'preview' ? <PreviewOverlay /> : tab === 'toothseg' ? <ToothSegOverlay /> : <SceneOverlay />}
          </main>
        </div>
      </Spin>
    </ConfigProvider>
  );
}

export default App;
