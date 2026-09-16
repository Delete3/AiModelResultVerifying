import './App.scss';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ConfigProvider, Spin, Tabs } from 'antd';

import Editor from '../utils/Editor';
import CaseScene, { jawOfFdi } from '../utils/function/CaseScene';
import CheckGroundTrue from '../utils/function/CheckGroundTrue';
import MarginEditor from '../utils/function/margin-editor/MarginEditor';
import { useCaseScene } from '../utils/tool/useStores';
import DesignPanel from './design/DesignPanel';
import DirectFlowToothPanel from './advanced/DirectFlowToothPanel';
import DirectFSAbutmentPanel from './advanced/DirectFSAbutmentPanel';
import LegacyTools from './legacy/LegacyTools';
import SceneOverlay from './SceneOverlay';

function App() {
  const containerRef = useRef();
  const [isLoading, setIsLoading] = useState(false);
  const [fdi, setFdi] = useState(null);
  const [allToothFdi, setAllToothFdi] = useState('');
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
  }, []);

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
                  key: 'legacy',
                  label: '舊工具',
                  children: <LegacyTools setIsLoading={setIsLoading} />,
                },
              ]}
            />
          </aside>
          <main className='viewport'>
            <div ref={containerRef} className='editor' />
            <SceneOverlay />
          </main>
        </div>
      </Spin>
    </ConfigProvider>
  );
}

export default App;
