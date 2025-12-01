import * as THREE from 'three';
/**
 * 使用移動平均對點進行平滑處理
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

export { smoothPoints }