import * as THREE from 'three';
import { projectPointOnMesh } from './ProjectPoint';

/**
 * 使用移動平均對點進行平滑處理（保留作為基礎方法）
 * @param {THREE.Vector3[]} points 
 * @param {number} iterations 平滑迭代次數
 * @param {number} factor 平滑強度 (0-1)
 * @returns {THREE.Vector3[]}
 */
const smoothPoints = (points, iterations = 3, factor = 0.5) => {
    if (points.length < 3) return points;

    let smoothedPoints = points.map(p => p.clone());

    for (let iter = 0; iter < iterations; iter++) {
        const newPoints = [];

        for (let i = 0; i < smoothedPoints.length; i++) {
            const current = smoothedPoints[i];
            const prev = smoothedPoints[(i - 1 + smoothedPoints.length) % smoothedPoints.length];
            const next = smoothedPoints[(i + 1) % smoothedPoints.length];

            // 計算相鄰點的平均位置
            const avgPos = new THREE.Vector3()
                .addVectors(prev, next)
                .divideScalar(2);

            // 在當前位置和平均位置之間插值
            const smoothedPos = current.clone().lerp(avgPos, factor);
            newPoints.push(smoothedPos);
        }

        smoothedPoints = newPoints;
    }

    return smoothedPoints;
}

/**
 * 距離加權 Laplacian 平滑 + 每步投影回 mesh
 * 比等權移動平均更精確，投影確保曲線始終貼在 mesh 表面
 * @param {THREE.Vector3[]} points 
 * @param {THREE.Mesh} mesh - 用於投影的 mesh
 * @param {number} iterations 平滑迭代次數
 * @param {number} factor 平滑強度 (0-1)，建議 0.3
 * @param {number} windowSize 鄰域窗口大小（單側），2 表示前後各2個點
 * @returns {THREE.Vector3[]}
 */
const smoothPointsWithProjection = (points, mesh, iterations = 3, factor = 0.3, windowSize = 2) => {
    if (points.length < 3) return points;

    let smoothedPoints = points.map(p => p.clone());
    const n = smoothedPoints.length;

    for (let iter = 0; iter < iterations; iter++) {
        const newPoints = [];

        for (let i = 0; i < n; i++) {
            const current = smoothedPoints[i];

            // 距離加權 Laplacian：考慮窗口內多個鄰居
            let weightSum = 0;
            const avgPos = new THREE.Vector3();

            for (let offset = -windowSize; offset <= windowSize; offset++) {
                if (offset === 0) continue;
                const neighborIdx = (i + offset + n) % n;
                const neighbor = smoothedPoints[neighborIdx];
                const dist = current.distanceTo(neighbor);
                const weight = dist > 0 ? 1 / dist : 1; // 距離越近權重越大

                avgPos.addScaledVector(neighbor, weight);
                weightSum += weight;
            }

            if (weightSum > 0) {
                avgPos.divideScalar(weightSum);
            }

            // 在當前位置和加權平均位置之間插值
            const smoothedPos = current.clone().lerp(avgPos, factor);
            newPoints.push(smoothedPos);
        }

        // 每步平滑後投影回 mesh 表面
        if (mesh) {
            for (const point of newPoints) {
                const projected = projectPointOnMesh(mesh, point);
                point.copy(projected);
            }
        }

        smoothedPoints = newPoints;
    }

    return smoothedPoints;
}

export { smoothPoints, smoothPointsWithProjection }