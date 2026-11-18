import { useCallback, useEffect, useRef, useState } from 'react';

// Parameter edits rebuild the part once they settle for this long.
const REBUILD_DELAY_MS = 350;

/**
 * A part built in this browser from a finished job: the PEEK crown's lower part from the crown's
 * outer shell (peek/peekBuilder.js), or the custom abutment from the stump
 * (stump/abutmentBuilder.js). Rebuilt whenever its parameters settle; a build that a newer one
 * overtook is thrown away.
 *
 * `createBuilder` makes the builder (setJob / build / dispose / hasJob); `draw(solid, tibase)` and
 * `clear()` put the result on screen or take it off.
 *
 * Returns { state (the last build), busy, error, hasJob, setJob(args), drop(), rebuild }.
 */
const useLowerBuild = ({ createBuilder, draw, clear, enabled, params, part }) => {
  const builder = useRef(null);
  const seq = useRef(0);
  const [hasJob, setHasJob] = useState(false);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    builder.current = createBuilder();
    return () => builder.current.dispose();
  }, []);

  const drop = useCallback(() => {
    seq.current++;
    builder.current?.dispose();
    setHasJob(false);
    setState(null);
    setError(null);
    setBusy(false);
  }, []);

  // The job's mesh, margin and site go to the builder; the build itself follows from hasJob (and
  // from every parameter change after it).
  const setJob = useCallback(async args => {
    try {
      await builder.current.setJob(args);
      setHasJob(true);
    } catch (setupError) {
      setError(setupError.message);
    }
  }, []);

  const rebuild = useCallback(async () => {
    if (!builder.current?.hasJob) return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    // Let the busy state paint: the build runs on this thread for up to a second or so.
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
      if (mine !== seq.current) return;
      const out = await builder.current.build(params, part);
      if (mine !== seq.current) {
        out.solid?.dispose();
        out.tibase?.dispose();
        return;
      }
      if (out.error) {
        clear();
        setState(null);
        setError(out.error);
        return;
      }
      draw(out.solid, out.tibase);
      setState(out);
    } catch (buildError) {
      if (mine === seq.current) setError(buildError.message);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [params, part]);

  useEffect(() => {
    if (!hasJob || !enabled) return undefined;
    const timer = setTimeout(rebuild, REBUILD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasJob, enabled, rebuild]);

  return { state, busy, error, hasJob, setJob, drop, rebuild };
};

export default useLowerBuild;
