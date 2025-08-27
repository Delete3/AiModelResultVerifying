import * as THREE from 'three';

/**
 * 使用最小生成樹算法對點進行排序
 * @param {THREE.Vector3[]} points 
 * @returns {THREE.Vector3[]}
 */
const sortPointsByMST = (points) => {
    if (points.length <= 2) return points;
    console.time('sortPointsByMST')

    // 1. 構建距離矩陣
    const n = points.length;
    const distances = Array(n).fill().map(() => Array(n).fill(Infinity));

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = points[i].distanceTo(points[j]);
            distances[i][j] = distances[j][i] = dist;
        }
        distances[i][i] = 0;
    }

    // 2. 構建最小生成樹
    const edges = [];
    const visited = new Set([0]);

    while (visited.size < n) {
        let minDist = Infinity;
        let minEdge = null;

        for (const i of visited) {
            for (let j = 0; j < n; j++) {
                if (!visited.has(j) && distances[i][j] < minDist) {
                    minDist = distances[i][j];
                    minEdge = [i, j];
                }
            }
        }

        if (minEdge) {
            edges.push(minEdge);
            visited.add(minEdge[1]);
        }
    }

    // 3. 構建鄰接列表
    const graph = Array(n).fill().map(() => []);
    for (const [a, b] of edges) {
        graph[a].push(b);
        graph[b].push(a);
    }

    // 4. 找到度數為1的起始點（如果是封閉環則任選一點）
    let startIndex = 0;
    for (let i = 0; i < n; i++) {
        if (graph[i].length === 1) {
            startIndex = i;
            break;
        }
    }

    // 5. DFS遍歷獲得排序
    const result = [];
    const dfsVisited = new Set();

    const dfs = (current) => {
        dfsVisited.add(current);
        result.push(points[current]);

        for (const neighbor of graph[current]) {
            if (!dfsVisited.has(neighbor)) {
                dfs(neighbor);
            }
        }
    };

    dfs(startIndex);
    console.timeEnd('sortPointsByMST')
    return result;
}

/**
 * 使用2-opt算法優化點的順序（高效能版本）
 * @param {THREE.Vector3[]} points 
 * @param {number} maxIterations 最大迭代次數
 * @returns {THREE.Vector3[]}
 */
const optimizePointOrder = (points, maxIterations = Infinity) => {
    console.time('optimizePointOrder')
    if (points.length <= 3) return points;

    // 對於大量點集，先進行快速預處理
    // points = quickDecimate(points, 200);

    let bestOrder = [...points];
    let bestDistance = calculateTotalDistance(bestOrder);
    let improved = true;
    let iterations = 0;

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        for (let i = 1; i < points.length - 2; i++) {
            for (let j = i + 1; j < points.length; j++) {
                if (j - i === 1) continue; // 跳過相鄰點

                // 只計算受影響的距離變化，而不是整個路徑
                const deltaDistance = calculate2OptDelta(bestOrder, i, j);

                if (deltaDistance < 0) { // 距離減少了
                    // 直接在原數組上進行反轉
                    reverse(bestOrder, i, j);
                    bestDistance += deltaDistance;
                    improved = true;

                    // 找到改進後立即跳到下一輪，避免過度優化
                    break;
                }
            }
            if (improved) break; // 早停，避免過度計算
        }
    }

    console.timeEnd('optimizePointOrder')
    return bestOrder;
}

/**
 * 計算2-opt交換的距離變化（不重新計算整個路徑）
 * @param {THREE.Vector3[]} points 
 * @param {number} i 
 * @param {number} j 
 * @returns {number} 距離變化量
 */
const calculate2OptDelta = (points, i, j) => {
    const n = points.length;

    // 原始連接的距離
    const prevI = (i - 1 + n) % n;
    const nextJ = (j + 1) % n;

    const oldDistance = points[prevI].distanceTo(points[i]) + points[j].distanceTo(points[nextJ]);

    // 2-opt交換後的距離
    const newDistance = points[prevI].distanceTo(points[j]) + points[i].distanceTo(points[nextJ]);

    return newDistance - oldDistance;
}

/**
 * 快速減少點數量（保持形狀特徵）
 * @param {THREE.Vector3[]} points 
 * @param {number} targetCount 
 * @returns {THREE.Vector3[]}
 */
const quickDecimate = (points, targetCount) => {
    if (points.length <= targetCount) return points;

    const step = points.length / targetCount;
    const decimated = [];

    for (let i = 0; i < targetCount; i++) {
        const index = Math.floor(i * step);
        decimated.push(points[index]);
    }

    return decimated;
}

/**
 * 計算路徑總距離
 */
const calculateTotalDistance = (points) => {
    let total = 0;
    for (let i = 0; i < points.length; i++) {
        const next = (i + 1) % points.length;
        total += points[i].distanceTo(points[next]);
    }
    return total;
}

/**
 * 反轉數組中指定範圍的元素
 */
const reverse = (array, start, end) => {
    while (start < end) {
        [array[start], array[end]] = [array[end], array[start]];
        start++;
        end--;
    }
}

export { sortPointsByMST, optimizePointOrder, quickDecimate }