'use strict';
// The Fussen workbench from airdental (tools/fussenWorkbench/ui), served by eztest inside an
// iframe. Differences from the original: requests go to eztest's /api/fussen/<site>/ proxy
// (vite.config.js), which adds the site's API key on the server; the site comes from ?site=,
// chosen in eztest's own top bar; there is no local server to stop.
const $ = id => document.getElementById(id);
const SITE = new URLSearchParams(location.search).get('site') || 'test';
let config;
let offset = 0;
let total = 0;
let listVersion = 0;
let creating = false;
let stopped = false;
// eztest asks before it reloads this frame for another site, so an upload is not cut off.
window.fussenWorkbenchBusy = () => creating;
const PAGE_SIZE = 20;
const fdi = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28,38,37,36,35,34,33,32,31,41,42,43,44,45,46,47,48];
const products = { anatomicCrown: '全解剖牙冠', anatomicPontic: '橋體', inlay_Onlay: '嵌體 / 高嵌體', veneer: '貼片' };
const attempts = new Set();

function message(text, error = false, target = 'notice') {
    const element = $(target);
    element.textContent = text;
    element.className = error ? 'error' : '';
    element.hidden = false;
}
function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}
function detail(data) {
    $('detail').hidden = false;
    $('result').textContent = JSON.stringify(data, null, 2);
}
async function api(route, options = {}) {
    const response = await fetch(`/api/fussen/${SITE}/${route}`, {
        ...options, headers: { 'X-Fussen-Workbench': '1', ...options.headers },
    });
    const type = response.headers.get('content-type') || '';
    if (type.includes('json')) {
        const data = await response.json();
        if (!response.ok || data.error || data.errors) {
            const error = new Error(data.error?.message || JSON.stringify(data.errors || data));
            error.reason = data.error?.reason;
            error.status = response.status;
            throw error;
        }
        if (options.expectedStatus && response.status !== options.expectedStatus) throw new Error(`非預期 HTTP ${response.status}，請查詢原序號確認結果。`);
        return data;
    }
    if (!response.ok || !options.download) {
        const error = new Error(response.status === 404 ? '後端尚未提供清單 API，請更新並重啟後端。仍可使用下方外部序號操作。' : `後端回傳非預期內容（HTTP ${response.status}），請確認網址及 API 路徑。`);
        error.status = response.status;
        throw error;
    }
    if (!/zip|octet-stream/i.test(type)) throw new Error('下載內容不是 ZIP，請確認後端回應。');
    return response.blob();
}
async function run(button, action, target = 'notice') {
    button.disabled = true;
    try { await action(); } catch (error) { message(error.message, true, target); }
    finally { button.disabled = stopped; }
}
async function loadList() {
    const version = ++listVersion;
    $('refresh').disabled = true;
    $('previous').disabled = true;
    $('next').disabled = true;
    try {
        const params = new URLSearchParams({ q: $('search').value.trim(), offset, limit: PAGE_SIZE });
        const data = await api(`list?${params}`);
        if (version !== listVersion) return;
        if (!Array.isArray(data.projects) || !data.pagination) throw new Error('清單回應格式不符。');
        total = data.pagination.total;
        $('total').textContent = `${total} 筆訂單`;
        $('orders').replaceChildren();
        if (!data.projects.length) {
            const cell = node('td', '沒有符合條件的訂單', 'empty'); cell.colSpan = 5;
            const row = node('tr'); row.append(cell); $('orders').append(row);
        }
        for (const project of data.projects) {
            const row = node('tr');
            const serial = node('td'); serial.append(node('strong', project.externalSerialnum), node('small', project.serialnum || project.oid || '—'));
            const status = project.crownStatus || 'none';
            const tone = /failure/i.test(status) ? 'failure' : /checking|completed/i.test(status) ? 'success' : /pending|generating|processing/i.test(status) ? 'processing' : '';
            const state = node('td'); state.append(node('span', status, `badge ${tone}`));
            const actions = node('td'); const group = node('div', undefined, 'actions');
            const teethButton = node('button', '齒位');
            teethButton.addEventListener('click', () => toggleTeeth(row, teethButton, project));
            group.append(teethButton);
            for (const [label, operation] of [['狀態', 'status'], ['Viewer', 'viewerLink'], ['編輯', 'editLink'], ['下載', 'download']]) {
                const button = node('button', label);
                button.addEventListener('click', () => run(button, () => operate(project.externalSerialnum, operation)));
                group.append(button);
            }
            actions.append(group);
            row.append(serial, node('td', project.patient?.trim() || '—'), state,
                node('td', project.date ? new Date(project.date).toLocaleString('zh-TW', { hour12: false }) : '—'), actions);
            $('orders').append(row);
        }
        $('page-info').textContent = total ? `第 ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} 筆，共 ${total} 筆` : '共 0 筆';
        $('previous').disabled = offset === 0;
        $('next').disabled = offset + PAGE_SIZE >= total;
    } catch (error) {
        if (version !== listVersion) return;
        $('total').textContent = '清單未載入';
        $('orders').replaceChildren();
        const row = node('tr'); const cell = node('td', '無法載入訂單，請查看上方訊息。', 'empty'); cell.colSpan = 5; row.append(cell); $('orders').append(row);
        $('page-info').textContent = '';
        message(error.message, true);
    } finally { if (version === listVersion) $('refresh').disabled = false; }
}
// --- The order's teeth, drawn like airdental's product picker -----------------------------
// common/prosthese-select-v2 (index.js, TeethChild.js, items.js), read-only: the same markup
// and classes, so teeth-chart.css -- its stylesheet, compiled -- places and tints each tooth.

// The list returns teeth as stored, in airdental's tooth-chart ids (common/teethchart.js):
// 0-15 are 18..11 21..28, 16-31 are 38..31 41..48 -- the same order as `fdi` above. Creating
// an order sends FDI instead, which the server converts; only reading needs this.
const fdiOfChartId = id => (Number.isInteger(id) && id >= 0 && id < fdi.length ? fdi[id] : null);
// items.js PRODUCTS colours; anything else is grey there too.
const productColors = { anatomicCrown: '#52c41a', anatomicPontic: '#fa8c16', inlay_Onlay: '#722ed1', veneer: '#eb2f96', screwRetainedAbutmentAnatomicCrown: '#1677ff' };
const productColor = type => productColors[type] || '#8c8c8c';
// TeethChild.js: the small product icon above each tooth that has one.
const productIcons = {
    offsetCoping: 'co', anatomicCoping: 'co', anatomicCrown: 'cr', anatomicCrownShell: 'cr',
    corePontic: 'poco', reducedPontic: 'poco', anatomicPontic: 'pocr', provisionalPontic: 'pocr',
    veneer: 've', inlay_Onlay: 'in', provisionalCrown: 'ts', abutment: 'ia',
    abut_OffsetCoping: 'ia_co', abut_AnatomicCoping: 'ia_co', abut_AnatomicCrown: 'ia_cr',
    screwRetainedAbutment: 'sria', screwRetainedAbutmentAnatomicCrown: 'sria_cr',
    diagnosticWaxupCrown: 'ia_cr', diagnosticWaxupPontic: 'pocr',
};
const productName = type => products[type] || type || '未指定產品';

// items.js getDefaultTeeth(): each arch left to right, a connector slot between neighbours.
// Upper slots are named "<this>-<next>", lower ones "<next>-<this>", as there.
function chartItems() {
    const items = [];
    const upper = fdi.slice(0, 16).map(String);
    // Lower, left to right on screen: 48..41 then 31..38.
    const lowerRow = [...fdi.slice(24, 32).reverse(), ...fdi.slice(16, 24).reverse()].map(String);
    upper.forEach((tooth, i) => {
        items.push({ fdi: tooth });
        if (i < upper.length - 1) items.push({ link: `${tooth}-${upper[i + 1]}` });
    });
    lowerRow.forEach((tooth, i) => {
        items.push({ fdi: tooth });
        if (i < lowerRow.length - 1) items.push({ link: `${lowerRow[i + 1]}-${tooth}` });
    });
    return items.map((item, key) => ({ ...item, key }));
}
function renderTeethChart(teeth) {
    const byFdi = new Map();
    for (const tooth of teeth) {
        const toothFdi = fdiOfChartId(Number(tooth.id));
        if (toothFdi) byFdi.set(String(toothFdi), tooth);
    }
    const items = chartItems().map(item => {
        if (item.fdi) return { ...item, tooth: byFdi.get(item.fdi) };
        // index.js updateTeeth(): a tooth's connector lights the slot that starts with it.
        const first = byFdi.get(item.link.split('-')[0]);
        return { ...item, selected: first?.connector === true || first?.connector === 'true' };
    });
    // index.js teethChild(): a slot draws the bridge line back to the previous slot when both
    // are lit, carried across the four quarters in drawing order.
    let previousLink = null;
    const draw = (from, to, className) => {
        const list = node('ul', undefined, className);
        for (const item of items.filter(t => t.key >= from && t.key <= to)) {
            if (item.fdi) {
                const li = node('li', undefined, `t${item.fdi}`);
                const button = node('button');
                button.type = 'button'; button.tabIndex = -1;
                if (item.tooth) {
                    li.style.setProperty('--product-color', productColor(item.tooth.productType));
                    const icon = productIcons[item.tooth.productType];
                    if (icon) { const img = node('img', undefined, 'selected'); img.src = `./teeth/product/ttype_${icon}.png`; img.alt = ''; li.append(img); }
                    button.className = `selected product-set${String(item.tooth.productType).includes('Pontic') ? ' pontic' : ''}`;
                    li.title = `T${item.fdi} ${productName(item.tooth.productType)}`;
                }
                li.append(node('label', item.fdi), button);
                list.append(li);
            } else {
                const isLine = Boolean(previousLink && item.selected && previousLink.selected);
                const li = node('li', undefined, `link l${item.link} ${item.selected}${isLine ? ' line' : ''}`);
                const button = node('button', undefined, item.selected ? 'selected' : '');
                button.type = 'button'; button.tabIndex = -1;
                li.append(button);
                list.append(li);
                previousLink = item;
            }
        }
        return list;
    };
    const content = node('div', undefined, 'prostheses-content');
    for (const [text, className] of [['Upper', 'upper-label'], ['Lower', 'lower-label'], ['Right', 'right-label'], ['Left', 'left-label']]) content.append(node('span', text, className));
    const top = node('div', undefined, 'tmap-line'); top.append(draw(0, 15, 'tmap-top-left'), draw(16, 30, 'tmap-top-right'));
    const bottom = node('div', undefined, 'tmap-line'); bottom.style.marginTop = '15px';
    bottom.append(draw(31, 46, 'tmap-bottom-left'), draw(47, 61, 'tmap-bottom-right'));
    content.append(top, bottom);

    const legend = node('div', undefined, 'batch-legend');
    const swatch = (text, color) => {
        const item = node('span', undefined, 'legend-item'); const box = node('i', undefined, 'legend-swatch');
        if (color) box.style.backgroundColor = color; else box.classList.add('unset');
        item.append(box, text); return item;
    };
    legend.append(swatch('未設定'));
    const shown = new Set([...Object.keys(products), ...teeth.map(t => t.productType).filter(Boolean)]);
    for (const type of shown) legend.append(swatch(productName(type), productColor(type)));

    const map = node('div', undefined, 'prostheses-map'); map.append(content, legend);
    const layout = node('div', undefined, 'prostheses-layout'); layout.append(map);
    const chart = node('div', undefined, 'prostheses-select prostheses-select-v2'); chart.append(layout);
    return chart;
}
// The same teeth as text, for reading off or copying: one line per tooth in arch order.
function renderTeethList(teeth) {
    const list = node('ul', undefined, 'teeth-list');
    const rows = teeth.map(tooth => ({ tooth, fdi: fdiOfChartId(Number(tooth.id)) }))
        .sort((a, b) => (a.fdi ? fdi.indexOf(a.fdi) : 99) - (b.fdi ? fdi.indexOf(b.fdi) : 99));
    for (const { tooth, fdi: toothFdi } of rows) {
        const item = node('li');
        const swatch = node('i', undefined, 'legend-swatch'); swatch.style.backgroundColor = productColor(tooth.productType);
        const position = fdi.indexOf(toothFdi);
        const next = position >= 0 && position < fdi.length - 1 && Math.floor(toothFdi / 30) === Math.floor(fdi[position + 1] / 30) ? fdi[position + 1] : null;
        const connected = tooth.connector === true || tooth.connector === 'true';
        item.append(swatch, node('strong', toothFdi ? `T${toothFdi}` : `id ${tooth.id}（非恆齒）`), ` ${productName(tooth.productType)}`,
            connected ? node('span', next ? ` · 連接 T${next}` : ' · 連接下一齒', 'connector') : '');
        list.append(item);
    }
    if (!rows.length) list.append(node('li', '這張訂單沒有齒位資料。', 'muted'));
    return list;
}
function toggleTeeth(row, button, project) {
    const open = row.nextElementSibling?.classList.contains('teeth-row') ? row.nextElementSibling : null;
    if (open) { open.remove(); button.textContent = '齒位'; return; }
    const teeth = Array.isArray(project.teeth) ? project.teeth : [];
    const cell = node('td'); cell.colSpan = 5;
    const detail = node('div', undefined, 'teeth-detail');
    detail.append(renderTeethChart(teeth), renderTeethList(teeth));
    cell.append(detail);
    const detailRow = node('tr', undefined, 'teeth-row'); detailRow.append(cell);
    row.after(detailRow);
    button.textContent = '收合齒位';
}

async function operate(serial, operation) {
    serial = serial.trim();
    if (!serial) throw new Error('請先輸入完整外部序號。');
    $('serial').value = serial;
    const encoded = encodeURIComponent(serial);
    if (operation === 'status') {
        const data = await api(`status/${encoded}`);
        detail(data);
        message(`${serial}：${data.status}`);
    } else if (operation === 'viewerLink' || operation === 'editLink') {
        // Open immediately inside the user gesture, before awaiting the API, to avoid popup blocking.
        const tab = window.open('about:blank', '_blank');
        if (!tab) throw new Error('瀏覽器封鎖了新分頁，請允許 eztest 開啟彈出視窗。');
        tab.opener = null;
        try {
            const data = await api(`viewerLink/${encoded}`);
            if (typeof data[operation] !== 'string') throw new Error('後端未提供 Viewer 連結。');
            const link = new URL(data[operation], config.baseUrl);
            if (link.origin !== new URL(config.baseUrl).origin || !['http:', 'https:'].includes(link.protocol)) throw new Error('Viewer 連結與設定的後端不同。');
            tab.location.replace(link.href);
            message(`已開啟 ${serial} 的${operation === 'editLink' ? '編輯器' : ' Viewer'}。`);
        } catch (error) { tab.close(); throw error; }
    } else {
        message(`正在準備 ${serial} 的下載…`);
        const blob = await api(`${operation}/${encoded}`, { download: true });
        const url = URL.createObjectURL(blob);
        const link = node('a'); link.href = url; link.download = `${serial.replace(/[\\/:*?"<>|]/g, '_')}${operation === 'marginLine' ? '-margins' : ''}.zip`;
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        message('下載已開始。');
    }
}
function generateSerial() { $('create-serial').value = `INTERNAL-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomUUID().slice(0, 6)}`; }
function addTooth(id = 11, product = 'anatomicCrown') {
    const row = node('div', undefined, 'tooth');
    const tooth = node('select'); tooth.setAttribute('aria-label', 'FDI 齒位'); tooth.className = 'fdi';
    for (const value of fdi) { const option = node('option', `T${value}`); option.value = value; tooth.append(option); }
    tooth.value = id;
    const type = node('select'); type.setAttribute('aria-label', '產品類型'); type.className = 'product';
    for (const [value, label] of Object.entries(products)) { const option = node('option', label); option.value = value; type.append(option); }
    type.value = product;
    const label = node('label'); const connector = node('input'); connector.type = 'checkbox'; connector.className = 'connector'; label.append(connector, '連接下一齒');
    const remove = node('button', '移除'); remove.type = 'button'; remove.addEventListener('click', () => row.remove());
    row.append(tooth, type, label, remove); $('teeth').append(row);
}

// Defaults follow externalProject/projectController, rather than the logged-in user's
// material presets. Numeric bounds for post-processing follow PostProcessingPage.
const advancedGroups = {
    crownStretching: {
        title: '牙冠伸縮',
        fields: [
            { key: 'occlusalGap', label: '咬合間隙', value: -0.2, min: -0.2, max: 1, step: 0.01, unit: 'mm' },
            { key: 'adjacentGap', label: '鄰接間隙', value: -0.2, min: -0.2, max: 0.2, step: 0.01, unit: 'mm' },
        ],
    },
    designParameter: {
        title: '設計參數',
        fields: [
            { key: 'material', label: '材質名稱', value: 'zirconia', options: [['zirconia', '氧化鋯'], ['Metal', '金屬'], ['Composite', '複合樹脂'], ['PMMA', 'PMMA'], ['Others', '其他']] },
            { key: 'name', label: '參數組名稱', value: 'default', type: 'text' },
            { key: 'extraCementGap', label: '特殊黏合預留', value: 0.07, min: -0.05, max: 0.2, step: 0.01, unit: 'mm' },
            { key: 'cementHeight', label: '黏合預留高度', value: 1, min: 0.5, max: 4.9, step: 0.1, unit: 'mm' },
            { key: 'cementGap', label: '黏合預留', value: 0.05, min: -0.05, max: 0.2, step: 0.01, unit: 'mm' },
            { key: 'minimumThickness', label: '最小厚度', value: 0.5, min: 0.3, max: 1, step: 0.1, unit: 'mm' },
            { key: 'slopeExtension', label: '削尖高度', value: 0.3, min: 0.05, max: 0.5, step: 0.05, unit: 'mm' },
            { key: 'marginExtension', label: '削尖厚度', value: 0.3, min: 0.05, max: 0.5, step: 0.05, unit: 'mm' },
            { key: 'slopeAngle', label: '削尖角度', value: 45, min: 0, max: 90, step: 1, unit: '°' },
            { key: 'drillRadius', label: '刀具半徑', value: 0.6, min: 0, max: 1, step: 0.1, unit: 'mm' },
            { key: 'blockUndercut', label: '取消模型補倒凹', value: false, type: 'checkbox' },
        ],
    },
    buildEModel: {
        title: '生成模型',
        fields: [
            { key: 'useDie', label: '使用個別牙模', value: true, type: 'checkbox' },
            { key: 'hollow', label: '模型掏空', value: true, type: 'checkbox' },
            { key: 'dieOnModel', label: '模型保留牙模', value: false, type: 'checkbox' },
            { key: 'eModelHeight', label: '模型高度', value: 30, min: 25, max: 50, step: 0.1, unit: 'mm' },
        ],
    },
};
const contactAreaField = { key: 'bridgeContactArea', label: '鄰接接觸區參數', value: 50, min: 9, max: 1000, step: 'any' };

function parameterField(prefix, field) {
    const label = node('label');
    const input = node(field.options ? 'select' : 'input');
    input.id = `${prefix}-${field.key}`;
    if (field.options) {
        for (const [value, text] of field.options) { const option = node('option', text); option.value = value; input.append(option); }
        input.value = field.value;
    } else {
        input.type = field.type || 'number';
        if (field.type === 'checkbox') input.checked = field.value;
        else {
            input.value = field.value;
            input.required = true;
            if (field.type === 'text') input.maxLength = 100;
            else { input.min = field.min; input.max = field.max; input.step = field.step; }
        }
    }
    if (field.type === 'checkbox') {
        label.className = 'check-label'; label.append(input, field.label);
    } else {
        label.append(node('span', field.label + (field.unit ? `（${field.unit}）` : '')), input);
        if (field.min !== undefined) label.append(node('small', `${field.min} ～ ${field.max}`));
    }
    return label;
}
function parameterToggle(id, title) {
    const label = node('label', undefined, 'check-label parameter-toggle');
    const input = node('input'); input.type = 'checkbox'; input.id = id;
    label.append(input, title);
    input.addEventListener('change', syncDesignControls);
    return label;
}
function syncDesignControls() {
    $('ai-fields').disabled = !$('custom-ai').checked;
    $('ai-fields').hidden = !$('custom-ai').checked;
    $('post-fields').disabled = !$('custom-post').checked;
    $('post-fields').hidden = !$('custom-post').checked;
    for (const key of Object.keys(advancedGroups)) {
        $(`${key}-fields`).disabled = !$(`${key}-enable`).checked;
        $(`${key}-fields`).hidden = !$(`${key}-enable`).checked;
    }
    const useDie = $('buildEModel-useDie').checked;
    $('buildEModel-dieOnModel').disabled = !useDie;
    if (!useDie) $('buildEModel-dieOnModel').checked = false;
}
function initDesignControls() {
    const ai = node('section', undefined, 'parameter-panel');
    ai.append(parameterToggle('custom-ai', '自訂 AI 設計參數'), node('p', '未勾選時使用後端預設。自訂接觸區參數的起始值為 50。', 'hint'));
    const aiFields = node('fieldset'); aiFields.id = 'ai-fields';
    aiFields.append(parameterField('ai', contactAreaField)); ai.append(aiFields);

    const post = node('section', undefined, 'parameter-panel');
    post.append(parameterToggle('custom-post', '自訂後處理'), node('p', '未勾選時使用後端預設。勾選後，僅執行下方已啟用的處理項目。', 'hint'));
    const postFields = node('fieldset'); postFields.id = 'post-fields';
    for (const [key, group] of Object.entries(advancedGroups)) {
        const section = node('section', undefined, 'parameter-group');
        section.append(parameterToggle(`${key}-enable`, `啟用${group.title}`));
        const fields = node('fieldset', undefined, 'fields'); fields.id = `${key}-fields`;
        for (const field of group.fields) fields.append(parameterField(key, field));
        if (key === 'designParameter') fields.append(node('p', '初始數值採外部 API 預設；變更材質名稱不會自動套用其他數值。', 'hint parameter-note'));
        section.append(fields);
        postFields.append(section);
    }
    post.append(postFields);
    $('design-options').append(ai, post);
    $('buildEModel-useDie').addEventListener('change', syncDesignControls);
    syncDesignControls();
    // Reveal an invalid control even if the user has collapsed advanced options.
    $('create-form').addEventListener('invalid', event => {
        let container = event.target.parentElement;
        while (container) { if (container.tagName === 'DETAILS') container.open = true; container = container.parentElement; }
    }, true);
}
function parameterValue(prefix, field) {
    const input = $(`${prefix}-${field.key}`);
    if (field.type === 'checkbox') return input.checked;
    if (field.options || field.type === 'text') {
        const value = input.value.trim();
        if (!value) throw new Error(`請填寫${field.label}。`);
        return value;
    }
    const value = input.valueAsNumber;
    if (!Number.isFinite(value) || !input.checkValidity()) throw new Error(`${field.label}需填入 ${field.min} ～ ${field.max} 的有效數值。`);
    return value;
}
function appendDesignParameters(data) {
    if ($('custom-ai').checked) data.set('aiDesignParam', JSON.stringify({ bridgeContactArea: parameterValue('ai', contactAreaField) }));
    if (!$('custom-post').checked) return;
    const post = {};
    for (const [key, group] of Object.entries(advancedGroups)) {
        const enable = $(`${key}-enable`).checked;
        post[key] = { enable };
        if (enable) for (const field of group.fields) post[key][field.key] = parameterValue(key, field);
    }
    if (post.buildEModel.enable && !post.buildEModel.useDie) post.buildEModel.dieOnModel = false;
    data.set('postProcessingData', JSON.stringify(post));
}
function buildForm() {
    const form = $('create-form');
    const data = new FormData();
    data.set('externalSerialnum', form.elements.externalSerialnum.value.trim());
    data.set('patient', form.elements.patient.value.trim());
    const teeth = [...$('teeth').children].map(row => ({ id: Number(row.querySelector('.fdi').value), productType: row.querySelector('.product').value, connector: row.querySelector('.connector').checked }));
    teeth.sort((a, b) => fdi.indexOf(a.id) - fdi.indexOf(b.id));
    if (!teeth.length || new Set(teeth.map(t => t.id)).size !== teeth.length) throw new Error('至少選擇一個齒位，齒位不可重複。');
    for (let i = 0; i < teeth.length; i++) {
        const current = teeth[i], next = teeth[i + 1];
        if (current.connector && (!next || Math.floor(current.id / 30) !== Math.floor(next.id / 30) || fdi.indexOf(next.id) !== fdi.indexOf(current.id) + 1)) throw new Error('連接只能勾選相鄰、同顎的下一個齒位。');
        if (current.productType === 'anatomicPontic' && !current.connector && !teeth[i - 1]?.connector) throw new Error('橋體需與相鄰牙冠連接。');
    }
    data.set('teeth', JSON.stringify(teeth));
    let size = 0;
    for (const name of ['maxilla', 'mandible']) {
        const file = form.elements[name].files[0];
        if (!file || !file.size || !/\.(stl|ply|obj)$/.test(file.name)) throw new Error('請選擇非空的上下顎模型，副檔名需為小寫 stl、ply 或 obj。');
        data.set(name, file); size += file.size;
    }
    const margins = new Set();
    for (const file of $('margins').files) {
        const match = /^margin_line-(\d+)\.pts$/.exec(file.name);
        if (!match || !teeth.some(t => t.id === Number(match[1])) || !file.size || file.size > 1024 * 1024 || margins.has(file.name)) throw new Error('邊緣線需為所選齒位的 margin_line-<FDI>.pts，不可重複，每檔需介於 1 byte 至 1 MB。');
        margins.add(file.name); data.append('marginFiles', file); size += file.size;
    }
    if (size > config.maxUploadBytes - 1024 * 1024) throw new Error('總檔案大小超過上傳上限（需保留表單封裝空間）。');
    appendDesignParameters(data);
    return data;
}
async function checkCreate() {
    const serial = $('create-serial').value.trim();
    if (!serial) throw new Error('請先輸入外部序號。');
    try {
        const data = await api(`status/${encodeURIComponent(serial)}`);
        message(`${serial} 已存在，狀態：${data.status}。請勿重複建單。`, false, 'create-message');
    } catch (error) {
        if (error.reason !== 'orderNotFound') throw error;
        message('目前查無此序號。若前次送出逾時，請稍後再次確認；本次工作階段不會重送相同序號。', false, 'create-message');
    }
}
async function createCase(event) {
    event.preventDefault();
    if (creating) return;
    const button = $('submit-create');
    await run(button, async () => {
        const data = buildForm();
        const serial = data.get('externalSerialnum');
        if (!serial) throw new Error('外部序號不可為空白。');
        if (attempts.has(serial)) throw new Error('此序號已送出過，請先查詢此序號，避免重複建單。');
        creating = true;
        // Freeze inputs while the preflight/upload is running so feedback refers to the submitted form.
        const controls = [...$('create-form').elements];
        const disabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try {
            message('正在確認外部序號是否已存在…', false, 'create-message');
            try {
                await api(`status/${encodeURIComponent(serial)}`);
                throw new Error('此序號已存在，請使用查詢、Viewer 或編輯功能。');
            } catch (error) { if (error.reason !== 'orderNotFound') throw error; }
            attempts.add(serial);
            message('正在上傳並建單，請保持頁面開啟。逾時不會自動重送。', false, 'create-message');
            const result = await api('project', { method: 'POST', body: data, expectedStatus: 201 });
            if (!result.order?.oid || !result.order?.pid) throw new Error('回應缺少 oid / pid，請先查詢原序號，勿直接重送。');
            $('serial').value = serial;
            detail(result);
            message(`建單成功：${serial}\nOID：${result.order.oid}\nPID：${result.order.pid}\nAI 尚未確認完成，請按「查詢此序號」。`, false, 'create-message');
            offset = 0;
            await loadList();
        } catch (error) {
            if (attempts.has(serial)) error.message += `\n請保留原序號 ${serial} 並先查詢狀態；此頁不會自動重送。`;
            throw error;
        } finally {
            creating = false;
            controls.forEach((control, i) => { control.disabled = disabled[i]; });
        }
    }, 'create-message');
}
async function init() {
    const response = await fetch('/api/fussen/config', { headers: { 'X-Fussen-Workbench': '1' } });
    if (!response.ok) throw new Error(`無法載入 Fussen 設定（HTTP ${response.status}）。`);
    const site = (await response.json()).sites.find(s => s.id === SITE);
    if (!site) throw new Error(`沒有「${SITE}」這個站點。`);
    config = { baseUrl: site.baseUrl, maxUploadBytes: site.maxUploadBytes };
    $('host').textContent = `${site.label} ${site.baseUrl}`;
    $('create-site').textContent = `送到${site.label}：${site.baseUrl}${SITE === 'prod' ? '（真實客戶環境）' : ''}`;
    $('create-site').classList.toggle('prod', SITE === 'prod');
    if (!site.configured) {
        stopped = true;
        document.querySelectorAll('button').forEach(button => { button.disabled = true; });
        throw new Error(`eztest 沒有設定${site.label}的 API key（.env 的 ${site.keyName}）。`);
    }
    $('search-form').addEventListener('submit', event => { event.preventDefault(); offset = 0; loadList(); });
    $('refresh').addEventListener('click', loadList);
    $('previous').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); loadList(); });
    $('next').addEventListener('click', () => { offset += PAGE_SIZE; loadList(); });
    $('lookup-form').addEventListener('submit', event => { event.preventDefault(); run(event.submitter, () => operate($('serial').value, 'status')); });
    document.querySelectorAll('[data-quick]').forEach(button => button.addEventListener('click', () => run(button, () => operate($('serial').value, button.dataset.quick))));
    $('new-case').addEventListener('click', () => { if (!$('create-serial').value) generateSerial(); $('create-dialog').showModal(); });
    $('close-create').addEventListener('click', () => $('create-dialog').close());
    $('create-dialog').addEventListener('cancel', event => { if (creating) event.preventDefault(); });
    $('close-detail').addEventListener('click', () => { $('detail').hidden = true; });
    $('generate-serial').addEventListener('click', generateSerial);
    $('add-tooth').addEventListener('click', () => addTooth());
    $('check-create').addEventListener('click', event => run(event.currentTarget, checkCreate, 'create-message'));
    $('create-form').addEventListener('submit', createCase);
    initDesignControls();
    addTooth();
    await loadList();
}
init().catch(error => message(error.message, true));
