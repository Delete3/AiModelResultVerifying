import { Dropdown } from 'antd';

// The pages eztest holds. The key is also the URL hash (#fussen), so a page can be opened
// directly by link; the viewer is the page with no hash.
export const APPS = {
  viewer: 'AI Checking Viewer',
  fussen: 'Fussen Workbench',
};

export function appFromHash() {
  return window.location.hash.replace(/^#/, '').split('?')[0] === 'fussen' ? 'fussen' : 'viewer';
}

// The title at the top left, which opens a menu of the other pages.
export default function AppSwitcher({ app, onChange }) {
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        selectable: true,
        selectedKeys: [app],
        items: Object.entries(APPS).map(([key, label]) => ({ key, label })),
        onClick: ({ key }) => onChange(key),
      }}
    >
      <button type='button' className='app-switcher' title='切換頁面'>
        <strong>{APPS[app]}</strong>
        {/* A character, not @ant-design/icons: that package is not a direct dependency, and a
            new import makes Vite re-bundle and reload every open eztest page. */}
        <span className='app-switcher-caret' aria-hidden='true'>▼</span>
      </button>
    </Dropdown>
  );
}
