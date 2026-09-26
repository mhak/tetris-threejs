// A transport moves JSON messages between exactly two peers: the host, which
// registers a room under a join code, and the guest, which joins it.
//
// On the host every incoming connection starts out as a candidate. Its
// messages reach onMessage like any other, with the connection as the second
// argument, and the session then calls accept(conn) to make it the one `send`
// talks to (replacing and closing an older one, e.g. after a reconnect) or
// reject(conn, message). "Room is full" is decided that way by the session,
// since only it knows the resume token.
//
// Connections are opaque to the session: it only compares them with
// `current` and hands them back to accept / reject.

export type TransportState = 'connecting' | 'open' | 'lost' | 'closed';

/** How host() and join() fail. */
export interface TransportError {
  code: 'taken' | 'not-found' | 'failed';
}

export interface ConnectOptions {
  timeoutMs?: number;
}

export abstract class Transport {
  abstract host(code: string, options?: ConnectOptions): Promise<void>; // rejects with { code: 'taken' | 'failed' } ('failed' also after options.timeoutMs)
  abstract join(code: string, options?: ConnectOptions): Promise<void>; // rejects with { code: 'not-found' | 'failed' } ('failed' also after options.timeoutMs)
  abstract send(message: object): void; // reliable, ordered, to the current connection; dropped when there is none
  abstract accept(conn: unknown): void; // host: make `conn` the current connection (closes an older one)
  abstract reject(conn: unknown, message: object): void; // host: send `message` to `conn`, then close it once the message is out
  abstract drop(): void; // close the current connection only; a host stays registered
  abstract close(message?: object | null): void; // leave for good; `message` (e.g. bye) goes out before the channel closes
  get current(): unknown { // the current connection, or null
    return null;
  }
  onMessage: (msg: unknown, conn: unknown) => void = () => {};
  onState: (state: TransportState) => void = () => {};
}

/**
 * In-memory stand-in for the broker and the network, shared by any number of
 * LoopbackTransports. Messages go through JSON like the real channel. With
 * `latencyMs` 0 they arrive on the next microtask.
 */
export class LoopbackNetwork {
  latencyMs: number;
  hosts: Map<string, LoopbackTransport>;
  cut: boolean;

  constructor({ latencyMs = 0 }: { latencyMs?: number } = {}) {
    this.latencyMs = latencyMs;
    this.hosts = new Map();
    // While true, messages vanish without closing anything (a dead network).
    this.cut = false;
  }

  deliver(fn: () => void) {
    if (this.latencyMs > 0) setTimeout(fn, this.latencyMs);
    else queueMicrotask(fn);
  }
}

/** One end of an in-memory connection. */
class LoopbackConnection {
  network: LoopbackNetwork;
  owner: LoopbackTransport;
  // Set right after both ends exist (see LoopbackTransport.join).
  other!: LoopbackConnection;
  open: boolean;

  constructor(network: LoopbackNetwork, owner: LoopbackTransport) {
    this.network = network;
    this.owner = owner;
    this.open = true;
  }

  send(message: object) {
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
  network: LoopbackNetwork;
  code: string | null;
  conn: LoopbackConnection | null;
  candidates: Set<LoopbackConnection>;
  closed: boolean;

  constructor(network: LoopbackNetwork) {
    super();
    this.network = network;
    this.code = null;
    this.conn = null;
    this.candidates = new Set();
    this.closed = false;
  }

  override get current(): LoopbackConnection | null {
    return this.conn;
  }

  async host(code: string) {
    if (this.network.hosts.has(code)) throw { code: 'taken' } satisfies TransportError;
    this.network.hosts.set(code, this);
    this.code = code;
  }

  async join(code: string) {
    const host = this.network.hosts.get(code);
    if (!host || host.closed) throw { code: 'not-found' } satisfies TransportError;
    this.drop();
    const mine = new LoopbackConnection(this.network, this);
    const theirs = new LoopbackConnection(this.network, host);
    mine.other = theirs;
    theirs.other = mine;
    host.candidates.add(theirs);
    this.conn = mine;
    this.onState('open');
  }

  receive(conn: LoopbackConnection, message: unknown) {
    if (this.closed) return;
    if (conn !== this.conn && !this.candidates.has(conn)) return;
    this.onMessage(message, conn);
  }

  connectionClosed(conn: LoopbackConnection) {
    this.candidates.delete(conn);
    if (conn === this.conn) {
      this.conn = null;
      if (!this.closed) this.onState('lost');
    }
  }

  send(message: object) {
    this.conn?.send(message);
  }

  accept(conn: LoopbackConnection) {
    if (!this.candidates.delete(conn)) return;
    if (this.conn && this.conn !== conn) this.conn.close();
    this.conn = conn;
    this.onState('open');
  }

  reject(conn: LoopbackConnection, message: object) {
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

  close(message?: object | null) {
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
