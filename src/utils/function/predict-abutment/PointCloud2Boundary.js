import * as THREE from 'three';

/**
 * 從點雲 + 機率值提取 abutment 邊界輪廓
 * 
 * 算法：
 * 1. KNN 邊界檢測：找出同時有 abutment 和 non-abutment 鄰居的點（真正的邊界點）
 * 2. PCA 投影：找邊界點的最佳投影平面
 * 3. Angular Sweep：在邊界點上按角度分 bin，每 bin 取最遠點
 * 
 * @param {number[][]} jawPoints - 8192 個 [x,y,z] 點雲
 * @param {number[]} allProbabilities - 8192 個機率值
 * @param {number} toothFdi - 齒位 FDI 編號（保留接口）
 * @param {object} [options]
 * @param {number} [options.probThreshold=0.5] - abutment 機率閾值
 * @param {number} [options.neighborRadius=0.8] - KNN 鄰居搜索半徑 (mm)
 * @param {number} [options.boundaryRatio=0.15] - 邊界判定：非 abutment 鄰居佔比閾值
 * @param {number} [options.angleBins=90] - 角度分 bin 數量
 * @param {number} [options.maxGapBins=3] - 最大允許的連續空 bin 數
 * @returns {THREE.Vector3[]} 有序閉合輪廓點陣列
 */
const pointCloud2Boundary = (jawPoints, allProbabilities, toothFdi, options = {}) => {
    const {
        probThreshold = 0.5,
        neighborRadius = 0.8,
        boundaryRatio = 0.15,
        angleBins = 90,
        maxGapBins = 3,
    } = options;

    const n = jawPoints.length;

    // ========== Step 1: KNN 邊界檢測 ==========
    // 建立 3D grid 加速鄰居搜索
    const cellSize = neighborRadius;
    const grid = new Map();

    for (let i = 0; i < n; i++) {
        const p = jawPoints[i];
        const key = `${Math.floor(p[0] / cellSize)}_${Math.floor(p[1] / cellSize)}_${Math.floor(p[2] / cellSize)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
    }

    const rSq = neighborRadius * neighborRadius;
    const boundaryPoints = []; // { point: THREE.Vector3, ratio: number }

    for (let i = 0; i < n; i++) {
        if (allProbabilities[i] <= probThreshold) continue;

        const p = jawPoints[i];
        const cx = Math.floor(p[0] / cellSize);
        const cy = Math.floor(p[1] / cellSize);
        const cz = Math.floor(p[2] / cellSize);

        let nonAbutCount = 0;
        let totalCount = 0;

        // 搜索 3x3x3 鄰居格子
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = `${cx + dx}_${cy + dy}_${cz + dz}`;
                    const cell = grid.get(key);
                    if (!cell) continue;

                    for (const idx of cell) {
                        if (idx === i) continue;
                        const q = jawPoints[idx];
                        const dSq = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
                        if (dSq < rSq) {
                            totalCount++;
                            if (allProbabilities[idx] <= probThreshold) {
                                nonAbutCount++;
                            }
                        }
                    }
                }
            }
        }

        if (totalCount > 0 && nonAbutCount > 0) {
            const ratio = nonAbutCount / totalCount;
            if (ratio > boundaryRatio) {
                boundaryPoints.push({
                    point: new THREE.Vector3(p[0], p[1], p[2]),
                    ratio,
                });
            }
        }
    }

    if (boundaryPoints.length < 10) {
        console.warn('Too few boundary points:', boundaryPoints.length);
        return [];
    }

    console.log(`KNN boundary: ${boundaryPoints.length} boundary points found`);

    // ========== Step 2: PCA 投影平面 ==========
    const centroid = new THREE.Vector3();
    for (const bp of boundaryPoints) centroid.add(bp.point);
    centroid.divideScalar(boundaryPoints.length);

    const { u, v } = computePCA(boundaryPoints.map(bp => bp.point), centroid);

    // ========== Step 3: Angular Sweep on boundary points ==========
    const binSize = (2 * Math.PI) / angleBins;
    const bins = new Array(angleBins).fill(null);

    for (const bp of boundaryPoints) {
        const rel = new THREE.Vector3().subVectors(bp.point, centroid);
        const projU = rel.dot(u);
        const projV = rel.dot(v);
        const angle = Math.atan2(projV, projU);
        const dist = Math.sqrt(projU * projU + projV * projV);

        let binIndex = Math.floor((angle + Math.PI) / binSize);
        if (binIndex >= angleBins) binIndex = angleBins - 1;

        if (!bins[binIndex] || dist > bins[binIndex].distance) {
            bins[binIndex] = { point: bp.point.clone(), distance: dist };
        }
    }

    // ========== Step 4: 提取輪廓，插值空 bin ==========
    const outlinePoints = [];
    for (let i = 0; i < angleBins; i++) {
        if (bins[i]) {
            outlinePoints.push(bins[i].point);
        } else {
            let prevIdx = -1, nextIdx = -1;
            for (let d = 1; d <= maxGapBins; d++) {
                if (prevIdx === -1 && bins[(i - d + angleBins) % angleBins]) {
                    prevIdx = (i - d + angleBins) % angleBins;
                }
                if (nextIdx === -1 && bins[(i + d) % angleBins]) {
                    nextIdx = (i + d) % angleBins;
                }
                if (prevIdx !== -1 && nextIdx !== -1) break;
            }
            if (prevIdx !== -1 && nextIdx !== -1) {
                const prevPoint = bins[prevIdx].point;
                const nextPoint = bins[nextIdx].point;
                const prevDist = ((i - prevIdx) + angleBins) % angleBins;
                const nextDist = ((nextIdx - i) + angleBins) % angleBins;
                const t = prevDist / (prevDist + nextDist);
                outlinePoints.push(prevPoint.clone().lerp(nextPoint, t));
            }
        }
    }

    console.log(`Angular sweep on boundary: ${boundaryPoints.length} → ${outlinePoints.length} outline points (${angleBins} bins)`);

    return outlinePoints;
}

/**
 * PCA: Power Iteration + Deflation 找前兩個主成分
 */
const computePCA = (points, centroid) => {
    const n = points.length;
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

    for (const p of points) {
        const d = [p.x - centroid.x, p.y - centroid.y, p.z - centroid.z];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                cov[i][j] += d[i] * d[j];
            }
        }
    }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] /= n;

    const ev1 = powerIteration(cov);
    const cov2 = cov.map((row, i) =>
        row.map((val, j) => val - ev1.eigenvalue * ev1.vector[i] * ev1.vector[j])
    );
    const ev2 = powerIteration(cov2);

    return {
        u: new THREE.Vector3(ev1.vector[0], ev1.vector[1], ev1.vector[2]),
        v: new THREE.Vector3(ev2.vector[0], ev2.vector[1], ev2.vector[2]),
    };
}

const powerIteration = (mat, numIter = 100) => {
    let v = [1.0, 0.0, 0.0];
    for (let iter = 0; iter < numIter; iter++) {
        const nv = [
            mat[0][0] * v[0] + mat[0][1] * v[1] + mat[0][2] * v[2],
            mat[1][0] * v[0] + mat[1][1] * v[1] + mat[1][2] * v[2],
            mat[2][0] * v[0] + mat[2][1] * v[1] + mat[2][2] * v[2],
        ];
        const norm = Math.sqrt(nv[0] ** 2 + nv[1] ** 2 + nv[2] ** 2);
        if (norm > 0) v = [nv[0] / norm, nv[1] / norm, nv[2] / norm];
    }
    let eigenvalue = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) eigenvalue += mat[i][j] * v[j] * v[i];
    return { vector: v, eigenvalue };
}

export { pointCloud2Boundary }