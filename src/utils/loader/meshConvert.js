import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { getFileExtension } from '../tool/StringProcessing.js';
import { parseTRI } from './TRILoader.js';

// Rewriting a scan into a format a service can read, for the services that cannot read the
// one it arrived in: the production pipeline predates .tri, and FlowToothSDF saves whatever
// it is sent as upper.stl.
//
// Always from the FILE, never from the mesh on screen. The mesh on screen is not the file
// any more: three-mesh-bvh reorders an index in place the first time the margin editor
// builds its bounds tree, and the jaw service samples the surface face by face with a fixed
// seed, so a copy in a different face order is a different input to it. Read from the file,
// a .tri converted here and a .tri converted by ezai-pipeline are the same mesh.

/**
 * Vertices and faces straight from a scan file, in the file's own order. `indices` is null
 * for STL, which has none.
 * @param {File} file
 */
const readMeshArrays = async file => {
  const format = getFileExtension(file.name);
  const buffer = await file.arrayBuffer();
  if (format === 'tri') return parseTRI(buffer);
  const geometry = format === 'ply' ? new PLYLoader().parse(buffer)
    : format === 'stl' ? new STLLoader().parse(buffer)
      : null;
  if (!geometry) throw new Error(`無法轉換 ${file.name}：只支援 STL / PLY / TRI`);
  return { positions: geometry.getAttribute('position').array, indices: geometry.index?.array ?? null };
};

const faceCountOf = (positions, indices) => (indices ? indices.length : positions.length / 3) / 3;

/** Binary little-endian PLY holding exactly these vertices and faces, in this order. */
const writeBinaryPly = (positions, indices) => {
  const vertexCount = positions.length / 3;
  const faceCount = faceCountOf(positions, indices);
  const header = new TextEncoder().encode([
    'ply',
    'format binary_little_endian 1.0',
    'comment converted by checkingViewer',
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faceCount}`,
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n'));
  const buffer = new ArrayBuffer(header.length + vertexCount * 12 + faceCount * 13);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  let at = header.length;
  for (let i = 0; i < positions.length; i += 1, at += 4) view.setFloat32(at, positions[i], true);
  for (let face = 0; face < faceCount; face += 1) {
    view.setUint8(at, 3);
    at += 1;
    for (let corner = 0; corner < 3; corner += 1, at += 4) {
      view.setInt32(at, indices ? indices[face * 3 + corner] : face * 3 + corner, true);
    }
  }
  return buffer;
};

/** Binary STL, one facet per face, with each facet's normal computed from its corners. */
const writeBinaryStl = (positions, indices) => {
  const faceCount = faceCountOf(positions, indices);
  const buffer = new ArrayBuffer(84 + faceCount * 50);
  const view = new DataView(buffer);
  // Anything but "solid" at the start: some readers take that as the sign of an ASCII STL.
  new Uint8Array(buffer).set(new TextEncoder().encode('binary STL from checkingViewer'));
  view.setUint32(80, faceCount, true);
  const corner = (face, k) => (indices ? indices[face * 3 + k] : face * 3 + k) * 3;
  let at = 84;
  for (let face = 0; face < faceCount; face += 1) {
    const [a, b, c] = [corner(face, 0), corner(face, 1), corner(face, 2)];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const value of [nx, ny, nz]) {
      view.setFloat32(at, value, true);
      at += 4;
    }
    for (const start of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1, at += 4) view.setFloat32(at, positions[start + axis], true);
    }
    at += 2; // attribute byte count, always 0
  }
  return buffer;
};

/**
 * The same scan as a .ply or .stl File, named after the original. A file already in that
 * format comes back untouched.
 * @param {File} file
 * @param {'ply'|'stl'} format
 * @returns {Promise<File>}
 */
const convertScan = async (file, format) => {
  if (getFileExtension(file.name) === format) return file;
  const { positions, indices } = await readMeshArrays(file);
  const bytes = format === 'ply' ? writeBinaryPly(positions, indices) : writeBinaryStl(positions, indices);
  const name = `${file.name.replace(/\.[^.]*$/, '')}.${format}`;
  return new File([bytes], name, { type: 'application/octet-stream' });
};

export { convertScan, readMeshArrays, writeBinaryPly, writeBinaryStl };
