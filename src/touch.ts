// Touch controls for player 1: gestures on the board plus a button bar.
//
//   drag left / right  move one column per cell dragged
//   drag down          soft drop one row per cell dragged
//   fast swipe down    hard drop
//   swipe up           hold
//   tap                rotate right
//
// Gestures become short button "pulses" (pressed for one frame, released the
// next) so they go through the same edge-triggered input code as a gamepad.
import { emptyState, type Button, type PadState } from './game/input.ts';

const TAP_MAX_MS = 250;
const TAP_MAX_PX = 12;
const FLICK_WINDOW_MS = 100; // release velocity is measured over this window
const FLICK_SPEED = 0.8; // px per ms
const MAX_QUEUE = 12;

/** Keep receiving a pointer's events even if it leaves the element. */
/** A drag on the board, from pointerdown to pointerup. */
interface Gesture {
  id: number;
  startX: number;
  startY: number;
  anchorX: number; // where the next column / row step is measured from
  anchorY: number;
  startTime: number;
  moved: boolean;
  axis: 'x' | 'y' | null;
  samples: { x: number; y: number; t: number }[];
}

function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture?.(pointerId);
  } catch {
    // The pointer is already gone (e.g. lifted before the handler ran).
  }
}

export class TouchControls {
  getCellPx: () => number;
  queue: Button[];
  pulse: Button | null;
  releaseFrame: boolean;
  held: Set<Button>;
  tapped: Set<Button>;
  gesture: Gesture | null;
  onAnyInput: (() => void) | null;

  /**
   * @param surface element that receives board gestures
   * @param buttons element holding <button data-action="..."> children
   * @param getCellPx () => size of one board cell in CSS pixels
   */
  constructor(surface: HTMLElement, buttons: ParentNode, getCellPx: () => number) {
    this.getCellPx = getCellPx;
    this.queue = [];
    this.pulse = null; // button pressed this frame
    this.releaseFrame = false;
    this.held = new Set(); // buttons held via the button bar
    this.tapped = new Set(); // pressed since last frame, so quick taps count
    this.gesture = null;
    this.onAnyInput = null;

    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', () => (this.gesture = null));

    for (const btn of buttons.querySelectorAll<HTMLElement>('[data-action]')) {
      const action = btn.dataset.action as Button;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(btn, e.pointerId);
        this.held.add(action);
        this.tapped.add(action);
        btn.classList.add('active');
        navigator.vibrate?.(8);
        this.onAnyInput?.();
      });
      const release = () => {
        this.held.delete(action);
        btn.classList.remove('active');
      };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  push(button: Button) {
    if (this.queue.length < MAX_QUEUE) this.queue.push(button);
  }

  down(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    capture(e.currentTarget as Element, e.pointerId);
    this.gesture = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      anchorX: e.clientX,
      anchorY: e.clientY,
      startTime: performance.now(),
      moved: false,
      axis: null,
      samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    };
    this.onAnyInput?.();
  }

  move(e: PointerEvent) {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    const now = performance.now();
    g.samples.push({ x: e.clientX, y: e.clientY, t: now });
    while (g.samples.length > 2 && now - g.samples[0].t > FLICK_WINDOW_MS) g.samples.shift();
    const cell = Math.max(8, this.getCellPx());
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > TAP_MAX_PX) g.moved = true;
    if (!g.moved) return;

    // Lock to the dominant axis so a sideways drag doesn't also soft drop.
    if (!g.axis) g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';

    if (g.axis === 'x') {
      while (e.clientX - g.anchorX >= cell) {
        this.push('right');
        g.anchorX += cell;
      }
      while (g.anchorX - e.clientX >= cell) {
        this.push('left');
        g.anchorX -= cell;
      }
    } else {
      while (e.clientY - g.anchorY >= cell) {
        this.push('down');
        g.anchorY += cell;
      }
    }
  }

  up(e: PointerEvent) {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.gesture = null;
    const now = performance.now();
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const cell = Math.max(8, this.getCellPx());

    if (!g.moved && now - g.startTime < TAP_MAX_MS) {
      this.push('a');
      return;
    }

    // A flick is judged by how fast the finger was moving when it lifted,
    // so "drag, pause, flick" works as well as a single quick swipe.
    const ref = g.samples[0];
    const vy = (e.clientY - ref.y) / Math.max(1, now - ref.t);
    const vertical = Math.abs(dy) > Math.abs(dx) * 1.5;
    if (vertical && vy > FLICK_SPEED && dy > cell) {
      // Drop the soft-drop steps this swipe queued; the hard drop covers them.
      this.queue = this.queue.filter((b) => b !== 'down');
      this.push('up');
    } else if (vertical && vy < -FLICK_SPEED && dy < -cell * 2) {
      this.push('rb');
    }
  }

  /** State to merge into player 1's input for this frame. */
  getState(): PadState {
    const state = emptyState();
    for (const b of this.held) state[b] = true;
    for (const b of this.tapped) state[b] = true;
    if (this.pulse) state[this.pulse] = true;
    return state;
  }

  /** Advance the pulse queue; call once per frame after reading state. */
  endFrame() {
    this.tapped.clear();
    if (this.pulse) {
      // Release for one frame so the next pulse is a fresh press.
      this.pulse = null;
      return;
    }
    this.pulse = this.queue.shift() ?? null;
  }
}
