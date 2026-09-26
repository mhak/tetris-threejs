// Virtual gamepad per player, built from the Gamepad API plus a keyboard layout
// so the game is playable without controllers. Button names follow the Xbox
// layout used by the original MonoGame GameScreen.
export const BUTTONS = ['left', 'right', 'down', 'up', 'a', 'x', 'y', 'rb', 'lt', 'rt', 'start'];

export const KEYBOARD_LAYOUTS = [
  {
    left: ['KeyA'],
    right: ['KeyD'],
    down: ['KeyS'],
    up: ['KeyW'],
    a: ['KeyE'], // rotate right
    x: ['KeyQ'], // rotate left
    rb: ['KeyR'], // hold
    y: ['KeyF'], // use power
    lt: ['KeyZ'], // shift powers left
    rt: ['KeyC'], // shift powers right
    start: ['Space'],
  },
  {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    down: ['ArrowDown'],
    up: ['ArrowUp'],
    a: ['Period', 'Numpad2'],
    x: ['Comma', 'Numpad1'],
    rb: ['Slash', 'Numpad3'],
    y: ['KeyL', 'Numpad0'],
    lt: ['KeyK', 'Numpad4'],
    rt: ['Semicolon', 'Numpad6'],
    start: ['Enter', 'NumpadEnter'],
  },
];

// Standard gamepad mapping indices.
const PAD_BUTTONS = { a: 0, x: 2, y: 3, rb: 5, lt: 6, rt: 7, start: 9, up: 12, down: 13, left: 14, right: 15 };
const STICK_THRESHOLD = 0.5;

export const emptyState = () => Object.fromEntries(BUTTONS.map((b) => [b, false]));

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    // Keys pressed since the last frame, so a tap shorter than a frame still registers.
    this.tapped = new Set();
    this.onAnyInput = null;
    const gameKeys = new Set(KEYBOARD_LAYOUTS.flatMap((l) => Object.values(l).flat()));
    target.addEventListener('keydown', (e) => {
      // Leave browser shortcuts (Ctrl/Cmd/Alt + key) alone and out of the game.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (gameKeys.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.tapped.add(e.code);
      this.onAnyInput?.();
    });
    target.addEventListener('keyup', (e) => {
      // macOS doesn't send keyup for keys released while Cmd was held.
      if (e.key === 'Meta') this.keys.clear();
      else this.keys.delete(e.code);
    });
    target.addEventListener('blur', () => this.keys.clear());
  }

  /** Call once per frame after all players' states were read. */
  endFrame() {
    this.tapped.clear();
  }

  getState(playerIndex) {
    const state = emptyState();
    const layout = KEYBOARD_LAYOUTS[playerIndex];
    if (layout) {
      for (const [button, codes] of Object.entries(layout)) {
        if (codes.some((c) => this.keys.has(c) || this.tapped.has(c))) state[button] = true;
      }
    }

    const pad = getPads()[playerIndex]; // by slot, so pads keep their player
    if (pad) {
      for (const [button, idx] of Object.entries(PAD_BUTTONS)) {
        if (pad.buttons[idx]?.pressed) state[button] = true;
      }
      const [ax = 0, ay = 0] = pad.axes;
      if (ax <= -STICK_THRESHOLD) state.left = true;
      if (ax >= STICK_THRESHOLD) state.right = true;
      if (ay <= -STICK_THRESHOLD) state.up = true;
      if (ay >= STICK_THRESHOLD) state.down = true;
    }
    return state;
  }

  anyPadButtonPressed() {
    return getPads().some((p) => p?.buttons.some((b) => b.pressed));
  }
}

function getPads() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  // Keep empty slots: filtering them would shift pad 1 to player 1 on a disconnect.
  return Array.from(navigator.getGamepads());
}
