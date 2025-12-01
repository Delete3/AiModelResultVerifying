/**
 * @param {string} string 
 * @returns {string}
 */
const getFileExtension = (string) => {
    return string.slice((string.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
}

export { getFileExtension }