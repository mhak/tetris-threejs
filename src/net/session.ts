// Room state machine for online play (docs/online-2p-spec.md, sections 2, 4.5 and 5 to 7).
//
//   idle -> hosting -> waiting -> countdown -> playing -> roundOver -> countdown ...
//   idle -> joining -> countdown
//   countdown | playing <-> paused
//   countdown | playing | paused | roundOver -> reconnecting -> (countdown | paused | roundOver | closed)
//   any -> closed (bye, cancel, fatal error, grace period over)
//
// Each device runs the rules for its own board only and sends the other one
// snapshots (to draw) and attacks (the only thing that changes the other
// board). The host starts every round and decides every result, so both
// screens always agree.
import { BUILD_ID, MSG, isMessage, snapshotOf, type Message } from './protocol.ts';
import { cleanName, displayNames } from './playerName.ts';
import { generateCode, isValidCode, type RandomValues } from './joinCode.ts';
import type { Transport, TransportError, TransportState } from './transport.ts';
import { GameScreen, type GameResult } from '../game/gameScreen.ts';
import type { AttackKind, RemoteField } from '../game/remoteField.ts';
import type { PadState } from '../game/input.ts';
import type { Sounds } from '../game/tetrisField.ts';
import { randomSeed } from '../game/random.ts';

export type Role = 'host' | 'guest';
export type Winner = Role | 'draw';
export type SessionState =
  | 'idle'
  | 'hosting'
  | 'waiting'
  | 'joining'
  | 'countdown'
  | 'playing'
  | 'paused'
  | 'roundOver'
  | 'reconnecting'
  | 'closed';
// Why the session closed: 'not-found' | 'full' | 'failed' | 'version' | 'taken'
// | 'left' (we left) | 'bye' (they left) | 'lost' (no winner)
// | 'forfeit-win' (they went away) | 'forfeit-lose' (we went away).
export type CloseReason =
  | 'not-found'
  | 'full'
  | 'failed'
  | 'version'
  | 'taken'
  | 'left'
  | 'bye'
  | 'lost'
  | 'forfeit-win'
  | 'forfeit-lose';

export type TimerId = ReturnType<typeof setTimeout> | number;

/** Time and timers, so tests can run them by hand. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}

/** The room as kept across a reload, see Session.save(). */
export interface SavedRoom {
  role: Role;
  code: string;
  names: [string, string];
  token: string;
  wins: Record<Role, number>;
  round: number;
  seed: number | null;
  result: Winner | null;
  lastSeen: number;
}

export interface RoomStorage {
  load(): unknown;
  save(room: SavedRoom): void;
  clear(): void;
}

export interface SessionOptions {
  role: Role;
  transport: Transport;
  name?: unknown;
  code?: string | null;
  sounds?: Sounds;
  storage?: RoomStorage | null;
  clock?: Clock;
  buildId?: string;
  makeCode?: () => string;
  makeSeed?: () => number;
}

/** Session.restore(): the options from the saved room come from there. */
export type RestoreOptions = Omit<SessionOptions, 'role' | 'code' | 'name'>;

export const JOIN_TIMEOUT_MS = 15000;
export const COUNTDOWN_MS = 3000;
export const RESULT_WINDOW_MS = 250; // a second top-out this soon after the first is a draw
export const PING_MS = 1000;
export const LIVENESS_MS = 5000; // no message for this long: the connection is lost
export const GRACE_MS = 30000; // how long a lost connection may take to come back
export const RETRY_MS = 2000;
const ATTEMPT_MS = 8000; // one reconnect attempt, from connecting to the host's sync
const HOST_CODE_TRIES = 5;
const SNAPSHOT_MS = 50; // at most 20 snapshots a second
const ATTACKS: readonly unknown[] = ['line', 'drop'] satisfies AttackKind[];
const WINNERS: readonly unknown[] = ['host', 'guest', 'draw'] satisfies Winner[];
const IN_ROUND: readonly SessionState[] = ['countdown', 'playing', 'paused'];
const IN_ROOM: readonly SessionState[] = [...IN_ROUND, 'roundOver', 'reconnecting'];
const ROOM_KEY = 'tetris-threejs-room';

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

/** Random resume token the host hands out in its hello. */
export function newToken(getRandomValues: RandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  return Array.from(getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The room as kept in sessionStorage across a reload: role, code, names,
 * token, wins and round. Nothing about the board: a reload loses the round.
 */
export function roomStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = globalThis.sessionStorage,
): RoomStorage {
  return {
    load() {
      try {
        return JSON.parse(storage.getItem(ROOM_KEY) ?? 'null');
      } catch {
        return null;
      }
    },
    save(room) {
      try {
        storage.setItem(ROOM_KEY, JSON.stringify(room));
      } catch {
        // Storage disabled: a reload just ends the room.
      }
    },
    clear() {
      try {
        storage.removeItem(ROOM_KEY);
      } catch {
        // As above.
      }
    },
  };
}

const count = (v: unknown): number => (isInt(v) && v >= 0 ? v : 0);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isAttack = (v: unknown): v is AttackKind => ATTACKS.includes(v);
const isWinner = (v: unknown): v is Winner => WINNERS.includes(v);
/** The counts in a wins object from the network or storage. */
const winsFrom = (v: unknown): Record<Role, number> => {
  const w = v as Partial<Record<Role, unknown>> | null | undefined;
  return { host: count(w?.host), guest: count(w?.guest) };
};

/** An outgoing hello; see MSG.hello. */
interface Hello {
  t: typeof MSG.hello;
  v: string;
  name: string;
  token?: string;
}

export class Session {
  role: Role;
  transport: Transport;
  localName: string;
  remoteName: string | null;
  code: string | null;
  storage: RoomStorage | null;
  clock: Clock;
  buildId: string;
  makeCode: () => string;
  makeSeed: () => number;
  token: string | null;
  state: SessionState;
  closeReason: CloseReason | null;
  notice: 'version' | null;
  timeouts: Set<TimerId>;
  restored: boolean;

  round: number;
  seed: number | null;
  result: Winner | null;
  wins: Record<Role, number>;
  ready: Record<Role, boolean>;
  firstOver: Role | null;
  overTimer: TimerId;
  joinTimer: TimerId = 0;

  connected: boolean;
  lastHeard: number;
  latency: number | null;
  pingTimer: TimerId;
  graceDeadline: number;
  wasPaused: boolean;
  reconnecting: boolean;
  wake: (() => void) | null;
  hiddenAt: number | null;
  remoteAway: boolean;

  game: GameScreen;
  lastSnapshot: string;
  lastSnapshotAt: number;
  onChange: () => void;
  onAttackSent: (kind: AttackKind) => void;

  /**
   * @param role 'host' | 'guest'
   * @param transport a Transport (PeerTransport, or LoopbackTransport in tests)
   * @param code the room to join (guest only; the host makes its own)
   * @param storage where the room is kept across a reload (see roomStorage)
   */
  constructor({
    role,
    transport,
    name,
    code = null,
    sounds,
    storage = null,
    clock = realClock,
    buildId = BUILD_ID,
    makeCode = generateCode,
    makeSeed = randomSeed,
  }: SessionOptions) {
    this.role = role;
    this.transport = transport;
    this.localName = cleanName(name);
    this.remoteName = null;
    this.code = code;
    this.storage = storage;
    this.clock = clock;
    this.buildId = buildId;
    this.makeCode = makeCode;
    this.makeSeed = makeSeed;
    this.token = null;
    this.state = 'idle';
    // Why the session closed, see CloseReason.
    this.closeReason = null;
    // Something the host should mention while it keeps waiting, e.g. 'version'.
    this.notice = null;
    this.timeouts = new Set();
    this.restored = false;

    this.round = 0;
    this.seed = null;
    this.result = null; // this round's winner: 'host' | 'guest' | 'draw'
    this.wins = { host: 0, guest: 0 };
    this.ready = { host: false, guest: false };
    this.firstOver = null; // host: who topped out first this round, while the draw window is open
    this.overTimer = 0;

    // Connection health and reconnecting.
    this.connected = false;
    this.lastHeard = 0;
    this.latency = null;
    this.pingTimer = 0;
    this.graceDeadline = 0;
    this.wasPaused = false; // the room was paused when the connection went
    this.reconnecting = false;
    this.wake = null;
    // When our page went to the background, or null while it is visible.
    this.hiddenAt = null;
    // The other side said it went to the background (pause with reason
    // 'hidden') and hasn't said it's back since.
    this.remoteAway = false;

    // Player 0 is our board, player 1 mirrors the opponent's snapshots.
    this.game = new GameScreen({ online: true, sounds });
    this.game.onAttack = (kind) => this.sendAttack(kind);
    this.game.onOver = () => this.localOver();
    this.game.onStartPressed = () => this.pressStart();
    this.lastSnapshot = ''; // cheap signature of the last snapshot sent
    this.lastSnapshotAt = -Infinity;
    this.onChange = () => {};
    this.onAttackSent = () => {};
    transport.onMessage = (msg, conn) => this.receive(msg, conn);
    transport.onState = (state) => this.transportState(state);
  }

  /**
   * A session for the room saved before a page reload, or null if there is
   * none or it is too old to come back to.
   */
  static restore(saved: unknown, options: RestoreOptions): Session | null {
    if (!Session.canRestore(saved, (options.clock ?? realClock).now())) return null;
    const { role, code, names, token, wins, round, seed, result } = saved;
    const s = new Session({ ...options, role, code, name: names[0] });
    s.remoteName = cleanName(names[1]);
    s.token = token;
    s.wins = winsFrom(wins);
    s.round = round;
    s.seed = (seed as number) >>> 0;
    s.result = isWinner(result) ? result : null;
    s.restored = true;
    return s;
  }

  /** A saved room is worth offering when it is whole and recent enough to come back to. */
  static canRestore(saved: unknown, now = Date.now()): saved is SavedRoom {
    if (!saved || typeof saved !== 'object') return false;
    const { role, code, names, token, round, lastSeen } = saved as Partial<Record<keyof SavedRoom, unknown>>;
    return (
      (role === 'host' || role === 'guest') &&
      isValidCode(code) &&
      typeof token === 'string' &&
      Array.isArray(names) &&
      isInt(round) &&
      round >= 1 &&
      now - (lastSeen as number) < GRACE_MS
    );
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  get other(): Role {
    return this.isHost ? 'guest' : 'host';
  }

  get isOpen(): boolean {
    return this.state !== 'idle' && this.state !== 'closed';
  }

  /** True once the first round has started: the game is shown instead of the lobby. */
  get inRoom(): boolean {
    return IN_ROOM.includes(this.state);
  }

  /** [local, remote] names as shown on screen. */
  get names(): [string, string] {
    return displayNames(this.localName, this.remoteName ?? '');
  }

  /** The winner's display name, or null for a draw or no result. */
  get winnerName(): string | null {
    if (!this.result || this.result === 'draw') return null;
    return this.names[this.result === this.role ? 0 : 1];
  }

  /** Wins as [local, remote]. */
  get score(): [number, number] {
    return [this.wins[this.role], this.wins[this.other]];
  }

  /** Our page is in the background. */
  get localAway(): boolean {
    return this.hiddenAt !== null;
  }

  /** Whole seconds left before a lost connection ends the room. */
  get graceLeft(): number {
    return Math.max(0, Math.ceil((this.graceDeadline - this.clock.now()) / 1000));
  }

  /** The name can change until it has been sent in hello. */
  setLocalName(name: unknown) {
    if (this.remoteName === null) this.localName = cleanName(name);
  }

  setState(state: SessionState) {
    this.state = state;
    this.onChange();
  }

  after(ms: number, fn: () => void): TimerId {
    const id = this.clock.setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  cancel(id: TimerId) {
    if (!id) return;
    this.clock.clearTimeout(id);
    this.timeouts.delete(id);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  send(message: object) {
    this.transport.send(message);
  }

  /** Keeps the room for a reload. Also called on pagehide, so lastSeen is fresh. */
  save() {
    // A closed room is gone for both sides: a reload must not offer it again.
    if (this.state === 'closed') return;
    if (!this.storage || !this.token || this.remoteName === null || this.round < 1) return;
    this.storage.save({
      role: this.role,
      code: this.code as string,
      names: [this.localName, this.remoteName],
      token: this.token,
      wins: this.wins,
      round: this.round,
      seed: this.seed,
      result: this.result,
      lastSeen: this.clock.now(),
    });
  }

  // #region joining

  /** Create or join the room (or get back into it after a reload). */
  async open() {
    if (this.restored) await this.rejoin();
    else if (this.isHost) await this.hostRoom();
    else await this.joinRoom();
  }

  async hostRoom() {
    this.setState('hosting');
    for (let i = 0; i < HOST_CODE_TRIES; i++) {
      const code = this.makeCode();
      try {
        await this.transport.host(code);
      } catch (err) {
        if (this.state !== 'hosting') return;
        if ((err as TransportError | undefined)?.code === 'taken') continue;
        return this.fail('failed');
      }
      if (this.state !== 'hosting') return;
      this.code = code;
      this.token = newToken();
      this.setState('waiting');
      return;
    }
    this.fail('taken');
  }

  async joinRoom() {
    this.setState('joining');
    // One budget for the whole join: channel open, the host's hello and start.
    this.joinTimer = this.after(JOIN_TIMEOUT_MS, () => this.fail('failed'));
    try {
      await this.transport.join(this.code as string, { timeoutMs: JOIN_TIMEOUT_MS });
    } catch (err) {
      if (this.state === 'joining') this.fail((err as TransportError | undefined)?.code === 'not-found' ? 'not-found' : 'failed');
      return;
    }
    if (this.state !== 'joining') return;
    this.sendHello();
  }

  sendHello() {
    const hello: Hello = { t: MSG.hello, v: this.buildId, name: this.localName };
    if (this.token) hello.token = this.token;
    this.send(hello);
  }

  /** Host: a new connection says hello. Let it in, or turn it away. */
  receiveCandidate(msg: Message, conn: unknown) {
    if (msg.t !== MSG.hello) return;
    if (msg.v !== this.buildId) {
      this.transport.reject(conn, { t: MSG.version, v: this.buildId });
      this.notice = 'version';
      this.onChange();
      return;
    }
    if (this.state === 'waiting') {
      this.transport.accept(conn);
      this.remoteName = cleanName(msg.name);
      this.game.names = this.names;
      this.notice = null;
      this.sendHello();
      this.markConnected();
      this.hostStartRound(1);
      return;
    }
    // Our guest coming back (reconnect or reload) carries the room's token.
    if (this.inRoom && this.token && msg.token === this.token) {
      this.transport.accept(conn);
      this.welcomeBack();
      return;
    }
    this.transport.reject(conn, { t: MSG.full });
  }

  /** Guest: the host's answer to our hello. */
  receiveHello(msg: Message) {
    if (this.isHost || (this.state !== 'joining' && this.state !== 'reconnecting')) return;
    if (msg.v !== this.buildId) {
      this.send({ t: MSG.version, v: this.buildId });
      return this.fail('version');
    }
    if (this.state === 'reconnecting') return; // the sync that follows puts us back
    this.token = typeof msg.token === 'string' ? msg.token : null;
    this.remoteName = cleanName(msg.name);
    this.game.names = this.names;
    this.markConnected();
  }

  markConnected() {
    this.connected = true;
    this.lastHeard = this.clock.now();
    this.cancel(this.joinTimer);
    this.pingTimer ||= this.clock.setInterval(() => this.tick(), PING_MS);
    this.wake?.();
    this.save();
  }

  // #endregion

  // #region rounds

  hostStartRound(round: number) {
    const seed = this.makeSeed();
    this.send({ t: MSG.start, round, seed, countdownMs: COUNTDOWN_MS });
    this.startRound(round, seed, COUNTDOWN_MS);
  }

  receiveStart(msg: Message) {
    if (this.isHost || !isInt(msg.round) || msg.round <= this.round) return;
    const countdown = Math.min(Math.max(Number(msg.countdownMs) || 0, 0), COUNTDOWN_MS * 2);
    this.startRound(msg.round, (msg.seed as number) >>> 0, countdown);
  }

  startRound(round: number, seed: number, countdownMs: number) {
    this.round = round;
    this.seed = seed;
    this.result = null;
    this.ready = { host: false, guest: false };
    this.firstOver = null;
    this.cancel(this.overTimer);
    // Both pressed ready (or joined) for this round, so both are here.
    this.remoteAway = false;
    this.game.startRound(round, seed, countdownMs);
    this.lastSnapshot = '';
    this.save();
    this.setState('countdown');
  }

  /** Once per frame: runs our board and tells the opponent what changed. */
  update(elapsedMs: number, getState: (playerIndex: number) => PadState) {
    if (!this.inRoom) return;
    this.game.update(elapsedMs, getState);
    if (this.state === 'countdown' && this.game.running) this.setState('playing');
    if (this.connected) this.sendSnapshot();
  }

  /** Sends our board when it changed, at most every SNAPSHOT_MS. */
  sendSnapshot() {
    const now = this.clock.now();
    if (now - this.lastSnapshotAt < SNAPSHOT_MS) return;
    // A short signature instead of encoding the whole board every frame:
    // field.revision changes whenever a cell does.
    const f = this.game.localField;
    const p = f.currentPiece;
    const key = `${this.round}|${f.revision}|${p?.kind}${p?.orientation},${p?.posX},${p?.posY}|${f.powers}|${f.score}|${f.lines}|${f.isGameOver}`;
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    this.lastSnapshotAt = now;
    this.send(snapshotOf(f, this.round));
  }

  sendAttack(kind: AttackKind) {
    this.send({ t: MSG.attack, round: this.round, kind });
    this.onAttackSent(kind);
  }

  receiveAttack(msg: Message) {
    if (msg.round !== this.round || !isAttack(msg.kind)) return;
    this.game.receiveAttack(msg.kind);
  }

  /** Our board topped out (or was lost to a reload). */
  localOver() {
    this.send({ t: MSG.over, round: this.round });
    if (this.isHost) this.noteOver('host', this.round);
  }

  /**
   * Host: the first player to top out loses, unless the other one also tops
   * out within RESULT_WINDOW_MS, which is a draw.
   */
  noteOver(who: Role, round: unknown) {
    if (!this.isHost || round !== this.round || this.result) return;
    if (!this.firstOver) {
      this.firstOver = who;
      this.overTimer = this.after(RESULT_WINDOW_MS, () => this.decide(who === 'host' ? 'guest' : 'host'));
    } else if (this.firstOver !== who) {
      this.decide('draw');
    }
  }

  decide(winner: Winner) {
    this.cancel(this.overTimer);
    this.firstOver = null;
    this.send({ t: MSG.result, round: this.round, winner });
    this.applyResult(this.round, winner);
  }

  applyResult(round: unknown, winner: unknown) {
    if (round !== this.round || this.result || !isWinner(winner)) return;
    this.result = winner;
    if (winner !== 'draw') this.wins[winner]++;
    this.game.result = this.gameResult(winner);
    this.save();
    if (this.state === 'reconnecting') {
      this.onChange(); // carryOn() shows it once the other side is back
    } else {
      this.game.pause = false;
      this.setState('roundOver');
    }
  }

  /** A winner as GameScreen.result sees it: our board is 0, theirs 1. */
  gameResult(winner: Winner): GameResult {
    if (winner === 'draw') return 'draw';
    return winner === this.role ? 0 : 1;
  }

  /** Ready for a rematch. The host starts the next round once both are. */
  sendReady() {
    if (this.state !== 'roundOver' || this.ready[this.role]) return;
    this.ready[this.role] = true;
    this.send({ t: MSG.ready, round: this.round });
    this.onChange();
    this.maybeStartNext();
  }

  receiveReady(msg: Message) {
    if (msg.round !== this.round || !this.result) return;
    this.ready[this.other] = true;
    this.remoteAway = false; // they pressed it, so they're here
    this.onChange();
    this.maybeStartNext();
  }

  maybeStartNext() {
    if (this.isHost && this.state === 'roundOver' && this.ready.host && this.ready.guest) {
      this.hostStartRound(this.round + 1);
    }
  }

  // #endregion

  // #region pause

  /** Start on our side: pause, resume, or (after a round) ready for a rematch. */
  pressStart() {
    if (this.state === 'countdown' || this.state === 'playing') {
      this.pauseBoth();
      this.send({ t: MSG.pause });
    } else if (this.state === 'paused') {
      this.resume();
    } else if (this.state === 'roundOver') {
      this.sendReady();
    }
  }

  resume() {
    if (this.state !== 'paused') return;
    this.send({ t: MSG.resume });
    this.beginCountdown();
  }

  pauseBoth() {
    this.game.pause = true;
    this.setState('paused');
  }

  /** After a pause or a reconnect both sides count down 3 s before play restarts. */
  beginCountdown() {
    this.game.pause = false;
    this.game.countdown = COUNTDOWN_MS;
    this.setState('countdown');
  }

  /** A plain pause also means "I'm here": a page back from the background sends one. */
  receivePause(msg: Message) {
    this.remoteAway = msg.reason === 'hidden';
    if (this.state === 'countdown' || this.state === 'playing') this.pauseBoth();
  }

  receiveResume() {
    this.remoteAway = false;
    if (this.state !== 'paused') return;
    this.beginCountdown();
    // Still in the background here: pause again rather than play unseen.
    if (this.hiddenAt != null) this.goneAway();
  }

  /** The page went to the background, or came back. */
  setHidden(hidden: boolean) {
    if (hidden) {
      this.hiddenAt = this.clock.now();
      this.save(); // a reload or a killed tab may come next
      this.goneAway();
      return;
    }
    // A long suspension shows up as a stale connection. Check while we still
    // count as away: a grace period that ran out meanwhile is ours to lose.
    if (this.pingTimer) this.tick();
    this.hiddenAt = null;
    // Tell the other side we're back: a pause without the 'hidden' reason.
    if (this.connected && (this.state === 'paused' || this.state === 'roundOver')) this.send({ t: MSG.pause });
  }

  /** In the background: pause both and say why. */
  goneAway() {
    if (!this.connected || !IN_ROOM.includes(this.state) || this.state === 'reconnecting') return;
    if (this.state === 'countdown' || this.state === 'playing') this.pauseBoth();
    this.send({ t: MSG.pause, reason: 'hidden' });
  }

  // #endregion

  // #region connection

  /** Every PING_MS from a timer (not the frame loop, which stops in a background tab). */
  tick() {
    const now = this.clock.now();
    if (this.connected) {
      if (now - this.lastHeard >= LIVENESS_MS) {
        this.connectionLost();
      } else {
        this.send({ t: MSG.ping, ts: now });
      }
    }
    if (this.state === 'reconnecting') {
      if (now >= this.graceDeadline) this.expire();
      else this.onChange(); // the countdown on screen
    }
  }

  transportState(state: TransportState) {
    if (state !== 'lost') return;
    if (this.state === 'joining') this.fail('failed');
    else if (this.connected) this.connectionLost();
    else if (this.state === 'reconnecting' && !this.isHost) this.reconnectLoop();
  }

  /** The channel closed, or nothing arrived for LIVENESS_MS. */
  connectionLost() {
    if (!this.connected) return;
    this.connected = false;
    this.transport.drop();
    if (!this.inRoom) return this.fail('lost');
    const now = this.clock.now();
    this.suspend();
    // The other side started its grace period about when it last heard from us.
    this.graceDeadline = Math.min(now, this.lastHeard + LIVENESS_MS) + GRACE_MS;
    if (now >= this.graceDeadline) return this.expire(); // back from a long suspension
    this.setState('reconnecting');
    if (!this.isHost) this.reconnectLoop();
  }

  /** Freezes the room until the other side is back. */
  suspend() {
    if (this.state === 'reconnecting') return;
    this.wasPaused = this.state === 'paused';
    if (this.state !== 'roundOver') this.game.pause = true;
  }

  /** Guest: connect to the host's code again until it answers or the grace period ends. */
  async reconnectLoop() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    while (this.state === 'reconnecting' && !this.connected) {
      try {
        await this.transport.join(this.code as string, { timeoutMs: ATTEMPT_MS });
        if (this.state !== 'reconnecting') break;
        this.sendHello();
        // The host answers with hello and sync; give this attempt up if it doesn't.
        await new Promise<void>((resolve) => {
          const id = this.after(ATTEMPT_MS, () => resolve());
          this.wake = () => {
            this.cancel(id);
            resolve();
          };
        });
        this.wake = null;
        if (!this.connected && this.state === 'reconnecting') this.transport.drop();
      } catch {
        // Host not there (yet), e.g. still reloading. Try again.
      }
      if (this.state === 'reconnecting' && !this.connected) await this.sleep(RETRY_MS);
    }
    this.reconnecting = false;
  }

  /** Host: our guest is back. Tell it where the room is, then carry on. */
  welcomeBack() {
    this.suspend();
    this.sendHello();
    this.send({
      t: MSG.sync,
      round: this.round,
      seed: this.seed,
      winner: this.result,
      ready: this.ready.host,
      wins: this.wins,
      paused: this.wasPaused,
    });
    this.markConnected();
    this.carryOn();
  }

  /** Guest: the host's view of the room after a reconnect. */
  receiveSync(msg: Message) {
    if (this.isHost || this.state !== 'reconnecting') return;
    if (isInt(msg.round) && msg.round > this.round) {
      // We missed a start (or were reloaded before it arrived).
      this.startRound(msg.round, (msg.seed as number) >>> 0, 0);
    }
    if (msg.round === this.round && isWinner(msg.winner)) this.applyResult(this.round, msg.winner);
    if (this.result && msg.ready === true) this.ready.host = true;
    this.wins = winsFrom(msg.wins);
    this.markConnected();
    this.carryOn(msg.paused === true);
  }

  /**
   * Back after a reconnect: the result screen, the pause either side was in,
   * or the round again after a countdown.
   * @param hostPaused guest only: the host's room was paused (from sync)
   */
  carryOn(hostPaused = false) {
    // A side that is still in the background says so again below.
    this.remoteAway = false;
    this.lastSnapshot = '';
    if (this.result) {
      this.game.pause = false;
      this.setState('roundOver');
      if (this.ready[this.role]) this.send({ t: MSG.ready, round: this.round });
      this.maybeStartNext();
    } else if (this.wasPaused || hostPaused) {
      this.pauseBoth();
      // The host only knows its own pause; bring it along.
      if (this.wasPaused && !hostPaused) this.send({ t: MSG.pause });
    } else {
      this.beginCountdown();
    }
    // Topped out before the connection went (or lost the round to a reload): say so again.
    if (!this.result && this.game.localField.isGameOver) this.localOver();
    if (this.localAway) this.goneAway();
  }

  /** The grace period ran out. Each side decides the outcome on its own. */
  expire() {
    if (this.localAway && !this.remoteAway) this.closeReason = 'forfeit-lose';
    else if (this.remoteAway && !this.localAway) this.closeReason = 'forfeit-win';
    else this.closeReason = 'lost'; // a plain outage: nobody wins
    this.shutdown();
  }

  /** After a page reload: rejoin the saved room. The reloaded player loses the round. */
  async rejoin() {
    const game = this.game;
    game.names = this.names;
    game.startRound(this.round, this.seed, 0);
    this.wasPaused = false;
    if (this.result) {
      game.result = this.gameResult(this.result);
    } else {
      game.localField.isGameOver = true;
      game.pause = true;
    }
    this.graceDeadline = this.clock.now() + GRACE_MS;
    this.pingTimer ||= this.clock.setInterval(() => this.tick(), PING_MS);
    this.setState('reconnecting');
    if (!this.isHost) return this.reconnectLoop();
    // Host: take the same code back. The broker may take a moment to free it.
    while (this.state === 'reconnecting') {
      try {
        await this.transport.host(this.code as string);
        return;
      } catch {
        await this.sleep(RETRY_MS);
      }
    }
  }

  // #endregion

  receive(msg: unknown, conn: unknown) {
    if (!isMessage(msg) || this.state === 'closed') return;
    if (this.isHost && conn !== this.transport.current) {
      this.receiveCandidate(msg, conn);
      return;
    }
    this.lastHeard = this.clock.now();
    switch (msg.t) {
      case MSG.hello:
        return this.receiveHello(msg);
      case MSG.full:
        return this.fail(this.state === 'reconnecting' ? 'lost' : 'full');
      case MSG.version:
        return this.fail('version');
      case MSG.sync:
        return this.receiveSync(msg);
      case MSG.start:
        return this.receiveStart(msg);
      case MSG.state:
        (this.game.players[1] as RemoteField).applySnapshot(msg);
        return;
      case MSG.attack:
        return this.receiveAttack(msg);
      case MSG.over:
        return this.noteOver(this.other, msg.round);
      case MSG.result:
        if (!this.isHost) this.applyResult(msg.round, msg.winner);
        return;
      case MSG.ready:
        return this.receiveReady(msg);
      case MSG.pause:
        return this.receivePause(msg);
      case MSG.resume:
        return this.receiveResume();
      case MSG.ping:
        this.send({ t: MSG.pong, ts: msg.ts });
        return;
      case MSG.pong:
        // Round trip, shown next to the win counter.
        if (!Number.isFinite(msg.ts)) return;
        this.latency = this.clock.now() - (msg.ts as number);
        this.onChange();
        return;
      case MSG.bye:
        this.closeReason = 'bye';
        return this.shutdown();
    }
  }

  fail(reason: CloseReason) {
    if (this.state === 'closed') return;
    this.closeReason = reason;
    this.shutdown();
  }

  /** The player cancelled or left; the opponent is told. */
  leave() {
    if (this.state === 'closed') return;
    this.closeReason = 'left';
    this.shutdown(this.connected ? { t: MSG.bye } : null);
  }

  shutdown(lastMessage: object | null = null) {
    for (const id of this.timeouts) this.clock.clearTimeout(id);
    this.timeouts.clear();
    if (this.pingTimer) this.clock.clearInterval(this.pingTimer);
    this.pingTimer = 0;
    this.connected = false;
    this.game.pause = true;
    this.storage?.clear();
    this.transport.close(lastMessage);
    this.setState('closed');
    this.wake?.();
  }
}
