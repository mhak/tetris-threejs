// Online protocol: every message is a JSON object with a `t` (type) field,
// sent over one reliable, ordered data channel. See docs/online-2p-spec.md.

/* global __BUILD_ID__ */
// The deployed commit, injected by vite.config.js. Two devices only play when
// their IDs match, so both run the same rules and the same piece generator.
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

export const MSG = Object.freeze({
  hello: 'hello', // { v, name, token? } first message both ways; must keep this shape forever
  full: 'full', // host to guest: room already has a guest
  version: 'version', // { v } build IDs differ; must keep this shape forever
  start: 'start', // host to guest { round, seed, countdownMs }: start a round with this piece seed
  state: 'state', // board snapshot, see snapshotOf()
  attack: 'attack', // { round, kind: 'line' | 'drop' }
  over: 'over', // { round } the sender topped out
  result: 'result', // host to guest { round, winner: 'host' | 'guest' | 'draw' }
  ready: 'ready', // { round } ready for a rematch
  pause: 'pause', // { reason? } pause both; reason 'hidden' when the sender went to the background
  resume: 'resume', // resume both, after a countdown
  ping: 'ping', // { ts } every second; the liveness signal
  pong: 'pong', // { ts } answer to ping
  bye: 'bye', // the player left the room
  sync: 'sync', // host to guest after a reconnect { round, seed, winner, ready, wins }
});

/** True for something that looks like a protocol message. */
export function isMessage(msg) {
  return msg != null && typeof msg === 'object' && typeof msg.t === 'string';
}

/** 200 characters, one base-36 digit per cell (values 0..11), row by row. */
export function encodeField(field) {
  let out = '';
  for (const row of field) for (const v of row) out += v.toString(36);
  return out;
}

/** The other way; anything malformed becomes empty cells. */
export function decodeField(text, width = 10, height = 20) {
  const ok = typeof text === 'string' && text.length === width * height;
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const v = ok ? parseInt(text[y * width + x], 36) : 0;
      return v >= 0 && v <= 11 ? v : 0;
    }),
  );
}

/** What the opponent needs to draw our board: sent when anything in it changes. */
export function snapshotOf(field, round) {
  const p = field.isGameOver ? null : field.currentPiece;
  return {
    t: MSG.state,
    round,
    field: encodeField(field.field),
    piece: p && { kind: p.kind, rot: p.orientation, x: p.posX, y: p.posY },
    powers: field.powers.slice(),
    score: field.score,
    lines: field.lines,
    over: field.isGameOver,
  };
}
