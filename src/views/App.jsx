import './App.scss';

import { useRef } from 'react';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import * as THREE from 'three';
import { Upload, Button, Input } from 'antd';
import axios from 'axios';

import Editor from '../utils/Editor';
import { useUpdateEffect } from '../utils/tool/UseUpdateEffect';
import { extractAbutment } from '../utils/function/ExtractAbutment';
import { prepareColorMesh } from '../utils/function/SceneTool';

import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { drawArrow, drawSphere } from '../utils/tool/ThreejsMathTool';
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

/**
 * @param {string} string 
 * @returns {string}
 */
const getFileExtension = (string) => {
  return string.slice((string.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
}

/**
 * @param {File} file 
 */
const loadModel = async file => {
  /**
   * @param {Blob} blob 
   * @param {string} fileFormat 
   * @returns {GeometryWithFileFormat}
   */
  const parseGeometry = async (blob, fileFormat) => {
    /**@type {THREE.BufferGeometry} */
    let geometry = null;
    if (fileFormat == 'stl') geometry = new STLLoader().parse(await blob.arrayBuffer());
    else if (fileFormat == 'obj') {
      const group = new OBJLoader().parse(await blob.text());
      const mesh = group.children[0];
      geometry = mesh.geometry;
    }
    else if (fileFormat == 'ply') geometry = new PLYLoader().parse(await blob.arrayBuffer());
    else return;

    geometry.computeBoundsTree();
    geometry.computeVertexNormals();
    return geometry;
  }

  try {
    const fileExtension = getFileExtension(file.name);
    const buffrGeometry = await parseGeometry(file, fileExtension);

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(buffrGeometry, material);
    prepareColorMesh(mesh);
    mesh.name = 'model';

    Editor.scene.add(mesh);
  } catch (error) {
    console.log(error);
  }
};

/**
 * @param {File} file 
 */
const loadMargin = async file => {
  const marginDataText = await file.text();
  const marginVectorList = marginDataText.split('\n');

  const marginPoints = [];
  for (let i = 1; i < marginVectorList.length - 1; i++) {
    const vectorText = marginVectorList[i].split(' ');
    const point = new THREE.Vector3(Number(vectorText[0]), Number(vectorText[1]), Number(vectorText[2]));
    marginPoints.push(point);
  }

  const fittedCurve = new THREE.CatmullRomCurve3(marginPoints, true);
  const curveGeometry = new THREE.TubeGeometry(fittedCurve, marginPoints.length, 0.02, 8, true);
  const curveMesh = new THREE.Mesh(curveGeometry, new THREE.MeshStandardMaterial({
    color: 0xff0000,
    emissive: 0,
    metalness: 0.2,
    side: 2,
    roughness: 0.5
  }));
  curveMesh.marginPoints = marginPoints;
  curveMesh.name = 'margin';
  curveMesh.visible = false;

  Editor.scene.add(curveMesh);
}

const loadDirJson = async file => {
  const dirText = await file.text();
  const matrixArrayData = JSON.parse(dirText);
  const matrix = new THREE.Matrix4()
  matrix.fromArray(matrixArrayData.flat());

  /**@type {string} */
  const filename = file.name;
  const isLower = filename.split('_')[2].includes('+');

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const dirVector = new THREE.Vector3(0, 0, isLower ? 1 : -1);
  return dirVector.applyQuaternion(quaternion);
}

/**
 * @param {File} file 
 */
const loadPointCloud = async file => {
  const string = await file.text();
  const pointStrList = string.split('\n');
  for (const pointStr of pointStrList) {
    const [x, y, z] = pointStr.split(' ');
    const point = new THREE.Vector3(x, y, z);
    drawSphere(point, 0xff0000, crypto.randomUUID(), 0.1)
  }

}

/**
 * @param {File} file 
 */
const loadFile = async file => {
  const fileExtension = getFileExtension(file.name);
  if (['stl', 'obj', 'ply'].includes(fileExtension)) return await loadModel(file);
  else if ('pts' == fileExtension) return await loadMargin(file);
  else if ('json' == fileExtension) return await loadDirJson(file);
  else if ('txt' == fileExtension) return await loadPointCloud(file);
}

function App() {
  const containerRef = useRef();

  useUpdateEffect(() => {
    const initial = async () => {
      if (!containerRef.current) return;

      Editor.setEditor(containerRef.current);
      const axisHelper = new THREE.AxesHelper(10);
      Editor.scene.add(axisHelper);

      const modelName = 'lower.ply';
      const modelRes = await axios.get(`./${modelName}`, { responseType: 'blob' });
      const modelFile = modelRes.data;
      modelFile.name = modelName;

      const marginName = 'design_service_margin_line-35.pts';
      const marginRes = await axios.get(`./${marginName}`, { responseType: 'blob' });
      const marginFile = marginRes.data;
      marginFile.name = marginName;

      const dirName = 'lower_matrix_+Z_+Y.json';
      const dirRes = await axios.get(`./${dirName}`, { responseType: 'blob' });
      const dirFile = dirRes.data;
      dirFile.name = dirName;


      const abutmentPointName = 'abutmentPoints_35.txt';
      const abutmentPointRes = await axios.get(`./${abutmentPointName}`, { responseType: 'blob' });
      const abutmentPointFile = abutmentPointRes.data;
      abutmentPointFile.name = abutmentPointName;




      await loadFile(modelRes.data)
      await loadFile(marginRes.data)
      const zAxis = await loadFile(dirRes.data)
      await loadFile(abutmentPointRes.data)

      const model = Editor.scene.getObjectByName('model');
      const margin = Editor.scene.getObjectByName('margin');
      extractAbutment(model, margin.marginPoints, zAxis);
    };

    initial();
  }, []);

  return (
    <div className="container">
      <Upload
        customRequest={uploadRequestOption => loadFile(uploadRequestOption.file)}
        beforeUpload={(file) => file}
        showUploadList={false}
      >
        <Button>upload file</Button>
      </Upload>
      <Button
        onClick={() => {
          const model = Editor.scene.getObjectByName('model');
          const margin = Editor.scene.getObjectByName('margin');
          extractAbutment(model, margin.marginPoints);
        }}
      >
        extract abutment
      </Button>
      <div ref={containerRef} className="editor" />
    </div>
  );
}

export default App;
