import { useEffect, useRef } from 'react';
import type { SystemActivity } from '../lib/ambient';
import { glowFilter, prefersReducedMotion, svgEl } from './NexusCore';

/**
 * AEGIS — the second dashboard avatar.
 *
 * Where NEXUS says the state in colour and motion, AEGIS says it in words: a
 * HUD ring with a readout at its centre and a waveform underneath. It is the
 * one that reads updates aloud, so it earns the right to show the sentence.
 *
 * Idle collapses to the wordmark alone — the ring at rest should say the
 * companion's name and nothing else.
 */

type AegisState = { main: string; sub: string; col: string; sub2: string; spin: number };

const AEGIS: Record<SystemActivity, AegisState> = {
  idle: { main: 'IDLE', sub: '', col: '#dffaff', sub2: '#6fc7dd', spin: 1 },
  active: { main: 'WORKING', sub: 'AGENTS IN MOTION', col: '#9df1ff', sub2: '#6fc7dd', spin: 3 },
  busy: { main: 'REASONING', sub: 'HIGH ACTIVITY', col: '#c9f5ff', sub2: '#6fc7dd', spin: 4.4 },
  blocked: { main: 'NEEDS YOU', sub: 'APPROVAL BLOCKED', col: '#ff8a8a', sub2: '#ff6b6b', spin: 0.4 },
  failed: { main: 'FAULT', sub: 'AGENT FAULTED', col: '#ff8a8a', sub2: '#ff6b6b', spin: 0.2 },
};

const CX = 130;
const CY = 128;

/** shrink a <text> until it fits — copy can never collide with the ring */
function fit(node: SVGTextElement, max: number) {
  if (!node.textContent) return;
  const fs = parseFloat(node.getAttribute('font-size') || '0');
  const ls = parseFloat(node.getAttribute('letter-spacing') || '0');
  let w = 0;
  try {
    w = node.getComputedTextLength();
  } catch {
    return;
  }
  if (!w || w <= max) return;
  const k = max / w;
  node.setAttribute('font-size', (fs * k).toFixed(2));
  node.setAttribute('letter-spacing', (ls * k).toFixed(2));
}

export function AegisCore({
  activity,
  detail,
  size = 260,
  className = '',
  label,
}: {
  activity: SystemActivity;
  /** one line of live context; falls back to the state's own subtitle */
  detail?: string;
  size?: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const detailRef = useRef(detail);
  detailRef.current = detail;

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const uid = `a${Math.random().toString(36).slice(2, 7)}`;

    const defs = svgEl('defs');
    const cg = svgEl('radialGradient', { id: `${uid}c` });
    cg.append(
      svgEl('stop', { offset: '0%', 'stop-color': '#eafcff' }),
      svgEl('stop', { offset: '40%', 'stop-color': '#6fdcee', 'stop-opacity': '.45' }),
      svgEl('stop', { offset: '100%', 'stop-color': '#2aa8c8', 'stop-opacity': '0' }),
    );
    defs.append(cg, glowFilter(`${uid}g`, 0.6, 3));
    svg.append(defs);

    const haze = svgEl('circle', { cx: CX, cy: CY, r: 96, fill: `url(#${uid}c)`, opacity: 0.35 });
    svg.append(haze);
    const ring = svgEl('g', { filter: `url(#${uid}g)` });
    svg.append(ring);

    const parts: Array<{ el: SVGGElement; sp: number }> = [];

    // fine tick ring — every tenth tick is a major
    const g1 = svgEl('g');
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * 6.283;
      const maj = i % 10 === 0;
      const r1 = 96;
      const r2 = 96 + (maj ? 10 : 4);
      const l = svgEl('line', {
        x1: (CX + r1 * Math.cos(a)).toFixed(1), y1: (CY + r1 * Math.sin(a)).toFixed(1),
        x2: (CX + r2 * Math.cos(a)).toFixed(1), y2: (CY + r2 * Math.sin(a)).toFixed(1),
        'stroke-width': maj ? 1.1 : 0.45, opacity: maj ? 0.8 : 0.32,
      });
      l.classList.add('aInk');
      g1.append(l);
    }
    ring.append(g1);
    parts.push({ el: g1, sp: -6 });

    // segmented arc ring
    const g2 = svgEl('g');
    for (let i = 0; i < 14; i++) {
      const a0 = (i / 14) * 6.283 + 0.05;
      const a1 = ((i + 1) / 14) * 6.283 - 0.05;
      const r = 80;
      const p = svgEl('path', {
        d: `M${(CX + r * Math.cos(a0)).toFixed(1)} ${(CY + r * Math.sin(a0)).toFixed(1)} A${r} ${r} 0 0 1 ${(CX + r * Math.cos(a1)).toFixed(1)} ${(CY + r * Math.sin(a1)).toFixed(1)}`,
        fill: 'none', 'stroke-width': i % 3 === 0 ? 4.5 : 2, 'stroke-linecap': 'round',
        opacity: i % 3 === 0 ? 0.92 : 0.45,
      });
      p.classList.add('aInk');
      g2.append(p);
    }
    ring.append(g2);
    parts.push({ el: g2, sp: 14 });

    // inner hairline arcs, counter-rotating
    const g3 = svgEl('g');
    ([[64, 0.9, 2.4], [52, 1.9, 1.2]] as Array<[number, number, number]>).forEach(([r, gap, w], idx) => {
      const p = svgEl('path', {
        d: `M${(CX + r * Math.cos(gap)).toFixed(1)} ${(CY + r * Math.sin(gap)).toFixed(1)} A${r} ${r} 0 1 1 ${(CX + r * Math.cos(6.283 - gap)).toFixed(1)} ${(CY + r * Math.sin(6.283 - gap)).toFixed(1)}`,
        fill: 'none', 'stroke-width': w, 'stroke-linecap': 'round', opacity: idx ? 0.5 : 0.85,
      });
      p.classList.add('aInk');
      g3.append(p);
    });
    ring.append(g3);
    parts.push({ el: g3, sp: -22 });

    // the one warm accent, so the ring has a heading you can read at a glance
    const g4 = svgEl('g');
    const acc = svgEl('path', {
      d: `M${CX - 88} ${CY} A88 88 0 0 1 ${(CX - 88 * Math.cos(1.1)).toFixed(1)} ${(CY - 88 * Math.sin(1.1)).toFixed(1)}`,
      fill: 'none', stroke: '#ffc244', 'stroke-width': 2.6, 'stroke-linecap': 'round',
    });
    g4.append(acc);
    ring.append(g4);
    parts.push({ el: g4, sp: 9 });

    // readout plate keeps the copy legible where it crosses the ring glow
    // fill comes from CSS so the plate can invert with the theme — a black
    // slab behind the readout is correct on dark and wrong on white
    const plate = svgEl('ellipse', { cx: CX, cy: 134, rx: 80, ry: 52, class: 'aPlate', opacity: 0.6 });
    svg.append(plate);

    const wave = svgEl('g');
    const bars: SVGRectElement[] = [];
    for (let i = 0; i < 26; i++) {
      const r = svgEl('rect', { x: (CX - 52 + i * 4).toFixed(1), width: 2, rx: 1, fill: '#8fe9fb' });
      wave.append(r);
      bars.push(r);
    }
    svg.append(wave);

    const txt = (y: number, fs: number, ls: number, fill: string) =>
      svgEl('text', {
        x: CX, y, 'text-anchor': 'middle',
        'font-family': 'ui-monospace,"Cascadia Mono",Menlo,monospace',
        'font-size': fs, 'letter-spacing': ls, fill,
      });
    const name = txt(134, 20, 6, '#dffaff');
    name.textContent = 'AEGIS';
    const main = txt(132, 15, 3.5, '#dffaff');
    main.setAttribute('opacity', '0');
    const sub = txt(150, 9.5, 2, '#6fc7dd');
    sub.setAttribute('opacity', '0');
    svg.append(name, main, sub);

    const reduced = prefersReducedMotion();
    let raf = 0;
    let t = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduced) t += dt;

      const key = activityRef.current;
      const A = AEGIS[key] ?? AEGIS.idle;
      const idle = key === 'idle';
      const alert = key === 'blocked' || key === 'failed';

      parts.forEach((p) =>
        p.el.setAttribute('transform', `rotate(${((t * p.sp * A.spin * 0.5) % 360).toFixed(1)} ${CX} ${CY})`),
      );
      ring.querySelectorAll('.aInk').forEach((e) => e.setAttribute('stroke', A.col));
      haze.setAttribute('opacity', (0.3 + 0.16 * Math.sin(t * 1.4)).toFixed(2));
      acc.setAttribute('stroke', alert ? '#ff6b6b' : '#ffc244');

      name.setAttribute('y', String(idle ? 138 : 100));
      name.setAttribute('font-size', String(idle ? 20 : 9.5));
      name.setAttribute('letter-spacing', String(idle ? 6 : 4.5));
      name.setAttribute('fill', idle ? A.col : A.sub2);
      name.setAttribute('opacity', idle ? (0.82 + 0.18 * Math.sin(t * 1.1)).toFixed(2) : '0.55');
      main.setAttribute('opacity', idle ? '0' : '1');
      sub.setAttribute('opacity', idle ? '0' : '0.9');
      main.setAttribute('y', String(alert ? 131 : 130));
      main.setAttribute('font-size', String(alert ? 17 : 15));
      main.setAttribute('letter-spacing', String(alert ? 4 : 3.5));
      sub.setAttribute('y', String(alert ? 151 : 149));
      sub.setAttribute('font-size', String(alert ? 10 : 9.5));
      sub.setAttribute('letter-spacing', '2');
      main.textContent = idle ? '' : A.main;
      sub.textContent = idle ? '' : (detailRef.current || A.sub).toUpperCase();
      main.setAttribute('fill', A.col);
      sub.setAttribute('fill', A.sub2);
      fit(main, idle ? 148 : 122);
      fit(sub, 112);
      fit(name, idle ? 152 : 104);
      plate.setAttribute('opacity', idle ? '0.44' : '0.66');
      plate.setAttribute('ry', String(idle ? 34 : 52));

      bars.forEach((r, i) => {
        let h = 2;
        if (key === 'active') h = 3 + ((i + Math.floor(t * 9)) % 7 === 0 ? 11 : 1);
        else if (key === 'busy') h = 3 + Math.abs(Math.sin(t * 5 + i)) * 5;
        else if (alert) h = Math.sin(t * 3) > 0 ? 11 : 2;
        r.setAttribute('height', h.toFixed(1));
        r.setAttribute('y', (172 - h / 2).toFixed(1));
        r.setAttribute('fill', alert ? '#ff6b6b' : A.col);
        r.setAttribute('opacity', idle ? '0' : '0.85');
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
  }, []);

  return (
    <svg
      ref={ref}
      className={`nexus-core ${activity} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 260 260"
      role="img"
      aria-label={label ? `Intelligence core: ${label}` : 'Intelligence core'}
    />
  );
}
