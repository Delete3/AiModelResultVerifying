/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useState } from 'react';
import { Button } from 'antd';

// The small subset of Markdown the API documents under public/docs/ are written in: headings,
// paragraphs, - and 1. lists, pipe tables, ``` code blocks, and `code`, **bold** and [links](url)
// inline. Written here rather than added as a dependency: a new package makes Vite re-bundle its
// dependencies, and through Cloudflare's 4-hour cache of eztest's .js that blanks the page for
// anyone who opened eztest before (AGENTS.md §5.3).

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** `code`, **bold**, [text](url) inside a line, as React nodes. */
const renderInline = text => {
  const out = [];
  let last = 0;
  let m;
  const re = new RegExp(INLINE.source, 'g');     // its own: bold and link text recurse
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${m.index}`;
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{renderInline(token.slice(2, -2))}</strong>);
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      out.push(<a key={key} href={link[2]} target='_blank' rel='noreferrer'>{renderInline(link[1])}</a>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
const isTableRule = line => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
const startsBlock = line => /^(#{1,4}\s|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(line);

/** Markdown text -> a list of blocks: heading, para, ul, ol, table, code. */
const parseMarkdown = text => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(lines[i]);
      const header = rows.length > 1 && isTableRule(rows[1]) ? splitRow(rows[0]) : null;
      blocks.push({ type: 'table', header, rows: rows.slice(header ? 2 : 0).map(splitRow) });
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const number = /^\s*\d+\.\s+/;
    if (bullet.test(line) || number.test(line)) {
      const pattern = bullet.test(line) ? bullet : number;
      const items = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        if (pattern.test(lines[i])) items.push(lines[i].replace(pattern, ''));
        else if (/^\s+/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      blocks.push({ type: pattern === bullet ? 'ul' : 'ol', items });
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i])); i++) para.push(lines[i].trim());
    blocks.push({ type: 'para', text: para.join(' ') });
  }
  return blocks;
};

const CodeBlock = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });
  return <div className='md-code'>
    <Button size='small' className='md-copy' onClick={copy}>{copied ? '已複製' : '複製'}</Button>
    <pre><code>{text}</code></pre>
  </div>;
};

/** Heading ids, so a table of contents can scroll to them: `${idPrefix}-${index of the block}`. */
const headingId = (idPrefix, index) => `${idPrefix}-${index}`;

/**
 * Renders a Markdown document.
 * @param {{ text: string, idPrefix?: string }} props
 */
const MarkdownView = ({ text, idPrefix = 'md' }) => <div className='md-view'>
  {parseMarkdown(text).map((block, index) => {
    const key = `${block.type}-${index}`;
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(block.level + 1, 5)}`;
        return <Tag key={key} id={headingId(idPrefix, index)}>{renderInline(block.text)}</Tag>;
      }
      case 'ul': return <ul key={key}>{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>;
      case 'ol': return <ol key={key}>{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol>;
      case 'table': return <div key={key} className='md-table-wrap'><table>
        {block.header && <thead><tr>{block.header.map((cell, j) => <th key={j}>{renderInline(cell)}</th>)}</tr></thead>}
        <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, j) => <td key={j}>{renderInline(cell)}</td>)}</tr>)}</tbody>
      </table></div>;
      case 'code': return <CodeBlock key={key} text={block.text} />;
      default: return <p key={key}>{renderInline(block.text)}</p>;
    }
  })}
</div>;

/** The `##` headings of a document, with the ids MarkdownView gives them. */
const markdownOutline = (text, idPrefix = 'md') => parseMarkdown(text)
  .map((block, index) => ({ block, id: headingId(idPrefix, index) }))
  .filter(({ block }) => block.type === 'heading' && block.level === 2)
  .map(({ block, id }) => ({ id, text: block.text.replace(/[`*]/g, '') }));

export { markdownOutline, parseMarkdown };
export default MarkdownView;
