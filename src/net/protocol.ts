// Online protocol: every message is a JSON object with a `t` (type) field,
// sent over one reliable, ordered data channel. See docs/online-2p-spec.md.
import type { TetrisField } from '../game/tetrisField.ts';
import type { PieceKind } from '../game/tetromino.ts';

// The deployed commit, injected by vite.config.ts. Two devices only play when
// their IDs match, so both run the same rules and the same piece generator.
export const BUILD_ID: string = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

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

/** A received message: the type is known, every other field is unchecked. */
export interface Message {
  t: string;
  [field: string]: unknown;
}

/** True for something that looks like a protocol message. */
export function isMessage(msg: unknown): msg is Message {
  return msg != null && typeof msg === 'object' && typeof (msg as { t?: unknown }).t === 'string';
}

/** 200 characters, one base-36 digit per cell (values 0..11), row by row. */
export function encodeField(field: readonly (readonly number[])[]): string {
  let out = '';
  for (const row of field) for (const v of row) out += v.toString(36);
  return out;
}

/** The other way; anything malformed becomes empty cells. */
export function decodeField(text: unknown, width = 10, height = 20): number[][] {
  const ok = typeof text === 'string' && text.length === width * height;
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const v = ok ? parseInt((text as string)[y * width + x], 36) : 0;
      return v >= 0 && v <= 11 ? v : 0;
    }),
  );
}

export interface Snapshot {
  t: typeof MSG.state;
  round: number;
  field: string;
  piece: { kind: PieceKind; rot: number; x: number; y: number } | null;
  powers: number[];
  score: number;
  lines: number;
  over: boolean;
}

/** What the opponent needs to draw our board: sent when anything in it changes. */
export function snapshotOf(field: TetrisField, round: number): Snapshot {
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
