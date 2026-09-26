// PeerJS implementation of the transport (see transport.ts). PeerJS uses its
// free public broker (0.peerjs.com) only to set up the connection; game
// messages go straight between the devices over a WebRTC data channel.
// PeerJS's default ICE servers (Google STUN plus the PeerJS TURN relay) are
// kept on purpose, so networks that block direct connections still work.
import { Peer, type DataConnection, type PeerConnectOption, type PeerJSOption } from 'peerjs';
import { Transport, type ConnectOptions, type TransportError } from './transport.ts';
import { peerIdFor } from './joinCode.ts';

/**
 * Our own broker instead of the public one, when the build sets e.g.
 * VITE_PEER_SERVER=https://peer.example.com/tetris (a peerjs-server).
 */
export function brokerOptions(url = import.meta.env?.VITE_PEER_SERVER): PeerJSOption {
  if (!url) return {};
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  return { host: u.hostname, port: Number(u.port) || (secure ? 443 : 80), path: u.pathname, secure };
}

const BROKER_RETRY_MS = 2000;
const CLOSE_DELAY_MS = 1000; // lets a last message (bye) leave before the peer is destroyed
const CONNECT_OPTIONS: PeerConnectOption = { reliable: true, serialization: 'json' };

/** A join in progress; finish(null) on success. */
interface JoinAttempt {
  finish(err: TransportError | null): void;
}

export class PeerTransport extends Transport {
  peerOptions: PeerJSOption;
  peer: Peer | null;
  conn: DataConnection | null;
  candidates: Set<DataConnection>;
  pendingJoin: JoinAttempt | null;
  brokerTimer: ReturnType<typeof setTimeout> | number;
  closed: boolean;

  constructor(peerOptions: PeerJSOption = {}) {
    super();
    this.peerOptions = { debug: 1, ...brokerOptions(), ...peerOptions };
    this.peer = null;
    this.conn = null;
    this.candidates = new Set();
    this.pendingJoin = null;
    this.brokerTimer = 0;
    this.closed = false;
  }

  override get current(): DataConnection | null {
    return this.conn;
  }

  host(code: string, { timeoutMs = 15000 }: ConnectOptions = {}): Promise<void> {
    this.destroyPeer();
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerIdFor(code), this.peerOptions);
      this.peer = peer;
      let settled = false;
      const fail = (reason: TransportError['code']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.peer === peer) this.peer = null;
        peer.destroy();
        reject({ code: reason } satisfies TransportError);
      };
      // A broker that never answers (captive portal, blocked websocket) must not hang us.
      const timer = setTimeout(() => fail('failed'), timeoutMs);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      peer.on('connection', (conn) => this.watchCandidate(conn));
      peer.on('disconnected', () => this.retryBroker(peer));
      // Errors after 'open' end in 'disconnected', handled above.
      peer.on('error', (err) => fail(err?.type === 'unavailable-id' ? 'taken' : 'failed'));
    });
  }

  join(code: string, { timeoutMs = 15000 }: ConnectOptions = {}): Promise<void> {
    this.drop();
    this.pendingJoin?.finish({ code: 'failed' });
    return new Promise((resolve, reject) => {
      let conn: DataConnection | null = null;
      const attempt: JoinAttempt = {
        finish: (err) => {
          if (this.pendingJoin !== attempt) return;
          this.pendingJoin = null;
          clearTimeout(timer);
          if (!err) return resolve();
          conn?.close();
          reject(err);
        },
      };
      const timer = setTimeout(() => attempt.finish({ code: 'failed' }), timeoutMs);
      this.pendingJoin = attempt;
      this.guestPeer().then(
        (peer) => {
          if (this.pendingJoin !== attempt) return;
          const c = peer.connect(peerIdFor(code), CONNECT_OPTIONS);
          conn = c;
          c.on('open', () => {
            if (this.pendingJoin !== attempt) return c.close();
            this.adopt(c);
            attempt.finish(null);
          });
          c.on('error', () => attempt.finish({ code: 'failed' }));
          c.on('close', () => attempt.finish({ code: 'failed' }));
        },
        () => attempt.finish({ code: 'failed' }),
      );
    });
  }

  /** The guest's peer (random ID), opened on first use and kept for reconnects. */
  guestPeer(): Promise<Peer> {
    let peer = this.peer;
    if (!peer || peer.destroyed) {
      const fresh = new Peer(this.peerOptions);
      peer = fresh;
      this.peer = fresh;
      fresh.on('disconnected', () => this.retryBroker(fresh));
      fresh.on('error', (err) => {
        if (err?.type === 'peer-unavailable') this.pendingJoin?.finish({ code: 'not-found' });
      });
    }
    if (peer.open) return Promise.resolve(peer);
    return new Promise((resolve, reject) => {
      peer.once('open', () => resolve(peer));
      peer.once('close', () => reject());
    });
  }

  /** After losing the broker, keep trying to get the same ID back. */
  retryBroker(peer: Peer) {
    clearTimeout(this.brokerTimer);
    this.brokerTimer = setTimeout(() => {
      if (this.closed || peer !== this.peer || peer.destroyed || !peer.disconnected) return;
      try {
        peer.reconnect();
      } catch {
        // Destroyed in the meantime.
      }
    }, BROKER_RETRY_MS);
  }

  watchCandidate(conn: DataConnection) {
    if (this.closed) return conn.close();
    this.candidates.add(conn);
    conn.on('data', (msg) => {
      if (!this.closed && (conn === this.conn || this.candidates.has(conn))) this.onMessage(msg, conn);
    });
    conn.on('close', () => this.connectionClosed(conn));
    conn.on('error', () => {});
  }

  adopt(conn: DataConnection) {
    this.conn = conn;
    conn.on('data', (msg) => {
      if (!this.closed && conn === this.conn) this.onMessage(msg, conn);
    });
    conn.on('close', () => this.connectionClosed(conn));
    this.onState('open');
  }

  connectionClosed(conn: DataConnection) {
    this.candidates.delete(conn);
    if (conn !== this.conn) return;
    this.conn = null;
    if (!this.closed) this.onState('lost');
  }

  send(message: object) {
    if (this.conn?.open) this.conn.send(message);
  }

  accept(conn: DataConnection) {
    if (!this.candidates.delete(conn)) return;
    const old = this.conn;
    this.conn = conn;
    if (old && old !== conn) old.close();
    this.onState('open');
  }

  reject(conn: DataConnection, message: object) {
    this.candidates.delete(conn);
    if (conn.open) {
      conn.send(message);
      conn.close({ flush: true });
    } else {
      conn.close();
    }
  }

  drop() {
    const conn = this.conn;
    this.conn = null;
    conn?.close();
  }

  close(message?: object | null) {
    if (this.closed) return;
    this.closed = true;
    this.pendingJoin?.finish({ code: 'failed' });
    const conn = this.conn;
    this.conn = null;
    let delay = 0;
    if (message && conn?.open) {
      conn.send(message);
      conn.close({ flush: true });
      delay = CLOSE_DELAY_MS;
    } else {
      conn?.close();
    }
    for (const c of this.candidates) c.close();
    this.candidates.clear();
    const peer = this.peer;
    setTimeout(() => this.destroyPeer(peer), delay);
    this.onState('closed');
  }

  destroyPeer(peer: Peer | null = this.peer) {
    if (!peer) return;
    if (peer === this.peer) {
      this.peer = null;
      clearTimeout(this.brokerTimer);
    }
    peer.destroy();
  }
}
