/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Checkbox, ColorPicker, Slider, Spin, Upload } from 'antd';

import PreviewScene, { PALETTE } from '../../utils/function/PreviewScene';
import { MODEL_ACCEPT } from '../../utils/loader/loadModel';
import { usePreviewScene } from '../../utils/tool/useStores';

const formatBytes = bytes => (bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** One model: show/hide, colour, name, then opacity and the switches that apply to it. */
const PreviewItem = ({ item }) => {
  if (item.loading) {
    return <div className='preview-item loading'>
      <Spin size='small' />
      <span className='preview-name' title={item.name}>{item.name}</span>
      <span className='preview-meta'>讀取中… {formatBytes(item.bytes)}</span>
    </div>;
  }

  const percent = Math.round(item.opacity * 100);
  return <div className={`preview-item ${item.visible ? '' : 'is-hidden'}`}>
    <div className='preview-item-head'>
      <Checkbox checked={item.visible} onChange={e => PreviewScene.setVisible(item.id, e.target.checked)} />
      <ColorPicker
        size='small'
        disabledAlpha
        value={item.color}
        presets={[{ label: '常用', colors: PALETTE }]}
        onChangeComplete={color => PreviewScene.setColor(item.id, color.toHexString())}
      />
      <span className='preview-name' title={item.name}>{item.name}</span>
      <Button size='small' type='link' onClick={() => PreviewScene.fitView(item.id)}>置中</Button>
      <Button size='small' type='link' danger onClick={() => PreviewScene.remove(item.id)}>移除</Button>
    </div>
    <div className='preview-meta' title={item.summary}>{item.summary} · {formatBytes(item.bytes)}</div>
    <div className='preview-opacity'>
      <span>透明度</span>
      <Slider
        min={0}
        max={100}
        value={percent}
        tooltip={{ formatter: value => `${value}%` }}
        onChange={value => PreviewScene.setOpacity(item.id, value / 100)}
      />
      <span className='preview-percent'>{percent}%</span>
    </div>
    {(item.hasMesh || item.hasVertexColors) && <div className='preview-switches'>
      {item.hasMesh && <Checkbox checked={item.wireframe} onChange={e => PreviewScene.setWireframe(item.id, e.target.checked)}>線框</Checkbox>}
      {item.hasVertexColors && <Checkbox checked={item.vertexColors} onChange={e => PreviewScene.setVertexColors(item.id, e.target.checked)}>檔案內的顏色</Checkbox>}
    </div>}
  </div>;
};

/**
 * The model preview tab: drop any number of STL / PLY / OBJ / TRI files here or on the 3D
 * view (PreviewOverlay) and look at them together. The case on the other tabs is hidden
 * while this tab is open and comes back as it was; see PreviewScene.
 */
const PreviewPanel = () => {
  const preview = usePreviewScene();
  const loaded = preview.items.filter(item => !item.loading);
  const allVisible = loaded.length > 0 && loaded.every(item => item.visible);

  return <div className='preview-panel'>
    <section className='panel-section'>
      <p className='panel-note'>
        把 STL / PLY / OBJ / TRI 拖曳到下面或右邊的 3D 畫面，可以一次多個，每個模型各自調整顏色、透明度與顯示。
        只在這個分頁看得到，不影響其他分頁的病例。檔案只在這個瀏覽器裡讀取，不會上傳。
      </p>
      <Upload.Dragger
        multiple
        accept={MODEL_ACCEPT}
        showUploadList={false}
        // Every file of a multi-file drop comes through here one by one; the whole list is
        // taken from the first call, so a drop of five files is one batch.
        beforeUpload={(file, fileList) => {
          if (file === fileList[0]) PreviewScene.addFiles(fileList);
          return Upload.LIST_IGNORE;
        }}
      >
        <p className='preview-drop-title'>拖曳模型到這裡，或點擊選擇檔案</p>
        <p className='preview-drop-hint'>.stl · .ply · .obj · .tri（V1 / V2）· 可多選</p>
      </Upload.Dragger>
      {preview.errors.length > 0 && <Alert
        className='section-alert'
        type='error'
        showIcon
        closable
        onClose={() => PreviewScene.dismissErrors()}
        message={`${preview.errors.length} 個檔案無法讀取`}
        description={<ul className='preview-errors'>
          {preview.errors.map(error => <li key={error.id}><b>{error.name}</b>：{error.message}</li>)}
        </ul>}
      />}
    </section>

    {preview.items.length > 0 && <section className='panel-section'>
      <div className='section-title preview-list-title'>
        <span>模型（{loaded.length}{preview.loading ? ` · 讀取中 ${preview.loading}` : ''}）</span>
        <span className='preview-list-actions'>
          <Button size='small' onClick={() => PreviewScene.setAll({ visible: !allVisible })} disabled={!loaded.length}>
            {allVisible ? '全部隱藏' : '全部顯示'}
          </Button>
          <Button size='small' onClick={() => PreviewScene.fitView()} disabled={!loaded.length}>全部置中</Button>
          <Button size='small' danger onClick={() => PreviewScene.clear()}>全部清除</Button>
        </span>
      </div>
      <div className='preview-list'>
        {preview.items.map(item => <PreviewItem key={item.id} item={item} />)}
      </div>
    </section>}
  </div>;
};

export default PreviewPanel;
