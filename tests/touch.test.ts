import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TouchControls as TouchControlsType } from '../src/touch.ts';

// Minimal DOM stand-ins so TouchControls can run under node.
// A controllable clock so gesture speeds are deterministic.
let clock = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true });
globalThis.navigator ??= {} as Navigator;
const { TouchControls } = await import('../src/touch.ts');

type Handler = (e: PointerEvent) => void;

function fakeElement() {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    querySelectorAll: () => [],
  };
}

/** A fake element passed where TouchControls wants a real one. */
const asElement = (fake: object) => fake as unknown as HTMLElement;

function setup(cellPx = 30) {
  const surface = fakeElement();
  const touch = new TouchControls(asElement(surface), asElement(fakeElement()), () => cellPx);
  const ev = (x: number, y: number) =>
    ({ pointerId: 1, pointerType: 'touch', button: 0, clientX: x, clientY: y, preventDefault() {}, currentTarget: {} }) as unknown as PointerEvent;
  return { touch, surface, ev };
}

/** Collects the pressed buttons over a number of frames. */
function frames(touch: TouchControlsType, n: number) {
  const pressed: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = touch.getState();
    pressed.push((Object.keys(s) as (keyof typeof s)[]).filter((k) => s[k]).join('+') || '-');
    touch.endFrame();
  }
  return pressed;
}

test('dragging right moves one column per cell, with a release between moves', () => {
  const { touch, surface, ev } = setup(30);
  surface.handlers.pointerdown(ev(100, 100));
  surface.handlers.pointermove(ev(165, 102)); // 2 cells
  surface.handlers.pointerup(ev(165, 102));
  assert.deepEqual(frames(touch, 5), ['-', 'right', '-', 'right', '-']);
});

test('a tap rotates right', () => {
  const { touch, surface, ev } = setup();
  surface.handlers.pointerdown(ev(100, 100));
  surface.handlers.pointerup(ev(102, 101));
  assert.deepEqual(frames(touch, 2), ['-', 'a']);
});

test('a fast flick down hard drops instead of soft dropping', () => {
  const { touch, surface, ev } = setup(30);
  surface.handlers.pointerdown(ev(100, 100));
  surface.handlers.pointermove(ev(100, 220));
  surface.handlers.pointerup(ev(100, 220)); // well under the swipe time limit
  assert.deepEqual(frames(touch, 3), ['-', 'up', '-']);
});

test('a flick up holds', () => {
  const { touch, surface, ev } = setup(30);
  surface.handlers.pointerdown(ev(100, 300));
  surface.handlers.pointermove(ev(100, 200));
  surface.handlers.pointerup(ev(100, 200));
  assert.deepEqual(frames(touch, 2), ['-', 'rb']);
});

test('a slow drag down only soft drops', () => {
  const { touch, surface, ev } = setup(30);
  clock = 0;
  surface.handlers.pointerdown(ev(100, 100));
  for (let i = 1; i <= 4; i++) {
    clock += 200;
    surface.handlers.pointermove(ev(100, 100 + i * 30));
  }
  clock += 200;
  surface.handlers.pointerup(ev(100, 220));
  assert.deepEqual(frames(touch, 8), ['-', 'down', '-', 'down', '-', 'down', '-', 'down']);
});

test('drag, pause, then flick down hard drops', () => {
  const { touch, surface, ev } = setup(30);
  clock = 0;
  surface.handlers.pointerdown(ev(100, 100));
  clock += 400;
  surface.handlers.pointermove(ev(130, 102)); // slow move right
  clock += 600;
  surface.handlers.pointermove(ev(130, 104)); // pause
  clock += 40;
  surface.handlers.pointermove(ev(131, 180)); // flick
  clock += 10;
  surface.handlers.pointerup(ev(131, 190));
  // Axis locked to x by the first move, but the release flick still counts.
  assert.ok(frames(touch, 6).includes('up'));
});

test('a button tap shorter than a frame still registers', () => {
  const btn = {
    dataset: { action: 'start' },
    classList: { add() {}, remove() {} },
    handlers: {} as Record<string, Handler>,
    addEventListener: (type: string, fn: Handler) => (btn.handlers[type] = fn),
  };
  const bar = { addEventListener() {}, querySelectorAll: () => [btn] };
  const touch = new TouchControls(asElement(fakeElement()), asElement(bar), () => 30);
  btn.handlers.pointerdown({ pointerId: 1, preventDefault() {} } as unknown as PointerEvent);
  btn.handlers.pointerup({ pointerId: 1 } as unknown as PointerEvent);
  assert.deepEqual(frames(touch, 2), ['start', '-']);
});
