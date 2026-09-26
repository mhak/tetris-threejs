// A transport moves JSON messages between exactly two peers: the host, which
// registers a room under a join code, and the guest, which joins it.
//
// On the host every incoming connection starts out as a candidate. Its
// messages reach onMessage like any other, with the connection as the second
// argument, and the session then calls accept(conn) to make it the one `send`
// talks to (replacing and closing an older one, e.g. after a reconnect) or
// reject(conn, message). "Room is full" is decided that way by the session,
// since only it knows the resume token.
export class Transport {
  host(code) {}           // Promise<void>; rejects with { code: 'taken' | 'failed' }
  join(code, options) {}  // Promise<void>; rejects with { code: 'not-found' | 'failed' } ('failed' also after options.timeoutMs)
  send(message) {}        // reliable, ordered, to the current connection; dropped when there is none
  accept(conn) {}         // host: make `conn` the current connection (closes an older one)
  reject(conn, message) {} // host: send `message` to `conn`, then close it once the message is out
  drop() {}               // close the current connection only; a host stays registered
  close(message) {}       // leave for good; `message` (e.g. bye) goes out before the channel closes
  get current() {         // the current connection, or null
    return null;
  }
  onMessage = (msg, conn) => {};
  onState = (state) => {}; // 'connecting' | 'open' | 'lost' | 'closed'
}

/**
 * In-memory stand-in for the broker and the network, shared by any number of
 * LoopbackTransports. Messages go through JSON like the real channel. With
 * `latencyMs` 0 they arrive on the next microtask.
 */
export class LoopbackNetwork {
  constructor({ latencyMs = 0 } = {}) {
    this.latencyMs = latencyMs;
    this.hosts = new Map();
    // While true, messages vanish without closing anything (a dead network).
    this.cut = false;
  }

  deliver(fn) {
    if (this.latencyMs > 0) setTimeout(fn, this.latencyMs);
    else queueMicrotask(fn);
  }
}

/** One end of an in-memory connection. */
class LoopbackConnection {
  constructor(network, owner) {
    this.network = network;
    this.owner = owner;
    this.other = null;
    this.open = true;
  }

  send(message) {
    if (!this.open || this.network.cut) return;
    const data = JSON.stringify(message);
    const other = this.other;
    this.network.deliver(() => other.open && other.owner.receive(other, JSON.parse(data)));
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const other = this.other;
    if (!this.network.cut) this.network.deliver(() => other.remoteClosed());
  }

  remoteClosed() {
    if (!this.open) return;
    this.open = false;
    this.owner.connectionClosed(this);
  }

  /** The network drops the connection: both ends see it close. */
  sever() {
    const other = this.other;
    this.network.deliver(() => {
      this.remoteClosed();
      other.remoteClosed();
    });
  }
}

export class LoopbackTransport extends Transport {
  constructor(network) {
    super();
    this.network = network;
    this.code = null;
    this.conn = null;
    this.candidates = new Set();
    this.closed = false;
  }

  get current() {
    return this.conn;
  }

  async host(code) {
    if (this.network.hosts.has(code)) throw { code: 'taken' };
    this.network.hosts.set(code, this);
    this.code = code;
  }

  async join(code) {
    const host = this.network.hosts.get(code);
    if (!host || host.closed) throw { code: 'not-found' };
    this.drop();
    const mine = new LoopbackConnection(this.network, this);
    const theirs = new LoopbackConnection(this.network, host);
    mine.other = theirs;
    theirs.other = mine;
    host.candidates.add(theirs);
    this.conn = mine;
    this.onState('open');
  }

  receive(conn, message) {
    if (this.closed) return;
    if (conn !== this.conn && !this.candidates.has(conn)) return;
    this.onMessage(message, conn);
  }

  connectionClosed(conn) {
    this.candidates.delete(conn);
    if (conn === this.conn) {
      this.conn = null;
      if (!this.closed) this.onState('lost');
    }
  }

  send(message) {
    this.conn?.send(message);
  }

  accept(conn) {
    if (!this.candidates.delete(conn)) return;
    if (this.conn && this.conn !== conn) this.conn.close();
    this.conn = conn;
    this.onState('open');
  }

  reject(conn, message) {
    this.candidates.delete(conn);
    conn.send(message);
    conn.close();
  }

  drop() {
    const conn = this.conn;
    this.conn = null;
    conn?.close();
  }

  /** Tests: the network drops the current connection under both ends. */
  sever() {
    this.conn?.sever();
  }

  close(message) {
    if (this.closed) return;
    if (message) this.send(message);
    this.closed = true;
    this.drop();
    for (const c of this.candidates) c.close();
    this.candidates.clear();
    if (this.code && this.network.hosts.get(this.code) === this) this.network.hosts.delete(this.code);
    this.onState('closed');
  }
}
