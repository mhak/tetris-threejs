import './style.css';
import { Audio } from './audio.js';
import { GameScreen } from './game/gameScreen.js';
import { Input } from './game/input.js';
import { Renderer } from './render/renderer.js';
import { FONT } from './render/textPlane.js';
import { TouchControls } from './touch.js';

// 2-player versus is disabled for now; it will be added back later.
// To re-enable it, switch these lines (and uncomment the P2 controls in index.html).
const PLAYER_COUNT = 1;
// const PLAYER_COUNT = 2;
const MAX_FRAME_MS = 100;

// Show touch UI on phones/tablets, or as soon as the screen is touched.
const setTouch = () => document.body.classList.add('touch');
if (window.matchMedia('(pointer: coarse)').matches) setTouch();
window.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && setTouch());

const app = document.getElementById('app');
const audio = new Audio();
const input = new Input({ playerCount: PLAYER_COUNT });
const renderer = new Renderer(app, PLAYER_COUNT);
const touch = new TouchControls(app, document.getElementById('touch-bar'), () => renderer.pxPerUnit);
const overlay = document.getElementById('start');

let game = null;
let last = performance.now();

document.fonts?.load(`32px ${FONT}`).then(() => renderer.refreshText());

function getState(i) {
  const state = input.getState(i);
  if (i !== 0) return state;
  const t = touch.getState();
  for (const [button, down] of Object.entries(t)) if (down) state[button] = true;
  // After game over (or a win), a tap on the board starts the next round.
  if (game?.isFinished && t.a) state.start = true;
  return state;
}

function start() {
  if (game) return;
  overlay.classList.add('hidden');
  audio.unlock();
  game = new GameScreen({ playerCount: PLAYER_COUNT, sounds: audio });
  game.onHardDrop = () => renderer.addShake(0.25);
  game.onTetris = () => renderer.addShake(0.9);
  game.onBoom = () => renderer.addShake(1.4);
  // Don't let the key that dismissed the overlay count as a fresh press.
  game.oldStates = game.oldStates.map((_, i) => getState(i));
}

input.onAnyInput = start;
overlay.addEventListener('click', start);

// Pause when the tab or app goes to the background (e.g. a phone call).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !game.isFinished) game.pause = true;
});

function frame(now) {
  const dt = Math.min(now - last, MAX_FRAME_MS);
  last = now;

  if (!game && input.anyPadButtonPressed()) start();

  if (game) {
    game.update(dt, getState);
    audio.update({ paused: game.pause, stopped: game.isFinished });
    renderer.draw(game, dt);
  } else {
    renderer.draw(idle, dt);
  }
  input.endFrame();
  touch.endFrame();
  requestAnimationFrame(frame);
}

// Attract-mode state shown behind the start overlay.
const idle = new GameScreen({ playerCount: PLAYER_COUNT });

requestAnimationFrame(frame);
