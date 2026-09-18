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
// Faces come BEFORE vertices in V2 and after them in V1. The colour block is read only when
// asked for (the model preview draws it; nothing else here does), and UVs never are.
// ezai-pipeline's app/tri.py reads the same two layouts and was checked against airdesign's
// reader over 5006 real files.

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

// The file stores sRGB bytes; three.js shades in linear. One table instead of a Color per
// vertex, since an arch has a few hundred thousand of them.
let srgbToLinear = null;
const linearTable = () => {
  if (!srgbToLinear) {
    const color = new THREE.Color();
    srgbToLinear = new Float32Array(256).map((_, i) => color.setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r);
  }
  return srgbToLinear;
};

const COLOR_TOKEN = 17000;
const UV_TOKEN = 87878;

/**
 * The per-vertex RGB block, when there is one that fits: V1 appends count + bytes after the
 * faces; V2 appends optional blocks shaped (token, count, token, data), UVs before colours.
 * A block that does not fit the file or the vertex count is ignored rather than fatal --
 * colour is decoration, and the mesh itself has already been read.
 */
const readColors = (buffer, version, end, pointCount) => {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  let bytesAt = -1;
  if (version === 'V1') {
    if (size >= end + 4 && view.getUint32(end, true) === pointCount && size >= end + 4 + pointCount * 3) {
      bytesAt = end + 4;
    }
  } else {
    let at = end;
    for (let block = 0; block < 2 && size >= at + 12; block += 1) {
      const token = view.getUint32(at, true);
      const count = view.getUint32(at + 4, true);
      if (token === UV_TOKEN) {
        at += 12 + count * 8;
      } else {
        if (token === COLOR_TOKEN && count === pointCount && size >= at + 12 + count * 3) bytesAt = at + 12;
        break;
      }
    }
  }
  if (bytesAt < 0) return null;
  const bytes = new Uint8Array(buffer, bytesAt, pointCount * 3);
  const table = linearTable();
  const colors = new Float32Array(pointCount * 3);
  for (let i = 0; i < colors.length; i += 1) colors[i] = table[bytes[i]];
  return colors;
};

/**
 * The mesh in a .tri file, exactly as stored: vertices and faces in the file's order.
 * Throws an Error whose message is meant for the person who picked the file.
 * @param {ArrayBuffer} buffer
 * @param {{ colors?: boolean }} [options] also read the per-vertex colours, if present
 * @returns {{ positions: Float32Array, indices: Uint32Array, version: 'V1'|'V2', colors: Float32Array|null }}
 */
const parseTRI = (buffer, { colors = false } = {}) => {
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

  const end = version === 'V2' ? verticesAt + pointCount * 12 : facesAt + triangleCount * 12;
  return { positions, indices, version, colors: colors ? readColors(buffer, version, end, pointCount) : null };
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
