/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Tabs } from 'antd';

import MarkdownView, { markdownOutline, parseMarkdown } from './MarkdownView';
import { downloadBlob } from '../../utils/tool/useStores';

// The AI排牙 API's documents for the orthodontic team, served as static files from
// public/docs/toothssm/ so that one edit there is what the team downloads:
//
//   api.md        the integration guide (endpoints, parameters, results, examples)
//   changelog.md  what changed, newest first -- its first `## <date>　<title>` is "this version"
//
// When the API changes, update both and tell the team to come back here (user, 2026-10-30).
const DOCS = {
  changelog: { url: '/docs/toothssm/changelog.md', label: '更新內容', file: 'AI排牙-API-更新內容' },
  api: { url: '/docs/toothssm/api.md', label: 'API 串接文件', file: 'AI排牙-API-串接說明' },
};

/** The document as served now: a query string past every cache between here and the file. */
const fetchDoc = async url => {
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}：${response.status}`);
  return response.text();
};

/** "2026-10-29　牙冠用口掃原樣…" from the changelog's first `##`: { date, title }. */
const latestEntry = changelog => {
  const heading = parseMarkdown(changelog).find(block => block.type === 'heading' && block.level === 2);
  if (!heading) return null;
  const m = heading.text.match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/);
  return m ? { date: m[1], title: m[2].trim() } : { date: '', title: heading.text };
};

/** "文件版本：2026-10-30" from the guide's first lines. */
const docVersion = api => api.match(/文件版本[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';

// The downloadable HTML: the rendered document with its own styles, to read offline or print to PDF.
const HTML_STYLE = `
body{font:14px/1.6 -apple-system,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif;color:#222;max-width:960px;margin:24px auto;padding:0 16px}
h2{font-size:22px;margin:0 0 8px}h3{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
h4{font-size:15px;margin:20px 0 6px}table{border-collapse:collapse;width:100%;margin:8px 0 12px;font-size:13px}
th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f5f5f5}
code{background:#f3f3f3;padding:0 4px;border-radius:3px;font-family:Consolas,monospace;font-size:12.5px}
pre{background:#f6f8fa;padding:10px;border-radius:4px;overflow:auto}pre code{background:none;padding:0}
@media print{pre{white-space:pre-wrap}}`;

const toHtml = (node, title) => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('.md-copy').forEach(button => button.remove());
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>${HTML_STYLE}</style></head><body>${copy.innerHTML}</body></html>`;
};

/**
 * The AI排牙 tab's documents: a line with the latest change, and a dialog with the change log and
 * the integration guide, each downloadable as Markdown or as HTML (printable to PDF).
 */
const ToothSsmDocs = () => {
  const [texts, setTexts] = useState({});
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);           // null | 'changelog' | 'api'
  const bodyRef = useRef(null);

  const load = () => Promise.all(Object.entries(DOCS).map(async ([key, doc]) => [key, await fetchDoc(doc.url)]))
    .then(pairs => { setTexts(Object.fromEntries(pairs)); setError(null); })
    .catch(e => setError(e.message));

  useEffect(() => { load(); }, []);

  const show = key => {
    setOpen(key);
    load();                                         // what the team sees is always the file as it is now
  };

  const latest = texts.changelog ? latestEntry(texts.changelog) : null;
  const version = texts.api ? docVersion(texts.api) : '';
  const text = open ? texts[open] : '';
  const stamp = open === 'api' ? version : latest?.date ?? '';

  const downloadMarkdown = () => downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }),
    `${DOCS[open].file}-${stamp}.md`);
  const downloadHtml = () => bodyRef.current && downloadBlob(
    new Blob([toHtml(bodyRef.current, `${DOCS[open].label} ${stamp}`)], { type: 'text/html;charset=utf-8' }),
    `${DOCS[open].file}-${stamp}.html`);

  const outline = open && text ? markdownOutline(text, `ssm-${open}`) : [];

  return <div className='ssm-docs-bar'>
    <div className='ssm-docs-latest'>
      <b>API 最新更新</b>
      {latest ? <span>{latest.date}　{latest.title}</span> : <span>{error ? `讀不到文件：${error}` : '讀取中…'}</span>}
    </div>
    <div className='button-row'>
      <Button size='small' type='primary' ghost disabled={!texts.changelog} onClick={() => show('changelog')}>看更新內容</Button>
      <Button size='small' disabled={!texts.api} onClick={() => show('api')}>
        API 串接文件{version ? `（${version} 版）` : ''}
      </Button>
    </div>

    <Modal
      open={Boolean(open)}
      onCancel={() => setOpen(null)}
      footer={null}
      width={980}
      title='AI排牙 API'
    >
      <Tabs
        activeKey={open ?? 'changelog'}
        onChange={setOpen}
        items={Object.entries(DOCS).map(([key, doc]) => ({ key, label: doc.label }))}
        tabBarExtraContent={<div className='button-row'>
          <Button size='small' onClick={downloadMarkdown} disabled={!text}>下載 Markdown</Button>
          <Button size='small' onClick={downloadHtml} disabled={!text}
            title='用瀏覽器開啟後可列印或另存成 PDF'>下載 HTML（可存成 PDF）</Button>
        </div>}
      />
      {error && <Alert type='error' showIcon message={`讀不到文件：${error}`} />}
      {outline.length > 2 && <div className='ssm-docs-toc'>
        {outline.map(item => <a key={item.id} onClick={() => document.getElementById(item.id)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{item.text}</a>)}
      </div>}
      <div className='ssm-docs-body' ref={bodyRef}>
        {text && <MarkdownView text={text} idPrefix={`ssm-${open}`} />}
      </div>
    </Modal>
  </div>;
};

export default ToothSsmDocs;
