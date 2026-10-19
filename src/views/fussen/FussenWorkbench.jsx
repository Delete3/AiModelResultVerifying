import { useEffect, useRef, useState } from 'react';
import { message, Segmented, Tag } from 'antd';

// airdental's Fussen workbench (tools/fussenWorkbench), which reaches Fussen orders with an
// API key because that edition has no login or order pages. The page itself is the tool's
// own HTML and script (fussen-workbench/ at the repo root), in an iframe so its stylesheet
// and element ids stay out of this app; vite.config.js is its backend and holds the keys.
// This bar is eztest's: the app switcher, and which Fussen site the page talks to.

const SITES = [
  { value: 'prod', label: '正式站' },
  { value: 'test', label: '測試站' },
];
const STORAGE_KEY = 'fussenWorkbench.site';

function siteFromHash() {
  const site = new URLSearchParams(window.location.hash.split('?')[1] || '').get('site');
  return SITES.some(s => s.value === site) ? site : null;
}

function initialSite() {
  // A link can name the site (#fussen?site=prod); otherwise the last one used, and the test
  // site the first time, since an order made by mistake there costs nothing.
  const fromHash = siteFromHash();
  if (fromHash) return fromHash;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (SITES.some(s => s.value === saved)) return saved;
  } catch { /* storage blocked: fall through */ }
  return 'test';
}

export default function FussenWorkbench({ active, appSwitcher }) {
  const frameRef = useRef(null);
  // Not loaded until first opened, so opening the viewer does not query Fussen.
  const [opened, setOpened] = useState(active);
  const [site, setSite] = useState(initialSite);
  const [sites, setSites] = useState(null);

  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);

  useEffect(() => {
    if (!opened) return;
    fetch('/api/fussen/config', { headers: { 'X-Fussen-Workbench': '1' } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => setSites(data.sites))
      .catch(() => setSites([]));
  }, [opened]);

  const choose = (next, { fromLink = false } = {}) => {
    if (next === site) return;
    let busy = false;
    try { busy = frameRef.current?.contentWindow?.fussenWorkbenchBusy?.() ?? false; } catch { /* not loaded */ }
    if (busy) {
      message.warning('正在建單，等結果出來再切換站點。');
      return;
    }
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* storage blocked */ }
    if (active && !fromLink) {
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', `${pathname}${search}#fussen?site=${next}`);
    }
    setSite(next);
  };

  // A link opened while eztest is already loaded only changes the hash.
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    const follow = () => {
      const fromHash = siteFromHash();
      if (fromHash) chooseRef.current(fromHash, { fromLink: true });
    };
    window.addEventListener('hashchange', follow);
    window.addEventListener('popstate', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
      window.removeEventListener('popstate', follow);
    };
  }, []);

  const current = sites?.find(s => s.id === site);
  return (
    <div className={`fussen-page${site === 'prod' ? ' is-prod' : ''}`} hidden={!active}>
      <header className='fussen-bar'>
        {appSwitcher}
        <span className='fussen-bar-site'>
          {site === 'prod' ? <Tag color='red'>正式站</Tag> : <Tag color='green'>測試站</Tag>}
          <code>{current?.baseUrl ?? ''}</code>
          {current && !current.configured ? <Tag color='orange'>沒有 API key</Tag> : null}
        </span>
        <Segmented options={SITES} value={site} onChange={choose} />
      </header>
      {opened ? (
        // Keyed by site: switching reloads the page against the other site, so nothing from
        // one site (a serial typed in, a half-made order) is carried over to the other.
        <iframe
          key={site}
          ref={frameRef}
          className='fussen-frame'
          title='Fussen Workbench'
          src={`/fussen-workbench/index.html?site=${site}`}
        />
      ) : null}
    </div>
  );
}
