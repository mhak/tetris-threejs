import './style.css';
import { Audio } from './audio.js';
import { GameScreen } from './game/gameScreen.js';
import { Input } from './game/input.js';
import { Renderer } from './render/renderer.js';
import { FONT } from './render/textPlane.js';
import { TouchControls } from './touch.js';
import { Lobby } from './ui/lobby.js';
import { Session } from './net/session.js';
import { isValidCode, normalizeCode } from './net/joinCode.js';

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
const menu = document.getElementById('menu');
const lobby = new Lobby();

// Online play stays behind ?online=1 until it is finished; a ?join= link always works.
const params = new URLSearchParams(location.search);
const joinParam = normalizeCode(params.get('join'));
const ONLINE = params.get('online') === '1' || isValidCode(joinParam);
document.getElementById('online-buttons').hidden = !ONLINE;

let game = null;
let session = null;
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
  if (game || lobby.isOpen) return;
  overlay.classList.add('hidden');
  audio.unlock();
  game = new GameScreen({ playerCount: PLAYER_COUNT, sounds: audio });
  game.onHardDrop = () => renderer.addShake(0.25);
  game.onTetris = () => renderer.addShake(0.9);
  game.onBoom = () => renderer.addShake(1.4);
  // Don't let the key that dismissed the overlay count as a fresh press.
  game.oldStates = game.oldStates.map((_, i) => getState(i));
}

// Any key or click on the start screen starts solo play, except on the online
// controls and while the create / join panel is open.
input.onAnyInput = (e) => {
  if (!e?.target?.closest?.('button')) start();
};
overlay.addEventListener('click', start);

function showMenu() {
  lobby.close();
  menu.hidden = false;
}

function openLobby(mode, code, tapToJoin) {
  menu.hidden = true;
  if (mode === 'create') {
    lobby.openCreate();
    startSession('host');
  } else {
    lobby.openJoin(code, { tapToJoin });
  }
}

for (const [id, mode] of [['create-room', 'create'], ['join-room', 'join']]) {
  document.getElementById(id).addEventListener('click', (e) => {
    e.stopPropagation();
    openLobby(mode);
  });
}

lobby.onJoin = (name, code) => startSession('guest', { name, code });
// The host can still change its name while it waits; it is sent when the guest arrives.
lobby.onNameChange = (name) => session?.setLocalName(name);
lobby.onCancel = () => {
  session?.leave();
  session = null;
  showMenu();
};

async function startSession(role, { name = lobby.name, code = null } = {}) {
  session?.leave();
  audio.unlock();
  const { PeerTransport } = await import('./net/peerTransport.js');
  if (!lobby.isOpen) return; // cancelled while loading
  const s = new Session({ role, name, code, transport: new PeerTransport() });
  session = s;
  s.onChange = () => s === session && updateLobby();
  s.open();
}

function updateLobby() {
  const s = session;
  lobby.setBusy(s.state === 'joining' || s.state === 'connected');
  switch (s.state) {
    case 'hosting':
      lobby.setStatus('CREATING ROOM...');
      break;
    case 'waiting':
      lobby.showCode(s.code);
      lobby.setStatus(
        s.notice === 'version' ? 'SOMEONE TRIED TO JOIN FROM A DIFFERENT VERSION.' : 'WAITING FOR OPPONENT...',
      );
      break;
    case 'joining':
      lobby.setStatus('CONNECTING...');
      break;
    case 'connected':
      lobby.lockName();
      lobby.setStatus(`CONNECTED TO ${s.remoteName}`, 'ok');
      if (s.role === 'guest') dropJoinParam();
      break;
    case 'closed':
      if (s.closeReason !== 'left') lobby.showError(s.closeReason);
      break;
  }
}

/** A reload after joining must not try to join a finished room again. */
function dropJoinParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('join')) return;
  url.searchParams.delete('join');
  history.replaceState(null, '', url);
}

if (isValidCode(joinParam)) openLobby('join', joinParam, true);

// Pause when the tab or app goes to the background (e.g. a phone call).
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !game.isFinished) game.pause = true;
});

function frame(now) {
  const dt = Math.min(now - last, MAX_FRAME_MS);
  last = now;

  if (!game && !lobby.isOpen && input.anyPadButtonPressed()) start();

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
