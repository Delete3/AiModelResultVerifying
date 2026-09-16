/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Segmented, Space, Switch, Tooltip, Upload } from 'antd';

import CaseScene from '../../utils/function/CaseScene';
import MarginEditor from '../../utils/function/margin-editor/MarginEditor';
import { formatMarginPts, parseMarginText } from '../../utils/function/margin-editor/marginPts';
import { downloadBlob, useMarginEditor } from '../../utils/tool/useStores';

const SOURCE_LABEL = {
  drawn: '手動繪製',
  file: '上傳檔案',
  'file-edited': '上傳檔案（已修改）',
  ai: 'AI 預測',
  'ai-edited': 'AI 預測（已修改）',
};

// The pipeline warns past 0.3 mm (MARGIN_SURFACE_WARN_MM); the same line here, so a ring
// that would be flagged there is flagged before it is sent.
const SURFACE_WARN_MM = 0.3;

/**
 * Step 2: where the margin comes from. "AI" lets ezai-pipeline predict it (mode=full);
 * "custom" is a ring drawn, uploaded or corrected here and sent with mode=margin_override.
 *
 * Props: marginSource, setMarginSource, fdi, prepJaw, hasPrepScan, busy, onPredict,
 * notice / setNotice (a one-line message about the ring, e.g. a frame warning).
 */
const MarginSection = ({
  marginSource, setMarginSource, fdi, prepJaw, hasPrepScan, busy, onPredict, notice, setNotice,
}) => {
  const editor = useMarginEditor();
  const drawing = editor.mode === 'draw';
  const canEdit = hasPrepScan && Boolean(prepJaw) && !busy;

  const loadRingFile = async file => {
    try {
      const points = parseMarginText(await file.text());
      MarginEditor.setRing(points, 'file');
      const ring = MarginEditor.getRing();
      CaseScene.focusRing(prepJaw, ring);
      const distance = MarginEditor.surfaceDistance();
      setNotice(distance != null && distance > SURFACE_WARN_MM
        ? { type: 'warning', text: `${file.name} 離掃描表面中位數 ${distance.toFixed(2)} mm，可能不是這組口掃的座標系（例如 margin_canonical.pts）。` }
        : { type: 'success', text: `已載入 ${file.name}（${points.length} 點），可直接拖曳修改。` });
    } catch (error) {
      setNotice({ type: 'error', text: `無法讀取 ${file.name}：${error.message}` });
    }
    return false;
  };

  const downloadRing = () => {
    const ring = MarginEditor.getRing();
    if (!ring) return;
    downloadBlob(new Blob([formatMarginPts(ring, fdi)], { type: 'text/plain' }), `margin_${fdi ?? 'unknown'}.pts`);
  };

  const status = (() => {
    if (!hasPrepScan) return prepJaw ? `請先上傳${prepJaw === 'upper' ? '上' : '下'}顎` : '請先輸入 FDI';
    if (drawing) return `繪製中 · 已放 ${editor.controlCount} 點${editor.controlCount >= 3 ? ' · 點第一點或按 Enter 閉合' : ''}`;
    if (editor.hasRing) {
      return `已閉合 · ${editor.controlCount} 個控制點 · 周長 ${editor.perimeter.toFixed(1)} mm · ${SOURCE_LABEL[editor.source] ?? ''}`;
    }
    return '尚未有 margin';
  })();

  return <section className='panel-section'>
    <div className='section-title'><span className='step'>2</span>Margin</div>
    <Segmented
      block
      value={marginSource}
      onChange={setMarginSource}
      options={[
        { label: 'AI 自動預測', value: 'ai' },
        { label: '自訂（繪製 / 上傳）', value: 'custom' },
      ]}
    />

    {marginSource === 'ai' && <div className='section-body'>
      <p className='panel-note'>
        由 pipeline 的 margin 模型預測（mode=full）。PEEK abutment 這類模型認不得的案例，請改用「自訂」。
      </p>
      <Tooltip title='只跑擺正與 margin（mode=margin_only），把結果載入編輯器，修改後再生成'>
        <Button block disabled={!canEdit} loading={busy === 'margin'} onClick={onPredict}>
          先讓 AI 預測 margin，再手動修改
        </Button>
      </Tooltip>
    </div>}

    {marginSource === 'custom' && <div className='section-body'>
      <div className='button-grid'>
        {!drawing
          ? <Button type={editor.hasRing ? 'default' : 'primary'} disabled={!canEdit} onClick={() => {
            if (editor.hasRing && !window.confirm('重新繪製會取代目前的 margin，確定嗎？')) return;
            setNotice(null);
            MarginEditor.startDrawing();
          }}>{editor.hasRing ? '重新繪製' : '開始繪製'}</Button>
          : <Button type='primary' disabled={editor.controlCount < 3} onClick={() => MarginEditor.finishDrawing()}>
            完成（閉合）
          </Button>}
        <Upload accept='.pts,.json,.txt' showUploadList={false} beforeUpload={loadRingFile} disabled={!canEdit || drawing}>
          <Button block disabled={!canEdit || drawing}>上傳 .pts</Button>
        </Upload>
        <Button disabled={!canEdit || !(editor.canUndo || drawing)} onClick={() => MarginEditor.undo()}>
          復原
        </Button>
        <Button danger disabled={!canEdit || (!editor.controlCount && !drawing)} onClick={() => {
          if (drawing) MarginEditor.cancelDrawing();
          else MarginEditor.clear();
          setNotice(null);
        }}>{drawing ? '取消' : '清除'}</Button>
      </div>

      <div className='margin-status'>
        <span>{status}</span>
        {editor.hasRing && !drawing && <Space size={6}>
          <span className='switch-label'>顯示控制點</span>
          <Switch size='small' checked={editor.mode === 'edit'} onChange={checked => MarginEditor.setEditing(checked)} />
        </Space>}
      </div>

      <div className='button-row'>
        <Button size='small' disabled={!editor.hasRing} onClick={() => CaseScene.focusRing(prepJaw, MarginEditor.getRing())}>
          對焦到 margin
        </Button>
        <Button size='small' disabled={!editor.hasRing} onClick={downloadRing}>下載 .pts</Button>
      </div>

      <ul className='hint-list'>
        <li><b>繪製</b>：左鍵沿邊緣點選；點第一點或 Enter 閉合；Backspace 退一點；Esc 取消</li>
        <li><b>修改</b>：拖曳綠點；點紅線加點；Shift + 點綠點刪除；Ctrl + Z 復原</li>
        <li><b>視角</b>：右鍵旋轉、中鍵平移、滾輪縮放</li>
      </ul>
    </div>}

    {notice && <Alert className='section-alert' type={notice.type} showIcon message={notice.text} closable onClose={() => setNotice(null)} />}
  </section>;
};

export default MarginSection;
