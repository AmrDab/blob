// The React side of Blob's type (type.ts): a line's words, a card title, and the line that swaps (a caption, the
// pill's activity).
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { commandLines, condense, dissolve, letters, settle, swapper, tokens } from './type.ts';

const CALM = matchMedia('(prefers-reduced-motion: reduce)');
/** The blob mark's outline, in the text's own colour: the dot of an "i" and a closing full stop in a title. */
const Drop = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
    <path fill="currentColor" d="M16 2.4c7 0 13.3 4.7 13.6 12.8.3 8.3-5.7 14.4-13.7 14.4C7.9 29.6 2.2 24 2.4 15.8 2.6 7.9 8.6 2.4 16 2.4z" />
  </svg>
);

/** A title's word: the real letters stay in the text at no size (so it reads the same to a screen reader), and a
    dotless "i" is drawn by CSS with the droplet above it. */
function droplets(word: string): ReactNode[] {
  const { parts, stop } = letters(word);
  const out: ReactNode[] = parts.map((p, n) => p !== 'i' ? p : (
    <span className="ij" key={n}><span className="ij-p">i</span><span className="ij-d" aria-hidden="true"><i><Drop className="tittle" /></i></span></span>
  ));
  if (stop) out.push(<span className="dot" key="dot">.</span>, <Drop className="drop" key="drop" />);
  return out;
}

/** A line as words (.w), so they can arrive one at a time. `drops`: a title's droplet dots. A very long word (a link,
    a path) stays plain text: as a box of its own it would wrap inside itself, and count as one line of a caption. */
export function Words({ text, drops }: { text: string; drops?: boolean }) {
  return <>{tokens(text).map((t, n) => t.space ? ' ' : !drops && t.text.length > 24 ? t.text
    : <span key={n} className={t.num ? 'w num' : 'w'}>{drops ? droplets(t.text) : t.text}</span>)}</>;
}

/** A card's title, in Blob's voice: it condenses once when it appears (after `wait` ms: a card's text shows only
    once its liquid has arrived), then rests with its letters fused. With reduced motion it is simply there. */
export function Title({ text, wait = 0 }: { text: string; wait?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (CALM.matches) { settle(el, true); return; }
    el.style.visibility = 'hidden';
    const t = setTimeout(() => void condense(el, true), wait);
    return () => clearTimeout(t);
  }, [text]);
  return <div ref={ref} className="title"><Words text={text} drops /></div>;
}

/** A command exactly as it will run: every character, wrapped at spaces first, then after a path separator; each of
    its own lines hangs its wrapped lines in, so a wrap never reads as a new line. */
export const Command = ({ text }: { text: string }) => (
  <pre className="detail">{commandLines(text).map((line, i) => (
    <div key={i}>{line.map((piece, j) => <Fragment key={j}>{j > 0 && <wbr />}{piece}</Fragment>)}</div>
  ))}</pre>
);

/** A line that swaps. `id` names it: a new id dissolves the old line and condenses the new one, the same id only
    updates what it says. `plain`: it never animates (a label). `blob`: Blob's own words, in its voice. */
export interface Line { id: string; node: ReactNode; plain?: boolean; blob?: boolean }

/**
 * The line on screen, and the ref for the element that holds it (the one that turns to goo). It lags `line` by the
 * dissolve, and always ends on the latest one. With reduced motion the swap is at once, with a short fade.
 */
export function useSwap<E extends HTMLElement>(line: Line | null): [Line | null, RefObject<E>] {
  const ref = useRef<E>(null);
  const [shown, setShown] = useState<Line | null>(null);
  const committed = useRef<() => void>();
  useLayoutEffect(() => { committed.current?.(); committed.current = undefined; }, [shown]);
  const set = useMemo(() => {
    const el = () => (ref.current?.isConnected ? ref.current : null);
    return swapper<Line>({
      same: (a, b) => a?.id === b?.id,
      // a label comes and goes at once: nothing dissolves to make room for it, or when it leaves
      hide: async (old, next) => { const e = el(); if (e && !old.plain && !next?.plain && !CALM.matches) await dissolve(e); },
      show: next => new Promise<void>(done => { committed.current = done; setShown(next); }),
      form: async next => {
        const e = el();
        if (!e) return;
        if (next.plain) settle(e); else if (CALM.matches) settle(e, false, true); else await condense(e);
      },
    });
  }, []);
  useLayoutEffect(() => { void set(line).catch(() => {}); }, [line?.id]);
  return [shown && line && shown.id === line.id ? line : shown, ref];
}
