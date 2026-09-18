import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { getFileExtension } from '../tool/StringProcessing.js';
import { parseTRI } from './TRILoader.js';

// Anything a developer drops on the model preview: arch scans, crowns, contacts, point
// clouds. Unlike loadGeometry (one triangle mesh, for the case on the design tab), this
// keeps what the file says it is -- a PLY with no faces is a point cloud and is drawn as
// points, an OBJ can hold several meshes and lines -- and keeps the vertex colours.

const MODEL_FORMATS = ['stl', 'ply', 'obj', 'tri'];
const MODEL_ACCEPT = MODEL_FORMATS.map(format => `.${format}`).join(',');

/**
 * @typedef {{ kind: 'mesh'|'points'|'lines', geometry: THREE.BufferGeometry }} ModelPart
 * @typedef {{ format: string, detail: string, parts: ModelPart[] }} LoadedModel
 */

/** How many faces a PLY header declares; 0 means a point cloud. */
const plyFaceCount = buffer => {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536)));
  const end = head.indexOf('end_header');
  if (end < 0) throw new Error('不是有效的 PLY：找不到 end_header');
  return Number(head.slice(0, end).match(/element\s+face\s+(\d+)/)?.[1] ?? 0);
};

const fromObj = text => {
  const group = new OBJLoader().parse(text);
  const parts = [];
  group.traverse(child => {
    if (child.isMesh) parts.push({ kind: 'mesh', geometry: child.geometry });
    else if (child.isPoints) parts.push({ kind: 'points', geometry: child.geometry });
    else if (child.isLine) parts.push({ kind: 'lines', geometry: child.geometry });
  });
  // OBJLoader gives each mesh its own material; the preview draws with its own, so only
  // the geometry is kept.
  group.traverse(child => child.material?.dispose?.());
  return parts;
};

/**
 * @param {File} file
 * @returns {Promise<LoadedModel>}
 */
const loadModel = async file => {
  const format = getFileExtension(file.name);
  if (!MODEL_FORMATS.includes(format)) {
    throw new Error(`不支援 .${format || '（沒有副檔名）'}，只能預覽 ${MODEL_FORMATS.map(f => `.${f}`).join(' ')}`);
  }
  const buffer = await file.arrayBuffer();
  let parts;
  let detail = format.toUpperCase();

  if (format === 'stl') {
    // Binary STLs from Materialise and VisCAM carry per-face colours; STLLoader turns
    // those into a colour attribute, which the preview can show.
    parts = [{ kind: 'mesh', geometry: new STLLoader().parse(buffer) }];
  } else if (format === 'ply') {
    const faces = plyFaceCount(buffer);
    parts = [{ kind: faces > 0 ? 'mesh' : 'points', geometry: new PLYLoader().parse(buffer) }];
    if (!faces) detail = 'PLY 點雲';
  } else if (format === 'obj') {
    parts = fromObj(new TextDecoder().decode(buffer));
  } else {
    const { positions, indices, version, colors } = parseTRI(buffer, { colors: true });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts = [{ kind: 'mesh', geometry }];
    detail = `TRI ${version}`;
  }

  parts = parts.filter(part => part.geometry.getAttribute('position')?.count > 0);
  if (!parts.length) throw new Error('檔案裡沒有任何頂點');
  for (const part of parts) {
    if (part.kind === 'mesh' && !part.geometry.getAttribute('normal')) part.geometry.computeVertexNormals();
    part.geometry.computeBoundingBox();
  }
  return { format, detail, parts };
};

export { loadModel, MODEL_ACCEPT, MODEL_FORMATS };
