import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../src/game/input.ts';

type Handler = (e: KeyboardEvent) => void;

function setup() {
  const handlers: Record<string, Handler> = {};
  const target = { addEventListener: (type: string, fn: Handler) => (handlers[type] = fn) };
  const input = new Input({ target: target as unknown as Window, playerCount: 1 });
  const key = (code: string, tagName = 'BODY') => {
    const e = { code, key: code, target: { tagName }, defaultPrevented: false, preventDefault() {} };
    e.preventDefault = () => (e.defaultPrevented = true);
    handlers.keydown(e as unknown as KeyboardEvent);
    return e;
  };
  return { input, key };
}

test('game keys are blocked and become game input', () => {
  const { input, key } = setup();
  let any = 0;
  input.onAnyInput = () => any++;
  const e = key('KeyA');
  assert.equal(e.defaultPrevented, true);
  assert.equal(input.getState(0).left, true);
  assert.equal(any, 1);
});

test('keys typed into a text field are not blocked or turned into game input', () => {
  const { input, key } = setup();
  let any = 0;
  input.onAnyInput = () => any++;
  for (const code of ['KeyA', 'KeyQ', 'KeyW', 'Space', 'Enter']) {
    assert.equal(key(code, 'INPUT').defaultPrevented, false, code);
  }
  assert.equal(key('KeyD', 'TEXTAREA').defaultPrevented, false);
  const state = input.getState(0);
  assert.ok(Object.values(state).every((v) => !v));
  assert.equal(any, 0);
});

test('Space and Enter on a focused button press the button, not Start', () => {
  const { input, key } = setup();
  let any = 0;
  input.onAnyInput = () => any++;
  assert.equal(key('Space', 'BUTTON').defaultPrevented, false);
  assert.equal(key('Enter', 'BUTTON').defaultPrevented, false);
  assert.equal(input.getState(0).start, false);
  assert.equal(any, 0);
  // Other game keys still work while a button has focus.
  assert.equal(key('KeyA', 'BUTTON').defaultPrevented, true);
  assert.equal(input.getState(0).left, true);
});
