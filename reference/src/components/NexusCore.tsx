import { useEffect, useRef } from 'react';
import type { SystemActivity } from '../lib/ambient';

/**
 * NEXUS — the live intelligence core.
 *
 * A wireframe data sphere whose colour, motion character and bristle extension
 * are all bound to what the system is actually doing. The brand-blue family
 * covers every normal state so that the amber "needs you" flip is the loudest
 * signal on screen: you read the state from colour alone, before any text.
 *
 * Built imperatively inside one <svg> and driven by a rAF loop rather than
 * React state — a 60fps animation should never trigger a reconcile.
 */

type Visual = {
  /** primary stroke for the longitude rings and the bulk of the bristles */
  col: string;
  /** highlight stroke for the ~25% of bristles flagged bright, and the core */
  bright: string;
  /** rotation rate multiplier */
  spin: number;
  /** how far the bristles reach past the shell (0 = fully retracted) */
  extend: number;
  /** positional noise, used only for high activity */
  jitter: number;
  /** true = rotation freezes and every bristle blinks in unison */
  stall: boolean;
};

export const NEXUS_VISUAL: Record<SystemActivity, Visual> = {
  idle: { col: '#2d6ea8', bright: '#68a6d8', spin: 0.5, extend: 0.55, jitter: 0, stall: false },
  active: { col: '#3d94ee', bright: '#dcefff', spin: 3.2, extend: 1.0, jitter: 0, stall: false },
  busy: { col: '#9a9cf0', bright: '#ffffff', spin: 5.0, extend: 1.15, jitter: 1.8, stall: false },
  blocked: { col: '#ff7a1e', bright: '#ffd7a0', spin: 0, extend: 0.5, jitter: 0, stall: true },
  failed: { col: '#ff4d4d', bright: '#ffc0c0', spin: 0, extend: 0.35, jitter: 0, stall: true },
};

const NS = 'http://www.w3.org/2000/svg';
const CX = 130;
const CY = 128;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** deterministic PRNG so the sphere looks identical on every mount */
export function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

export function mixHex(hex: string, other: string, amt: number) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex);
  const b = p(other);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amt).toString(16).padStart(2, '0')).join('')}`;
}

/** a tight bloom for definition plus a wide one for atmosphere */
export function glowFilter(id: string, tight = 0.7, wide = 3.4) {
  const f = svgEl('filter', { id, x: '-140%', y: '-140%', width: '380%', height: '380%' });
  f.append(
    svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: tight, result: 'tight' }),
    svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: wide, result: 'wide' }),
  );
  const m = svgEl('feMerge');
  m.append(
    svgEl('feMergeNode', { in: 'wide' }),
    svgEl('feMergeNode', { in: 'tight' }),
    svgEl('feMergeNode', { in: 'SourceGraphic' }),
  );
  f.append(m);
  return f;
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function NexusCore({
  activity,
  size = 260,
  className = '',
  label,
}: {
  activity: SystemActivity;
  size?: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const activityRef = useRef(activity);
  activityRef.current = activity;

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const uid = `n${Math.random().toString(36).slice(2, 7)}`;

    const defs = svgEl('defs');
    const haze = svgEl('radialGradient', { id: `${uid}h` });
    const hz0 = svgEl('stop', { offset: '0%', 'stop-color': '#3d94ee', 'stop-opacity': '.34' });
    const hz1 = svgEl('stop', { offset: '100%', 'stop-color': '#2d6ea8', 'stop-opacity': '0' });
    haze.append(hz0, hz1);
    const coreGrad = svgEl('radialGradient', { id: `${uid}c` });
    const cn = [
      svgEl('stop', { offset: '0%', 'stop-color': '#ffffff' }),
      svgEl('stop', { offset: '18%', 'stop-color': '#eaf6ff' }),
      svgEl('stop', { offset: '42%', 'stop-color': '#9fd0ff' }),
      svgEl('stop', { offset: '74%', 'stop-color': '#2d6ea8', 'stop-opacity': '.5' }),
      svgEl('stop', { offset: '100%', 'stop-color': '#123a63', 'stop-opacity': '0' }),
    ];
    coreGrad.append(...cn);
    // turbulence for the plasma shell — this is what stops the nucleus reading
    // as a flat lit ball and makes it read as contained energy
    const turb = svgEl('filter', { id: `${uid}p`, x: '-60%', y: '-60%', width: '220%', height: '220%' });
    const fe = svgEl('feTurbulence', {
      type: 'fractalNoise', baseFrequency: '0.035', numOctaves: 2, seed: 3, result: 'noise',
    });
    turb.append(
      fe,
      svgEl('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'noise', scale: 5, xChannelSelector: 'R', yChannelSelector: 'G',
      }),
      svgEl('feGaussianBlur', { stdDeviation: '1.15' }),
    );
    defs.append(haze, coreGrad, glowFilter(`${uid}g`), turb);
    svg.append(defs);

    svg.append(svgEl('circle', { cx: CX, cy: CY, r: 106, fill: `url(#${uid}h)` }));
    const host = svgEl('g', { filter: `url(#${uid}g)` });
    svg.append(host);
    const bang = svgEl('g', { opacity: 0 });
    bang.append(
      svgEl('path', {
        d: 'M130 92 v34 M130 138 v6',
        stroke: '#ffb04d',
        'stroke-width': 7,
        'stroke-linecap': 'round',
      }),
    );
    svg.append(bang);
    const atmo = svgEl('circle', {
      cx: CX, cy: CY, r: 88, fill: 'none', stroke: '#8fc8ff', 'stroke-width': 0.5, opacity: 0.22,
    });
    svg.append(atmo);
    const orb = svgEl('circle', { cx: CX, cy: CY, r: 30, fill: `url(#${uid}c)` });
    svg.append(orb);

    // The nucleus is contained energy: displaced plasma shells and filaments
    // turning over a hot white centre.
    const plasma = svgEl('g', { filter: `url(#${uid}p)` });
    const shells: SVGCircleElement[] = [];
    for (let i = 0; i < 3; i++) {
      const e = svgEl('circle', {
        cx: CX, cy: CY, fill: 'none', 'stroke-width': (1.6 - i * 0.45).toFixed(2),
      });
      plasma.append(e);
      shells.push(e);
    }
    const filaments: SVGEllipseElement[] = [];
    for (let i = 0; i < 4; i++) {
      const e = svgEl('ellipse', { cx: CX, cy: CY, fill: 'none', 'stroke-width': 0.9 });
      plasma.append(e);
      filaments.push(e);
    }
    svg.append(plasma);

    const bloom = svgEl('circle', {
      cx: CX, cy: CY, r: 18, fill: '#ffffff', opacity: 0.18, filter: `url(#${uid}g)`,
    });
    const nucleus = svgEl('circle', {
      cx: CX, cy: CY, r: 9, fill: '#ffffff', filter: `url(#${uid}g)`,
    });
    svg.append(bloom, nucleus);

    const rnd = seeded(42);
    const rings: Array<{ el: SVGEllipseElement; ry0: number; ph: number; sp: number; base: number }> = [];
    const sparks: Array<{
      el: SVGLineElement; a: number; r0: number; len: number; sq: number;
      bright: boolean; base: number; ph: number; sp: number;
    }> = [];

    // 20 longitude rings at mixed weights. Each oscillates its ry through zero
    // and fades as it turns edge-on, which is what sells the sphere.
    for (let i = 0; i < 20; i++) {
      const e = svgEl('ellipse', {
        cx: CX, cy: CY, rx: 84, fill: 'none',
        'stroke-width': (i % 5 === 0 ? 1.05 : 0.5 + rnd() * 0.3).toFixed(2),
      });
      host.append(e);
      rings.push({ el: e, ry0: 84, ph: rnd() * 6.28, sp: 0.3 + rnd() * 0.5, base: 0.12 + rnd() * 0.42 });
    }
    // 190 fine radial bristles. Their length is the load indicator.
    for (let i = 0; i < 190; i++) {
      const a = rnd() * 6.283;
      const e = svgEl('line', {
        'stroke-linecap': 'round',
        'stroke-width': (0.35 + rnd() * 0.75).toFixed(2),
      });
      host.append(e);
      sparks.push({
        el: e, a, r0: 56 + rnd() * 30, len: 6 + rnd() * 34,
        sq: 0.55 + 0.45 * Math.abs(Math.sin(a * 2)),
        bright: rnd() > 0.75, base: 0.22 + rnd() * 0.58,
        ph: rnd() * 6.28, sp: 0.6 + rnd() * 2.6,
      });
    }

    const reduced = prefersReducedMotion();
    let raf = 0;
    let t = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduced) t += dt;
      const S = NEXUS_VISUAL[activityRef.current] ?? NEXUS_VISUAL.idle;

      for (const p of sparks) {
        const L = p.len * S.extend;
        p.el.setAttribute('x1', (CX + p.r0 * Math.cos(p.a)).toFixed(1));
        p.el.setAttribute('y1', (CY + p.r0 * Math.sin(p.a) * p.sq).toFixed(1));
        p.el.setAttribute('x2', (CX + (p.r0 + L) * Math.cos(p.a)).toFixed(1));
        p.el.setAttribute('y2', (CY + (p.r0 + L) * Math.sin(p.a) * p.sq).toFixed(1));
        p.el.setAttribute('stroke', p.bright ? S.bright : S.col);
        p.el.setAttribute(
          'opacity',
          (S.stall
            ? Math.sin(t * 5) > 0 ? 0.95 : 0.12
            : p.base * (0.35 + 0.65 * Math.abs(Math.sin(t * p.sp * S.spin * 0.5 + p.ph)))
          ).toFixed(2),
        );
      }
      for (const r of rings) {
        if (!S.stall) r.ph += r.sp * S.spin * 0.032;
        const c = Math.abs(Math.cos(r.ph));
        r.el.setAttribute('stroke', S.col);
        r.el.setAttribute('ry', Math.max(1.2, c * r.ry0).toFixed(1));
        r.el.setAttribute('opacity', (r.base * (0.35 + 0.65 * c)).toFixed(2));
      }

      const jit = S.jitter ? (Math.sin(t * 37) + Math.sin(t * 53)) * S.jitter * 0.5 : 0;
      host.setAttribute(
        'transform',
        `rotate(${(S.stall ? 0 : (t * 4 * S.spin) % 360).toFixed(1)} ${CX} ${CY}) translate(${jit.toFixed(1)} ${jit.toFixed(1)})`,
      );

      cn[2].setAttribute('stop-color', S.bright);
      cn[3].setAttribute('stop-color', S.col);
      cn[4].setAttribute('stop-color', mixHex(S.col, '#000018', 0.55));
      hz0.setAttribute('stop-color', S.bright);
      hz1.setAttribute('stop-color', S.col);
      atmo.setAttribute('stroke', S.bright);

      const r = 30 + Math.sin(t * S.spin * 1.6) * 4;
      orb.setAttribute('r', r.toFixed(1));

      // the plasma churns: shells breathing out of phase, filaments turning
      fe.setAttribute('seed', String(Math.floor(t * 2.2) % 97));
      fe.setAttribute('baseFrequency', (0.028 + 0.014 * Math.abs(Math.sin(t * 0.55))).toFixed(4));
      shells.forEach((e, i) => {
        e.setAttribute('r', (r * (0.86 - i * 0.2) + Math.sin(t * (1.4 + i) * S.spin * 0.5) * 1.6).toFixed(2));
        e.setAttribute('stroke', i === 0 ? S.bright : mixHex(S.bright, S.col, 0.5));
        e.setAttribute('opacity', (0.34 - i * 0.07 + 0.14 * Math.sin(t * (2 + i))).toFixed(2));
      });
      filaments.forEach((e, i) => {
        const ph = t * S.spin * (0.5 + i * 0.22) + i * 1.7;
        e.setAttribute('rx', (r * 0.8).toFixed(2));
        e.setAttribute('ry', Math.max(0.8, Math.abs(Math.cos(ph)) * r * 0.8).toFixed(2));
        e.setAttribute('transform', `rotate(${((i * 45 + t * 12 * S.spin) % 360).toFixed(1)} ${CX} ${CY})`);
        e.setAttribute('stroke', S.bright);
        e.setAttribute('opacity', (0.14 + 0.3 * Math.abs(Math.cos(ph))).toFixed(2));
      });
      nucleus.setAttribute('r', (r * 0.32 + Math.sin(t * 3.1) * 0.8).toFixed(2));
      nucleus.setAttribute('opacity', (0.86 + 0.14 * Math.sin(t * 2.6)).toFixed(2));
      bloom.setAttribute('r', (r * 0.68 + Math.sin(t * 1.7) * 2).toFixed(2));
      bloom.setAttribute('fill', S.bright);
      bloom.setAttribute('opacity', (0.16 + 0.08 * Math.sin(t * 2.2)).toFixed(2));
      bang.setAttribute(
        'opacity',
        S.stall ? (0.55 + 0.45 * Math.abs(Math.sin(t * 3))).toFixed(2) : '0',
      );

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
