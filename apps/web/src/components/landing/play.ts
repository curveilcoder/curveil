/** Small timing hooks for the landing-page demos. Everything pauses off screen and for reduced motion. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { usePrefersReducedMotion } from "../../lib/motion";

export function useInView<T extends Element>(ref: RefObject<T | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setInView(es.some((e) => e.isIntersecting)), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/**
 * A playhead from 0 to 1 that advances over `seconds` while it is playing and on screen.
 * Dragging calls `seek`, which also pauses; `play` resumes (from the start once it has finished).
 */
export function usePlayhead<T extends Element>(ref: RefObject<T | null>, seconds: number, { loop = true, fps = 30, rest = 0.35 } = {}) {
  const reduced = usePrefersReducedMotion();
  const inView = useInView(ref);
  const [playing, setPlaying] = useState(!reduced);
  const [t, setT] = useState(reduced ? rest : 0);
  const tRef = useRef(t);
  useEffect(() => { if (reduced) { setPlaying(false); tRef.current = rest; setT(rest); } }, [reduced, rest]);
  useEffect(() => {
    if (!playing || !inView) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const step = (now: number) => {
      acc += (now - last) / 1000;
      last = now;
      if (acc >= 1 / fps) {
        let n = tRef.current + acc / seconds;
        acc = 0;
        if (n >= 1) n = loop ? n % 1 : 1;
        tRef.current = n;
        setT(n);
        if (n >= 1 && !loop) { setPlaying(false); return; }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, inView, seconds, loop, fps]);
  const seek = useCallback((v: number) => { setPlaying(false); tRef.current = v; setT(v); }, []);
  const play = useCallback(() => { if (tRef.current >= 1) { tRef.current = 0; setT(0); } setPlaying(true); }, []);
  const restart = useCallback(() => { tRef.current = 0; setT(0); if (!reduced) setPlaying(true); else { tRef.current = 1; setT(1); } }, [reduced]);
  const pause = useCallback(() => setPlaying(false), []);
  return { t, playing, seek, play, pause, restart, reduced };
}

/** Steps through `count` items every `ms` while on screen, until the reader picks one. */
export function useCycle<T extends Element>(ref: RefObject<T | null>, count: number, ms: number) {
  const reduced = usePrefersReducedMotion();
  const inView = useInView(ref);
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto || !inView || reduced) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % count), ms);
    return () => window.clearInterval(id);
  }, [auto, inView, reduced, count, ms]);
  const pick = useCallback((n: number) => { setAuto(false); setI(n); }, []);
  return [i, pick, auto && !reduced] as const;
}

/** A seeded random number generator, so sample data is the same on every visit. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** True below a CSS width, following resizes. */
export function useNarrow(px = 720): boolean {
  const q = `(max-width: ${px}px)`;
  const [n, setN] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setN(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return n;
}
