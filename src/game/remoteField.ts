// Read-only stand-in for the opponent's board in online play, drawn from the
// snapshots the other device sends. It sits in GameScreen.players like a
// TetrisField, so attacks aimed at it (a Tetris, Add Line, Drop) land here and
// are forwarded to the other device instead of changing a board.
import { Width, Height } from './tetrisField.ts';
import { SHAPES, createTetromino, type PieceKind, type Tetromino } from './tetromino.ts';
import { decodeField, type Snapshot } from '../net/protocol.ts';

export type AttackKind = 'line' | 'drop';

/** A snapshot as received: any field may be missing or junk. */
export type SnapshotLike = { [K in keyof Snapshot]?: unknown };

const MAX_POWERS = 5;

const int = (v: unknown, min: number, max: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v as number))) : min;

function pieceFrom(value: unknown): Tetromino | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as { kind?: unknown; rot?: unknown; x?: unknown; y?: unknown };
  if (!Object.hasOwn(SHAPES, p.kind as PropertyKey)) return null;
  const piece = createTetromino(p.kind as PieceKind);
  for (let r = int(p.rot, 0, 3); r > 0; r--) piece.rotateRight();
  piece.posX = int(p.x, -4, Width + 4);
  piece.posY = int(p.y, -4, Height + 4);
  return piece;
}

export interface RemoteFieldOptions {
  round?: number;
  onAttack?: ((kind: AttackKind) => void) | null;
}

export class RemoteField {
  readonly isRemote = true;
  playerNum: number;
  round: number;
  onAttack: ((kind: AttackKind) => void) | null;
  field: number[][];
  currentPiece: Tetromino | null;
  heldPiece: Tetromino | null;
  nextPiece: Tetromino | null;
  powers: number[];
  score: number;
  lines: number;
  isGameOver: boolean;
  isWinner: boolean;

  constructor(playerNum = 1, { round = 0, onAttack = null }: RemoteFieldOptions = {}) {
    this.playerNum = playerNum;
    this.round = round;
    this.onAttack = onAttack;
    this.field = decodeField(null, Width, Height);
    this.currentPiece = null;
    this.heldPiece = null;
    this.nextPiece = null;
    this.powers = [];
    this.score = 0;
    this.lines = 0;
    this.isGameOver = false;
    this.isWinner = false;
  }

  get level(): number {
    return Math.floor(this.lines / 10);
  }

  /** Copies a snapshot in; returns false for one from another round. */
  applySnapshot(msg: SnapshotLike | null | undefined): boolean {
    if (!msg || msg.round !== this.round) return false;
    this.field = decodeField(msg.field, Width, Height);
    this.currentPiece = pieceFrom(msg.piece);
    this.powers = Array.isArray(msg.powers)
      ? msg.powers.filter((v): v is number => Number.isInteger(v) && v >= 8 && v <= 11).slice(0, MAX_POWERS)
      : [];
    this.score = int(msg.score, 0, Number.MAX_SAFE_INTEGER);
    this.lines = int(msg.lines, 0, Number.MAX_SAFE_INTEGER);
    this.isGameOver = msg.over === true;
    return true;
  }

  addLine() {
    this.onAttack?.('line');
  }

  movePieceHardDrop() {
    this.onAttack?.('drop');
  }
}
