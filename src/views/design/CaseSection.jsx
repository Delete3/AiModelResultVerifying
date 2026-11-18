/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { Alert, Button, Checkbox, Input, InputNumber, Tag, Tooltip, Upload } from 'antd';

import { SCAN_ACCEPT } from '../../utils/loader/loadGeometry';

const JAW_NAME = { upper: '上顎', lower: '下顎' };

/**
 * The case: FDI, the arch scans, and what happens without the opposing arch. Shared by every
 * product of the 牙冠設計 tab; the case stays when the product changes.
 *
 * Props: step, fdi, setFdi, allToothFdi / setAllToothFdi (null: not asked, e.g. a drawn margin),
 * prepJaw, prepRole (the prep arch's tag: 備牙顎 or 植體位置所在顎), scene (CaseScene snapshot),
 * busy, onUpload(jaw) (an Upload beforeUpload), onRemove(jaw), scanError, ignoreOpposing /
 * setIgnoreOpposing, noOpposing ({ message, description } shown without the opposing arch),
 * ignoreLabel (the checkbox's words).
 */
const CaseSection = ({
  step, fdi, setFdi, allToothFdi, setAllToothFdi, prepJaw, prepRole, scene, busy, onUpload, onRemove, scanError,
  ignoreOpposing, setIgnoreOpposing, noOpposing, ignoreLabel,
}) => {
  const has = { upper: scene.hasUpper, lower: scene.hasLower };
  const opposingJaw = prepJaw === 'upper' ? 'lower' : prepJaw === 'lower' ? 'upper' : null;
  const hasPrep = Boolean(prepJaw && has[prepJaw]);
  const hasOpposing = Boolean(opposingJaw && has[opposingJaw]);
  const disabled = Boolean(busy);

  const scanSlot = jaw => {
    const isPrep = jaw === prepJaw;
    const role = !prepJaw ? '' : isPrep ? prepRole : '對咬顎';
    const fileName = jaw === 'upper' ? scene.upperName : scene.lowerName;
    return <div className={`scan-slot ${has[jaw] ? 'loaded' : ''} ${isPrep ? 'prep' : ''}`}>
      <div className='scan-slot-head'>
        <span>{JAW_NAME[jaw]}</span>
        {role && <Tag color={isPrep ? 'orange' : 'default'}>{role}</Tag>}
      </div>
      <Upload accept={SCAN_ACCEPT} showUploadList={false} beforeUpload={onUpload(jaw)} disabled={disabled}>
        <Button block size='small' type={has[jaw] ? 'default' : 'dashed'} disabled={disabled} title={fileName ?? `${JAW_NAME[jaw]}口掃：.stl、.ply 或 .tri`}>
          {fileName ?? '上傳 STL / PLY / TRI'}
        </Button>
      </Upload>
      {has[jaw] && <Button size='small' type='link' danger disabled={disabled} onClick={() => onRemove(jaw)}>移除</Button>}
    </div>;
  };

  return <section className='panel-section'>
    <div className='section-title'><span className='step'>{step}</span>病例</div>
    <div className='field-row'>
      <label>
        FDI
        <InputNumber min={11} max={48} value={fdi} onChange={setFdi} placeholder='例如 36' disabled={disabled} />
      </label>
      {setAllToothFdi && <label>
        <Tooltip title='同一顎有多顆備牙時填入完整清單（含本顆），供 margin 模型參考；單顆可留白'>
          同顎所有備牙 FDI
        </Tooltip>
        <Input value={allToothFdi} onChange={e => setAllToothFdi(e.target.value)} placeholder='例如 14,15' disabled={disabled} />
      </label>}
    </div>
    <div className='scan-slots'>
      {scanSlot('upper')}
      {scanSlot('lower')}
    </div>
    {scanError && <Alert className='section-alert' type='error' showIcon message={scanError} />}
    {hasPrep && !hasOpposing && <Alert className='section-alert' type='info' showIcon {...noOpposing} />}
    {hasPrep && hasOpposing && <Checkbox checked={ignoreOpposing} onChange={e => setIgnoreOpposing(e.target.checked)} disabled={disabled}>
      {ignoreLabel}
    </Checkbox>}
  </section>;
};

export default CaseSection;
