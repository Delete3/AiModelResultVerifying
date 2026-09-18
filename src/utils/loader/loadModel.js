import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { parseMarginText } from '../function/margin-editor/marginPts.js';
import { getFileExtension } from '../tool/StringProcessing.js';
import { parseTRI } from './TRILoader.js';

// Anything a developer drops on the model preview: arch scans, crowns, contacts, point
// clouds, margin lines. Unlike loadGeometry (one triangle mesh, for the case on the design
// tab), this keeps what the file says it is -- a PLY with no faces is a point cloud and is
// drawn as points, an OBJ can hold several meshes and lines, a .pts is one or more rings --
// and keeps the vertex colours.

const MODEL_FORMATS = ['stl', 'ply', 'obj', 'tri', 'pts'];
const MODEL_ACCEPT = MODEL_FORMATS.map(format => `.${format}`).join(',');

/**
 * @typedef {{ kind: 'mesh'|'points'|'lines', geometry: THREE.BufferGeometry }} ModelPart
 * @typedef {{ kind: 'ring', label: string, points: number[][], closed: boolean, length: number }} RingPart
 * @typedef {{ format: string, detail: string, parts: (ModelPart|RingPart)[] }} LoadedModel
 */

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The rings in a .pts: one per BEGIN_<fdi> ... END_<fdi> block. A file for several teeth
 * has several blocks, and reading it as one list -- which is right for the margin editor,
 * which takes one ring -- would draw a line from one tooth to the next that no file
 * contains. Lines outside any block form a ring of their own, and a JSON ring goes through
 * the editor's own reader.
 * @param {string} text
 * @returns {{ label: string, points: number[][] }[]}
 */
const parsePtsRings = text => {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return [{ label: '', points: parseMarginText(trimmed) }];
  const rings = [];
  let current = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const stripped = line.trim();
    const begin = stripped.match(/^BEGIN_?(\S*)/i);
    if (begin) {
      current = { label: begin[1], points: [] };
      rings.push(current);
      continue;
    }
    if (/^END/i.test(stripped)) {
      current = null;
      continue;
    }
    const values = stripped.split(/[\s,]+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) continue;
    if (!current) {
      current = { label: '', points: [] };
      rings.push(current);
    }
    current.points.push(values.slice(0, 3));
  }
  return rings.filter(ring => ring.points.length);
};

/**
 * Whether a list of points is a closed ring. The ground-truth files close it by repeating
 * the first point, and that repeat is dropped; otherwise a last point about one step from
 * the first -- within three median steps -- closes it too. Anything further apart is an
 * open curve and is drawn as one.
 */
const closeRing = points => {
  let closed = false;
  if (points.length >= 3) {
    if (distance(points[0], points[points.length - 1]) < 1e-6) {
      points = points.slice(0, -1);
      closed = true;
    } else {
      const steps = points.slice(1).map((point, i) => distance(point, points[i])).sort((a, b) => a - b);
      closed = distance(points[0], points[points.length - 1]) <= 3 * steps[steps.length >> 1];
    }
  }
  let length = points.slice(1).reduce((sum, point, i) => sum + distance(point, points[i]), 0);
  if (closed) length += distance(points[points.length - 1], points[0]);
  return { points, closed, length };
};

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

  if (format === 'pts') {
    const rings = parsePtsRings(new TextDecoder().decode(buffer));
    if (!rings.length) throw new Error('檔案裡沒有任何點（每行應是 x y z）');
    return { format, detail, parts: rings.map(ring => ({ kind: 'ring', label: ring.label, ...closeRing(ring.points) })) };
  }

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
