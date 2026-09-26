import './style.css';
import { Audio } from './audio.js';
import { GameScreen } from './game/gameScreen.js';
import { Input } from './game/input.js';
import { Renderer } from './render/renderer.js';
import { FONT } from './render/textPlane.js';

const PLAYER_COUNT = 2;
const MAX_FRAME_MS = 100;

const audio = new Audio();
const input = new Input();
const renderer = new Renderer(document.getElementById('app'), PLAYER_COUNT);
const overlay = document.getElementById('start');

let game = null;
let last = performance.now();

document.fonts?.load(`32px ${FONT}`).then(() => renderer.refreshText());

function start() {
  if (game) return;
  overlay.classList.add('hidden');
  audio.unlock();
  game = new GameScreen({ playerCount: PLAYER_COUNT, sounds: audio });
  game.onHardDrop = () => renderer.addShake(0.25);
  game.onTetris = () => renderer.addShake(0.9);
  game.onBoom = () => renderer.addShake(1.4);
  // Don't let the key that dismissed the overlay count as a fresh press.
  game.oldStates = game.oldStates.map((_, i) => input.getState(i));
}

input.onAnyInput = start;
overlay.addEventListener('click', start);

function frame(now) {
  const dt = Math.min(now - last, MAX_FRAME_MS);
  last = now;

  if (!game && input.anyPadButtonPressed()) start();

  if (game) {
    game.update(dt, (i) => input.getState(i));
    audio.update({ paused: game.pause, stopped: game.isFinished });
    renderer.draw(game, dt);
  } else {
    renderer.draw(idle, dt);
  }
  input.endFrame();
  requestAnimationFrame(frame);
}

// Attract-mode state shown behind the start overlay.
const idle = new GameScreen({ playerCount: PLAYER_COUNT });

requestAnimationFrame(frame);
