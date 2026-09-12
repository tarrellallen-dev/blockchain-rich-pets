export interface CompanionDragMotion {
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
}

export const NEUTRAL_COMPANION_MOTION: Readonly<CompanionDragMotion> = {
  x: 0,
  y: 0,
  rotate: 0,
  scaleX: 1,
  scaleY: 1,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));

/**
 * Turns pointer velocity into a small, bounded sense of weight.
 * The desktop window still follows the real cursor in the main process; this
 * only animates the artwork inside it, so it cannot affect placement safety.
 */
export function deriveCompanionDragMotion(
  dx: number,
  dy: number,
  previous: Readonly<CompanionDragMotion> = NEUTRAL_COMPANION_MOTION,
  reducedMotion = false,
): CompanionDragMotion {
  if (reducedMotion) return { ...NEUTRAL_COMPANION_MOTION };

  const speed = Math.min(1, Math.hypot(dx, dy) / 28);
  const target: CompanionDragMotion = {
    x: clamp(dx * 0.5, -11, 11),
    y: clamp(dy * 0.3, -7, 7),
    rotate: clamp(dx * 0.22, -5.5, 5.5),
    scaleX: 1 + speed * 0.035,
    scaleY: 1 - speed * 0.028,
  };
  const ease = 0.42;

  return {
    x: previous.x + (target.x - previous.x) * ease,
    y: previous.y + (target.y - previous.y) * ease,
    rotate: previous.rotate + (target.rotate - previous.rotate) * ease,
    scaleX: previous.scaleX + (target.scaleX - previous.scaleX) * ease,
    scaleY: previous.scaleY + (target.scaleY - previous.scaleY) * ease,
  };
}

export function companionMotionTransform(motion: Readonly<CompanionDragMotion>): string {
  return `translate3d(${motion.x.toFixed(2)}px, ${motion.y.toFixed(2)}px, 0) rotate(${motion.rotate.toFixed(2)}deg) scale(${motion.scaleX.toFixed(4)}, ${motion.scaleY.toFixed(4)})`;
}

export type CompanionDirection = 'still' | 'left' | 'right' | 'up' | 'down';

/**
 * The fall pose is momentary, not a latch. A fast downward pull starts it, but
 * reversing upward must release it immediately or the artwork appears to sink
 * while the desktop window is actually following the cursor correctly.
 */
export function nextCompanionFalling(
  falling: boolean,
  direction: CompanionDirection,
  velocityY: number,
): boolean {
  if (!Number.isFinite(velocityY)) return false;
  if (direction === 'up' || velocityY < -120) return false;
  if (direction !== 'down') return falling;
  return velocityY > 500 || (falling && velocityY > 80);
}

export function companionDirection(
  dx: number,
  dy: number,
  deadZone = 1.5,
  previous: CompanionDirection = 'still',
): CompanionDirection {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < deadZone) return 'still';
  if ((previous === 'left' || previous === 'right') && Math.abs(dy) < Math.abs(dx) * 1.35) {
    return dx < 0 ? 'left' : 'right';
  }
  if ((previous === 'up' || previous === 'down') && Math.abs(dx) < Math.abs(dy) * 1.35) {
    return dy < 0 ? 'up' : 'down';
  }
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}
