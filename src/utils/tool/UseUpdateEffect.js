import { useEffect, useRef } from 'react';

/**裝載時不會觸發的useEffect */
const useUpdateEffect = (effect, deps) => {
  const isFirstMount = useRef(true);

  useEffect(() => {
    if (!isFirstMount.current) effect();
    else isFirstMount.current = false;
  }, deps);
};

export { useUpdateEffect };
