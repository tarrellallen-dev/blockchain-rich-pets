import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type CompanionScale, type CompanionSkin, type DashboardSummary } from '../lib/api';
import { deriveActivity, type SystemActivity } from '../lib/ambient';
import { parseCommand } from '../lib/commands';
import {
  companionDirection,
  companionMotionTransform,
  deriveCompanionDragMotion,
  nextCompanionFalling,
  NEUTRAL_COMPANION_MOTION,
  type CompanionDragMotion,
} from '../lib/companion-motion';
import {
  advanceCompanionPose,
  INITIAL_COMPANION_POSE,
  type CompanionPose,
  type CompanionPoseState,
} from '../lib/companion-idle';
import { companionBlinkDelay, companionFrameSequence } from '../lib/companion-animation';
import { NexusCore, mixHex, prefersReducedMotion, seeded, svgEl, glowFilter } from './NexusCore';
import { AegisCore } from './AegisCore';
import {
  isRasterCompanionSkin,
  preloadRasterCompanion,
  RASTER_COMPANIONS,
  type RasterCompanionSkin,
} from './companion-skins';

/**
 * The companion window's renderer.
 *
 * Mounts instead of the dashboard when the window URL carries #companion.
 *
 * The hard problem here is click-through. The window is a transparent
 * rectangle sitting over the desktop, so most of it must pass clicks to
 * whatever is underneath — but the avatar and its cards must not. The obvious
 * approach, toggling `setIgnoreMouseEvents` from mouseenter/mouseleave on the
 * avatar, cannot work: the instant the pointer leaves the avatar the window
 * goes transparent to input, so nothing else in the window ever receives a
 * mouseenter again. Menus become unclickable and drags die on the first pixel.
 *
 * The fix is to decide from one place. The window stays click-through with
 * `forward: true`, which keeps delivering mousemove, and on every move we ask
 * `elementFromPoint` whether the pointer is over anything marked `data-solid`.
 * One authority, no races.
 */

interface Alert {
  id: string;
  tone: 'danger' | 'warn' | 'info';
  headline: string;
  detail: string;
  page: string;
  projectId?: string;
}

type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: string };
interface CompanionBridge {
  invoke: <T>(channel: string, payload?: unknown) => Promise<BridgeResult<T>>;
  onCompanionPrefs?: (fn: () => void) => () => void;
}

const bridge = () => (window as unknown as { tbp?: CompanionBridge }).tbp;

const invoke = (channel: string, payload?: unknown) => void bridge()?.invoke(channel, payload);

/** What actually deserves to interrupt you, in the order it deserves to. */
function readAlerts(summary: DashboardSummary | null): Alert[] {
  if (!summary) return [];
  const out: Alert[] = [];
  const critical = (summary.criticalBlockers ?? []).filter(
    (b) => String((b as Record<string, unknown>).severity ?? '') === 'Critical',
  );
  const faulted = (summary.agents ?? []).filter((a) => a.status === 'Failed' || a.status === 'Misconfigured');

  if (faulted.length) {
    out.push({
      id: 'faulted',
      tone: 'danger',
      headline: faulted.length === 1 ? 'An agent has faulted' : `${faulted.length} agents have faulted`,
      detail: faulted.map((a) => a.name).slice(0, 3).join(', '),
      page: 'agents',
      projectId: faulted[0]?.current_project_id ?? undefined,
    });
  }
  if (critical.length) {
    out.push({
      id: 'critical',
      projectId: String((critical[0] as Record<string, unknown>).project_id ?? '') || undefined,
      tone: 'danger',
      headline: critical.length === 1 ? '1 critical blocker' : `${critical.length} critical blockers`,
      detail: String((critical[0] as Record<string, unknown>).description ?? 'Open the blockers list'),
      page: 'blockers',
    });
  }
  const approvals = summary.pendingApprovals?.length ?? 0;
  if (approvals) {
    out.push({
      id: 'approvals',
      tone: 'warn',
      headline: approvals === 1 ? '1 approval waiting' : `${approvals} approvals waiting`,
      detail: 'Nothing moves until you decide',
      projectId: String((summary.pendingApprovals?.[0] as Record<string, unknown>)?.project_id ?? '') || undefined,
      page: 'approvals',
    });
  }
  const overdue = summary.overdue?.length ?? 0;
  if (overdue) {
    out.push({
      id: 'overdue',
      tone: 'warn',
      headline: overdue === 1 ? '1 task overdue' : `${overdue} tasks overdue`,
      detail: String((summary.overdue?.[0] as Record<string, unknown>)?.title ?? ''),
      page: 'tasks',
      projectId: String((summary.overdue?.[0] as Record<string, unknown>)?.project_id ?? '') || undefined,
    });
  }
  if (summary.untriagedReports) {
    out.push({
      id: 'reports',
      tone: 'info',
      headline:
        summary.untriagedReports === 1 ? '1 report to read' : `${summary.untriagedReports} reports to read`,
      detail: 'Agents have reported back',
      page: 'reports',
    });
  }
  return out;
}

/**
 * Snoozing is local to this window and deliberately time-boxed.
 *
 * "Dismiss" on a desktop alert has to mean "not now", never "resolved" — the
 * blocker is still a blocker, and an alert that can be silenced permanently
 * from a floating widget is a way to lose work quietly. Everything comes back.
 */
const SNOOZE_KEY = 'tbp.companion.snoozed';

function readSnoozed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}') as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now));
  } catch {
    return {};
  }
}

function snooze(id: string, minutes: number): Record<string, number> {
  const next = { ...readSnoozed(), [id]: Date.now() + minutes * 60_000 };
  localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
  return next;
}

interface Prefs {
  skin: CompanionSkin;
  accent: string;
  scale: CompanionScale;
  alerts: boolean;
  commandLine: boolean;
}

const PREF_DEFAULTS: Prefs = {
  skin: 'kavalier',
  accent: '#a294ee',
  scale: 'medium',
  alerts: true,
  commandLine: true,
};

const AVATAR_PX: Record<Prefs['scale'], number> = { small: 150, medium: 190, large: 240 };

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function Companion() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(PREF_DEFAULTS);
  const [expanded, setExpanded] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [commandRequest, setCommandRequest] = useState(0);
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => readSnoozed());
  const [isDragging, setIsDragging] = useState(false);
  const [isLanding, setIsLanding] = useState(false);
  const [poseState, setPoseState] = useState<CompanionPoseState>({ ...INITIAL_COMPANION_POSE });
  const [atTopEdge, setAtTopEdge] = useState(false);
  const reducedMotion = useReducedMotionPreference();
  const lastInteractionAt = useRef(Date.now());

  const { skin, accent } = prefs;
  const activity: SystemActivity = deriveActivity(summary);
  const alerts = useMemo(
    () => (prefs.alerts ? readAlerts(summary).filter((a) => !snoozed[a.id]) : []),
    [summary, snoozed, prefs.alerts],
  );

  const refresh = async () => {
    const next = await api.summary().catch(() => null);
    if (next) setSummary(next);
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const next = await api.summary().catch(() => null);
      if (alive && next) setSummary(next);
    };
    void tick();
    const t = setInterval(tick, 60_000);
    // Snoozes expire on their own, so the list has to be re-read on a clock
    // rather than only when something else happens.
    const s = setInterval(() => setSnoozed(readSnoozed()), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(s);
    };
  }, []);

  const loadPrefs = () =>
    void bridge()
      ?.invoke<Prefs>('companion:prefs')
      .then((result) => {
        if (result.ok) setPrefs((prev) => ({ ...prev, ...result.data }));
      })
      .catch(() => undefined);

  useEffect(() => {
    loadPrefs();
    // The native menu changes preferences in the main process, so the renderer
    // is told to re-read rather than owning that state itself.
    const off = bridge()?.onCompanionPrefs?.(loadPrefs);
    return off;
  }, []);

  // --- one authority for what is solid ------------------------------------
  const draggingRef = useRef(false);
  useEffect(() => {
    let solid = false;
    const apply = (next: boolean) => {
      if (next === solid) return;
      solid = next;
      invoke('companion:interactive', { interactive: next });
    };
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) return apply(true);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      apply(Boolean(el && (el as Element).closest('[data-solid]')));
    };
    // When the cursor leaves the window entirely, drop solid ourselves. The
    // main-process guard also drops it after a second, but it cannot update
    // this cached flag — and a stale `true` here would suppress the next
    // companion:interactive call on re-entry, leaving the window click-through
    // while the avatar looks solid.
    const onOut = (e: MouseEvent) => {
      if (draggingRef.current) return;
      if (!e.relatedTarget) apply(false);
    };
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseout', onOut);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onOut);
      invoke('companion:interactive', { interactive: false });
    };
  }, []);

  // Clicking away from a transparent window never reaches the renderer, so the
  // menu closes on focus loss instead — which is what "clicking elsewhere"
  // actually means here.
  useEffect(() => {
    const dismiss = () => setExpanded(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // --- drag ---------------------------------------------------------------
  const last = useRef<{ x: number; y: number; at: number } | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragMotion = useRef<CompanionDragMotion>({ ...NEUTRAL_COMPANION_MOTION });
  const dragDirection = useRef<ReturnType<typeof companionDirection>>('still');
  const fallingRef = useRef(false);
  const landingTimer = useRef<number | null>(null);
  const dragSettleTimer = useRef<number | null>(null);
  const rasterSettleAnimation = useRef<Animation | null>(null);

  const cancelRasterSettle = () => {
    rasterSettleAnimation.current?.cancel();
    rasterSettleAnimation.current = null;
  };

  const settleRasterMotion = () => {
    const body = bodyRef.current;
    const layer = body?.querySelector<HTMLElement>('.raster-motion');
    const from = layer ? window.getComputedStyle(layer).transform : 'none';
    cancelRasterSettle();
    dragDirection.current = 'still';
    if (body) body.dataset.direction = 'still';
    if (!layer || reducedMotion || from === 'none') return;
    const animation = layer.animate(
      [{ transform: from }, { transform: 'none' }],
      { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' },
    );
    rasterSettleAnimation.current = animation;
    void animation.finished.catch(() => undefined).finally(() => {
      if (rasterSettleAnimation.current === animation) {
        animation.cancel();
        rasterSettleAnimation.current = null;
      }
    });
  };

  // The main process follows the real cursor while a drag is live. Doing it
  // from here meant the window moved out from under the pointer on every frame,
  // and one frame landing on a transparent pixel turned the window click-through
  // and killed the drag. The renderer only says when it starts and stops.
  //
  // The lean is written straight to the node rather than held in state. It used
  // to be a useState, which meant a full React render of the alert stack and the
  // whole avatar on every single pointer sample while the window was also being
  // repositioned by the main process — the two fighting for frames is what made
  // the drag feel like it was stuttering.
  const applyDragMotion = (dx: number, dy: number, elapsed = 16.667) => {
    cancelRasterSettle();
    const frameScale = 16.667 / Math.max(8, elapsed);
    dragMotion.current = deriveCompanionDragMotion(
      dx * frameScale,
      dy * frameScale,
      dragMotion.current,
      reducedMotion,
    );
    if (bodyRef.current) {
      bodyRef.current.style.transform = companionMotionTransform(dragMotion.current);
      bodyRef.current.dataset.direction = companionDirection(dx, dy);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Capture the pointer so pointerup still reaches this element when the
    // main process clamps the window at a screen edge and the cursor escapes
    // the body mid-drag. Without this, endDrag never fired in that case and
    // the 32ms chase loop followed the cursor forever ("sticky companion").
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; the blur fallback below still ends the drag */
    }
    if (landingTimer.current) window.clearTimeout(landingTimer.current);
    if (dragSettleTimer.current) window.clearTimeout(dragSettleTimer.current);
    cancelRasterSettle();
    setIsLanding(false);
    fallingRef.current = false;
    bodyRef.current?.classList.remove('companion-landing');
    last.current = { x: e.screenX, y: e.screenY, at: performance.now() };
    press.current = { x: e.screenX, y: e.screenY, moved: false };
    draggingRef.current = true;
    setIsDragging(true);
    lastInteractionAt.current = Date.now();
    bodyRef.current?.classList.add('companion-dragging');
    invoke('companion:beginDrag');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!last.current) return;
    // Used only for artwork response; the window itself moves in the main process.
    const now = performance.now();
    const dx = e.screenX - last.current.x;
    const dy = e.screenY - last.current.y;
    if (press.current && Math.hypot(e.screenX - press.current.x, e.screenY - press.current.y) > 5) {
      press.current.moved = true;
    }
    const elapsed = Math.max(8, now - last.current.at);
    last.current = { x: e.screenX, y: e.screenY, at: now };
    applyDragMotion(dx, dy, elapsed);
    if (dragSettleTimer.current) window.clearTimeout(dragSettleTimer.current);
    dragSettleTimer.current = window.setTimeout(() => {
      dragMotion.current = { ...NEUTRAL_COMPANION_MOTION };
      if (bodyRef.current) {
        bodyRef.current.style.transform = companionMotionTransform(dragMotion.current);
      }
      settleRasterMotion();
      dragSettleTimer.current = null;
    }, 90);
    dragDirection.current = companionDirection(dx, dy, 1.5, dragDirection.current);
    if (bodyRef.current) {
      bodyRef.current.dataset.direction = dragDirection.current;
      fallingRef.current = nextCompanionFalling(
        fallingRef.current,
        dragDirection.current,
        (dy / elapsed) * 1000,
      );
      bodyRef.current.dataset.falling = String(fallingRef.current);
    }
  };
  const endDrag = (allowClick = false) => {
    if (!draggingRef.current && !last.current) return;
    const fell = fallingRef.current;
    fallingRef.current = false;
    last.current = null;
    draggingRef.current = false;
    setIsDragging(false);
    if (dragSettleTimer.current) window.clearTimeout(dragSettleTimer.current);
    dragSettleTimer.current = null;
    lastInteractionAt.current = Date.now();
    dragMotion.current = { ...NEUTRAL_COMPANION_MOTION };
    if (!fell) settleRasterMotion();
    bodyRef.current?.classList.remove('companion-dragging');
    dragDirection.current = 'still';
    if (bodyRef.current) {
      bodyRef.current.dataset.direction = 'still';
      bodyRef.current.dataset.falling = 'false';
      if (fell && !reducedMotion) {
        bodyRef.current.classList.add('companion-landing');
        setIsLanding(true);
        landingTimer.current = window.setTimeout(() => {
          bodyRef.current?.classList.remove('companion-landing');
          setIsLanding(false);
          landingTimer.current = null;
        }, 360);
      }
    }
    if (bodyRef.current) bodyRef.current.style.transform = companionMotionTransform(dragMotion.current);
    invoke('companion:endDrag');
    if (allowClick && press.current && !press.current.moved) setTrayOpen((value) => !value);
    press.current = null;
  };

  // A drag must never outlive the window's ability to see the pointer. If the
  // window loses focus mid-drag (alt-tab, OS dialog), end it.
  useEffect(() => {
    const onBlur = () => endDrag();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  useEffect(() => {
    if (!reducedMotion) return;
    dragMotion.current = { ...NEUTRAL_COMPANION_MOTION };
    if (bodyRef.current) bodyRef.current.style.transform = companionMotionTransform(dragMotion.current);
  }, [reducedMotion]);

  useEffect(() => {
    const update = () => {
      const availableTop = (window.screen as Screen & { availTop?: number }).availTop ?? 0;
      setAtTopEdge(window.screenY < availableTop);
    };
    update();
    const timer = window.setInterval(update, 120);
    return () => window.clearInterval(timer);
  }, []);

  // --- acting on an alert --------------------------------------------------
  const [note, setNote] = useState<{ alert: Alert; text: string } | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const flash = (message: string) => {
    setSaid(message);
    window.setTimeout(() => setSaid((cur) => (cur === message ? null : cur)), 3200);
  };

  const openAlert = (a: Alert) => {
    invoke('companion:openPage', { page: a.page });
    setExpanded(false);
  };

  const snoozeAlert = (a: Alert) => {
    setSnoozed(snooze(a.id, 60));
    flash('Back in an hour.');
  };

  /**
   * A note against an alert files a task. Deliberately a task and not a verdict:
   * nothing on this window resolves an approval, closes a blocker or dispatches
   * an agent. A transparent widget that floats over everything is the last place
   * an irreversible action should live, and one stray click is all it would take.
   */
  const fileNote = async () => {
    if (!note?.text.trim()) return setNote(null);
    try {
      await api.captureTask(
        note.text.trim(),
        note.alert.projectId,
        {
        priority: note.alert.tone === 'danger' ? 'High' : 'Medium',
        notes: `Raised from the companion against: ${note.alert.headline} — ${note.alert.detail}`,
        },
      );
      flash('Filed as a task.');
      void refresh();
    } catch {
      flash('Could not file that.');
    }
    setNote(null);
  };

  const top = alerts[0];
  const rest = alerts.slice(1);

  useEffect(() => {
    const tick = () => setPoseState((state) => advanceCompanionPose(state, {
      now: Date.now(),
      lastInteractionAt: lastInteractionAt.current,
      activity,
      dragging: isDragging,
      suppressed: Boolean(top || note || expanded),
      reducedMotion: prefersReducedMotion(),
    }));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [activity, expanded, isDragging, note, top]);

  const px = AVATAR_PX[prefs.scale] ?? AVATAR_PX.medium;

  /** The row of things you can do about an alert without opening anything. */
  const actions = (a: Alert) => (
    <span className="alert-actions">
      <button onClick={() => openAlert(a)}>Open</button>
      <button onClick={() => setNote({ alert: a, text: '' })}>Note</button>
      <button onClick={() => snoozeAlert(a)}>Snooze</button>
    </span>
  );

  return (
    <div className={`companion ${activity}${atTopEdge ? ' at-top-edge' : ''}`} data-scale={prefs.scale} data-skin={skin}>
      {/* The signature: what needs you, said above his head.

          The lead card is written first and laid out last, because the stack is
          column-reverse. That keeps it pinned closest to him, and it means an
          expanded stack that overflows scrolls away from the lead rather than
          pushing it off the top — which is what a plain column did. */}
      {top && (
        <div className={`alert-stack${expanded ? ' expanded' : ''}`} data-solid>
          <div className={`alert-card ${top.tone} lead`}>
            <button
              className="alert-face"
              onClick={() => (rest.length ? setExpanded((v) => !v) : openAlert(top))}
            >
              <strong>{top.headline}</strong>
              <span>{top.detail}</span>
              {rest.length > 0 && <i className="alert-more">{expanded ? 'Less' : `+${rest.length} more`}</i>}
            </button>
            {actions(top)}
          </div>
          {expanded &&
            rest.map((a) => (
              <div key={a.id} className={`alert-card ${a.tone}`}>
                <button className="alert-face" onClick={() => openAlert(a)}>
                  <strong>{a.headline}</strong>
                  <span>{a.detail}</span>
                </button>
                {actions(a)}
              </div>
            ))}
          {/* stacked paper behind the card, so a queue reads as a queue */}
          {!expanded && rest.length > 0 && <span className="alert-shadow" aria-hidden="true" />}
        </div>
      )}

      {/* writing a line about an alert, in place, without opening the app */}
      {note && (
        <div className="companion-note" data-solid>
          <label>{note.alert.headline}</label>
          <input
            autoFocus
            value={note.text}
            placeholder="What about it?"
            onChange={(e) => setNote({ ...note, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void fileNote();
              if (e.key === 'Escape') setNote(null);
            }}
          />
          <span className="companion-hint">Enter files it as a task · Esc cancels</span>
        </div>
      )}

      {trayOpen && !note && <CompanionTray summary={summary} onOpen={(page) => {
        invoke('companion:openPage', { page });
        setTrayOpen(false);
      }} onCapture={() => { setCommandRequest((value) => value + 1); setTrayOpen(false); }} />}

      <div
        ref={bodyRef}
        className="companion-body"
        data-solid
        role="button"
        tabIndex={0}
        aria-label="Companion controls. Press Enter or Shift F10 to open the menu."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onLostPointerCapture={() => endDrag(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            invoke('companion:menu');
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // A native menu is not bounded by this window and flips itself at the
          // screen edge without being told to.
          invoke('companion:menu');
        }}
      >
        {skin === 'kavalier' && <span className="vector-companion" data-vector-skin="kavalier"><KavalierCore activity={activity} drift={0} accent={accent} size={px} /></span>}
        {skin === 'nexus' && <span className="vector-companion" data-vector-skin="nexus"><NexusCore activity={activity} size={px} /></span>}
        {skin === 'aegis' && <span className="vector-companion" data-vector-skin="aegis"><AegisCore activity={activity} size={px} /></span>}
        {isRasterCompanionSkin(skin) && (
          <RasterCompanion skin={skin} activity={activity} size={px} pose={poseState.pose} dragging={isDragging} landing={isLanding} reducedMotion={reducedMotion} />
        )}
      </div>

      {said && <div className="companion-said" data-solid>{said}</div>}

      {prefs.commandLine && !note && <CommandLine onSaid={flash} onRan={refresh} requestOpen={commandRequest} />}
    </div>
  );
}

function RasterCompanion({
  activity,
  size,
  skin,
  pose,
  dragging,
  landing,
  reducedMotion,
}: {
  activity: SystemActivity;
  size: number;
  skin: RasterCompanionSkin;
  pose: CompanionPose;
  dragging: boolean;
  landing: boolean;
  reducedMotion: boolean;
}) {
  const definition = RASTER_COMPANIONS[skin];
  const urgent = activity === 'blocked' || activity === 'failed';
  const requestedPose: CompanionPose = urgent ? 'wave' : pose;
  const [displayedPose, setDisplayedPose] = useState<CompanionPose>(requestedPose);
  const [frameIndex, setFrameIndex] = useState(0);
  const [blinking, setBlinking] = useState(false);
  const [framesReady, setFramesReady] = useState(false);
  const displayedPoseRef = useRef(displayedPose);
  const artRef = useRef<HTMLSpanElement>(null);
  const transitionSequence = useRef(0);

  useEffect(() => {
    let alive = true;
    setFramesReady(false);
    void preloadRasterCompanion(skin).then((ready) => {
      if (alive) setFramesReady(ready);
    });
    return () => { alive = false; };
  }, [skin]);

  useEffect(() => {
    if (reducedMotion || dragging || landing || urgent || displayedPose !== 'idle') {
      setBlinking(false);
      return;
    }
    let blinkTimer = 0;
    let openTimer = 0;
    const schedule = () => {
      blinkTimer = window.setTimeout(() => {
        setBlinking(true);
        openTimer = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, 260);
      }, companionBlinkDelay(Math.random()));
    };
    schedule();
    return () => {
      window.clearTimeout(blinkTimer);
      window.clearTimeout(openTimer);
    };
  }, [displayedPose, dragging, landing, reducedMotion, urgent]);

  useEffect(() => {
    const sequence = ++transitionSequence.current;
    const cancelArt = () => {
      artRef.current?.getAnimations().forEach((animation) => animation.cancel());
      if (artRef.current) {
        artRef.current.style.opacity = '';
        artRef.current.style.transform = '';
      }
    };
    cancelArt();

    if (reducedMotion) {
      displayedPoseRef.current = requestedPose;
      setDisplayedPose(requestedPose);
      setFrameIndex(requestedPose === 'idle' ? 0 : 2);
      return cancelArt;
    }

    // Direct manipulation owns the outer motion layer. Preserve the current
    // authored frame until release so a drag never creates a one-frame limb pop.
    if (dragging || landing) {
      return cancelArt;
    }

    const run = async () => {
      const animate = async (frames: Keyframe[], options: KeyframeAnimationOptions) => {
        const node = artRef.current;
        if (!node || sequence !== transitionSequence.current) return false;
        const animation = node.animate(frames, { ...options, fill: 'forwards' });
        try {
          await animation.finished;
        } catch {
          return false;
        }
        if (sequence !== transitionSequence.current) return false;
        animation.cancel();
        return true;
      };

      const wait = (ms: number) => new Promise<boolean>((resolve) => {
        window.setTimeout(() => resolve(sequence === transitionSequence.current), ms);
      });

      const ready = await preloadRasterCompanion(skin);
      if (sequence !== transitionSequence.current) return;
      if (!ready) {
        displayedPoseRef.current = requestedPose;
        setDisplayedPose(requestedPose);
        return;
      }
      setFramesReady(true);

      if (displayedPoseRef.current !== requestedPose && displayedPoseRef.current !== 'idle') {
        // Finish the current silhouette through its authored recovery frame
        // before changing actions. This is especially important when a drag or
        // urgent alert interrupts a lying or raised-arm pose.
        const frames = definition.frames[displayedPoseRef.current];
        for (let recovery = Math.min(frameIndex + 1, frames.length - 1); recovery < frames.length; recovery += 1) {
          setFrameIndex(recovery);
          if (!await wait(recovery === frames.length - 1 ? 180 : 110)) return;
        }
        displayedPoseRef.current = 'idle';
        setDisplayedPose('idle');
        setFrameIndex(0);
        if (!await wait(90)) return;
      }

      if (displayedPoseRef.current !== requestedPose) {
        const anticipated = await animate([
          { opacity: 1, transform: 'translateY(0) scale(1)' },
          { opacity: .97, transform: 'translateY(.4%) scale(1.006,.994)' },
        ], { duration: 110, easing: 'cubic-bezier(.33,0,.67,1)' });
        if (!anticipated) return;
        displayedPoseRef.current = requestedPose;
        setDisplayedPose(requestedPose);
        setFrameIndex(0);
        if (!await wait(70)) return;
      }

      if (requestedPose !== 'idle') {
        for (const beat of companionFrameSequence(requestedPose, definition.frames[requestedPose].length)) {
          if (sequence !== transitionSequence.current) return;
          setFrameIndex(beat.frame);
          if (!await wait(beat.holdMs)) return;
        }
      } else {
        setFrameIndex(0);
        await animate([
          { opacity: .97, transform: 'translateY(.3%) scale(1.004,.996)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    };

    void run();
    return () => {
      transitionSequence.current += 1;
      cancelArt();
    };
  }, [dragging, landing, reducedMotion, requestedPose, skin]);

  const source = displayedPose === 'idle'
    ? definition.images.idle
    : framesReady
      ? definition.frames[displayedPose][frameIndex] ?? definition.images[displayedPose]
      : definition.images[displayedPose];

  return (
    <div
      className={`raster-companion ${activity}`}
      data-companion-skin={skin}
      data-activity={activity}
      data-pose={displayedPose}
      data-frame={frameIndex}
      data-blinking={blinking ? 'true' : 'false'}
      data-urgent={urgent ? 'true' : 'false'}
      role="img"
      aria-label={`${definition.label}, system ${activity}`}
      style={{ width: size, height: size }}
    >
      <span className="raster-companion-ring" aria-hidden="true" />
      <span className="raster-motion">
        <span className="raster-idle-motion">
          <span className="raster-weight-motion">
            <span className="raster-art" ref={artRef}>
              <img src={source} alt="" draggable={false} onError={() => setFramesReady(false)} />
              <span className="raster-eyelid raster-eye-left" aria-hidden="true" />
              <span className="raster-eyelid raster-eye-right" aria-hidden="true" />
              <span className="raster-sparkle chain-a" aria-hidden="true" />
              <span className="raster-sparkle jewel-b" aria-hidden="true" />
            </span>
          </span>
        </span>
      </span>
      <span className="raster-companion-status" aria-hidden="true" />
    </div>
  );
}

/**
 * The command line under the avatar.
 *
 * It runs the same grammar as the command bar in the app, and that grammar
 * refuses on purpose to express an irreversible action — no approvals, no
 * dispatches, no deletes. That restraint matters more here than anywhere else:
 * this box sits on top of every other window all day, and voice will one day
 * feed the same parser.
 */
function CompanionTray({ summary, onOpen, onCapture }: {
  summary: DashboardSummary | null;
  onOpen: (page: string) => void;
  onCapture: () => void;
}) {
  const counts = summary?.counts;
  return <div className="companion-tray" data-solid>
    <div className="companion-tray-status">
      <span><b>{counts?.openTasks ?? 0}</b> Tasks</span>
      <span><b>{counts?.pendingApprovals ?? 0}</b> Approvals</span>
      <span><b>{counts?.openBlockers ?? 0}</b> Blockers</span>
      <span><b>{summary?.untriagedReports ?? 0}</b> Reports</span>
    </div>
    <div className="companion-shortcuts">
      <button onClick={() => onOpen('briefings')}>Brief</button>
      <button onClick={() => onOpen('tasks')}>Tasks</button>
      <button onClick={() => onOpen('agents')}>Agents</button>
      <button onClick={onCapture}>New task</button>
    </div>
  </div>;
}

function CommandLine({ onSaid, onRan, requestOpen }: { onSaid: (m: string) => void; onRan: () => void; requestOpen: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => (text.trim() ? parseCommand(text) : null), [text]);

  useEffect(() => {
    if (!requestOpen) return;
    setText('capture ');
    setOpen(true);
  }, [requestOpen]);

  const dictate = async () => {
    inputRef.current?.focus();
    const result = await bridge()?.invoke<{ started: boolean; reason?: string }>('companion:dictate');
    if (!result?.ok || !result.data.started) onSaid(result?.ok ? result.data.reason ?? 'Dictation unavailable.' : 'Dictation unavailable.');
  };

  const run = async () => {
    const command = parseCommand(text);
    setText('');
    switch (command.kind) {
      case 'navigate':
        invoke('companion:openPage', { page: command.page });
        break;
      case 'brief':
        invoke('companion:openPage', { page: 'briefings' });
        break;
      case 'blocked':
        invoke('companion:openPage', { page: 'blockers' });
        break;
      case 'capture':
        try {
          await api.captureTask(command.text, undefined, { priority: 'Medium' });
          onSaid('Captured.');
          onRan();
        } catch {
          onSaid('Could not capture that.');
        }
        break;
      default:
        // Saying what it did not understand beats doing something adjacent.
        onSaid(`Not a command I know: "${command.input}"`);
    }
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="companion-ask" data-solid onClick={() => setOpen(true)}>
        Ask
      </button>
    );
  }

  return (
    <div className="companion-command" data-solid>
      <input
        ref={inputRef}
        autoFocus
        value={text}
        placeholder="brief me · what's blocked · capture …"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void run();
          if (e.key === 'Escape') { setText(''); setOpen(false); }
        }}
      />
      <button className="companion-mic" title="Voice type" aria-label="Voice type" onClick={() => void dictate()}>Mic</button>
      <span className="companion-hint">
        {parsed && parsed.kind !== 'unknown' ? parsed.label : 'Type a command'}
      </span>
    </div>
  );
}

/**
 * KAVALIER — an orb inside two turning rings, wrapped in vapour that trails
 * against the drag so the thing reads as having mass.
 *
 * State has to be legible at 190 pixels across a cluttered desktop, so it is
 * carried by colour and by whether the rings turn at all — not by tempo. A
 * viewer cannot judge "slightly faster" without a reference; they can judge
 * "stopped, and orange" instantly.
 */
function KavalierCore({
  activity,
  drift,
  accent,
  size = 200,
}: {
  activity: SystemActivity;
  drift: number;
  accent: string;
  size?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotionPreference();
  const state = useRef({ activity, drift, accent });
  state.current = { activity, drift, accent };

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const uid = `k${Math.random().toString(36).slice(2, 7)}`;
    const CX = 130;
    const CY = 132;

    const defs = svgEl('defs');
    const sph = svgEl('radialGradient', { id: `${uid}s`, cx: '38%', cy: '32%', r: '76%' });
    const sp = [
      svgEl('stop', { offset: '0%', 'stop-color': '#ffffff' }),
      svgEl('stop', { offset: '46%', 'stop-color': accent }),
      svgEl('stop', { offset: '100%', 'stop-color': '#1a1533' }),
    ];
    sph.append(...sp);
    const vapGrad = svgEl('radialGradient', { id: `${uid}v` });
    const vs = [
      svgEl('stop', { offset: '0%', 'stop-color': accent, 'stop-opacity': '.34' }),
      svgEl('stop', { offset: '100%', 'stop-color': accent, 'stop-opacity': '0' }),
    ];
    vapGrad.append(...vs);
    const turb = svgEl('filter', { id: `${uid}t`, x: '-60%', y: '-60%', width: '220%', height: '220%' });
    const fe = svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.02', numOctaves: 2, seed: 5, result: 'n' });
    turb.append(fe, svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: 16 }));
    defs.append(sph, vapGrad, turb, glowFilter(`${uid}g`, 0.6, 3));
    svg.append(defs);

    const vapour = svgEl('g', { filter: `url(#${uid}t)` });
    const puffs: SVGCircleElement[] = [];
    const rnd = seeded(11);
    for (let i = 0; i < 7; i++) {
      const c = svgEl('circle', { fill: `url(#${uid}v)`, r: 26 + rnd() * 20 });
      vapour.append(c);
      puffs.push(c);
    }
    svg.append(vapour);

    // a ring that only exists when something needs you
    const alarm = svgEl('circle', {
      cx: CX, cy: CY, r: 62, fill: 'none', stroke: '#ff9b3d',
      'stroke-width': 2, 'stroke-dasharray': '3 9', 'stroke-linecap': 'round', opacity: 0,
    });
    svg.append(alarm);

    const back = svgEl('g');
    svg.append(back);
    const orb = svgEl('circle', { cx: CX, cy: CY, r: 46, fill: `url(#${uid}s)`, filter: `url(#${uid}g)` });
    svg.append(orb);
    const face = svgEl('rect', { x: CX - 21, y: CY - 15, width: 42, height: 30, rx: 9, fill: '#0d0a1f', opacity: 0.86 });
    const lids = [
      svgEl('rect', { x: CX - 13, y: CY - 5, width: 8, height: 11, rx: 4, fill: '#dcd4ff' }),
      svgEl('rect', { x: CX + 5, y: CY - 5, width: 8, height: 11, rx: 4, fill: '#dcd4ff' }),
    ];
    const front = svgEl('g');
    svg.append(face, ...lids, front);

    const RINGS = [
      { rx: 78, ryMax: 44, rot: -15, ph: 0, sp: 0.5 },
      { rx: 58, ryMax: 35, rot: 33, ph: 1.9, sp: 0.72 },
    ];
    const arcs = RINGS.map((r, i) => {
      const b = svgEl('path', { fill: 'none', 'stroke-width': i ? 1.6 : 2.1, opacity: 0.4 });
      const f = svgEl('path', { fill: 'none', 'stroke-width': i ? 1.6 : 2.1 });
      back.append(b);
      front.append(f);
      return { b, f, ...r };
    });

    const arcPath = (rx: number, ry: number, rot: number, sweep: number) => {
      const a = (rot * Math.PI) / 180;
      const x1 = CX + rx * Math.cos(a);
      const y1 = CY + rx * Math.sin(a);
      const x2 = CX - rx * Math.cos(a);
      const y2 = CY - rx * Math.sin(a);
      return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${rx} ${Math.max(1.2, ry).toFixed(1)} ${rot} 0 ${sweep} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    };

    let raf = 0;
    let t = 0;
    let lastNow = performance.now();
    let blink = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;
      if (!reduced) t += dt;
      const { activity: act, drift: d, accent: hue } = state.current;
      const alert = act === 'blocked' || act === 'failed';
      const busy = act === 'busy';
      const working = act === 'active' || busy;

      // Colour is the state. Motion is the second signal, and it is binary:
      // the rings either turn or they have stopped.
      const skin = alert ? (act === 'failed' ? '#ff6b6b' : '#ff9b3d') : hue;
      sp[1].setAttribute('stop-color', skin);
      sp[2].setAttribute('stop-color', mixHex(skin, '#000018', 0.78));
      vs[0].setAttribute('stop-color', skin);
      vs[1].setAttribute('stop-color', skin);

      const float = Math.sin(t * 1.4) * 3;
      orb.setAttribute('cy', (CY + float).toFixed(1));
      face.setAttribute('y', (CY - 15 + float).toFixed(1));

      if (!reduced) blink -= dt;
      if (blink < -0.16) blink = 2.4 + Math.abs(Math.sin(t * 7)) * 2.5;
      const shut = !reduced && blink < 0 && blink > -0.16 && !alert;
      lids.forEach((l, i) => {
        // eyes widen when working, narrow at rest, and go square on alert
        const h = alert ? 13 : shut ? 2 : working ? 12 : 9;
        l.setAttribute('height', String(h));
        l.setAttribute('rx', alert ? '1.5' : '4');
        l.setAttribute('y', (CY - h / 2 + float).toFixed(1));
        l.setAttribute('x', (CX + (i ? 5 : -13) + Math.max(-3, Math.min(3, d * 0.25))).toFixed(1));
        l.setAttribute('fill', alert ? '#ffe0c2' : '#dcd4ff');
      });

      arcs.forEach((r) => {
        if (!reduced && !alert) r.ph += dt * r.sp * (busy ? 2.4 : working ? 1.5 : 0.8);
        const ry = Math.cos(r.ph) * r.ryMax;
        const flip = ry < 0 ? 1 : 0;
        r.b.setAttribute('d', arcPath(r.rx, Math.abs(ry), r.rot, flip));
        r.f.setAttribute('d', arcPath(r.rx, Math.abs(ry), r.rot, 1 - flip));
        r.b.setAttribute('stroke', skin);
        r.f.setAttribute('stroke', mixHex(skin, '#ffffff', 0.45));
        r.f.setAttribute('opacity', (0.55 + 0.45 * Math.abs(Math.cos(r.ph))).toFixed(2));
      });

      alarm.setAttribute('opacity', alert ? (0.35 + 0.45 * Math.abs(Math.sin(t * 2.4))).toFixed(2) : '0');
      alarm.setAttribute('stroke', act === 'failed' ? '#ff6b6b' : '#ff9b3d');
      alarm.setAttribute('r', (62 + (alert ? Math.sin(t * 2.4) * 3 : 0)).toFixed(1));

      fe.setAttribute('seed', String(Math.floor(t * 3) % 71));
      puffs.forEach((c, i) => {
        const a = (i / puffs.length) * 6.283 + t * 0.35;
        c.setAttribute('cx', (CX + Math.cos(a) * 26 - d * 1.4).toFixed(1));
        c.setAttribute('cy', (CY + Math.sin(a) * 20 + float * 1.4 + 6).toFixed(1));
        c.setAttribute('opacity', (0.5 + 0.5 * Math.sin(t * 1.1 + i)).toFixed(2));
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
  }, [reduced]);

  // The viewBox is 260x270, so the height follows the width to keep him whole.
  return (
    <svg
      ref={ref}
      className="kavalier"
      width={size}
      height={Math.round(size * (270 / 260))}
      viewBox="0 0 260 270"
      aria-label="Kavalier"
    />
  );
}
