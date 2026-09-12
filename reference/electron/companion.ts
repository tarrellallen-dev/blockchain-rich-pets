import { BrowserWindow, Menu, app, screen } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readConfig, writeConfig } from './config';
import {
  COMPANION_SCALES,
  companionHorizontalRange,
  normalizeCompanionPreferences,
  sanitizeCompanionPatch,
  type CompanionPreferences,
  type CompanionScale,
} from '../shared/companion';
export type { CompanionScale } from '../shared/companion';

/**
 * Kavalier — the desktop companion.
 *
 * A second window that has nothing to do with the main one: frameless,
 * transparent, always on top, and alive whether or not the dashboard is open.
 * It is the thing you leave on your screen all day, so the rules it follows are
 * about staying out of the way:
 *
 *   · transparent with no frame, so only what is painted is visible
 *   · click-through everywhere except the avatar itself, set from the renderer
 *     via `setIgnoreMouseEvents` with `forward: true` — otherwise an invisible
 *     rectangle would eat clicks meant for whatever is underneath
 *   · excluded from the taskbar and from screen capture prompts
 *   · position remembered, and validated against the current displays on
 *     restore, because a window restored onto a monitor you have unplugged is
 *     a window you cannot reach
 */

/**
 * The window is a canvas, not a frame. It has to hold the avatar, a stack of
 * alert cards above its head, and a command line under it — all of which are
 * painted, so anything the renderer draws outside these bounds is simply
 * clipped away with no warning.
 */
const SCALES = {
  small: { width: 380, height: 340 },
  medium: { width: 440, height: 410 },
  large: { width: 520, height: 480 },
} as const;

function sizeFor(scale: CompanionScale | undefined): { width: number; height: number } {
  return SCALES[scale ?? 'medium'] ?? SCALES.medium;
}

/** The size the live window is actually using. */
function currentSize(): { width: number; height: number } {
  if (isCompanionOpen()) {
    const [width, height] = companionWindow!.getSize();
    return { width, height };
  }
  return sizeFor(readConfig().companion?.scale);
}

let companionWindow: BrowserWindow | null = null;

/**
 * Keeps a position somewhere a person can still reach.
 *
 * This exists because of a real incident: the companion was dragged off the
 * edge of the screen, and because the window was always-on-top and not yet
 * click-through it took the desktop with it — nothing but the taskbar was
 * clickable, and the machine had to be restarted.
 *
 * The rule is that a generous margin of the window must stay inside the work
 * area of whichever display it is nearest. Off-screen is not a position the
 * companion is allowed to hold, whether it got there by drag, by a display
 * being unplugged, or by a stale config file.
 */
function clamp(x: number, y: number, displayAnchor?: { x: number; y: number }): { x: number; y: number } {
  const { width, height } = currentSize();
  // During a drag the cursor owns the display transition. The transparent
  // window origin can still be hundreds of pixels back on the old monitor,
  // which used to create an invisible wall between adjacent displays.
  const anchor = displayAnchor ?? { x: x + width / 2, y: y + height / 2 };
  const area = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
  const scale = readConfig().companion?.scale ?? 'medium';
  const visibleFromBottom = { small: 198, medium: 238, large: 288 }[scale] ?? 238;
  const visibleWidth = { small: 150, medium: 190, large: 240 }[scale] ?? 190;
  const horizontal = companionHorizontalRange(area.x, area.width, width, visibleWidth);
  // The character is bottom-aligned in a tall transparent canvas so alerts can
  // open above it. Let that empty headroom move beyond the top work-area edge;
  // otherwise the invisible canvas becomes a ceiling well below the menu bar.
  const topTransparentHeadroom = Math.max(0, height - visibleFromBottom);
  return {
    x: Math.round(Math.min(Math.max(x, horizontal.min), Math.max(horizontal.min, horizontal.max))),
    y: Math.round(Math.min(
      Math.max(y, area.y - topTransparentHeadroom),
      Math.max(area.y, area.y + area.height - height),
    )),
  };
}

function savedBounds(): { x: number; y: number } | null {
  const stored = readConfig().companion;
  if (!stored || typeof stored.x !== 'number' || typeof stored.y !== 'number') return null;
  // Clamped rather than discarded: a position that has drifted off a display
  // that no longer exists should pull back onto one, not reset to the corner.
  return clamp(stored.x, stored.y);
}

function defaultBounds(): { x: number; y: number } {
  // Bottom-right of the primary display's work area, inset a little.
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = currentSize();
  return {
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + area.height - height - 24),
  };
}

function remember(): void {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  const [x, y] = companionWindow.getPosition();
  writeConfig({ companion: { ...readConfig().companion, x, y } });
}

/** Puts it back in the corner. The way out when it has gone somewhere silly. */
export function resetCompanionPosition(): boolean {
  if (!isCompanionOpen()) return false;
  const at = defaultBounds();
  companionWindow!.setPosition(at.x, at.y);
  remember();
  return true;
}

export function isCompanionOpen(): boolean {
  return Boolean(companionWindow && !companionWindow.isDestroyed());
}

export function createCompanion(devServer?: string): BrowserWindow {
  if (isCompanionOpen()) {
    companionWindow!.showInactive();
    return companionWindow!;
  }

  const at = savedBounds() ?? defaultBounds();

  companionWindow = new BrowserWindow({
    ...sizeFor(readConfig().companion?.scale),
    x: at.x,
    y: at.y,
    frame: false,
    transparent: true,
    // Electron paints an opaque window background unless it is told otherwise.
    // `transparent: true` alone is not enough on Windows — without a fully
    // transparent backgroundColor the window shows as a dark rectangle behind
    // whatever the page draws.
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Show without stealing focus from whatever you are actually doing.
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Above normal windows but below system UI, and present on every virtual
  // desktop — a companion that vanishes when you switch desktops is not a
  // companion.
  companionWindow.setAlwaysOnTop(true, 'floating');
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  companionWindow.on('moved', remember);
  companionWindow.on('close', remember);
  companionWindow.on('closed', () => {
    companionWindow = null;
    stopDragLoop();
    stopGuard();
    solid = false;
  });

  const target = devServer
    ? `${devServer}#companion`
    // pathToFileURL rather than string concatenation: a Windows path is full of
    // backslashes and a drive letter, which `file://C:\...` does not survive.
    : `${pathToFileURL(path.join(__dirname, '../renderer/index.html')).href}#companion`;
  companionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  companionWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== target) event.preventDefault();
  });
  void companionWindow.loadURL(target);

  companionWindow.once('ready-to-show', () => {
    companionWindow?.showInactive();
    // Start click-through. Until the first mouse move the renderer has had no
    // chance to say what is solid, and an invisible 260x300 rectangle sitting
    // over the desktop eating clicks is the worst possible default. `forward`
    // keeps the move events coming, which is what turns it solid again.
    companionWindow?.setIgnoreMouseEvents(true, { forward: true });
    solid = false;
    startGuard();
  });

  return companionWindow;
}

/**
 * Dragging is driven from here, off the real cursor position, rather than from
 * mouse deltas in the renderer.
 *
 * The renderer version could not work reliably: the window moves out from under
 * the pointer on every frame, and the click-through hit test re-runs on each of
 * those moves. One bad frame — the pointer momentarily over a transparent part
 * of the window — turned the window click-through and the drag died silently.
 *
 * Following `getCursorScreenPoint` has no such coupling. The window chases the
 * cursor whatever the renderer thinks is under it.
 */
let dragTimer: NodeJS.Timeout | null = null;
let dragWatchdog: NodeJS.Timeout | null = null;
let grab: { dx: number; dy: number } | null = null;
let lastAt: { x: number; y: number } | null = null;

function stopDragLoop(): void {
  if (dragTimer) clearInterval(dragTimer);
  if (dragWatchdog) clearTimeout(dragWatchdog);
  dragTimer = null;
  dragWatchdog = null;
  lastAt = null;
  grab = null;
}

export function beginDrag(): boolean {
  if (!isCompanionOpen()) return false;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = companionWindow!.getPosition();
  // Hold the grab offset so the avatar does not jump to centre on first move.
  stopDragLoop();
  grab = { dx: cursor.x - wx, dy: cursor.y - wy };
  lastAt = { x: wx, y: wy };

  // 60Hz was the source of the twitch. Windows coalesces cursor samples, so a
  // 16ms poll asks for a position that has not moved most of the time and then
  // catches up in a jump; and every setPosition on a transparent always-on-top
  // window forces a composite. 30Hz reads cleanly, and the redundant-move guard
  // means a still hand costs nothing at all.
  dragTimer = setInterval(() => {
    if (!isCompanionOpen() || !grab) return stopDragLoop();
    const p = screen.getCursorScreenPoint();
    const next = clamp(p.x - grab.dx, p.y - grab.dy, p);
    if (lastAt && next.x === lastAt.x && next.y === lastAt.y) return;
    lastAt = next;
    companionWindow!.setPosition(next.x, next.y);
  }, 32);

  // Failsafe: if the renderer's endDrag never arrives (pointerup lost when the
  // cursor escaped the window at a screen edge), the chase loop must not run
  // forever. Twenty seconds is longer than any deliberate drag.
  dragWatchdog = setTimeout(() => {
    if (grab) endDrag();
  }, 20_000);
  return true;
}

export function endDrag(): boolean {
  stopDragLoop();
  if (isCompanionOpen()) {
    // Whatever happened during the drag, it lands somewhere reachable.
    const [x, y] = companionWindow!.getPosition();
    const safe = clamp(x, y);
    if (safe.x !== x || safe.y !== y) companionWindow!.setPosition(safe.x, safe.y);
  }
  remember();
  return true;
}

/** Kept for compatibility; the drag loop above is what actually moves it. */
export function moveCompanionBy(dx: number, dy: number): boolean {
  if (!isCompanionOpen()) return false;
  const [x, y] = companionWindow!.getPosition();
  // Clamped like every other placement path. Unclamped, this channel could
  // put the window fully off-screen — the exact incident clamp() exists for.
  const next = clamp(Math.round(x + dx), Math.round(y + dy));
  companionWindow!.setPosition(next.x, next.y);
  remember();
  return true;
}

export const ACCENTS: Array<{ label: string; value: string }> = [
  { label: 'Lavender', value: '#a294ee' },
  { label: 'Cyan', value: '#6fdcee' },
  { label: 'Mint', value: '#52e1ac' },
  { label: 'Amber', value: '#ffc266' },
  { label: 'Rose', value: '#ff8ab0' },
  { label: 'Ice', value: '#8fa6ff' },
];

/**
 * A native context menu, not an HTML one.
 *
 * The HTML version could never work: it was drawn inside a 260x300 window and
 * windows clip their contents, so most of it was simply outside the frame. An
 * OS menu is not bounded by the window at all, and it already knows to flip
 * itself up or sideways when it would run off the screen — which is exactly the
 * behaviour that would otherwise have to be written by hand and kept correct
 * across every display arrangement.
 */
export function popupCompanionMenu(onChange: () => void): void {
  if (!isCompanionOpen()) return;
  const prefs = companionPrefs();

  const menu = Menu.buildFromTemplate([
    { label: 'Kavalier', type: 'radio', checked: prefs.skin === 'kavalier',
      click: () => { setCompanionPrefs({ skin: 'kavalier' }); onChange(); } },
    { label: 'Nexus', type: 'radio', checked: prefs.skin === 'nexus',
      click: () => { setCompanionPrefs({ skin: 'nexus' }); onChange(); } },
    { label: 'Aegis', type: 'radio', checked: prefs.skin === 'aegis',
      click: () => { setCompanionPrefs({ skin: 'aegis' }); onChange(); } },
    { label: 'Ak (Ack)', type: 'radio', checked: prefs.skin === 'prodigy',
      click: () => { setCompanionPrefs({ skin: 'prodigy' }); onChange(); } },
    { label: 'Rell', type: 'radio', checked: prefs.skin === 'blockchain-dreads',
      click: () => { setCompanionPrefs({ skin: 'blockchain-dreads' }); onChange(); } },
    { label: 'Pat', type: 'radio', checked: prefs.skin === 'blockchain-waves',
      click: () => { setCompanionPrefs({ skin: 'blockchain-waves' }); onChange(); } },
    { type: 'separator' },
    {
      label: 'Colour',
      submenu: ACCENTS.map((a) => ({
        label: a.label,
        type: 'radio' as const,
        checked: prefs.accent === a.value,
        click: () => { setCompanionPrefs({ accent: a.value }); onChange(); },
      })),
    },
    {
      label: 'Size',
      submenu: COMPANION_SCALES.map((s) => ({
        label: s[0].toUpperCase() + s.slice(1),
        type: 'radio' as const,
        checked: prefs.scale === s,
        click: () => { setCompanionPrefs({ scale: s }); onChange(); },
      })),
    },
    { type: 'separator' },
    { label: 'Show alerts', type: 'checkbox', checked: prefs.alerts,
      click: () => { setCompanionPrefs({ alerts: !prefs.alerts }); onChange(); } },
    { label: 'Show command line', type: 'checkbox', checked: prefs.commandLine,
      click: () => { setCompanionPrefs({ commandLine: !prefs.commandLine }); onChange(); } },
    { type: 'separator' },
    { label: 'Start with computer', type: 'checkbox', checked: prefs.openAtLogin,
      click: () => { setCompanionPrefs({ openAtLogin: !prefs.openAtLogin }); onChange(); } },
    { label: 'Reset position', click: () => { resetCompanionPosition(); } },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => openDashboard() },
    { label: 'Hide companion', click: () => { setCompanionPrefs({ enabled: false }); onChange(); } },
  ]);

  // The companion is shown with showInactive() and may never have held focus.
  // A menu popped on a window the OS does not consider active can be dismissed
  // the instant it opens, which reads as "nothing happened" — so take focus
  // first and hand it back when the menu closes.
  const win = companionWindow!;
  if (!win.isFocused()) win.focus();
  menu.popup({ window: win, callback: () => win.blur() });
}

/**
 * How the companion asks for the dashboard when there is no dashboard window
 * left to show. Registered by main.ts rather than imported from it, because
 * main already imports this module and the cycle would be worse than the
 * indirection.
 */
let dashboardOpener: (() => void) | null = null;
export function onOpenDashboardRequest(fn: () => void): void {
  dashboardOpener = fn;
}

function openDashboard(): void {
  requestDashboard();
}

/**
 * Brings the dashboard up — recreating it if it was closed — and optionally
 * lands it on a page once its renderer is ready. This is the single path used
 * by the native menu, the alert "Open" buttons and the command line, so a
 * companion-only launch (the default login flow) can always reach the app.
 */
export function requestDashboard(page?: string): void {
  const find = () =>
    BrowserWindow.getAllWindows().filter((w) => w !== companionWindow && !w.isAlwaysOnTop())[0];

  const existing = find();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (page) existing.webContents.send('tbp:navigate', { page });
    return;
  }

  // Closing the dashboard and then asking for it back is an ordinary thing to
  // do. A menu item that quietly does nothing is worse than one that is absent.
  dashboardOpener?.();

  if (page) {
    // The fresh window loads asynchronously; deliver the navigation once its
    // renderer can actually receive it.
    const fresh = find();
    fresh?.webContents.once('did-finish-load', () => {
      if (!fresh.isDestroyed()) fresh.webContents.send('tbp:navigate', { page });
    });
  }
}

export function closeCompanion(): void {
  if (isCompanionOpen()) companionWindow!.close();
  companionWindow = null;
}

export function toggleCompanion(devServer?: string): boolean {
  if (isCompanionOpen()) {
    setCompanionPrefs({ enabled: false });
    return false;
  }
  setCompanionPrefs({ enabled: true });
  if (!isCompanionOpen()) createCompanion(devServer);
  return true;
}

/**
 * Lets the renderer declare which parts of the window are solid. Everything
 * else passes clicks through to the desktop beneath.
 */
export function setCompanionInteractive(interactive: boolean): void {
  if (!isCompanionOpen()) return;
  solid = interactive;
  companionWindow!.setIgnoreMouseEvents(!interactive, { forward: true });
}

/**
 * The failsafe.
 *
 * Solid is a state the renderer asks for and the renderer takes back. If the
 * renderer stops running — a crash, a reload, a window that lost its page —
 * nobody takes it back, and what is left behind is an always-on-top invisible
 * rectangle that swallows every click inside it. That is exactly the fault that
 * left the desktop unusable, and no amount of care in the renderer can rule it
 * out, because the renderer is the thing that failed.
 *
 * So the main process checks the one fact it can establish on its own: is the
 * cursor actually inside the window. If it is not, and the window still claims
 * to be solid, the claim is stale and gets dropped.
 */
let solid = false;
let guard: NodeJS.Timeout | null = null;

function startGuard(): void {
  stopGuard();
  guard = setInterval(() => {
    if (!isCompanionOpen()) return stopGuard();
    if (!solid || grab) return; // a live drag is allowed to leave the bounds
    const p = screen.getCursorScreenPoint();
    const b = companionWindow!.getBounds();
    const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    if (!inside) setCompanionInteractive(false);
  }, 1000);
}

function stopGuard(): void {
  if (guard) clearInterval(guard);
  guard = null;
}

// ---------------------------------------------------------------------------
// Start with the computer
// ---------------------------------------------------------------------------

export type CompanionPrefs = CompanionPreferences;

export function companionPrefs(): CompanionPrefs {
  return normalizeCompanionPreferences(readConfig().companion);
}

/**
 * Writing the preference is the easy half. Every one of these settings used to
 * stop there — the file changed and the window on the desktop carried on
 * exactly as before, because nothing told it to look again. Applying the change
 * to the live window is this function's actual job; persisting it is the part
 * that happens on the way.
 */
export function setCompanionPrefs(input: unknown): CompanionPrefs {
  const patch = sanitizeCompanionPatch(input);
  const next = { ...companionPrefs(), ...patch };
  writeConfig({ companion: next });

  if (patch.openAtLogin !== undefined) {
    // `--companion` tells the next launch to bring up the avatar and stay in
    // the tray, rather than opening the whole dashboard uninvited.
    app.setLoginItemSettings(process.platform === 'darwin'
      ? { openAtLogin: next.openAtLogin }
      : { openAtLogin: next.openAtLogin, args: ['--companion'] });
  }

  // A larger avatar needs a larger canvas, and the window clips whatever the
  // renderer draws outside it — so the size has to change here, not in CSS.
  if (patch.scale !== undefined && isCompanionOpen()) {
    const { width, height } = sizeFor(next.scale);
    const [x, y] = companionWindow!.getPosition();
    companionWindow!.setSize(width, height);
    const safe = clamp(x, y);
    companionWindow!.setPosition(safe.x, safe.y);
    remember();
  }

  if (patch.enabled === false) closeCompanion();
  if (patch.enabled === true && !isCompanionOpen()) createCompanion(process.env.TBP_DEV_SERVER);

  // Tell every window a preference moved. The companion re-reads and repaints;
  // the dashboard's settings page re-reads so the two never disagree.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tbp:companion-prefs');
  }
  return next;
}

/** True when this launch came from the login item, or was asked for by hand. */
export function launchedForCompanionOnly(): boolean {
  return process.argv.includes('--companion') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
}

/** Opens the OS-owned voice-typing surface; no audio or transcript enters IPC. */
export function startSystemDictation(): { started: boolean; reason?: string } {
  if (process.platform !== 'win32') {
    return { started: false, reason: 'Use your system dictation shortcut in the focused command box.' };
  }
  const script = [
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class TBPKeys { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint flags, System.UIntPtr extra); }'",
    '[TBPKeys]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)',
    '[TBPKeys]::keybd_event(0x48,0,0,[UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 80',
    '[TBPKeys]::keybd_event(0x48,0,2,[UIntPtr]::Zero)',
    '[TBPKeys]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { started: true };
}
