// A COPY of airdental's AbutmentLoft.js, so the peek abut tab builds the PEEK crown's lower
// part exactly the way the AIrDesign caller will (the caller takes only the outer shell from
// ezai-pipeline and does this part itself). Source: airdental
// client/default/airdesign/workflow/AbutmentDesign/AbutmentLoft.js, branch
// 1905-airdesign-integration-customAbutment, as of 2026-10-06 (not yet committed there).
//
// Kept verbatim -- the comments are the original Chinese and the indentation is airdental's
// four spaces -- so the two files can be diffed. The only change is the BufferGeometryUtils
// import path: three/addons/..., the form this viewer already imports it by (a new path
// makes Vite re-bundle and reload every open page). When airdental changes it, copy it again.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * peek abutment 的外冠縫合，參考 EZCAD 的 DentDesignAbutment::BuildAbutmentSRIA_Solid：
 * 外冠（AbutOuterObj）下緣先對到 margin，再用曲面放樣（LoftSur_AbutmentTissue）把 margin 接到植體介面（interface line），
 * 最後兩頭縫起來。
 *
 * EZCAD 是用 OpenCASCADE 對三條 B-spline（margin、tissue 控制線、interface 線）做 loft。這裡沒有 OCC，改成：
 * 繞植體軸取等角度的縱向剖線，每條剖線用 Hermite 三次曲線從外冠下緣接到 peek 底部的邊界。
 * 上端切線沿著外冠表面往下（由下緣上方一小圈的面法向推出來，見 computeCrownBottomTangents），接起來是 G1 連續，不會在 margin 折一下；
 * 下端沿著 peek 底部外壁往上（exocad 的 support 上緣是 cuff 外壁）。EZCAD 的 interface 縫合邊界是植體平台座面的外緣，
 * 座面是水平的，這時改沿植體軸往上（EZCAD 的 interface collar 也是沿軸偏移），不會從平台邊緣橫著長出一圈肩台。
 * 兩端直接沿用外冠下緣與 peek 底部邊界的頂點位置，縫完沒有縫隙。
 *
 * 外冠的處理也比照 EZCAD 對 SRIA 外冠的作法（margin morphing 後 remesh 成 0.2mm、再沿 margin 線分三圈平滑）：
 * prepareAbutmentCrown 先把下緣附近細分、margin 輕微平滑，對完 margin 再抹平下緣上方一圈。這段和穿齦段參數無關，
 * abutment 設計步驟拖曳控制點時沿用同一份結果，只重算穿齦段。
 * 穿齦段可調的部分對應 EZCAD abutment 設計：8 個 tissue 控制點（沿徑向、沿植體軸移動）與 bone avoidance（介面上方直上一段）。
 */

const TWO_PI = Math.PI * 2;
/**放樣段的縱向分段數 */
const LOFT_ROW_COUNT = 16;
const MIN_LOFT_COLUMN_COUNT = 64;
/**放樣的縱向剖線數跟著外冠下緣頂點數走，接近一比一時第一圈才不會連成扇形、在 margin 下方出現細條紋 */
const MAX_LOFT_COLUMN_COUNT = 384;
/**Hermite 切線長度與兩端距離的比例，越大剖線越飽滿 */
const HERMITE_TANGENT_SCALE = 0.7;
/**
 * peek 底部邊界往外延伸的方向與植體軸夾角的餘弦：高於上限照用底部外壁的方向，低於下限（平台座面這類水平面）改用植體軸，
 * 中間平滑過渡，避免同一圈裡有的剖線沿外壁、有的沿軸而出現折痕
 */
const BASE_TANGENT_AXIAL_MIN = 0.3;
const BASE_TANGENT_AXIAL_MAX = 0.7;
/**margin fit 時往內部傳的位移，依角度平滑的寬度（弧度） */
const DISPLACEMENT_SMOOTH_SIGMA = 0.12;
/**margin fit 後抹平下緣上方這個高度內的細紋（mm）與次數 */
const BOTTOM_RELAX_HEIGHT = 1.2;
const BOTTOM_RELAX_ITERATIONS = 15;
/**估外冠下緣切線用的取樣帶：下緣上方這個高度內的面（mm） */
const BOTTOM_TANGENT_BAND = 0.5;
const BOTTOM_TANGENT_BIN_COUNT = 120;
const BOTTOM_TANGENT_SMOOTH_SIGMA = 0.1;
/**
 * margin fit 位移往上衰減的高度：至少 FIT_FALLOFF_MIN（mm），且至少是最大位移的幾倍，最多外冠高度的 FIT_FALLOFF_MAX_RATIO。
 * 下緣要往上推（margin 比牙冠下緣高，例如鄰接面）時網格會被壓縮，衰減太短會壓到幾乎對折，看起來就是一條橫向折痕；
 * 軸向 3 倍時壓縮最多一半。
 */
const FIT_FALLOFF_MIN = 2.5;
const FIT_FALLOFF_MAX_RATIO = 0.75;
const FIT_FALLOFF_AXIAL_RATIO = 3;
const FIT_FALLOFF_LATERAL_RATIO = 1.5;
/**margin 先沿弧長平滑掉掃描面的細小起伏（mm） */
const MARGIN_SMOOTH_SIGMA = 0.2;
/**外冠下緣上方這個高度內（涵蓋 margin fit 的衰減範圍）、長於 REFINE_MAX_EDGE 的邊先細分（mm） */
const REFINE_HEIGHT = 5;
const REFINE_MAX_EDGE = 0.25;
const REFINE_MAX_PASSES = 2;
/**穿齦段控制點數（EZCAD 的 tissue control 也是 8 個） */
const TISSUE_CONTROL_COUNT = 8;
/**bone avoidance 直上段每段高度（mm）與視為 0 的門檻 */
const BONE_AVOID_ROW_HEIGHT = 0.3;
const BONE_AVOID_EPSILON = 1e-3;

/**
 * 只留 position、合併重複頂點，回傳有 index 的幾何
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Matrix4} [matrix]
 * @returns {THREE.BufferGeometry}
 */
const toIndexedPositionGeometry = (geometry, matrix) => {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', geometry.getAttribute('position').clone());
    if (geometry.index) result.setIndex(geometry.index.clone());
    if (matrix) result.applyMatrix4(matrix);
    return mergeVertices(result, 1e-4);
}

/**
 * 依三角形的方向找出所有開口邊界，每圈的頂點順序與網格繞向一致
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何
 * @returns {number[][]}
 */
const extractBoundaryLoops = geometry => {
    const indexArray = geometry.index.array;
    const vertexCount = geometry.getAttribute('position').count;
    const directedEdges = new Set();
    for (let i = 0; i < indexArray.length; i += 3) {
        for (let k = 0; k < 3; k++) directedEdges.add(indexArray[i + k] * vertexCount + indexArray[i + (k + 1) % 3]);
    }

    /**@type {Map<number, number>} 邊界上 a → b（反向邊不存在的邊） */
    const nextMap = new Map();
    for (let i = 0; i < indexArray.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const a = indexArray[i + k];
            const b = indexArray[i + (k + 1) % 3];
            if (!directedEdges.has(b * vertexCount + a)) nextMap.set(a, b);
        }
    }

    const visited = new Set();
    const loops = [];
    for (const start of nextMap.keys()) {
        if (visited.has(start)) continue;

        const loop = [];
        let current = start;
        while (current != undefined && !visited.has(current)) {
            visited.add(current);
            loop.push(current);
            current = nextMap.get(current);
        }
        if (loop.length >= 3) loops.push(loop);
    }
    return loops;
}

/**
 * 邊界頂點往網格外延伸的方向：從相鄰的內部頂點平均指向邊界頂點。用在 peek 底部（模型庫網格規則）；
 * 外冠下緣在 margin fit 之後太不規則，改用 computeCrownBottomTangents。沿迴圈再平滑一下，避免網格不規則造成抖動。
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何
 * @param {number[]} loop
 * @returns {THREE.Vector3[]}
 */
const computeBoundaryOutwardTangents = (geometry, loop) => {
    const posAttr = geometry.getAttribute('position');
    const indexArray = geometry.index.array;
    const loopSet = new Set(loop);

    /**@type {Map<number, Set<number>>} */
    const neighborMap = new Map(loop.map(vertex => [vertex, new Set()]));
    for (let i = 0; i < indexArray.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const vertex = indexArray[i + k];
            const neighbors = neighborMap.get(vertex);
            if (!neighbors) continue;
            neighbors.add(indexArray[i + (k + 1) % 3]);
            neighbors.add(indexArray[i + (k + 2) % 3]);
        }
    }

    const point = new THREE.Vector3();
    const average = new THREE.Vector3();
    const neighborPoint = new THREE.Vector3();
    let tangents = loop.map(vertex => {
        point.fromBufferAttribute(posAttr, vertex);
        average.set(0, 0, 0);
        let count = 0;
        for (const neighbor of neighborMap.get(vertex)) {
            if (loopSet.has(neighbor)) continue;
            average.add(neighborPoint.fromBufferAttribute(posAttr, neighbor));
            count++;
        }
        if (count == 0) return null;
        return point.clone().sub(average.divideScalar(count)).normalize();
    });

    // 少數邊界頂點沒有內部鄰點，借用前後的方向
    const fallback = tangents.find(Boolean) || new THREE.Vector3();
    tangents = tangents.map(tangent => tangent || fallback.clone());

    for (let pass = 0; pass < 3; pass++) {
        tangents = tangents.map((tangent, i) => tangent.clone()
            .multiplyScalar(2)
            .add(tangents[(i + tangents.length - 1) % tangents.length])
            .add(tangents[(i + 1) % tangents.length])
            .normalize());
    }
    return tangents;
}

/**
 * 繞軸的角度座標（右手：u → v → axis）
 * @param {THREE.Vector3} center
 * @param {THREE.Vector3} axis
 * @returns {(point: THREE.Vector3) => number}
 */
const createAngleFunction = (center, axis) => {
    const u = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.projectOnPlane(axis).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    const offset = new THREE.Vector3();
    return point => {
        offset.subVectors(point, center);
        return Math.atan2(offset.dot(v), offset.dot(u));
    };
}

/**
 * 把閉合迴圈整理成依角度遞增的樣本，之後用角度內插迴圈上的資料。
 * 迴圈要大致包住軸（從軸看出去每個方向只碰到一次），margin、外冠下緣與植體邊界都符合；
 * 不完全是星形時角度會小幅回頭，取累積最大值讓它單調。
 */
class LoopSampler {
    /**
     * @param {THREE.Vector3[]} points 迴圈上的點（依迴圈順序）
     * @param {(point: THREE.Vector3) => number} angleOf
     */
    constructor(points, angleOf) {
        const rawAngles = points.map(angleOf);
        const unwrap = order => {
            const angles = [rawAngles[order[0]]];
            for (let i = 1; i < order.length; i++) {
                let angle = rawAngles[order[i]];
                while (angle - angles[i - 1] > Math.PI) angle -= TWO_PI;
                while (angle - angles[i - 1] < -Math.PI) angle += TWO_PI;
                angles.push(angle);
            }
            return angles;
        }

        let order = points.map((_, i) => i);
        let angles = unwrap(order);
        if (angles[angles.length - 1] < angles[0]) {
            order = order.reverse();
            angles = unwrap(order);
        }
        for (let i = 1; i < angles.length; i++) angles[i] = Math.max(angles[i], angles[i - 1]);

        /**迴圈繞軸轉了多少，接近 2π 才是包住軸的迴圈 */
        this.span = angles[angles.length - 1] - angles[0];
        this.order = order;
        this.angles = angles;
        this.start = angles[0];
    }

    /**
     * @param {number} angle
     * @returns {{ i0: number, i1: number, t: number }} 原始索引與內插比例
     */
    locate = angle => {
        const { angles, order, start } = this;
        const n = angles.length;
        const a = start + (((angle - start) % TWO_PI) + TWO_PI) % TWO_PI;

        if (a >= angles[n - 1]) {
            const span = start + TWO_PI - angles[n - 1];
            return { i0: order[n - 1], i1: order[0], t: span > 1e-9 ? (a - angles[n - 1]) / span : 0 };
        }

        let low = 0;
        let high = n - 1;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (angles[middle] <= a) low = middle;
            else high = middle;
        }
        const span = angles[high] - angles[low];
        return { i0: order[low], i1: order[high], t: span > 1e-9 ? (a - angles[low]) / span : 0 };
    }

    /**
     * @param {THREE.Vector3[]} values 與建構時的點一一對應
     * @param {number} angle
     * @param {THREE.Vector3} [target]
     * @returns {THREE.Vector3}
     */
    sampleVector = (values, angle, target = new THREE.Vector3()) => {
        const { i0, i1, t } = this.locate(angle);
        return target.lerpVectors(values[i0], values[i1], t);
    }

    /**
     * @param {number[]} values
     * @param {number} angle
     * @returns {number}
     */
    sampleNumber = (values, angle) => {
        const { i0, i1, t } = this.locate(angle);
        return values[i0] + (values[i1] - values[i0]) * t;
    }
}

/**
 * 迴圈上的數值或向量依角度做高斯平滑（迴圈頂點疏密不均，照索引平滑會在密的地方平滑不夠）
 * @template {number|THREE.Vector3} T
 * @param {T[]} values
 * @param {number[]} angles 與 values 一一對應
 * @param {number} sigma 弧度
 * @returns {T[]}
 */
const smoothByAngle = (values, angles, sigma) => {
    const isNumber = typeof values[0] == 'number';
    return angles.map(angle => {
        const sum = isNumber ? null : new THREE.Vector3();
        let numberSum = 0;
        let weightSum = 0;
        angles.forEach((other, j) => {
            let delta = Math.abs(other - angle) % TWO_PI;
            if (delta > Math.PI) delta = TWO_PI - delta;
            if (delta > sigma * 3) return;
            const weight = Math.exp(-delta * delta / (2 * sigma * sigma));
            if (isNumber) numberSum += values[j] * weight;
            else sum.addScaledVector(values[j], weight);
            weightSum += weight;
        });
        return isNumber ? numberSum / weightSum : sum.divideScalar(weightSum);
    });
}

/**
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何
 * @returns {Set<number>[]}
 */
const buildVertexNeighbors = geometry => {
    const indexArray = geometry.index.array;
    const neighbors = Array.from({ length: geometry.getAttribute('position').count }, () => new Set());
    for (let i = 0; i < indexArray.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            neighbors[indexArray[i + k]].add(indexArray[i + (k + 1) % 3]);
            neighbors[indexArray[i + k]].add(indexArray[i + (k + 2) % 3]);
        }
    }
    return neighbors;
}

/**
 * 一次中點細分：shouldSplit(i, j) 為真的邊從中點切開，三角形依切開的邊數拆成 2～4 個。
 * 中點依邊共用，相鄰三角形切法一致，不會有 T 型接點；三角形繞向不變。
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何（只看 position）
 * @param {(i: number, j: number) => boolean} shouldSplit
 * @returns {THREE.BufferGeometry} 新的有 index 幾何
 */
const splitEdges = (geometry, shouldSplit) => {
    const posAttr = geometry.getAttribute('position');
    const indexArray = geometry.index.array;
    const vertexCount = posAttr.count;
    const positions = Array.from(posAttr.array);
    /**@type {Map<number, number>} 邊 → 中點頂點，不切的邊記 -1 */
    const midpointMap = new Map();
    const getMidpoint = (i, j) => {
        const key = i < j ? i * vertexCount + j : j * vertexCount + i;
        let midpoint = midpointMap.get(key);
        if (midpoint != undefined) return midpoint;

        midpoint = -1;
        if (shouldSplit(i, j)) {
            midpoint = positions.length / 3;
            for (let k = 0; k < 3; k++) positions.push((posAttr.array[i * 3 + k] + posAttr.array[j * 3 + k]) / 2);
        }
        midpointMap.set(key, midpoint);
        return midpoint;
    }

    const triangles = [];
    for (let t = 0; t < indexArray.length; t += 3) {
        const v = [indexArray[t], indexArray[t + 1], indexArray[t + 2]];
        const m = [getMidpoint(v[0], v[1]), getMidpoint(v[1], v[2]), getMidpoint(v[2], v[0])];
        const splitCount = m.filter(midpoint => midpoint >= 0).length;
        if (splitCount == 0) {
            triangles.push(...v);
            continue;
        }
        if (splitCount == 3) {
            triangles.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]);
            continue;
        }

        // 轉一下讓情況固定：一條邊切開時是 v0→v1；兩條邊切開時是 v0→v1 與 v1→v2
        let r = 0;
        if (splitCount == 1) r = m.findIndex(midpoint => midpoint >= 0);
        else r = (m.findIndex(midpoint => midpoint < 0) + 1) % 3;
        const p = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]];
        const q = [m[r], m[(r + 1) % 3], m[(r + 2) % 3]];
        if (splitCount == 1) triangles.push(p[0], q[0], p[2], q[0], p[1], p[2]);
        else triangles.push(q[0], p[1], q[1], p[0], q[0], q[1], p[0], q[1], p[2]);
    }

    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.setIndex(triangles);
    return result;
}

/**
 * 閉合迴圈的點沿弧長做高斯平滑
 * @param {THREE.Vector3[]} points
 * @param {number} sigma mm
 * @returns {THREE.Vector3[]}
 */
const smoothLoopByArcLength = (points, sigma) => {
    const count = points.length;
    const arcLengths = [0];
    for (let i = 1; i <= count; i++) arcLengths.push(arcLengths[i - 1] + points[i % count].distanceTo(points[i - 1]));
    const total = arcLengths[count];
    return points.map((_, i) => {
        const sum = new THREE.Vector3();
        let weightSum = 0;
        for (let j = 0; j < count; j++) {
            let delta = Math.abs(arcLengths[j] - arcLengths[i]);
            delta = Math.min(delta, total - delta);
            if (delta > sigma * 3) continue;
            const weight = Math.exp(-delta * delta / (2 * sigma * sigma));
            sum.addScaledVector(points[j], weight);
            weightSum += weight;
        }
        return sum.divideScalar(weightSum);
    });
}

/**
 * @param {THREE.Vector3[]} points
 * @returns {THREE.Vector3}
 */
const getCentroid = points => points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length);

/**
 * 外冠下緣對到 margin（對應 EZCAD 的 margin fit）：下緣每個頂點移到同角度的 margin 上，
 * 位移往上依高度平滑衰減，越靠近咬合面動得越少。衰減高度依位移量放大，位移大時才不會把網格擠到折起來。
 * @param {THREE.BufferGeometry} geometry 外冠（世界座標、有 index），會直接改它的頂點
 * @param {number[]} boundaryLoop 外冠下緣頂點
 * @param {THREE.Vector3[]} marginPoints
 * @param {THREE.Vector3} occlusalAxis
 * @returns {boolean}
 */
const fitCrownBottomToMargin = (geometry, boundaryLoop, marginPoints, occlusalAxis) => {
    const posAttr = geometry.getAttribute('position');
    const center = getCentroid(marginPoints);
    const angleOf = createAngleFunction(center, occlusalAxis);
    const heightOf = point => new THREE.Vector3().subVectors(point, center).dot(occlusalAxis);

    const marginSampler = new LoopSampler(marginPoints, angleOf);
    if (marginSampler.span < Math.PI) return false;

    const boundaryPoints = boundaryLoop.map(vertex => new THREE.Vector3().fromBufferAttribute(posAttr, vertex));
    const boundarySampler = new LoopSampler(boundaryPoints, angleOf);
    if (boundarySampler.span < Math.PI) return false;

    const boundaryAngles = boundaryPoints.map(angleOf);
    const boundaryHeights = boundaryPoints.map(heightOf);
    const targets = boundaryAngles.map(angle => marginSampler.sampleVector(marginPoints, angle));
    const displacements = targets.map((target, i) => target.clone().sub(boundaryPoints[i]));

    // 往內部傳的位移與衰減的起算高度都先依角度平滑：資料庫牙冠的下緣本身高低不齊，直接拿來算衰減權重，
    // 位移一大就會把那些高低差放大成一塊塊的凹凸；下緣本身照樣精確落在 margin 上
    const smoothDisplacements = smoothByAngle(displacements, boundaryAngles, DISPLACEMENT_SMOOTH_SIGMA);
    const smoothBoundaryHeights = smoothByAngle(boundaryHeights, boundaryAngles, DISPLACEMENT_SMOOTH_SIGMA);

    let crownTop = -Infinity;
    const point = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) crownTop = Math.max(crownTop, heightOf(point.fromBufferAttribute(posAttr, i)));
    const crownHeight = crownTop - Math.min(...boundaryHeights);
    const maxAxialMove = Math.max(...displacements.map(displacement => Math.abs(displacement.dot(occlusalAxis))));
    const maxLateralMove = Math.max(...displacements.map(displacement => displacement.clone().projectOnPlane(occlusalAxis).length()));
    const falloff = THREE.MathUtils.clamp(Math.max(FIT_FALLOFF_MIN, maxAxialMove * FIT_FALLOFF_AXIAL_RATIO, maxLateralMove * FIT_FALLOFF_LATERAL_RATIO), 1, Math.max(1, crownHeight * FIT_FALLOFF_MAX_RATIO));

    const boundarySet = new Set(boundaryLoop);
    const displacement = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
        if (boundarySet.has(i)) continue;

        point.fromBufferAttribute(posAttr, i);
        const angle = angleOf(point);
        const height = heightOf(point) - boundarySampler.sampleNumber(smoothBoundaryHeights, angle);
        const x = THREE.MathUtils.clamp(height / falloff, 0, 1);
        const weight = 1 - x * x * (3 - 2 * x);
        if (weight <= 0) continue;

        boundarySampler.sampleVector(smoothDisplacements, angle, displacement);
        point.addScaledVector(displacement, weight);
        posAttr.setXYZ(i, point.x, point.y, point.z);
    }

    boundaryLoop.forEach((vertex, i) => posAttr.setXYZ(vertex, targets[i].x, targets[i].y, targets[i].z));

    // 下緣精確落在 margin、內部用平滑過的位移，兩者的落差會在下緣上方擠出細紋；下緣固定，把貼近下緣的一圈抹平
    const fittedSampler = new LoopSampler(targets, angleOf);
    const fittedHeights = targets.map(heightOf);
    const heightAboveMargin = position => heightOf(position) - fittedSampler.sampleNumber(fittedHeights, angleOf(position));
    relaxBand(geometry, boundarySet, heightAboveMargin, BOTTOM_RELAX_HEIGHT, BOTTOM_RELAX_ITERATIONS);

    posAttr.needsUpdate = true;
    return true;
}

/**
 * 只對 heightOf(頂點) < bandHeight 的一圈做 Laplacian 平滑，越靠近底越強；fixed 裡的頂點不動
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何，直接改頂點
 * @param {Set<number>} fixed
 * @param {(point: THREE.Vector3) => number} heightOf
 * @param {number} bandHeight
 * @param {number} iterations
 */
const relaxBand = (geometry, fixed, heightOf, bandHeight, iterations) => {
    const posAttr = geometry.getAttribute('position');
    const point = new THREE.Vector3();
    const band = [];
    for (let i = 0; i < posAttr.count; i++) {
        if (fixed.has(i)) continue;
        const x = THREE.MathUtils.clamp(heightOf(point.fromBufferAttribute(posAttr, i)) / bandHeight, 0, 1);
        if (x < 1) band.push({ vertex: i, weight: 0.5 * (1 - x) * (1 - x) });
    }
    if (band.length == 0) return;

    const neighbors = buildVertexNeighbors(geometry);
    const average = new THREE.Vector3();
    const neighborPoint = new THREE.Vector3();
    for (let iteration = 0; iteration < iterations; iteration++) {
        const next = band.map(({ vertex, weight }) => {
            average.set(0, 0, 0);
            for (const neighbor of neighbors[vertex]) average.add(neighborPoint.fromBufferAttribute(posAttr, neighbor));
            average.divideScalar(neighbors[vertex].size);
            return point.fromBufferAttribute(posAttr, vertex).lerp(average, weight).toArray();
        });
        band.forEach(({ vertex }, i) => posAttr.setXYZ(vertex, ...next[i]));
    }
}

/**
 * 外冠下緣的切線（沿表面往下）：下緣上方 BOTTOM_TANGENT_BAND 內的面法向依角度分格、面積加權平均，
 * 切線取垂直於法向與下緣走向的方向，切平面就和外冠一致（G1）。
 * 不用「下緣頂點減掉旁邊內部頂點的平均」——margin fit 之後那些點離下緣太近又不規則，方向亂跳（甚至朝上），
 * 放大進 Hermite 曲線就是穿齦段一條條的皺紋。
 * @param {THREE.BufferGeometry} geometry 外冠（已對到 margin、有 index）
 * @param {number[]} boundaryLoop
 * @param {(point: THREE.Vector3) => number} angleOf
 * @param {THREE.Vector3} axis 咬合方向
 * @returns {THREE.Vector3[]} 與 boundaryLoop 一一對應
 */
const computeCrownBottomTangents = (geometry, boundaryLoop, angleOf, axis) => {
    const posAttr = geometry.getAttribute('position');
    const indexArray = geometry.index.array;
    const boundaryPoints = boundaryLoop.map(vertex => new THREE.Vector3().fromBufferAttribute(posAttr, vertex));
    const boundaryAngles = boundaryPoints.map(angleOf);
    const sampler = new LoopSampler(boundaryPoints, angleOf);

    // 下緣上方一小圈的面法向，依角度分格做面積加權平均
    const binCount = BOTTOM_TANGENT_BIN_COUNT;
    const binOf = angle => ((Math.floor((angle + Math.PI) / TWO_PI * binCount) % binCount) + binCount) % binCount;
    const normalSums = Array.from({ length: binCount }, () => new THREE.Vector3());
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const bottom = new THREE.Vector3();
    for (let i = 0; i < indexArray.length; i += 3) {
        a.fromBufferAttribute(posAttr, indexArray[i]);
        b.fromBufferAttribute(posAttr, indexArray[i + 1]);
        c.fromBufferAttribute(posAttr, indexArray[i + 2]);
        centroid.copy(a).add(b).add(c).divideScalar(3);
        const angle = angleOf(centroid);
        sampler.sampleVector(boundaryPoints, angle, bottom);
        const height = centroid.clone().sub(bottom).dot(axis);
        if (height < 0 || height > BOTTOM_TANGENT_BAND) continue;
        // 未正規化的外積長度就是兩倍面積，等於面積加權
        normalSums[binOf(angle)].add(new THREE.Vector3().subVectors(b, a).cross(c.clone().sub(a)));
    }
    const binAngles = normalSums.map((_, bin) => -Math.PI + (bin + 0.5) / binCount * TWO_PI);
    const binNormals = smoothByAngle(normalSums.map(sum => sum.clone().normalize()), binAngles, BOTTOM_TANGENT_SMOOTH_SIGMA)
        .map(normal => normal.normalize());

    // 沿表面往下的方向：垂直於法向、也垂直於下緣走向
    const loopDirections = smoothByAngle(boundaryPoints.map((_, i) => boundaryPoints[(i + 1) % boundaryPoints.length].clone()
        .sub(boundaryPoints[(i + boundaryPoints.length - 1) % boundaryPoints.length])), boundaryAngles, BOTTOM_TANGENT_SMOOTH_SIGMA);
    const tangents = boundaryPoints.map((_, i) => {
        const position = (boundaryAngles[i] + Math.PI) / TWO_PI * binCount - 0.5;
        const bin0 = ((Math.floor(position) % binCount) + binCount) % binCount;
        const bin1 = (bin0 + 1) % binCount;
        const normal = binNormals[bin0].clone().lerp(binNormals[bin1], position - Math.floor(position)).normalize();
        return new THREE.Vector3().crossVectors(normal, loopDirections[i]).normalize();
    });

    // 正負號整圈一起決定（整體要朝下、離開外冠），個別點接近水平時才不會翻來翻去
    const downward = tangents.reduce((sum, tangent) => sum - tangent.dot(axis), 0);
    return tangents.map(tangent => {
        if (downward < 0) tangent.negate();
        return tangent.lengthSq() > 0.5 ? tangent : axis.clone().negate();
    });
}

/**
 * 讓網格法向朝外（遠離 center）：開口網格算不了體積，用面法向與「中心 → 面」方向的加權總和判斷
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何
 * @param {THREE.Vector3} center
 */
const orientOutward = (geometry, center) => {
    const posAttr = geometry.getAttribute('position');
    const indexArray = geometry.index.array;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let score = 0;
    for (let i = 0; i < indexArray.length; i += 3) {
        a.fromBufferAttribute(posAttr, indexArray[i]);
        b.fromBufferAttribute(posAttr, indexArray[i + 1]);
        c.fromBufferAttribute(posAttr, indexArray[i + 2]);
        normal.subVectors(c, b).cross(a.clone().sub(b));
        score += normal.dot(a.add(b).add(c).divideScalar(3).sub(center));
    }
    if (score < 0) flipWinding(geometry);
}

/**
 * 三角形全部反向（有 index 換 index，沒有 index 換每個屬性的頂點順序），法向跟著反過來
 * @param {THREE.BufferGeometry} geometry
 */
const flipWinding = geometry => {
    const swap = (array, itemSize, count) => {
        for (let i = 0; i < count; i += 3) {
            for (let k = 0; k < itemSize; k++) {
                const a = (i + 1) * itemSize + k;
                const b = (i + 2) * itemSize + k;
                const temp = array[a];
                array[a] = array[b];
                array[b] = temp;
            }
        }
    }

    if (geometry.index) {
        swap(geometry.index.array, 1, geometry.index.count);
        geometry.index.needsUpdate = true;
    }
    else {
        for (const attribute of Object.values(geometry.attributes)) {
            swap(attribute.array, attribute.itemSize, attribute.count);
            attribute.needsUpdate = true;
        }
    }

    const normalAttr = geometry.getAttribute('normal');
    if (normalAttr) {
        for (let i = 0; i < normalAttr.array.length; i++) normalAttr.array[i] = -normalAttr.array[i];
        normalAttr.needsUpdate = true;
    }
}

/**
 * peek 底部的縫合邊界：離植體軸最遠的那圈（另一圈是螺絲孔）
 * @param {THREE.BufferGeometry} base 有 index 的幾何
 * @param {THREE.Vector3} implantAxis
 * @param {THREE.Vector3} implantCenter
 * @returns {number[]|null}
 */
const findStitchLoop = (base, implantAxis, implantCenter) => {
    const posAttr = base.getAttribute('position');
    const point = new THREE.Vector3();
    const radiusOf = vertex => point.fromBufferAttribute(posAttr, vertex).sub(implantCenter).projectOnPlane(implantAxis).length();
    const loops = extractBoundaryLoops(base);
    if (loops.length == 0) return null;

    return loops
        .map(loop => ({ loop, radius: loop.reduce((sum, vertex) => sum + radiusOf(vertex), 0) / loop.length }))
        .reduce((best, item) => item.radius > best.radius ? item : best).loop;
}

/**
 * 放樣段在縫合邊界上是繞植體軸逆時針走（見 laceRings），peek 底部那一側要順時針才縫得成一個法向朝外的網格。
 * EZCAD 模型庫的 interface 檔是反著存的（DentDesignAbutment 用之前一律 PObjFlipMeshVector），
 * exocad 的 support 不一定，所以依縫合邊界的實際繞向判斷要不要翻。
 * @param {THREE.BufferGeometry} geometry peek 底部（世界座標），會直接改它
 * @param {THREE.Vector3} implantAxis
 * @param {THREE.Vector3} implantCenter
 * @returns {boolean} 是否有翻面
 */
const orientBaseForStitching = (geometry, implantAxis, implantCenter) => {
    const base = toIndexedPositionGeometry(geometry);
    const loop = findStitchLoop(base, implantAxis, implantCenter);
    if (!loop) {
        base.dispose();
        return false;
    }

    const posAttr = base.getAttribute('position');
    const point = new THREE.Vector3();
    const angleOf = createAngleFunction(implantCenter, implantAxis);
    const angles = loop.map(vertex => angleOf(point.fromBufferAttribute(posAttr, vertex)));
    base.dispose();

    let turn = 0;
    for (let i = 0; i < angles.length; i++) {
        let delta = angles[(i + 1) % angles.length] - angles[i];
        if (delta > Math.PI) delta -= TWO_PI;
        else if (delta < -Math.PI) delta += TWO_PI;
        turn += delta;
    }
    if (turn <= 0) return false;

    flipWinding(geometry);
    return true;
}

/**
 * 兩圈依角度縫起來。兩圈都依角度遞增、從同一個起始角度算起。
 * 上圈在咬合側、角度繞植體軸逆時針遞增時，產生的三角形法向朝外。
 * @param {{ index: number, angle: number }[]} upper
 * @param {{ index: number, angle: number }[]} lower
 * @param {number[]} triangles
 */
const laceRings = (upper, lower, triangles) => {
    const angleAt = (ring, k) => k < ring.length ? ring[k].angle : ring[k - ring.length].angle + TWO_PI;
    let i = 0;
    let j = 0;
    while (i < upper.length || j < lower.length) {
        const nextUpperAngle = i < upper.length ? angleAt(upper, i + 1) : Infinity;
        const nextLowerAngle = j < lower.length ? angleAt(lower, j + 1) : Infinity;
        const u0 = upper[i % upper.length].index;
        const l0 = lower[j % lower.length].index;
        if (nextUpperAngle <= nextLowerAngle) {
            triangles.push(u0, l0, upper[(i + 1) % upper.length].index);
            i++;
        }
        else {
            triangles.push(u0, l0, lower[(j + 1) % lower.length].index);
            j++;
        }
    }
}

/**
 * 依角度排好一圈頂點，從 startAngle 起算、角度落在 [startAngle, startAngle + 2π)
 * @param {number[]} indices
 * @param {THREE.Vector3[]} points
 * @param {(point: THREE.Vector3) => number} angleOf
 * @param {number} startAngle
 * @returns {{ index: number, angle: number }[]}
 */
const toAngularRing = (indices, points, angleOf, startAngle) => indices
    .map((index, i) => ({ index, angle: startAngle + (((angleOf(points[i]) - startAngle) % TWO_PI) + TWO_PI) % TWO_PI }))
    .sort((itemA, itemB) => itemA.angle - itemB.angle);

/**
 * 外冠下緣附近細分：對 margin 時這一帶被拉伸最多，資料庫牙冠原本 0.3～0.5mm 又不規則的三角形一拉就是一塊塊的凹凸
 * （EZCAD 在 margin morphing 之後整顆 remesh 成 0.2mm）
 * @param {THREE.BufferGeometry} geometry 有 index 的幾何
 * @param {number[]} boundaryLoop
 * @param {THREE.Vector3} axis 咬合方向
 * @returns {{ geometry: THREE.BufferGeometry, boundaryLoop: number[] }}
 */
const refineBottomBand = (geometry, boundaryLoop, axis) => {
    let result = geometry;
    let loop = boundaryLoop;
    const maxEdgeSq = REFINE_MAX_EDGE * REFINE_MAX_EDGE;
    for (let pass = 0; pass < REFINE_MAX_PASSES; pass++) {
        const posAttr = result.getAttribute('position');
        const boundaryPoints = loop.map(vertex => new THREE.Vector3().fromBufferAttribute(posAttr, vertex));
        const angleOf = createAngleFunction(getCentroid(boundaryPoints), axis);
        const sampler = new LoopSampler(boundaryPoints, angleOf);
        const boundaryHeights = boundaryPoints.map(point => point.dot(axis));

        const point = new THREE.Vector3();
        const inBand = new Uint8Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) {
            point.fromBufferAttribute(posAttr, i);
            inBand[i] = point.dot(axis) - sampler.sampleNumber(boundaryHeights, angleOf(point)) < REFINE_HEIGHT ? 1 : 0;
        }

        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const next = splitEdges(result, (i, j) => (inBand[i] || inBand[j]) &&
            a.fromBufferAttribute(posAttr, i).distanceToSquared(b.fromBufferAttribute(posAttr, j)) > maxEdgeSq);
        if (next.getAttribute('position').count == posAttr.count) break;

        if (result != geometry) result.dispose();
        result = next;
        loop = extractBoundaryLoops(result).reduce((longest, item) => item.length > longest.length ? item : longest);
    }
    return { geometry: result, boundaryLoop: loop };
}

/**
 * @typedef {object} TissueOffset 一個穿齦段控制點相對預設位置的位移
 * @property {number} radial 沿徑向（離開植體軸為正，mm）
 * @property {number} axial 沿植體軸（往咬合側為正，mm）
 *
 * @typedef {object} AbutmentDesignParam 穿齦段的設計參數（對應 EZCAD abutment 設計可調的部分）
 * @property {TissueOffset[]} tissueOffsets 繞植體軸等角度的 TISSUE_CONTROL_COUNT 個控制點
 * @property {number} boneAvoid 介面上方沿軸直上的高度（EZCAD 的 bone avoidance，mm）
 *
 * @typedef {object} PreparedAbutmentCrown 對好 margin 的外冠，與穿齦段參數無關，可重複使用
 * @property {THREE.BufferGeometry} crown
 * @property {number[]} crownLoop
 * @property {THREE.Vector3[]} topPoints
 * @property {THREE.Vector3[]} topTangents
 * @property {LoopSampler} topSampler
 * @property {(point: THREE.Vector3) => number} angleOf 繞植體軸的角度
 */

const createDefaultAbutmentDesignParam = () => ({
    tissueOffsets: Array.from({ length: TISSUE_CONTROL_COUNT }, () => ({ radial: 0, axial: 0 })),
    boneAvoid: 0,
});

/**
 * 外冠對到 margin：margin 輕微平滑 → 下緣附近細分 → 對 margin → 抹平下緣上方 → 估下緣切線。
 * 這段最花時間但和穿齦段參數無關，調整控制點時沿用同一份結果。
 * @param {object} options
 * @param {THREE.BufferGeometry} options.crownGeometry 外冠（世界座標）
 * @param {THREE.Vector3[]} options.marginPoints
 * @param {THREE.Vector3} options.occlusalAxis 咬合方向（margin fit 的高度方向）
 * @param {THREE.Vector3} options.implantAxis 植體軸，指向咬合側
 * @param {THREE.Vector3} options.implantCenter 植體平台中心
 * @returns {PreparedAbutmentCrown|{ error: string }}
 */
const prepareAbutmentCrown = ({ crownGeometry, marginPoints, occlusalAxis, implantAxis, implantCenter }) => {
    const indexed = toIndexedPositionGeometry(crownGeometry);
    const loops = extractBoundaryLoops(indexed);
    if (loops.length == 0) return { error: 'crown has no open boundary' };
    const { geometry: crown, boundaryLoop: crownLoop } = refineBottomBand(indexed, loops.reduce((longest, loop) => loop.length > longest.length ? loop : longest), occlusalAxis);
    if (crown != indexed) indexed.dispose();

    // margin 是投影在口掃上的點，帶著掃描面的細小起伏；EZCAD 是先擬合成 B-spline 再用
    const closedMargin = marginPoints.length > 1 && marginPoints[0].distanceTo(marginPoints[marginPoints.length - 1]) < 1e-6 ?
        marginPoints.slice(0, -1) : marginPoints;
    const margin = smoothLoopByArcLength(closedMargin.filter((point, i) => i == 0 || point.distanceTo(closedMargin[i - 1]) > 1e-6), MARGIN_SMOOTH_SIGMA);
    if (!fitCrownBottomToMargin(crown, crownLoop, margin, occlusalAxis)) return { error: 'margin does not surround the crown' };
    orientOutward(crown, getCentroid(margin));

    const angleOf = createAngleFunction(implantCenter, implantAxis);
    const crownPosAttr = crown.getAttribute('position');
    const topPoints = crownLoop.map(vertex => new THREE.Vector3().fromBufferAttribute(crownPosAttr, vertex));
    const topSampler = new LoopSampler(topPoints, angleOf);
    if (topSampler.span < Math.PI) return { error: 'margin does not surround the implant' };

    return {
        crown,
        crownLoop,
        topPoints,
        topTangents: computeCrownBottomTangents(crown, crownLoop, angleOf, implantAxis),
        topSampler,
        angleOf,
    };
}

/**
 * 週期性 Catmull-Rom：count 個等角度控制值，內插任意角度
 * @param {number[]} values
 * @param {number} angle 弧度（0 對應第 0 個控制值）
 * @returns {number}
 */
const sampleControlValue = (values, angle) => {
    const count = values.length;
    const t = ((angle / TWO_PI * count) % count + count) % count;
    const k = Math.floor(t);
    const f = t - k;
    const p0 = values[(k + count - 1) % count];
    const p1 = values[k];
    const p2 = values[(k + 1) % count];
    const p3 = values[(k + 2) % count];
    return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}

/**
 * 穿齦段剖線：每個角度一條 Hermite 曲線，從外冠下緣（沿外冠表面往下）接到介面（沿底部外壁或植體軸往上）。
 * 控制點的位移乘上 16s²(1-s)² 疊上去：中間 s=0.5 正好位移到控制點，兩端位移與斜率都是 0，接外冠與底部的 G1 不受影響。
 * bone avoidance 時介面先沿軸直上一段，剖線接到直上段的頂端。
 * @param {PreparedAbutmentCrown} prepared
 * @param {{ bottomPoints: THREE.Vector3[], bottomTangents: THREE.Vector3[], bottomSampler: LoopSampler }} base
 * @param {THREE.Vector3} implantAxis
 * @param {THREE.Vector3} implantCenter
 * @param {AbutmentDesignParam} param
 */
const createProfile = (prepared, base, implantAxis, implantCenter, param) => {
    const { topPoints, topTangents, topSampler } = prepared;
    const { bottomPoints, bottomTangents, bottomSampler } = base;
    const radialValues = param.tissueOffsets.map(offset => offset.radial);
    const axialValues = param.tissueOffsets.map(offset => offset.axial);
    const hasOffset = param.tissueOffsets.some(offset => offset.radial != 0 || offset.axial != 0);

    const u = Math.abs(implantAxis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.projectOnPlane(implantAxis).normalize();
    const v = new THREE.Vector3().crossVectors(implantAxis, u);

    const top = new THREE.Vector3();
    const bottom = new THREE.Vector3();
    const topTangent = new THREE.Vector3();
    const bottomTangent = new THREE.Vector3();
    const radial = new THREE.Vector3();

    return {
        /**介面頂端（bone avoidance 直上段的上緣） */
        raisedBottom: (angle, target = new THREE.Vector3()) => {
            bottomSampler.sampleVector(bottomPoints, angle, target);
            bottomSampler.sampleVector(bottomTangents, angle, bottomTangent).normalize();
            return target.addScaledVector(bottomTangent, -param.boneAvoid);
        },
        /**
         * @param {number} angle
         * @param {number} s 0 = 外冠下緣、1 = 介面頂端
         * @param {THREE.Vector3} [target]
         * @param {boolean} [withOffset]
         */
        evaluate: (angle, s, target = new THREE.Vector3(), withOffset = true) => {
            topSampler.sampleVector(topPoints, angle, top);
            topSampler.sampleVector(topTangents, angle, topTangent).normalize();
            bottomSampler.sampleVector(bottomPoints, angle, bottom);
            bottomSampler.sampleVector(bottomTangents, angle, bottomTangent).normalize();
            bottom.addScaledVector(bottomTangent, -param.boneAvoid);

            const tangentLength = top.distanceTo(bottom) * HERMITE_TANGENT_SCALE;
            const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
            const h10 = s ** 3 - 2 * s ** 2 + s;
            const h01 = -2 * s ** 3 + 3 * s ** 2;
            const h11 = s ** 3 - s ** 2;
            target.set(0, 0, 0)
                .addScaledVector(top, h00)
                .addScaledVector(topTangent, h10 * tangentLength)
                .addScaledVector(bottom, h01)
                .addScaledVector(bottomTangent, h11 * tangentLength);

            if (withOffset && hasOffset) {
                const bump = 16 * s * s * (1 - s) * (1 - s);
                radial.copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
                target.addScaledVector(radial, sampleControlValue(radialValues, angle) * bump)
                    .addScaledVector(implantAxis, sampleControlValue(axialValues, angle) * bump);
            }
            return target;
        },
        /**繞植體軸角度 angle 的徑向單位向量 */
        radialAt: (angle, target = new THREE.Vector3()) => target.copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle)),
    };
}

/**
 * peek 底部的縫合邊界與從介面離開的方向
 * @param {THREE.BufferGeometry} baseGeometry
 * @param {THREE.Vector3} implantAxis
 * @param {THREE.Vector3} implantCenter
 * @param {(point: THREE.Vector3) => number} angleOf
 */
const prepareAbutmentBase = (baseGeometry, implantAxis, implantCenter, angleOf) => {
    const base = toIndexedPositionGeometry(baseGeometry);
    const baseLoop = findStitchLoop(base, implantAxis, implantCenter);
    if (!baseLoop) {
        base.dispose();
        return { error: 'abutment base has no open boundary' };
    }

    const basePosAttr = base.getAttribute('position');
    const bottomPoints = baseLoop.map(vertex => new THREE.Vector3().fromBufferAttribute(basePosAttr, vertex));
    // 從底部離開的方向：外壁往上就沿外壁，水平的平台座面就沿植體軸。放樣到這裡的行進方向要反過來（往下接進底部）
    const bottomTangents = computeBoundaryOutwardTangents(base, baseLoop).map(tangent => {
        const weight = THREE.MathUtils.smoothstep(tangent.dot(implantAxis), BASE_TANGENT_AXIAL_MIN, BASE_TANGENT_AXIAL_MAX);
        return implantAxis.clone().lerp(tangent, weight).normalize().negate();
    });
    base.dispose();

    const bottomSampler = new LoopSampler(bottomPoints, angleOf);
    if (bottomSampler.span < Math.PI) return { error: 'abutment base does not surround the implant' };
    return { bottomPoints, bottomTangents, bottomSampler };
}

/**
 * 穿齦段控制點目前的位置與可移動的方向（顯示與拖曳用）
 * @param {object} options
 * @param {PreparedAbutmentCrown} options.prepared
 * @param {THREE.BufferGeometry} options.baseGeometry
 * @param {THREE.Vector3} options.implantAxis
 * @param {THREE.Vector3} options.implantCenter
 * @param {AbutmentDesignParam} options.param
 * @returns {{ angle: number, position: THREE.Vector3, defaultPosition: THREE.Vector3, radial: THREE.Vector3, top: THREE.Vector3, bottom: THREE.Vector3 }[]|null}
 */
const getTissueControlFrames = ({ prepared, baseGeometry, implantAxis, implantCenter, param }) => {
    const base = prepareAbutmentBase(baseGeometry, implantAxis, implantCenter, prepared.angleOf);
    if (base.error) return null;
    const profile = createProfile(prepared, base, implantAxis, implantCenter, param);
    return param.tissueOffsets.map((_, k) => {
        const angle = TWO_PI * k / param.tissueOffsets.length;
        return {
            angle,
            position: profile.evaluate(angle, 0.5),
            defaultPosition: profile.evaluate(angle, 0.5, new THREE.Vector3(), false),
            radial: profile.radialAt(angle),
            top: profile.evaluate(angle, 0),
            bottom: profile.raisedBottom(angle),
        };
    });
}

/**
 * 外冠接到 peek 底部：外冠下緣先對 margin，再放樣到底部邊界，回傳「外冠＋穿齦段」一個網格（世界座標）。
 * 下緣的開口就是 peek 底部的縫合邊界，頂點位置與底部完全相同。
 *
 * @param {object} options
 * @param {PreparedAbutmentCrown} [options.prepared] 已經對好 margin 的外冠（調整控制點時重複使用）；沒給就用下面三個參數現算
 * @param {THREE.BufferGeometry} [options.crownGeometry] 外冠（世界座標）
 * @param {THREE.Vector3[]} [options.marginPoints]
 * @param {THREE.Vector3} [options.occlusalAxis] 咬合方向（margin fit 的高度方向）
 * @param {THREE.BufferGeometry} options.baseGeometry peek 底部（世界座標）
 * @param {THREE.Vector3} options.implantAxis 植體軸，指向咬合側
 * @param {THREE.Vector3} options.implantCenter 植體平台中心
 * @param {AbutmentDesignParam} [options.param] 穿齦段參數，沒給用預設
 * @returns {{ geometry: THREE.BufferGeometry|null, error?: string }}
 */
const buildAbutmentGeometry = ({ prepared, crownGeometry, marginPoints, occlusalAxis, baseGeometry, implantAxis, implantCenter, param }) => {
    const crownData = prepared || prepareAbutmentCrown({ crownGeometry, marginPoints, occlusalAxis, implantAxis, implantCenter });
    if (crownData.error) return { geometry: null, error: crownData.error };
    const { crown, crownLoop, topPoints, angleOf } = crownData;

    const base = prepareAbutmentBase(baseGeometry, implantAxis, implantCenter, angleOf);
    if (base.error) return { geometry: null, error: base.error };
    const { bottomPoints } = base;

    const designParam = param || createDefaultAbutmentDesignParam();
    const profile = createProfile(crownData, base, implantAxis, implantCenter, designParam);

    // ---- 放樣：每個角度一條剖線；bone avoidance 時再接一段直上的領圈 ----
    const columnCount = THREE.MathUtils.clamp(Math.max(topPoints.length, bottomPoints.length), MIN_LOFT_COLUMN_COUNT, MAX_LOFT_COLUMN_COUNT);
    const startAngle = angleOf(topPoints[0]);
    const columnAngle = column => startAngle + TWO_PI * column / columnCount;

    const crownPosAttr = crown.getAttribute('position');
    const positions = Array.from(crownPosAttr.array);
    const ringStarts = [];
    const point = new THREE.Vector3();
    const pushRing = pointAt => {
        ringStarts.push(positions.length / 3);
        for (let column = 0; column < columnCount; column++) {
            pointAt(columnAngle(column), point);
            positions.push(point.x, point.y, point.z);
        }
    }

    for (let row = 1; row < LOFT_ROW_COUNT; row++) pushRing((angle, target) => profile.evaluate(angle, row / LOFT_ROW_COUNT, target));
    if (designParam.boneAvoid > BONE_AVOID_EPSILON) {
        const raised = new THREE.Vector3();
        const bottom = new THREE.Vector3();
        const collarRows = Math.max(1, Math.ceil(designParam.boneAvoid / BONE_AVOID_ROW_HEIGHT));
        for (let row = 0; row < collarRows; row++) {
            pushRing((angle, target) => {
                profile.raisedBottom(angle, raised);
                base.bottomSampler.sampleVector(bottomPoints, angle, bottom);
                return target.lerpVectors(raised, bottom, row / collarRows);
            });
        }
    }

    const bottomStart = positions.length / 3;
    for (const bottomPoint of bottomPoints) positions.push(bottomPoint.x, bottomPoint.y, bottomPoint.z);

    // ---- 三角化：外冠下緣 ↔ 第一圈、中間各圈、最後一圈 ↔ 底部邊界 ----
    const triangles = Array.from(crown.index.array);
    const ringOf = ring => Array.from({ length: columnCount }, (_, column) => ({ index: ringStarts[ring] + column, angle: columnAngle(column) }));

    laceRings(toAngularRing(crownLoop, topPoints, angleOf, startAngle), ringOf(0), triangles);
    for (let ring = 0; ring < ringStarts.length - 1; ring++) laceRings(ringOf(ring), ringOf(ring + 1), triangles);
    laceRings(
        ringOf(ringStarts.length - 1),
        toAngularRing(bottomPoints.map((_, i) => bottomStart + i), bottomPoints, angleOf, startAngle),
        triangles,
    );

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(triangles);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    if (!prepared) crown.dispose();
    return { geometry };
}

/**外壁邊界點離 peek 底部縫合邊界多近才算在縫合邊界上（mm） */
const SEAM_TOLERANCE = 0.2;

/**
 * 外壁在牙冠設計雕刻時會細分，縫合邊界上多出 peek 底部沒有的頂點（T 型接點），兩者合起來就不是封閉網格。
 * 把這些點插進底部縫合邊界旁的三角形，回傳補好的底部（世界座標、只有 position）。
 * 縫合邊界取「頂點和外壁邊界重合最多」的那圈，外壁還沒縫上（restore 後）就原樣回傳。
 * @param {object} options
 * @param {THREE.BufferGeometry} options.baseGeometry
 * @param {THREE.Matrix4} options.baseMatrix
 * @param {THREE.BufferGeometry} options.outerGeometry
 * @param {THREE.Matrix4} options.outerMatrix
 * @returns {THREE.BufferGeometry}
 */
const conformBaseToOuterBoundary = ({ baseGeometry, baseMatrix, outerGeometry, outerMatrix }) => {
    const base = toIndexedPositionGeometry(baseGeometry, baseMatrix);
    const outer = toIndexedPositionGeometry(outerGeometry, outerMatrix);
    const outerPosAttr = outer.getAttribute('position');
    const outerBoundaryPoints = extractBoundaryLoops(outer).flat().map(vertex => new THREE.Vector3().fromBufferAttribute(outerPosAttr, vertex));
    outer.dispose();

    const basePosAttr = base.getAttribute('position');
    const toPoints = loop => loop.map(vertex => new THREE.Vector3().fromBufferAttribute(basePosAttr, vertex));
    const isShared = (point, points) => points.some(other => other.distanceToSquared(point) < 1e-8);
    const seam = extractBoundaryLoops(base)
        .map(loop => {
            const points = toPoints(loop);
            return { loop, points, sharedCount: points.filter(point => isShared(point, outerBoundaryPoints)).length };
        })
        .reduce((best, item) => !best || item.sharedCount > best.sharedCount ? item : best, null);
    if (!seam || seam.sharedCount == 0) return base;

    // 每個多出來的點落在縫合邊界的哪條邊（loop[i] → loop[i + 1]）、哪個位置
    const { loop, points } = seam;
    const segment = new THREE.Line3();
    /**@type {Map<number, { t: number, point: THREE.Vector3 }[]>} */
    const insertMap = new Map();
    for (const point of outerBoundaryPoints) {
        if (isShared(point, points)) continue;

        let best = null;
        for (let i = 0; i < loop.length; i++) {
            segment.set(points[i], points[(i + 1) % loop.length]);
            const t = segment.closestPointToPointParameter(point, true);
            const distance = segment.at(t, new THREE.Vector3()).distanceTo(point);
            if (!best || distance < best.distance) best = { i, t, distance };
        }
        if (best.distance > SEAM_TOLERANCE || best.t <= 0 || best.t >= 1) continue;

        if (!insertMap.has(best.i)) insertMap.set(best.i, []);
        insertMap.get(best.i).push({ t: best.t, point });
    }
    if (insertMap.size == 0) return base;

    // 縫合邊界依底部三角形的繞向排列，loop[i] → loop[i + 1] 就是某個底部三角形的一條邊；把它換成扇形
    const indexArray = Array.from(base.index.array);
    const vertexCount = basePosAttr.count;
    const triangleOfEdge = new Map();
    for (let i = 0; i < indexArray.length; i += 3) {
        for (let k = 0; k < 3; k++) triangleOfEdge.set(indexArray[i + k] * vertexCount + indexArray[i + (k + 1) % 3], i);
    }
    const hasEdge = (triangle, a, b) => [0, 1, 2].some(k => indexArray[triangle + k] == a && indexArray[triangle + (k + 1) % 3] == b);
    // 同一個三角形有兩條縫合邊時，前一條換掉後查表的結果就過期了，改從頭找
    const findTriangle = (a, b) => {
        const triangle = triangleOfEdge.get(a * vertexCount + b);
        if (triangle != undefined && hasEdge(triangle, a, b)) return triangle;
        for (let i = 0; i < indexArray.length; i += 3) if (hasEdge(i, a, b)) return i;
        return undefined;
    }

    const positions = Array.from(basePosAttr.array);
    for (const [i, inserts] of insertMap) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const triangle = findTriangle(a, b);
        if (triangle == undefined) continue;

        const c = [0, 1, 2].map(k => indexArray[triangle + k]).find(vertex => vertex != a && vertex != b);
        const chain = [a];
        for (const { point } of inserts.sort((itemA, itemB) => itemA.t - itemB.t)) {
            chain.push(positions.length / 3);
            positions.push(point.x, point.y, point.z);
        }
        chain.push(b);

        indexArray.splice(triangle, 3, chain[0], chain[1], c);
        for (let k = 1; k < chain.length - 1; k++) indexArray.push(chain[k], chain[k + 1], c);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indexArray);
    base.dispose();
    return geometry;
}

export {
    buildAbutmentGeometry,
    prepareAbutmentCrown,
    getTissueControlFrames,
    createDefaultAbutmentDesignParam,
    TISSUE_CONTROL_COUNT,
    orientBaseForStitching,
    conformBaseToOuterBoundary,
    extractBoundaryLoops,
    toIndexedPositionGeometry,
};
