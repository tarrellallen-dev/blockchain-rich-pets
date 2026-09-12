import type { CompanionSkin } from '../lib/api';
import type { CompanionPose } from '../lib/companion-idle';
import prodigyIdle from '../assets/companion/prodigy-penguin-app-pet.png';
import prodigyWatch from '../assets/companion/prodigy-watch.png';
import prodigyScratch from '../assets/companion/prodigy-scratch.png';
import prodigyWave from '../assets/companion/prodigy-wave.png';
import prodigyRest from '../assets/companion/prodigy-rest.png';
import dreadsIdle from '../assets/companion/blockchain-dreads-penguin.png';
import dreadsWatch from '../assets/companion/blockchain-dreads-watch.png';
import dreadsScratch from '../assets/companion/blockchain-dreads-scratch.png';
import dreadsWave from '../assets/companion/blockchain-dreads-wave.png';
import dreadsRest from '../assets/companion/blockchain-dreads-rest.png';
import wavesIdle from '../assets/companion/blockchain-waves-penguin.png';
import wavesWatch from '../assets/companion/blockchain-waves-watch.png';
import wavesScratch from '../assets/companion/blockchain-waves-scratch.png';
import wavesWave from '../assets/companion/blockchain-waves-wave.png';
import wavesRest from '../assets/companion/blockchain-waves-rest.png';

export type RasterCompanionSkin = Extract<CompanionSkin, 'prodigy' | 'blockchain-dreads' | 'blockchain-waves'>;

interface RasterCompanionDefinition {
  label: string;
  images: Record<CompanionPose, string>;
  frames: Record<Exclude<CompanionPose, 'idle'>, string[]>;
}

const frameAssets = import.meta.glob<string>('../assets/companion/frames/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

function gestureFrames(skin: RasterCompanionSkin, pose: Exclude<CompanionPose, 'idle'>): string[] {
  const count = (skin === 'prodigy' && (pose === 'watch' || pose === 'wave'))
    || (skin === 'blockchain-dreads' && pose === 'rest') ? 6 : 4;
  return Array.from({ length: count }, (_, index) => {
    const key = `../assets/companion/frames/${skin}-${pose}-${index}.webp`;
    const source = frameAssets[key];
    if (!source) throw new Error(`Missing companion animation frame: ${key}`);
    return source;
  });
}

function frames(skin: RasterCompanionSkin): RasterCompanionDefinition['frames'] {
  return {
    watch: gestureFrames(skin, 'watch'),
    scratch: gestureFrames(skin, 'scratch'),
    wave: gestureFrames(skin, 'wave'),
    rest: gestureFrames(skin, 'rest'),
  };
}

export const RASTER_COMPANIONS: Record<RasterCompanionSkin, RasterCompanionDefinition> = {
  prodigy: {
    label: 'Ak (Ack)',
    images: { idle: prodigyIdle, watch: prodigyWatch, scratch: prodigyScratch, wave: prodigyWave, rest: prodigyRest },
    frames: frames('prodigy'),
  },
  'blockchain-dreads': {
    label: 'Rell',
    images: { idle: dreadsIdle, watch: dreadsWatch, scratch: dreadsScratch, wave: dreadsWave, rest: dreadsRest },
    frames: frames('blockchain-dreads'),
  },
  'blockchain-waves': {
    label: 'Pat',
    images: { idle: wavesIdle, watch: wavesWatch, scratch: wavesScratch, wave: wavesWave, rest: wavesRest },
    frames: frames('blockchain-waves'),
  },
};

const preloadCache = new Map<RasterCompanionSkin, Promise<boolean>>();

export function preloadRasterCompanion(skin: RasterCompanionSkin): Promise<boolean> {
  const cached = preloadCache.get(skin);
  if (cached) return cached;
  const definition = RASTER_COMPANIONS[skin];
  const sources = [
    ...Object.values(definition.images),
    ...Object.values(definition.frames).flat(),
  ];
  const pending = Promise.all(sources.map((source) => new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => void image.decode().then(() => resolve(true), () => resolve(false));
    image.onerror = () => resolve(false);
    image.src = source;
  }))).then((results) => {
    const ready = results.every(Boolean);
    if (!ready) preloadCache.delete(skin);
    return ready;
  });
  preloadCache.set(skin, pending);
  return pending;
}

export function isRasterCompanionSkin(skin: CompanionSkin): skin is RasterCompanionSkin {
  return skin in RASTER_COMPANIONS;
}
