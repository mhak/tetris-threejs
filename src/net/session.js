// Room state machine for online play (docs/online-2p-spec.md, sections 5 to 7).
//
//   idle -> hosting -> waiting -> countdown -> playing -> roundOver
//   idle -> joining -> countdown
//   countdown | playing <-> paused
//   any -> closed (bye, cancel, fatal error)
//
// Each device runs the rules for its own board only and sends the other one
// snapshots (to draw) and attacks (the only thing that changes the other
// board). The host starts every round and decides every result, so both
// screens always agree.
import { BUILD_ID, MSG, isMessage, snapshotOf } from './protocol.js';
import { cleanName, displayNames } from './playerName.js';
import { generateCode } from './joinCode.js';
import { GameScreen } from '../game/gameScreen.js';
import { randomSeed } from '../game/random.js';

export const JOIN_TIMEOUT_MS = 15000;
export const COUNTDOWN_MS = 3000;
export const RESULT_WINDOW_MS = 250; // a second top-out this soon after the first is a draw
const HOST_CODE_TRIES = 5;
const SNAPSHOT_MS = 50; // at most 20 snapshots a second
const ATTACKS = ['line', 'drop'];
const WINNERS = ['host', 'guest', 'draw'];
const IN_ROUND = ['countdown', 'playing', 'paused'];

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

/** Random resume token the host hands out in its hello. */
export function newToken(getRandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  return Array.from(getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Session {
  /**
   * @param role 'host' | 'guest'
   * @param transport a Transport (PeerTransport, or LoopbackTransport in tests)
   * @param code the room to join (guest only; the host makes its own)
   */
  constructor({
    role,
    transport,
    name,
    code = null,
    sounds,
    clock = realClock,
    buildId = BUILD_ID,
    makeCode = generateCode,
    makeSeed = randomSeed,
  }) {
    this.role = role;
    this.transport = transport;
    this.localName = cleanName(name);
    this.remoteName = null;
    this.code = code;
    this.clock = clock;
    this.buildId = buildId;
    this.makeCode = makeCode;
    this.makeSeed = makeSeed;
    this.token = null;
    this.state = 'idle';
    // Why the session closed: 'not-found' | 'full' | 'failed' | 'version' | 'taken' | 'lost' | 'bye' | 'left'.
    this.closeReason = null;
    // Something the host should mention while it keeps waiting, e.g. 'version'.
    this.notice = null;
    this.timeouts = new Set();

    this.round = 0;
    this.seed = null;
    this.result = null; // this round's winner: 'host' | 'guest' | 'draw'
    this.wins = { host: 0, guest: 0 };
    this.firstOver = null; // host: who topped out first this round, while the draw window is open
    this.overTimer = 0;

    // Player 0 is our board, player 1 mirrors the opponent's snapshots.
    this.game = new GameScreen({ online: true, sounds });
    this.game.onAttack = (kind) => this.sendAttack(kind);
    this.game.onOver = () => this.localOver();
    this.game.onStartPressed = () => this.pressStart();
    this.lastSnapshot = '';
    this.lastSnapshotAt = -Infinity;
    this.onChange = () => {};
    this.onAttackSent = () => {};
    transport.onMessage = (msg, conn) => this.receive(msg, conn);
    transport.onState = (state) => this.transportState(state);
  }

  get isHost() {
    return this.role === 'host';
  }

  get other() {
    return this.isHost ? 'guest' : 'host';
  }

  get isOpen() {
    return this.state !== 'idle' && this.state !== 'closed';
  }

  /** True once the first round has started: the game is shown instead of the lobby. */
  get inRoom() {
    return IN_ROUND.includes(this.state) || this.state === 'roundOver';
  }

  /** [local, remote] names as shown on screen. */
  get names() {
    return displayNames(this.localName, this.remoteName ?? '');
  }

  /** The winner's display name, or null for a draw or no result. */
  get winnerName() {
    if (!this.result || this.result === 'draw') return null;
    return this.names[this.result === this.role ? 0 : 1];
  }

  /** Wins as [local, remote]. */
  get score() {
    return [this.wins[this.role], this.wins[this.other]];
  }

  /** The name can change until it has been sent in hello. */
  setLocalName(name) {
    if (this.remoteName === null) this.localName = cleanName(name);
  }

  setState(state) {
    this.state = state;
    this.onChange();
  }

  after(ms, fn) {
    const id = this.clock.setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  cancel(id) {
    if (!id) return;
    this.clock.clearTimeout(id);
    this.timeouts.delete(id);
  }

  send(message) {
    this.transport.send(message);
  }

  // #region joining

  /** Create or join the room. */
  async open() {
    if (this.isHost) await this.hostRoom();
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
        if (err?.code === 'taken') continue;
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
      await this.transport.join(this.code, { timeoutMs: JOIN_TIMEOUT_MS });
    } catch (err) {
      if (this.state === 'joining') this.fail(err?.code === 'not-found' ? 'not-found' : 'failed');
      return;
    }
    if (this.state !== 'joining') return;
    this.send({ t: MSG.hello, v: this.buildId, name: this.localName });
  }

  /** Host: a new connection says hello. Let it in, or turn it away. */
  receiveCandidate(msg, conn) {
    if (msg.t !== MSG.hello) return;
    if (msg.v !== this.buildId) {
      this.transport.reject(conn, { t: MSG.version, v: this.buildId });
      this.notice = 'version';
      this.onChange();
      return;
    }
    if (this.state !== 'waiting') {
      this.transport.reject(conn, { t: MSG.full });
      return;
    }
    this.transport.accept(conn);
    this.remoteName = cleanName(msg.name);
    this.game.names = this.names;
    this.notice = null;
    this.send({ t: MSG.hello, v: this.buildId, name: this.localName, token: this.token });
    this.hostStartRound(1);
  }

  /** Guest: the host's answer to our hello. */
  receiveHello(msg) {
    if (this.isHost || this.state !== 'joining') return;
    if (msg.v !== this.buildId) {
      this.send({ t: MSG.version, v: this.buildId });
      return this.fail('version');
    }
    this.token = typeof msg.token === 'string' ? msg.token : null;
    this.remoteName = cleanName(msg.name);
    this.game.names = this.names;
  }

  // #endregion

  // #region rounds

  hostStartRound(round) {
    const seed = this.makeSeed();
    this.send({ t: MSG.start, round, seed, countdownMs: COUNTDOWN_MS });
    this.startRound(round, seed, COUNTDOWN_MS);
  }

  receiveStart(msg) {
    if (this.isHost || !Number.isInteger(msg.round) || msg.round <= this.round) return;
    if (this.state === 'joining') this.cancel(this.joinTimer);
    const countdown = Math.min(Math.max(Number(msg.countdownMs) || 0, 0), COUNTDOWN_MS * 2);
    this.startRound(msg.round, msg.seed >>> 0, countdown);
  }

  startRound(round, seed, countdownMs) {
    this.round = round;
    this.seed = seed;
    this.result = null;
    this.firstOver = null;
    this.cancel(this.overTimer);
    this.game.startRound(round, seed, countdownMs);
    this.lastSnapshot = '';
    this.setState('countdown');
  }

  /** Once per frame: runs our board and tells the opponent what changed. */
  update(elapsedMs, getState) {
    if (!this.inRoom) return;
    this.game.update(elapsedMs, getState);
    if (this.state === 'countdown' && this.game.running) this.setState('playing');
    this.sendSnapshot();
  }

  sendSnapshot() {
    const now = this.clock.now();
    if (now - this.lastSnapshotAt < SNAPSHOT_MS) return;
    const snapshot = snapshotOf(this.game.players[0], this.round);
    const key = JSON.stringify(snapshot);
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    this.lastSnapshotAt = now;
    this.send(snapshot);
  }

  sendAttack(kind) {
    this.send({ t: MSG.attack, round: this.round, kind });
    this.onAttackSent(kind);
  }

  receiveAttack(msg) {
    if (msg.round !== this.round || !ATTACKS.includes(msg.kind)) return;
    this.game.receiveAttack(msg.kind);
  }

  /** Our board topped out. */
  localOver() {
    this.send({ t: MSG.over, round: this.round });
    if (this.isHost) this.noteOver('host', this.round);
  }

  /**
   * Host: the first player to top out loses, unless the other one also tops
   * out within RESULT_WINDOW_MS, which is a draw.
   */
  noteOver(who, round) {
    if (!this.isHost || round !== this.round || this.result) return;
    if (!this.firstOver) {
      this.firstOver = who;
      this.overTimer = this.after(RESULT_WINDOW_MS, () => this.decide(who === 'host' ? 'guest' : 'host'));
    } else if (this.firstOver !== who) {
      this.decide('draw');
    }
  }

  decide(winner) {
    this.cancel(this.overTimer);
    this.firstOver = null;
    this.send({ t: MSG.result, round: this.round, winner });
    this.applyResult(this.round, winner);
  }

  applyResult(round, winner) {
    if (round !== this.round || this.result || !WINNERS.includes(winner)) return;
    this.result = winner;
    if (winner !== 'draw') this.wins[winner]++;
    this.game.result = winner === 'draw' ? 'draw' : winner === this.role ? 0 : 1;
    this.game.pause = false;
    this.setState('roundOver');
  }

  // #endregion

  // #region pause

  /** Start on our side: pause, resume, or (after a round) ready for a rematch. */
  pressStart() {
    if (this.state === 'countdown' || this.state === 'playing') {
      this.pauseBoth();
      this.send({ t: MSG.pause });
    } else if (this.state === 'paused') {
      this.send({ t: MSG.resume });
      this.beginCountdown();
    }
  }

  pauseBoth() {
    this.game.pause = true;
    this.setState('paused');
  }

  /** After a pause both sides count down 3 s before input and gravity restart. */
  beginCountdown() {
    this.game.pause = false;
    this.game.countdown = COUNTDOWN_MS;
    this.setState('countdown');
  }

  receivePause() {
    if (this.state === 'countdown' || this.state === 'playing') this.pauseBoth();
  }

  receiveResume() {
    if (this.state === 'paused') this.beginCountdown();
  }

  // #endregion

  receive(msg, conn) {
    if (!isMessage(msg) || this.state === 'closed') return;
    if (this.isHost && conn !== this.transport.current) {
      this.receiveCandidate(msg, conn);
      return;
    }
    switch (msg.t) {
      case MSG.hello:
        return this.receiveHello(msg);
      case MSG.full:
        return this.fail('full');
      case MSG.version:
        return this.fail('version');
      case MSG.start:
        return this.receiveStart(msg);
      case MSG.state:
        this.game.players[1].applySnapshot(msg);
        return;
      case MSG.attack:
        return this.receiveAttack(msg);
      case MSG.over:
        return this.noteOver(this.other, msg.round);
      case MSG.result:
        if (!this.isHost) this.applyResult(msg.round, msg.winner);
        return;
      case MSG.pause:
        return this.receivePause();
      case MSG.resume:
        return this.receiveResume();
    }
  }

  transportState(state) {
    if (state === 'lost' && this.isOpen && this.state !== 'hosting' && this.state !== 'waiting') {
      this.fail(this.state === 'joining' ? 'failed' : 'lost');
    }
  }

  fail(reason) {
    if (this.state === 'closed') return;
    this.closeReason = reason;
    this.shutdown();
  }

  /** The player cancelled or left. */
  leave() {
    if (this.state === 'closed') return;
    this.closeReason = 'left';
    this.shutdown();
  }

  shutdown() {
    for (const id of this.timeouts) this.clock.clearTimeout(id);
    this.timeouts.clear();
    this.game.pause = true;
    this.transport.close();
    this.setState('closed');
  }
}
