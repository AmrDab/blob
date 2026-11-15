import { useEffect, useRef } from 'react';

const SETTLE_MS = 400;

/**
 * A card that just appeared, or took another one's place, takes no click for a moment: a click that was on its way to
 * what was there before must not answer the new one. `key` names what is shown; the returned function says whether a
 * click counts now.
 */
export function useSettled(key: unknown): () => boolean {
  const since = useRef(Date.now());
  useEffect(() => { since.current = Date.now(); }, [key]);
  return () => Date.now() - since.current >= SETTLE_MS;
}
