import { useEffect, useState } from 'react';
import { ConfigProvider } from 'antd';

import App from './App.jsx';
import AppSwitcher, { APPS, appFromHash } from './AppSwitcher';
import FussenWorkbench from './fussen/FussenWorkbench';

// Both pages stay mounted once opened, and the one not in use is only hidden: the viewer
// owns a WebGL context and the case on screen, the workbench a half-filled order form, and
// switching back and forth should lose neither.
export default function Root() {
  const [app, setApp] = useState(appFromHash);

  useEffect(() => {
    const follow = () => setApp(appFromHash());
    window.addEventListener('hashchange', follow);
    window.addEventListener('popstate', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
      window.removeEventListener('popstate', follow);
    };
  }, []);

  useEffect(() => {
    document.title = APPS[app];
  }, [app]);

  const choose = (next) => {
    if (next === app) return;
    const { pathname, search } = window.location;
    window.history.pushState(null, '', next === 'viewer' ? pathname + search : `${pathname}${search}#${next}`);
    setApp(next);
  };

  const switcher = <AppSwitcher app={app} onChange={choose} />;
  return (
    <>
      <div className='app-page' hidden={app !== 'viewer'}>
        <App appSwitcher={switcher} />
      </div>
      <ConfigProvider theme={{ token: { colorPrimary: '#d9480f', borderRadius: 6 } }}>
        <FussenWorkbench active={app === 'fussen'} appSwitcher={switcher} />
      </ConfigProvider>
    </>
  );
}
