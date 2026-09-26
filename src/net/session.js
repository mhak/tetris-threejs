// Room state machine for online play (docs/online-2p-spec.md, sections 2, 4.5 and 5 to 7).
//
//   idle -> hosting -> waiting -> countdown -> playing -> roundOver -> countdown ...
//   idle -> joining -> countdown
//   countdown | playing <-> paused
//   countdown | playing | paused | roundOver -> reconnecting -> (countdown | roundOver | closed)
//   any -> closed (bye, cancel, fatal error, grace period over)
//
// Each device runs the rules for its own board only and sends the other one
// snapshots (to draw) and attacks (the only thing that changes the other
// board). The host starts every round and decides every result, so both
// screens always agree.
import { BUILD_ID, MSG, isMessage, snapshotOf } from './protocol.js';
import { cleanName, displayNames } from './playerName.js';
import { generateCode, isValidCode } from './joinCode.js';
import { GameScreen } from '../game/gameScreen.js';
import { randomSeed } from '../game/random.js';

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
const ATTACKS = ['line', 'drop'];
const WINNERS = ['host', 'guest', 'draw'];
const IN_ROUND = ['countdown', 'playing', 'paused'];
const IN_ROOM = [...IN_ROUND, 'roundOver', 'reconnecting'];
const ROOM_KEY = 'tetris-threejs-room';

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

/**
 * The room as kept in sessionStorage across a reload: role, code, names,
 * token, wins and round. Nothing about the board: a reload loses the round.
 */
export function roomStorage(storage = globalThis.sessionStorage) {
  return {
    load() {
      try {
        return JSON.parse(storage.getItem(ROOM_KEY));
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

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

export class Session {
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
  }) {
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
    // Why the session closed: 'not-found' | 'full' | 'failed' | 'version' | 'taken'
    // | 'left' (we left) | 'bye' (they left) | 'lost' (no winner)
    // | 'forfeit-win' (they went away) | 'forfeit-lose' (we went away).
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
    this.resumeTo = 'countdown';
    this.reconnecting = false;
    this.wake = null;
    // Went to the background (sent or got pause with reason 'hidden'), with no resume since.
    this.localAway = false;
    this.remoteAway = false;
    this.hiddenAt = null;

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

  /**
   * A session for the room saved before a page reload, or null if there is
   * none or it is too old to come back to.
   */
  static restore(saved, options) {
    if (!Session.canRestore(saved, (options.clock ?? realClock).now())) return null;
    const { role, code, names, token, wins, round, seed, result } = saved;
    const s = new Session({ ...options, role, code, name: names[0] });
    s.remoteName = cleanName(names[1]);
    s.token = token;
    s.wins = { host: count(wins?.host), guest: count(wins?.guest) };
    s.round = round;
    s.seed = seed >>> 0;
    s.result = WINNERS.includes(result) ? result : null;
    s.restored = true;
    return s;
  }

  /** A saved room is worth offering when it is whole and recent enough to come back to. */
  static canRestore(saved, now = Date.now()) {
    if (!saved || typeof saved !== 'object') return false;
    const { role, code, names, token, round, lastSeen } = saved;
    return (
      (role === 'host' || role === 'guest') &&
      isValidCode(code) &&
      typeof token === 'string' &&
      Array.isArray(names) &&
      Number.isInteger(round) &&
      round >= 1 &&
      now - lastSeen < GRACE_MS
    );
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
    return IN_ROOM.includes(this.state);
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

  /** Whole seconds left before a lost connection ends the room. */
  get graceLeft() {
    return Math.max(0, Math.ceil((this.graceDeadline - this.clock.now()) / 1000));
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

  sleep(ms) {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  send(message) {
    this.transport.send(message);
  }

  save() {
    if (!this.storage || !this.token || this.remoteName === null || this.round < 1) return;
    this.storage.save({
      role: this.role,
      code: this.code,
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
    this.sendHello();
  }

  sendHello() {
    const hello = { t: MSG.hello, v: this.buildId, name: this.localName };
    if (this.token) hello.token = this.token;
    this.send(hello);
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
  receiveHello(msg) {
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

  hostStartRound(round) {
    const seed = this.makeSeed();
    this.send({ t: MSG.start, round, seed, countdownMs: COUNTDOWN_MS });
    this.startRound(round, seed, COUNTDOWN_MS);
  }

  receiveStart(msg) {
    if (this.isHost || !Number.isInteger(msg.round) || msg.round <= this.round) return;
    const countdown = Math.min(Math.max(Number(msg.countdownMs) || 0, 0), COUNTDOWN_MS * 2);
    this.startRound(msg.round, msg.seed >>> 0, countdown);
  }

  startRound(round, seed, countdownMs) {
    this.round = round;
    this.seed = seed;
    this.result = null;
    this.ready = { host: false, guest: false };
    this.firstOver = null;
    this.cancel(this.overTimer);
    // Both pressed ready (or joined) for this round, so both are here.
    this.localAway = false;
    this.remoteAway = false;
    this.game.startRound(round, seed, countdownMs);
    this.lastSnapshot = '';
    this.save();
    this.setState('countdown');
  }

  /** Once per frame: runs our board and tells the opponent what changed. */
  update(elapsedMs, getState) {
    if (!this.inRoom) return;
    this.game.update(elapsedMs, getState);
    if (this.state === 'countdown' && this.game.running) this.setState('playing');
    if (this.connected) this.sendSnapshot();
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

  /** Our board topped out (or was lost to a reload). */
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
    this.save();
    if (this.state === 'reconnecting') {
      this.resumeTo = 'roundOver';
      this.onChange();
    } else {
      this.game.pause = false;
      this.setState('roundOver');
    }
  }

  /** Ready for a rematch. The host starts the next round once both are. */
  sendReady() {
    if (this.state !== 'roundOver' || this.ready[this.role]) return;
    this.ready[this.role] = true;
    this.send({ t: MSG.ready, round: this.round });
    this.onChange();
    this.maybeStartNext();
  }

  receiveReady(msg) {
    if (msg.round !== this.round || !this.result) return;
    this.ready[this.other] = true;
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
    this.localAway = false;
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

  receivePause(msg) {
    if (msg.reason === 'hidden') this.remoteAway = true;
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
  setHidden(hidden) {
    if (hidden) {
      this.hiddenAt = this.clock.now();
      this.goneAway();
    } else {
      this.hiddenAt = null;
      // A long suspension shows up as a stale connection: notice it now.
      if (this.pingTimer) this.tick();
    }
  }

  goneAway() {
    if (!this.connected || !IN_ROOM.includes(this.state) || this.state === 'reconnecting') return;
    if (this.state === 'countdown' || this.state === 'playing') this.pauseBoth();
    this.localAway = true;
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
        this.save();
      }
    }
    if (this.state === 'reconnecting') {
      if (now >= this.graceDeadline) this.expire();
      else this.onChange(); // the countdown on screen
    }
  }

  transportState(state) {
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
    this.resumeTo = this.state === 'roundOver' ? 'roundOver' : 'countdown';
    if (this.resumeTo === 'countdown') this.game.pause = true;
  }

  /** Guest: connect to the host's code again until it answers or the grace period ends. */
  async reconnectLoop() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    while (this.state === 'reconnecting' && !this.connected) {
      try {
        await this.transport.join(this.code, { timeoutMs: ATTEMPT_MS });
        if (this.state !== 'reconnecting') break;
        this.sendHello();
        // The host answers with hello and sync; give this attempt up if it doesn't.
        await new Promise((resolve) => {
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
    });
    this.markConnected();
    this.carryOn();
  }

  /** Guest: the host's view of the room after a reconnect. */
  receiveSync(msg) {
    if (this.isHost || this.state !== 'reconnecting') return;
    if (Number.isInteger(msg.round) && msg.round > this.round) {
      // We missed a start (or were reloaded before it arrived).
      this.startRound(msg.round, msg.seed >>> 0, 0);
    }
    if (msg.round === this.round && WINNERS.includes(msg.winner)) this.applyResult(this.round, msg.winner);
    if (this.result && msg.ready === true) this.ready.host = true;
    this.wins = { host: count(msg.wins?.host), guest: count(msg.wins?.guest) };
    this.markConnected();
    this.carryOn();
  }

  /** Back after a reconnect: resume the round with a countdown, or the result screen. */
  carryOn() {
    this.localAway = false;
    this.remoteAway = false;
    this.lastSnapshot = '';
    if (this.result) {
      this.game.pause = false;
      this.setState('roundOver');
      if (this.ready[this.role]) this.send({ t: MSG.ready, round: this.round });
      this.maybeStartNext();
      return;
    }
    this.beginCountdown();
    // Topped out before the connection went (or lost the round to a reload): say so again.
    if (this.game.players[0].isGameOver) this.localOver();
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
    if (this.result) {
      game.result = this.result === 'draw' ? 'draw' : this.result === this.role ? 0 : 1;
      this.resumeTo = 'roundOver';
    } else {
      game.players[0].isGameOver = true;
      this.resumeTo = 'countdown';
      game.pause = true;
    }
    this.graceDeadline = this.clock.now() + GRACE_MS;
    this.pingTimer ||= this.clock.setInterval(() => this.tick(), PING_MS);
    this.setState('reconnecting');
    if (!this.isHost) return this.reconnectLoop();
    // Host: take the same code back. The broker may take a moment to free it.
    while (this.state === 'reconnecting') {
      try {
        await this.transport.host(this.code);
        return;
      } catch {
        await this.sleep(RETRY_MS);
      }
    }
  }

  // #endregion

  receive(msg, conn) {
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
        this.game.players[1].applySnapshot(msg);
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
        if (Number.isFinite(msg.ts)) this.latency = this.clock.now() - msg.ts;
        return;
      case MSG.bye:
        this.closeReason = 'bye';
        return this.shutdown();
    }
  }

  fail(reason) {
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

  shutdown(lastMessage = null) {
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
