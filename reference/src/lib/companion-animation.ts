import type { CompanionPose } from './companion-idle';

export interface CompanionFrameBeat {
  frame: number;
  holdMs: number;
}

export const COMPANION_FRAME_SEQUENCES: Record<Exclude<CompanionPose, 'idle'>, CompanionFrameBeat[]> = {
  watch: [
    { frame: 0, holdMs: 120 }, { frame: 1, holdMs: 110 }, { frame: 2, holdMs: 340 },
    { frame: 1, holdMs: 100 }, { frame: 2, holdMs: 260 }, { frame: 3, holdMs: 220 },
  ],
  scratch: [
    { frame: 0, holdMs: 120 }, { frame: 1, holdMs: 90 }, { frame: 2, holdMs: 100 },
    { frame: 1, holdMs: 90 }, { frame: 2, holdMs: 100 }, { frame: 1, holdMs: 90 },
    { frame: 3, holdMs: 220 },
  ],
  wave: [
    { frame: 0, holdMs: 100 }, { frame: 1, holdMs: 100 }, { frame: 2, holdMs: 120 },
    { frame: 1, holdMs: 100 }, { frame: 2, holdMs: 120 }, { frame: 1, holdMs: 100 },
    { frame: 3, holdMs: 220 },
  ],
  rest: [
    { frame: 0, holdMs: 160 }, { frame: 1, holdMs: 180 }, { frame: 2, holdMs: 1_650 },
    { frame: 3, holdMs: 260 },
  ],
};

const SIX_FRAME_SEQUENCES: Partial<Record<Exclude<CompanionPose, 'idle'>, CompanionFrameBeat[]>> = {
  watch: [
    { frame: 0, holdMs: 110 }, { frame: 1, holdMs: 100 }, { frame: 2, holdMs: 110 },
    { frame: 3, holdMs: 300 }, { frame: 4, holdMs: 120 }, { frame: 5, holdMs: 220 },
  ],
  wave: [
    { frame: 0, holdMs: 100 }, { frame: 1, holdMs: 100 }, { frame: 2, holdMs: 110 },
    { frame: 3, holdMs: 140 }, { frame: 4, holdMs: 110 }, { frame: 5, holdMs: 220 },
  ],
  rest: [
    { frame: 0, holdMs: 150 }, { frame: 1, holdMs: 150 }, { frame: 2, holdMs: 170 },
    { frame: 3, holdMs: 1_450 }, { frame: 4, holdMs: 170 }, { frame: 5, holdMs: 240 },
  ],
};

export function companionFrameSequence(
  pose: Exclude<CompanionPose, 'idle'>,
  frameCount: number,
): CompanionFrameBeat[] {
  return frameCount >= 6 && SIX_FRAME_SEQUENCES[pose]
    ? SIX_FRAME_SEQUENCES[pose]!
    : COMPANION_FRAME_SEQUENCES[pose];
}

export function companionBlinkDelay(random: number): number {
  const normalized = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
  return 3_200 + Math.round(normalized * 3_800);
}
