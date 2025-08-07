import {
    buildPointMap,
    buildTriMap,
    posKey2Neighbors,
} from './BufferGeometryTool';

/**
 * @param {BufferGeometry} geometry
 * @param {Set<string>} seedPointKeySet 所有種子點
 * @param {(seedPointKey: string, neighborPointKey: string)=>{}} ifSpreadJudgeFunc 擴散判斷函式，為true則繼續擴散
 * @return {Set<string>} 所有擴散到的點
 */
const pointSpread = (geometry, seedPointKeySet, ifSpreadJudgeFunc = () => true) => {
    if (!geometry.pointMap) geometry.pointMap = buildPointMap(geometry);
    /**@type {import('./GeometryMapTool').PointMap} */
    const pointMap = geometry.pointMap;

    const checkedPointKeySet = new Set();
    const tempSeedPointKeySet = new Set([...seedPointKeySet]);

    const neighborSeedKeySet = new Set();
    while (tempSeedPointKeySet.size > 0) {
        neighborSeedKeySet.clear();

        for (const seedPointKey of tempSeedPointKeySet) {
            const neighborKeySet = posKey2Neighbors(geometry, pointMap, seedPointKey);
            checkedPointKeySet.add(seedPointKey);

            for (const neighborKey of neighborKeySet) {
                if (checkedPointKeySet.has(neighborKey)) continue;
                if (!ifSpreadJudgeFunc(seedPointKey, neighborKey)) continue;

                neighborSeedKeySet.add(neighborKey);
            }
        }

        tempSeedPointKeySet.clear();
        for (const neighborKey of neighborSeedKeySet)
            tempSeedPointKeySet.add(neighborKey);
    }

    return checkedPointKeySet;
}

/**
 * @param {BufferGeometry} geometry
 * @param {Set<number>} seedtriIndexSet 所有種子三角形
 * @param {(checkedTriIndex: number, neighborTriIndex: number)=>{}} ifSpreadJudgeFunc 擴散判斷函式，為true則繼續擴散
 */
const triangleSpread = (geometry, seedtriIndexSet, ifSpreadJudgeFunc = () => true) => {
    if (!geometry.triMap) geometry.triMap = buildTriMap(geometry);
    /**@type {import('./GeometryMapTool').TriMap} */
    const triMap = geometry.triMap;

    const spreadTriIndexSet = new Set();
    const boundaryPointKeySet = new Set();
    const tempSeedTriIndexSet = new Set([...seedtriIndexSet]);

    const neighborTriIndexSet = new Set();
    while (tempSeedTriIndexSet.size > 0) {
        neighborTriIndexSet.clear();

        for (const seedTriKey of tempSeedTriIndexSet) {
            const { triIndices: neighborTriArray } = triMap[seedTriKey];
            spreadTriIndexSet.add(seedTriKey);

            for (const neighborKey of neighborTriArray) {
                if (spreadTriIndexSet.has(neighborKey)) continue;
                if (boundaryPointKeySet.has(neighborKey)) continue;

                if (!ifSpreadJudgeFunc(seedTriKey, neighborKey)) {
                    boundaryPointKeySet.add(neighborKey);
                    continue;
                }

                neighborTriIndexSet.add(neighborKey);
            }
        }

        tempSeedTriIndexSet.clear();
        for (const neighborKey of neighborTriIndexSet)
            tempSeedTriIndexSet.add(neighborKey);
    }

    return { spreadTriIndexSet, boundaryPointKeySet };
}

export { pointSpread, triangleSpread }