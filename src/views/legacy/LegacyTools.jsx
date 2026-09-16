/* eslint-disable react/prop-types -- props are documented at each component; no prop-types dependency here */
import { useReducer, useState } from 'react';
import { Button, Collapse, Input, Select, Upload } from 'antd';

import PredictDirection from '../../utils/function/PredictDirection';
import PredictAbutment from '../../utils/function/predict-abutment/PredictAbutment';
import { setupByAbutTaskUrl, setupByDirectionTaskUrl } from '../../utils/function/SetupByTaskUrl';
import CheckGroundTrue from '../../utils/function/CheckGroundTrue';
import CheckAIMarginResult from '../../utils/function/CheckAIMarginResult';
import { onUploadFile } from './legacyUpload';

const taskDomainOption = [{
  value: 'http://localhost:3000/api/executable/airdesign/task/',
  label: 'http://localhost:3000/api/executable/airdesign/task/',
}, {
  value: 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/',
  label: 'https://test-airdental.inteware.com.tw/api/executable/airdesign/task/',
}];

/**
 * The tools that predate the crown flow, moved here unchanged from App.jsx. They work on
 * their own meshes (PredictDirection / PredictAbutment / CheckGroundTrue), not on the scans
 * the design tab loads.
 */
const LegacyTools = ({ setIsLoading }) => {
  const [, forceRerender] = useReducer(x => x + 1, 0);
  const [taskDomain, setTaskDomain] = useState(taskDomainOption[1].value);
  const [taskId, setTaskId] = useState('');

  const withLoading = action => async () => {
    setIsLoading(true);
    try {
      await action();
    } finally {
      setIsLoading(false);
    }
  };

  const onUploadAbutmentData = async ({ file }) => {
    const object = JSON.parse(await file.text());
    PredictAbutment.processResult(object);
  };

  const uploadModel = <>
    <div className='function-group'>
      <Upload customRequest={({ file }) => onUploadFile(file)} showUploadList={false}>
        <Button>upload model</Button>
      </Upload>
      <Upload customRequest={onUploadAbutmentData} showUploadList={false}>
        <Button>import abutment data</Button>
      </Upload>
    </div>
    <div className='function-group'>
      <Input
        className='function-button'
        value={PredictAbutment.toothFdi}
        onChange={e => {
          PredictAbutment.toothFdi = e.target.value;
          forceRerender();
        }}
        placeholder='input FDI'
        onPressEnter={withLoading(async () => {
          await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30);
          await PredictAbutment.callApi_2();
        })}
      />
    </div>
    <div className='function-group'>
      <Input
        className='function-button'
        value={PredictAbutment.allToothFdi}
        onChange={e => {
          PredictAbutment.allToothFdi = e.target.value;
          forceRerender();
        }}
        placeholder='input All FDI'
        onPressEnter={withLoading(async () => {
          const fdiStrArray = PredictAbutment.allToothFdi.split(',');
          if (!fdiStrArray[0]) return;
          await PredictDirection.predictMesh(fdiStrArray[0] < 30);
          await PredictAbutment.callApi_2();
        })}
      />
    </div>
  </>;

  const directionTools = <div className='legacy-tool-stack'>
    <div className='function-group'>
      <Button className='function-button' onClick={withLoading(async () => {
        await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30);
        await PredictAbutment.callApi();
      })}>predict dir and margin 1</Button>
      <Button className='function-button' onClick={withLoading(async () => {
        await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30);
        await PredictAbutment.callApi(2);
      })}>predict dir and margin 1_2</Button>
      <Button className='function-button' onClick={withLoading(async () => {
        await PredictDirection.predictMesh(PredictAbutment.toothFdi < 30);
        await PredictAbutment.callApi_2();
      })}>predict dir and margin 2</Button>
    </div>
    <div className='function-group'>
      <Button className='function-button' onClick={withLoading(() => PredictDirection.predictMesh(true))}>
        predict upper dir
      </Button>
      <Button className='function-button' onClick={withLoading(() => PredictDirection.predictMesh(false))}>
        predict lower dir
      </Button>
    </div>
    <div className='function-group'>
      <Button className='function-button' onClick={withLoading(() => PredictAbutment.callApi())}>predict margin 1</Button>
      <Button className='function-button' onClick={withLoading(() => PredictAbutment.callApi(2))}>predict margin 1_2</Button>
      <Button className='function-button' onClick={withLoading(() => PredictAbutment.callApi_2())}>predict margin 2</Button>
      <Button className='function-button' onClick={withLoading(() => PredictAbutment.callApi_checkNPZ())}>
        predict margin 2_checkNPZ
      </Button>
    </div>
  </div>;

  const taskTools = <>
    <div className='function-group'>
      <Select value={taskDomain} options={taskDomainOption} onChange={setTaskDomain} />
    </div>
    <div className='function-group'>
      <Input
        className='function-button'
        value={taskId}
        onChange={e => setTaskId(e.target.value)}
        placeholder='input abut taskId'
        onPressEnter={withLoading(() => setupByAbutTaskUrl(taskDomain + taskId))}
      />
      <Button className='function-button' onClick={withLoading(() => setupByAbutTaskUrl(taskDomain + taskId))}>
        setupByAbutTaskUrl
      </Button>
      <Button className='function-button' onClick={withLoading(() => setupByDirectionTaskUrl(taskDomain + taskId))}>
        setupByDirTaskUrl
      </Button>
    </div>
  </>;

  const verifyTools = <div className='legacy-tool-stack'>
    <div className='function-group'>
      <Input
        className='function-button'
        value={CheckGroundTrue.dataIndex}
        onChange={e => {
          CheckGroundTrue.dataIndex = Number(e.target.value);
          forceRerender();
        }}
        onPressEnter={async () => {
          await CheckGroundTrue.loadNext();
          forceRerender();
        }}
      />
      <Button className='function-button' onClick={async () => {
        await CheckGroundTrue.loadNext();
        forceRerender();
      }}>next</Button>
      <Button className='function-button' onClick={() => CheckGroundTrue.save()}>save</Button>
    </div>
    <div className='function-group'>
      <Button className='function-button' onClick={() => CheckAIMarginResult.init()}>checkAIMarginResult</Button>
    </div>
  </div>;

  return <div className='legacy-tools-panel'>
    <p className='panel-note'>
      這些是牙冠流程之前的舊工具，使用自己的模型與 mesh，和「牙冠設計」分頁上傳的口掃無關。
    </p>
    <Collapse
      className='legacy-tools'
      size='small'
      items={[
        { key: 'model', label: '既有模型與牙位設定', children: uploadModel },
        { key: 'predict', label: '擺正與 Margin 測試工具', children: directionTools },
        { key: 'task', label: 'Task 載入', children: taskTools },
        { key: 'verify', label: '驗證工具', children: verifyTools },
      ]}
    />
  </div>;
};

export default LegacyTools;
