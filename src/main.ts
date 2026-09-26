import './style.css';
import { Audio } from './audio.ts';
import { GameScreen } from './game/gameScreen.ts';
import { Input, type Button, type PadState } from './game/input.ts';
import { Renderer, type BoardSpec } from './render/renderer.ts';
import { FONT } from './render/textPlane.ts';
import { TouchControls } from './touch.ts';
import { ERROR_TEXT, Lobby } from './ui/lobby.ts';
import { MatchHud } from './ui/matchHud.ts';
import { Session, roomStorage, type Role, type SavedRoom } from './net/session.ts';
import { isValidCode, normalizeCode } from './net/joinCode.ts';
import { saveName } from './net/playerName.ts';
import type { Transport } from './net/transport.ts';

// 2-player versus on one device is disabled for now; it will be added back later.
// To re-enable it, switch these lines (and uncomment the P2 controls in index.html).
const PLAYER_COUNT = 1;
// const PLAYER_COUNT = 2;
const MAX_FRAME_MS = 100;
// Online: our board full size, the opponent's as a mini board.
const ONLINE_BOARDS: BoardSpec[] = [{}, { mini: true }];

// Show touch UI on phones/tablets, or as soon as the screen is touched.
const setTouch = () => document.body.classList.add('touch');
if (window.matchMedia('(pointer: coarse)').matches) setTouch();
window.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && setTouch());

const params = new URLSearchParams(location.search);
// ?debug=loopback runs a host and a guest side by side in one tab over an
// in-memory transport: the left one plays with WASD, the right one with arrows.
const DEBUG_LOOPBACK = params.get('debug') === 'loopback';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $('app');
const view = DEBUG_LOOPBACK ? splitView() : app;
const audio = new Audio();
const input = new Input({ playerCount: DEBUG_LOOPBACK ? 2 : PLAYER_COUNT });
const renderer = new Renderer(view, PLAYER_COUNT);
const touch = new TouchControls(app, $('touch-bar'), () => renderer.pxPerUnit);
const overlay = $('start');
const menu = $('menu');
const rejoinPanel = $('rejoin');
const lobby = new Lobby();
const hud = new MatchHud();
const storage = roomStorage();

const joinParam = normalizeCode(params.get('join'));

let game: GameScreen | null = null; // solo game
let session: Session | null = null; // online room
// Set while PeerJS loads for a new session; a second request, Cancel or Leave
// replaces or clears it, so a late load can tell it is no longer wanted.
let opening: object | null = null;
let inRoom = false; // the online game is on screen (from the first countdown until Back to start)
let debugGuest: { session: Session; renderer: Renderer } | null = null; // ?debug=loopback: the right half
let last = performance.now();

document.fonts?.load(`32px ${FONT}`).then(() => {
  renderer.refreshText();
  debugGuest?.renderer.refreshText();
});

function splitView(): HTMLElement {
  app.classList.add('split');
  const left = document.createElement('div');
  const right = document.createElement('div');
  right.id = 'debug-right';
  app.append(left, right);
  return left;
}

/** The game on screen: the online one while in a room, else solo. */
function activeGame(): GameScreen | null {
  return inRoom ? session!.game : game;
}

function getState(i: number): PadState {
  const state = input.getState(i);
  if (i !== 0) return state;
  const t = touch.getState();
  for (const [button, down] of Object.entries(t) as [Button, boolean][]) if (down) state[button] = true;
  // After game over (or a win), a tap on the board starts the next round
  // (online: says we're ready for a rematch).
  if (activeGame()?.isFinished && t.a) state.start = true;
  return state;
}

function addEffects(g: GameScreen, r = renderer) {
  g.onHardDrop = () => r.addShake(0.25);
  g.onTetris = () => r.addShake(0.9);
  g.onBoom = () => r.addShake(1.4);
  g.onHit = () => r.flash(0, 'hit');
}

/** The start screen is busy with something other than "press any key". */
function menuBusy() {
  return lobby.isOpen || !rejoinPanel.hidden || !!session || !!opening;
}

function start() {
  if (game || menuBusy()) return;
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
  if (!(e?.target as Element | null)?.closest?.('button')) start();
};
overlay.addEventListener('click', start);

function showMenu() {
  lobby.close();
  rejoinPanel.hidden = true;
  menu.hidden = false;
}

function openLobby(mode: 'create' | 'join', code?: string, tapToJoin?: boolean) {
  menu.hidden = true;
  if (mode === 'create') {
    lobby.openCreate();
    startSession('host');
  } else {
    lobby.openJoin(code, { tapToJoin });
  }
}

for (const [id, mode] of [['create-room', 'create'], ['join-room', 'join']] as const) {
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    openLobby(mode);
  });
}

lobby.onJoin = (_name, code) => startSession('guest', { code });
// The host can still change its name while it waits; it is sent when the guest arrives.
lobby.onNameChange = (name) => session?.setLocalName(name);
lobby.onCancel = () => {
  endSession();
  showMenu();
};

async function newTransport(): Promise<Transport> {
  const { PeerTransport } = await import('./net/peerTransport.ts');
  return new PeerTransport();
}

/**
 * Loads PeerJS, then returns a transport, or null if this request was
 * cancelled or replaced meanwhile. Throws if the download failed.
 */
async function loadTransport(): Promise<Transport | null> {
  const ticket = {};
  opening = ticket;
  try {
    const transport = await newTransport();
    return opening === ticket ? transport : null;
  } finally {
    if (opening === ticket) opening = null;
  }
}

async function startSession(role: Role, { code = null }: { code?: string | null } = {}) {
  endSession();
  audio.unlock();
  lobby.setBusy(true); // no second join while PeerJS loads
  let transport: Transport | null;
  try {
    transport = await loadTransport();
  } catch {
    lobby.setBusy(false);
    lobby.showError('load');
    return;
  }
  if (!transport) return; // cancelled or replaced while loading
  // The name as it is now: the host may have edited it while PeerJS loaded.
  openSession(new Session({ role, name: lobby.name, code, sounds: audio, storage, transport }));
}

/** Makes `s` the current session and opens it; resolves when open() does. */
function openSession(s: Session): Promise<void> {
  session = s;
  addEffects(s.game);
  s.onAttackSent = () => renderer.flash(1, 'attack');
  s.onChange = () => s === session && updateSession();
  return s.open();
}

function endSession() {
  opening = null;
  // Forget it first: leaving fires one last onChange.
  const s = session;
  session = null;
  s?.leave();
}

async function startLoopback() {
  opening = {}; // start() must not run again while this sets up
  overlay.classList.add('hidden');
  audio.unlock();
  const { LoopbackNetwork, LoopbackTransport } = await import('./net/transport.ts');
  const network = new LoopbackNetwork({ latencyMs: Number(params.get('latency') ?? 40) });
  const host = new Session({ role: 'host', name: 'HOST', sounds: audio, transport: new LoopbackTransport(network) });
  opening = null;
  await openSession(host); // registers the room and picks its code
  const guest = new Session({ role: 'guest', name: 'GUEST', code: host.code, transport: new LoopbackTransport(network) });
  const guestRenderer = new Renderer($('debug-right'), ONLINE_BOARDS);
  debugGuest = { session: guest, renderer: guestRenderer };
  addEffects(guest.game, guestRenderer);
  guest.onAttackSent = () => guestRenderer.flash(1, 'attack');
  window.debugSessions = { host, guest, network }; // for poking at from the console
  guest.open();
}

/** Switches between the lobby and the match as the room changes state. */
function updateSession() {
  const s = session!;
  if (s.inRoom && !inRoom) enterRoom(s);
  if (inRoom) {
    // Also after the room ends, to show why (Leave goes through leaveRoom instead).
    hud.render(s);
    return;
  }
  updateLobby(s);
}

function enterRoom(s: Session) {
  inRoom = true;
  lobby.close();
  rejoinPanel.hidden = true;
  overlay.classList.add('hidden');
  renderer.setBoards(ONLINE_BOARDS);
  if (s.role === 'guest') dropJoinParam();
  // Remember the name that was actually sent (the host may have edited it while waiting).
  saveName(s.localName);
  if (!s.restored) hud.toast(s.isHost ? `${s.names[1]} JOINED` : `JOINED ${s.names[1]}`);
  // Don't let the tap or key that joined count as a fresh press.
  s.game.oldStates[0] = getState(0);
}

function leaveRoom() {
  inRoom = false;
  endSession();
  hud.hide();
  renderer.setBoards(PLAYER_COUNT);
  overlay.classList.remove('hidden');
  showMenu();
}

hud.onRematch = () => session?.sendReady();
hud.onResume = () => session?.resume();
hud.onLeave = () => leaveRoom();
hud.onBack = () => leaveRoom();

function updateLobby(s: Session) {
  lobby.setBusy(s.state === 'joining');
  switch (s.state) {
    case 'hosting':
      lobby.setStatus('CREATING ROOM...');
      break;
    case 'waiting':
      lobby.showCode(s.code!, joinUrl(s.code!));
      lobby.setStatus(
        s.notice === 'version' ? 'SOMEONE TRIED TO JOIN FROM A DIFFERENT VERSION.' : 'WAITING FOR OPPONENT...',
      );
      break;
    case 'joining':
      lobby.setStatus('CONNECTING...');
      break;
    case 'closed':
      if (s.closeReason !== 'left') lobby.showError(s.closeReason);
      session = null;
      break;
  }
}

/**
 * The link a guest opens to join. Built from the page's own address, not
 * import.meta.env.BASE_URL, which is './' in the build and would lose the
 * /tetris-threejs/ path.
 */
function joinUrl(code: string): string {
  const url = new URL(location.href);
  url.search = '?join=' + code;
  url.hash = '';
  return url.href;
}

/** A reload after joining must not try to join a finished room again. */
function dropJoinParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('join')) return;
  url.searchParams.delete('join');
  history.replaceState(null, '', url);
}

// After a reload in the middle of a room: offer to rejoin it. The tap is
// needed anyway, since audio only starts after a user gesture.
function offerRejoin(saved: SavedRoom) {
  menu.hidden = true;
  rejoinPanel.hidden = false;
  const text = $('rejoin-text');
  text.textContent = `ROOM ${saved.code} WITH ${saved.names[1]}`;
  $('rejoin-go').onclick = async (e) => {
    e.stopPropagation();
    const button = e.currentTarget as HTMLButtonElement;
    if (button.disabled) return; // one rejoin per saved room, however many taps
    button.disabled = true;
    audio.unlock();
    let transport: Transport | null;
    try {
      transport = await loadTransport();
    } catch {
      button.disabled = false;
      text.textContent = ERROR_TEXT.load;
      text.dataset.tone = 'error';
      return;
    }
    if (!transport) return; // left while loading
    const s = Session.restore(saved, { sounds: audio, storage, transport });
    if (!s) return showMenu();
    openSession(s);
  };
  $('rejoin-leave').onclick = (e) => {
    e.stopPropagation();
    opening = null;
    storage.clear();
    showMenu();
  };
  rejoinPanel.addEventListener('click', (e) => e.stopPropagation());
}

const saved = storage.load();
if (!DEBUG_LOOPBACK && Session.canRestore(saved)) offerRejoin(saved);
else if (isValidCode(joinParam)) openLobby('join', joinParam, true);

// Keep the room's lastSeen fresh for a reload (it isn't written every second).
window.addEventListener('pagehide', () => session?.save());

// Pause when the tab or app goes to the background (e.g. a phone call).
// Online this pauses both players.
document.addEventListener('visibilitychange', () => {
  if (session) session.setHidden(document.hidden);
  debugGuest?.session.setHidden(document.hidden);
  if (document.hidden && game && !game.isFinished) game.pause = true;
});

function frame(now: number) {
  const dt = Math.min(now - last, MAX_FRAME_MS);
  last = now;

  if (!game && !menuBusy() && input.anyPadButtonPressed()) start();

  const shown = activeGame();
  if (inRoom) session!.update(dt, getState);
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
