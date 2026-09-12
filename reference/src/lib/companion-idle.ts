import type { SystemActivity } from './ambient';

export type CompanionPose = 'idle' | 'watch' | 'scratch' | 'wave' | 'rest';

export interface CompanionPoseState {
  pose: CompanionPose;
  poseUntil: number;
  nextGestureAt: number;
  sequence: number;
}

export interface CompanionPoseInput {
  now: number;
  lastInteractionAt: number;
  activity: SystemActivity;
  dragging: boolean;
  suppressed: boolean;
  reducedMotion: boolean;
}

export const INITIAL_COMPANION_POSE: Readonly<CompanionPoseState> = {
  pose: 'idle',
  poseUntil: 0,
  nextGestureAt: 0,
  sequence: 0,
};

const durations: Record<Exclude<CompanionPose, 'idle'>, number> = {
  watch: 3_400,
  scratch: 2_900,
  wave: 2_600,
  rest: 5_200,
};

/** Deterministic, quiet idle direction: no random timers and no gesture spam. */
export function advanceCompanionPose(
  state: Readonly<CompanionPoseState>,
  input: Readonly<CompanionPoseInput>,
): CompanionPoseState {
  const unavailable = input.reducedMotion || input.dragging || input.suppressed || input.activity !== 'idle';
  if (unavailable) {
    return state.pose === 'idle' ? { ...state, nextGestureAt: Math.max(state.nextGestureAt, input.now + 30_000) }
      : { ...state, pose: 'idle', poseUntil: 0, nextGestureAt: input.now + 45_000 };
  }

  if (state.pose !== 'idle') {
    return input.now < state.poseUntil ? { ...state } : { ...state, pose: 'idle', poseUntil: 0 };
  }

  const idleFor = input.now - input.lastInteractionAt;
  if (idleFor < 30_000 || input.now < state.nextGestureAt) return { ...state };

  const ordinary: Array<Exclude<CompanionPose, 'idle' | 'rest'>> = ['watch', 'scratch', 'wave'];
  const pose: Exclude<CompanionPose, 'idle'> = idleFor >= 180_000 && state.sequence % 4 === 3
    ? 'rest'
    : ordinary[state.sequence % ordinary.length];
  return {
    pose,
    poseUntil: input.now + durations[pose],
    nextGestureAt: input.now + 45_000 + (state.sequence % 4) * 7_000,
    sequence: state.sequence + 1,
  };
}
