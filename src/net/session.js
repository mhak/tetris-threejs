// Room state machine for online play (docs/online-2p-spec.md, section 7).
//
//   idle -> hosting -> waiting -> connected
//   idle -> joining -> connected
//   any -> closed (bye, cancel, fatal error)
import { BUILD_ID, MSG, isMessage } from './protocol.js';
import { cleanName } from './playerName.js';
import { generateCode } from './joinCode.js';

export const JOIN_TIMEOUT_MS = 15000;
const HOST_CODE_TRIES = 5;

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
  constructor({ role, transport, name, code = null, clock = realClock, buildId = BUILD_ID, makeCode = generateCode }) {
    this.role = role;
    this.transport = transport;
    this.localName = cleanName(name);
    this.remoteName = null;
    this.code = code;
    this.clock = clock;
    this.buildId = buildId;
    this.makeCode = makeCode;
    this.token = null;
    this.state = 'idle';
    // Why the session closed: 'not-found' | 'full' | 'failed' | 'version' | 'taken' | 'lost' | 'bye' | 'left'.
    this.closeReason = null;
    // Something the host should mention while it keeps waiting, e.g. 'version'.
    this.notice = null;
    this.timeouts = new Set();
    this.onChange = () => {};
    transport.onMessage = (msg, conn) => this.receive(msg, conn);
    transport.onState = (state) => this.transportState(state);
  }

  /** The name can change until it has been sent in hello. */
  setLocalName(name) {
    if (this.remoteName === null) this.localName = cleanName(name);
  }

  get isHost() {
    return this.role === 'host';
  }

  get isOpen() {
    return this.state !== 'idle' && this.state !== 'closed';
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
    // One budget for the whole join: channel open plus the host's hello.
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
    }
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
    this.notice = null;
    this.send({ t: MSG.hello, v: this.buildId, name: this.localName, token: this.token });
    this.setState('connected');
  }

  /** Guest: the host's answer to our hello. */
  receiveHello(msg) {
    if (this.isHost || this.state !== 'joining') return;
    if (msg.v !== this.buildId) {
      this.send({ t: MSG.version, v: this.buildId });
      return this.fail('version');
    }
    this.cancel(this.joinTimer);
    this.token = typeof msg.token === 'string' ? msg.token : null;
    this.remoteName = cleanName(msg.name);
    this.setState('connected');
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
    this.transport.close();
    this.setState('closed');
  }
}
