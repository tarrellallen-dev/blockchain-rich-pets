import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prefs = require('../dist/test/companion/companion.cjs');
const motion = require('../dist/test/companion/companion-motion.cjs');
const idle = require('../dist/test/companion/companion-idle.cjs');
const animation = require('../dist/test/companion/companion-animation.cjs');

test('all original companion skins remain and Prodigy is additive', () => {
  assert.deepEqual(prefs.COMPANION_SKINS, [
    'kavalier', 'nexus', 'aegis', 'prodigy', 'blockchain-dreads', 'blockchain-waves',
  ]);
});

test('a one-field patch cannot erase unrelated preferences', () => {
  const before = prefs.normalizeCompanionPreferences({
    skin: 'nexus', accent: '#6fdcee', scale: 'large', alerts: true, commandLine: false,
  });
  const patch = prefs.sanitizeCompanionPatch({
    alerts: false, skin: undefined, accent: undefined, scale: undefined, commandLine: undefined,
  });
  const after = { ...before, ...patch };
  assert.equal(after.alerts, false);
  assert.equal(after.skin, 'nexus');
  assert.equal(after.accent, '#6fdcee');
  assert.equal(after.scale, 'large');
  assert.equal(after.commandLine, false);
});

test('invalid runtime values cannot make the companion invisible or unbounded', () => {
  const normalized = prefs.normalizeCompanionPreferences({
    skin: 'missing-skin', scale: 'enormous', accent: 'url(javascript:bad)', x: Infinity, y: NaN,
  });
  assert.equal(normalized.skin, 'kavalier');
  assert.equal(normalized.scale, 'medium');
  assert.equal(normalized.accent, '#a294ee');
  assert.equal(normalized.x, undefined);
  assert.equal(normalized.y, undefined);
});

test('drag response is smooth, finite, and bounded under hostile deltas', () => {
  let state = motion.NEUTRAL_COMPANION_MOTION;
  for (let i = 0; i < 30; i += 1) {
    state = motion.deriveCompanionDragMotion(1e9, -1e9, state);
    assert.ok(Number.isFinite(state.x));
    assert.ok(Number.isFinite(state.y));
    assert.ok(Math.abs(state.x) <= 11);
    assert.ok(Math.abs(state.y) <= 7);
    assert.ok(Math.abs(state.rotate) <= 5.5);
    assert.ok(state.scaleX >= 1 && state.scaleX <= 1.035);
    assert.ok(state.scaleY >= 0.972 && state.scaleY <= 1);
  }
  assert.match(motion.companionMotionTransform(state), /^translate3d\(.+\) rotate\(.+\) scale\(.+\)$/);
});

test('reduced-motion preference keeps drag artwork neutral', () => {
  assert.deepEqual(
    motion.deriveCompanionDragMotion(100, -100, { x: 8, y: 4, rotate: 3, scaleX: 1.02, scaleY: 0.98 }, true),
    motion.NEUTRAL_COMPANION_MOTION,
  );
});

test('drag direction covers both axes without inventing diagonal states', () => {
  assert.equal(motion.companionDirection(12, 2), 'right');
  assert.equal(motion.companionDirection(-12, 2), 'left');
  assert.equal(motion.companionDirection(1, -12), 'up');
  assert.equal(motion.companionDirection(1, 12), 'down');
  assert.equal(motion.companionDirection(0.2, 0.2), 'still');
  assert.equal(motion.companionDirection(8, 9, 1.5, 'right'), 'right');
  assert.equal(motion.companionDirection(4, 12, 1.5, 'right'), 'down');
});

test('fall motion cancels as soon as the user drags upward', () => {
  assert.equal(motion.nextCompanionFalling(false, 'down', 650), true);
  assert.equal(motion.nextCompanionFalling(true, 'down', 220), true);
  assert.equal(motion.nextCompanionFalling(true, 'up', -10), false);
  assert.equal(motion.nextCompanionFalling(true, 'still', -180), false);
  assert.equal(motion.nextCompanionFalling(true, 'down', 0), false);
  assert.equal(motion.nextCompanionFalling(true, 'down', Number.NaN), false);
});

test('idle gestures wait, cool down, include rest, and fail closed for motion', () => {
  const base = { ...idle.INITIAL_COMPANION_POSE };
  const input = {
    now: 29_999,
    lastInteractionAt: 0,
    activity: 'idle',
    dragging: false,
    suppressed: false,
    reducedMotion: false,
  };
  assert.equal(idle.advanceCompanionPose(base, input).pose, 'idle');

  const watch = idle.advanceCompanionPose(base, { ...input, now: 30_000 });
  assert.equal(watch.pose, 'watch');
  assert.ok(watch.poseUntil > 30_000);
  assert.ok(watch.nextGestureAt >= 75_000);
  assert.equal(idle.advanceCompanionPose(watch, { ...input, now: 31_000 }).pose, 'watch');
  assert.equal(idle.advanceCompanionPose(watch, { ...input, now: watch.poseUntil }).pose, 'idle');

  const rest = idle.advanceCompanionPose(
    { ...base, sequence: 3 },
    { ...input, now: 180_000 },
  );
  assert.equal(rest.pose, 'rest');
  assert.equal(idle.advanceCompanionPose(rest, { ...input, now: 181_000, dragging: true }).pose, 'idle');
  assert.equal(idle.advanceCompanionPose(base, { ...input, now: 180_000, reducedMotion: true }).pose, 'idle');
});

test('authored companion gestures have anticipation, action, recovery and bounded cadence', () => {
  for (const [pose, beats] of Object.entries(animation.COMPANION_FRAME_SEQUENCES)) {
    assert.equal(beats[0].frame, 0, `${pose} must begin from anticipation`);
    assert.equal(beats.at(-1).frame, 3, `${pose} must finish on recovery`);
    assert.ok(beats.some((beat) => beat.frame === 1), `${pose} must contain an in-between`);
    assert.ok(beats.some((beat) => beat.frame === 2), `${pose} must contain an action pose`);
    assert.ok(beats.every((beat) => beat.holdMs >= 80), `${pose} contains an unreadably fast frame`);
    assert.ok(beats.every((beat) => beat.holdMs <= 1_650), `${pose} contains an accidental stall`);
  }
});

test('blink intervals are varied, bounded and robust to bad random input', () => {
  assert.equal(animation.companionBlinkDelay(0), 3_200);
  assert.equal(animation.companionBlinkDelay(1), 7_000);
  assert.equal(animation.companionBlinkDelay(-4), 3_200);
  assert.equal(animation.companionBlinkDelay(9), 7_000);
  assert.equal(animation.companionBlinkDelay(Number.NaN), 5_100);
});

test('six-frame gestures use every authored in-between and recovery frame', () => {
  for (const pose of ['watch', 'wave', 'rest']) {
    const sequence = animation.companionFrameSequence(pose, 6);
    assert.deepEqual([...new Set(sequence.map((beat) => beat.frame))], [0, 1, 2, 3, 4, 5]);
  }
  assert.equal(animation.companionFrameSequence('scratch', 4).at(-1).frame, 3);
});

test('startup visibility cannot strand the user with no companion and no dashboard', () => {
  const hiddenForNow = prefs.normalizeCompanionPreferences({ enabled: false, openAtLogin: true });
  assert.equal(prefs.shouldBootCompanion(hiddenForNow, false), false);
  assert.equal(
    prefs.shouldBootCompanion(hiddenForNow, true),
    true,
    'Start with Windows remains authoritative on the next login',
  );
  assert.equal(prefs.shouldShowDashboard(true, false), true);
  assert.equal(prefs.shouldShowDashboard(true, true), false);
  assert.equal(prefs.shouldShowDashboard(false, false), true);
});

test('transparent canvas can leave the display while the visible avatar reaches both edges', () => {
  assert.deepEqual(prefs.companionHorizontalRange(0, 1920, 440, 190), { min: -125, max: 1605 });
  assert.deepEqual(prefs.companionHorizontalRange(-1920, 1920, 520, 240), { min: -2060, max: -380 });
  assert.deepEqual(prefs.companionHorizontalRange(0, 300, 200, 240), { min: 0, max: 100 });
});

test('dragging follows the cursor when crossing displays', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('electron/companion.ts', 'utf8'));
  assert.match(source, /clamp\(p\.x - grab\.dx, p\.y - grab\.dy, p\)/);
  assert.match(source, /getDisplayNearestPoint\(\{ x: Math\.round\(anchor\.x\), y: Math\.round\(anchor\.y\) \}\)/);
});
