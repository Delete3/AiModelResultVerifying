/**
 * Render a list of {label, seconds} steps as an aligned block ending in a measured total.
 * Lives apart from any one caller: the one-click flow shows the pipeline service's own
 * per-stage timings here, and anything else that grows stages can reuse it.
 */

/**
 * Monospace columns: CJK occupies two cells, so string length alone misaligns them.
 * Escapes rather than the characters themselves — the range opens at U+3000, an ideographic
 * space, and the literal form trips eslint's no-irregular-whitespace.
 */
const displayWidth = text => [...text]
  .reduce((total, ch) => total + (/[\u3000-\u9FFF\uFF00-\uFF60]/.test(ch) ? 2 : 1), 0);

/**
 * Render steps as an aligned block ending in the measured total.
 * totalSeconds is passed in rather than summed: the caller's wall clock also covers the gaps
 * between steps, and a column that does not add up to the total is the honest version.
 */
const formatTimings = (timings, totalSeconds) => {
  const width = Math.max(...[...timings.map(t => t.label), '總計'].map(displayWidth));
  const row = (label, seconds, note) =>
    `  ${label}${' '.repeat(width - displayWidth(label))}  ${seconds.toFixed(1).padStart(5)} 秒${note ? `  ${note}` : ''}`;

  return [
    ...timings.map(t => row(t.label, t.seconds, t.note)),
    `  ${'─'.repeat(width + 9)}`,
    row('總計', totalSeconds),
  ].join('\n');
};

export { formatTimings };
