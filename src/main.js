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

const params = new URLSearchParams(location.search);
// ?debug=loopback runs a host and a guest side by side in one tab over an
// in-memory transport: the left one plays with WASD, the right one with arrows.
const DEBUG_LOOPBACK = params.get('debug') === 'loopback';

const app = document.getElementById('app');
const view = DEBUG_LOOPBACK ? splitView() : app;
const audio = new Audio();
const input = new Input({ playerCount: DEBUG_LOOPBACK ? 2 : PLAYER_COUNT });
const renderer = new Renderer(view, PLAYER_COUNT);
const touch = new TouchControls(app, document.getElementById('touch-bar'), () => renderer.pxPerUnit);
const overlay = document.getElementById('start');
const menu = document.getElementById('menu');
const lobby = new Lobby();

// Online play stays behind ?online=1 until it is finished; a ?join= link always works.
const joinParam = normalizeCode(params.get('join'));
const ONLINE = params.get('online') === '1' || isValidCode(joinParam);
document.getElementById('online-buttons').hidden = !ONLINE;

let game = null; // solo game
let session = null; // online room; its game is shown once a round starts
let debugGuest = null; // ?debug=loopback: { session, renderer } for the right half
let last = performance.now();

document.fonts?.load(`32px ${FONT}`).then(() => {
  renderer.refreshText();
  debugGuest?.renderer.refreshText();
});

function splitView() {
  app.classList.add('split');
  const left = document.createElement('div');
  const right = document.createElement('div');
  right.id = 'debug-right';
  app.append(left, right);
  return left;
}

/** The game on screen: the online one while in a room, else solo. */
function activeGame() {
  return session?.inRoom ? session.game : game;
}

function getState(i) {
  const state = input.getState(i);
  if (i !== 0) return state;
  const t = touch.getState();
  for (const [button, down] of Object.entries(t)) if (down) state[button] = true;
  // After game over (or a win), a tap on the board starts the next round.
  if (activeGame()?.isFinished && t.a) state.start = true;
  return state;
}

function addEffects(g, r = renderer) {
  g.onHardDrop = () => r.addShake(0.25);
  g.onTetris = () => r.addShake(0.9);
  g.onBoom = () => r.addShake(1.4);
}

function start() {
  if (game || session || lobby.isOpen) return;
  if (DEBUG_LOOPBACK) return startLoopback();
  overlay.classList.add('hidden');
  audio.unlock();
  game = new GameScreen({ playerCount: PLAYER_COUNT, sounds: audio });
  addEffects(game);
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
  endSession();
  showMenu();
};

async function startSession(role, { name = lobby.name, code = null } = {}) {
  endSession();
  audio.unlock();
  const { PeerTransport } = await import('./net/peerTransport.js');
  if (!lobby.isOpen) return; // cancelled while loading
  openSession(new Session({ role, name, code, sounds: audio, transport: new PeerTransport() }));
}

function openSession(s) {
  session = s;
  addEffects(s.game);
  s.onChange = () => s === session && updateSession();
  s.open();
}

function endSession() {
  session?.leave();
  session = null;
}

async function startLoopback() {
  overlay.classList.add('hidden');
  audio.unlock();
  const { LoopbackNetwork, LoopbackTransport } = await import('./net/transport.js');
  const network = new LoopbackNetwork({ latencyMs: Number(params.get('latency') ?? 40) });
  const host = new Session({ role: 'host', name: 'HOST', sounds: audio, transport: new LoopbackTransport(network) });
  openSession(host);
  await host.open();
  const guest = new Session({ role: 'guest', name: 'GUEST', code: host.code, transport: new LoopbackTransport(network) });
  debugGuest = { session: guest, renderer: new Renderer(document.getElementById('debug-right'), 2) };
  addEffects(guest.game, debugGuest.renderer);
  window.debugSessions = { host, guest }; // for poking at from the console
  guest.open();
}

/** Switches between the lobby and the match as the room changes state. */
function updateSession() {
  const s = session;
  if (s.inRoom) {
    if (!overlay.classList.contains('hidden') || renderer.boards.length !== 2) enterRoom(s);
    return;
  }
  if (s.state === 'closed' && overlay.classList.contains('hidden')) {
    leaveRoom();
    return;
  }
  updateLobby(s);
}

function enterRoom(s) {
  lobby.close();
  overlay.classList.add('hidden');
  renderer.setBoards(2);
  if (s.role === 'guest') dropJoinParam();
  // Don't let the tap or key that joined count as a fresh press.
  s.game.oldStates[0] = getState(0);
}

function leaveRoom() {
  session = null;
  renderer.setBoards(PLAYER_COUNT);
  overlay.classList.remove('hidden');
  showMenu();
}

function updateLobby(s) {
  lobby.setBusy(s.state === 'joining');
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

  if (!game && !session && !lobby.isOpen && input.anyPadButtonPressed()) start();

  const shown = activeGame();
  if (session?.inRoom) session.update(dt, getState);
  else if (game) game.update(dt, getState);
  if (shown) {
    audio.update({ paused: shown.pause, stopped: shown.isFinished });
    renderer.draw(shown, dt);
  } else {
    renderer.draw(idle, dt);
  }
  if (debugGuest) {
    const g = debugGuest.session;
    g.update(dt, (i) => (i === 0 ? input.getState(1) : input.getState(0)));
    debugGuest.renderer.draw(g.inRoom ? g.game : idle, dt);
  }
  input.endFrame();
  touch.endFrame();
  requestAnimationFrame(frame);
}

// Attract-mode state shown behind the start overlay.
const idle = new GameScreen({ playerCount: PLAYER_COUNT });

requestAnimationFrame(frame);
