/** Shared companion preference rules used at both sides of the IPC boundary. */
export const COMPANION_SKINS = [
  'kavalier',
  'nexus',
  'aegis',
  'prodigy',
  'blockchain-dreads',
  'blockchain-waves',
] as const;
export const COMPANION_SCALES = ['small', 'medium', 'large'] as const;

export type CompanionSkin = (typeof COMPANION_SKINS)[number];
export type CompanionScale = (typeof COMPANION_SCALES)[number];

export interface CompanionPreferences {
  enabled: boolean;
  openAtLogin: boolean;
  skin: CompanionSkin;
  accent: string;
  scale: CompanionScale;
  alerts: boolean;
  commandLine: boolean;
  x?: number;
  y?: number;
}

export const DEFAULT_COMPANION_PREFERENCES: Readonly<CompanionPreferences> = {
  enabled: true,
  openAtLogin: false,
  skin: 'kavalier',
  accent: '#a294ee',
  scale: 'medium',
  alerts: true,
  commandLine: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isCompanionSkin(value: unknown): value is CompanionSkin {
  return typeof value === 'string' && (COMPANION_SKINS as readonly string[]).includes(value);
}

export function isCompanionScale(value: unknown): value is CompanionScale {
  return typeof value === 'string' && (COMPANION_SCALES as readonly string[]).includes(value);
}

/**
 * Keeps only explicitly supplied, valid values.
 *
 * This is intentionally a compact patch: an IPC caller changing one setting
 * must not overwrite every omitted setting with `undefined`.
 */
export function sanitizeCompanionPatch(value: unknown): Partial<CompanionPreferences> {
  if (!isRecord(value)) return {};
  const patch: Partial<CompanionPreferences> = {};

  if (typeof value.enabled === 'boolean') patch.enabled = value.enabled;
  if (typeof value.openAtLogin === 'boolean') patch.openAtLogin = value.openAtLogin;
  if (isCompanionSkin(value.skin)) patch.skin = value.skin;
  if (typeof value.accent === 'string' && /^#[0-9a-f]{6}$/i.test(value.accent)) {
    patch.accent = value.accent.toLowerCase();
  }
  if (isCompanionScale(value.scale)) patch.scale = value.scale;
  if (typeof value.alerts === 'boolean') patch.alerts = value.alerts;
  if (typeof value.commandLine === 'boolean') patch.commandLine = value.commandLine;
  if (typeof value.x === 'number' && Number.isFinite(value.x)) patch.x = Math.round(value.x);
  if (typeof value.y === 'number' && Number.isFinite(value.y)) patch.y = Math.round(value.y);

  return patch;
}

/** Makes a complete, render-safe preference object from untrusted JSON. */
export function normalizeCompanionPreferences(value: unknown): CompanionPreferences {
  return { ...DEFAULT_COMPANION_PREFERENCES, ...sanitizeCompanionPatch(value) };
}

/** A login-item launch follows its explicit startup setting, even if hidden now. */
export function shouldBootCompanion(
  preferences: Readonly<CompanionPreferences>,
  companionOnlyLaunch: boolean,
): boolean {
  return preferences.enabled || (companionOnlyLaunch && preferences.openAtLogin);
}

/** Never permit a companion-only launch to strand the app with no visible window. */
export function shouldShowDashboard(companionOnlyLaunch: boolean, companionOpen: boolean): boolean {
  return !companionOnlyLaunch || !companionOpen;
}

/**
 * Horizontal window limits that keep the painted avatar on-screen while
 * allowing the transparent canvas around it to extend beyond the display.
 */
export function companionHorizontalRange(
  areaX: number,
  areaWidth: number,
  windowWidth: number,
  avatarWidth: number,
): { min: number; max: number } {
  const headroom = Math.max(0, (windowWidth - Math.min(windowWidth, avatarWidth)) / 2);
  return {
    min: Math.round(areaX - headroom),
    max: Math.round(areaX + areaWidth - windowWidth + headroom),
  };
}
