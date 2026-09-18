import * as THREE from 'three';

// Inteware's own mesh format, what airdental and airdesign store scans in. Their reader is
// airdesign's utils/loader/TRILoader.js; this one reads the same bytes the same way, but
// without that file's axios/tool dependencies, and it refuses a file it cannot make sense
// of instead of handing three.js a geometry with indices past the end of its vertices.
//
// Nothing here needs a key. V2 salts its header with a few constant words; past those, both
// versions are a flat little-endian dump of an indexed triangle mesh:
//
//   V1  uint32 points, uint32 triangles, float32[points*3], uint32[triangles*3],
//       then optionally uint32 count + uint8[count*3] per-vertex RGB
//   V2  char[80] header containing "INTEWARE Mesh File",
//       uint32 17000, uint32 points, uint32 87878, uint32 triangles, uint32 0,
//       uint32[triangles*3], uint32 12528, float32[points*3],
//       then optional UV and colour blocks
//
// Faces come BEFORE vertices in V2 and after them in V1. The colour and UV blocks are not
// read; nothing in this viewer draws them. ezai-pipeline's app/tri.py reads the same two
// layouts and was checked against airdesign's reader over 5006 real files.

const V2_MARK = 'INTEWARE Mesh File';
const V2_HEADER_BYTES = 80;
// header + (17000, points, 87878, triangles, 0)
const V2_FACES_AT = V2_HEADER_BYTES + 5 * 4;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** airdesign looks for the mark in the first 81 bytes, so this does too. */
const isV2 = buffer => {
  const head = new Uint8Array(buffer, 0, Math.min(81, buffer.byteLength));
  return String.fromCharCode(...head).includes(V2_MARK);
};

/** A copy, so the result owns an aligned buffer the size of the data and nothing more. */
const readWords = (buffer, Type, offset, count) => {
  if (LITTLE_ENDIAN) return new Type(buffer.slice(offset, offset + count * 4));
  const view = new DataView(buffer, offset, count * 4);
  const out = new Type(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Type === Float32Array ? view.getFloat32(i * 4, true) : view.getUint32(i * 4, true);
  }
  return out;
};

/**
 * The mesh in a .tri file, exactly as stored: vertices and faces in the file's order.
 * Throws an Error whose message is meant for the person who picked the file.
 * @param {ArrayBuffer} buffer
 * @returns {{ positions: Float32Array, indices: Uint32Array, version: 'V1'|'V2' }}
 */
const parseTRI = buffer => {
  const size = buffer.byteLength;
  const view = new DataView(buffer);
  const version = isV2(buffer) ? 'V2' : 'V1';

  let pointCount;
  let triangleCount;
  let verticesAt;
  let facesAt;
  if (version === 'V2') {
    if (size < V2_FACES_AT) throw new Error(`V2 .tri 檔只有 ${size} bytes，比檔頭還短`);
    pointCount = view.getUint32(V2_HEADER_BYTES + 4, true);
    triangleCount = view.getUint32(V2_HEADER_BYTES + 12, true);
    facesAt = V2_FACES_AT;
    verticesAt = facesAt + triangleCount * 12 + 4;
  } else {
    if (size < 8) throw new Error(`${size} bytes 太短，不是 .tri 檔`);
    pointCount = view.getUint32(0, true);
    triangleCount = view.getUint32(4, true);
    verticesAt = 8;
    facesAt = verticesAt + pointCount * 12;
  }

  // The counts come out of the file, so they are checked against it before anything is
  // read that far. Something that is not a .tri at all -- an STL renamed, say -- fails
  // here: its first eight bytes read as counts in the billions.
  const needed = Math.max(verticesAt + pointCount * 12, facesAt + triangleCount * 12);
  if (needed > size) {
    throw new Error(`${version} .tri 檔頭宣告 ${pointCount} 個點、${triangleCount} 個面，需要 ${needed} bytes，`
      + `檔案只有 ${size} bytes：檔案不完整，或不是 .tri 檔`);
  }
  if (!pointCount || !triangleCount) {
    throw new Error(`${version} .tri 檔裡沒有網格（${pointCount} 個點、${triangleCount} 個面）`);
  }

  const positions = readWords(buffer, Float32Array, verticesAt, pointCount * 3);
  const indices = readWords(buffer, Uint32Array, facesAt, triangleCount * 3);

  let highest = 0;
  for (let i = 0; i < indices.length; i += 1) if (indices[i] > highest) highest = indices[i];
  if (highest >= pointCount) {
    throw new Error(`${version} .tri 檔有面用到第 ${highest} 個頂點，但只有 ${pointCount} 個頂點`);
  }
  for (let i = 0; i < positions.length; i += 1) {
    if (!Number.isFinite(positions[i])) throw new Error(`${version} .tri 檔有頂點座標是 NaN 或無限大`);
  }

  return { positions, indices, version };
};

/** @param {ArrayBuffer} buffer */
const parseTRIGeometry = buffer => {
  const { positions, indices, version } = parseTRI(buffer);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.userData.triVersion = version;
  return geometry;
};

export { parseTRI, parseTRIGeometry };
