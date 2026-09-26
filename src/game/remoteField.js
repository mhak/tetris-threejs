// Read-only stand-in for the opponent's board in online play, drawn from the
// snapshots the other device sends. It sits in GameScreen.players like a
// TetrisField, so attacks aimed at it (a Tetris, Add Line, Drop) land here and
// are forwarded to the other device instead of changing a board.
import { Width, Height } from './tetrisField.js';
import { SHAPES, createTetromino } from './tetromino.js';
import { decodeField } from '../net/protocol.js';

const MAX_POWERS = 5;

const int = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : min);

function pieceFrom(p) {
  if (!p || typeof p !== 'object' || !Object.hasOwn(SHAPES, p.kind)) return null;
  const piece = createTetromino(p.kind);
  for (let r = int(p.rot, 0, 3); r > 0; r--) piece.rotateRight();
  piece.posX = int(p.x, -4, Width + 4);
  piece.posY = int(p.y, -4, Height + 4);
  return piece;
}

export class RemoteField {
  /** @param onAttack (kind) => void, kind 'line' or 'drop' */
  constructor(playerNum = 1, { round = 0, onAttack = null } = {}) {
    this.playerNum = playerNum;
    this.isRemote = true;
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

  get level() {
    return Math.floor(this.lines / 10);
  }

  /** Copies a snapshot in; returns false for one from another round. */
  applySnapshot(msg) {
    if (msg?.round !== this.round) return false;
    this.field = decodeField(msg.field, Width, Height);
    this.currentPiece = pieceFrom(msg.piece);
    this.powers = Array.isArray(msg.powers)
      ? msg.powers.filter((v) => Number.isInteger(v) && v >= 8 && v <= 11).slice(0, MAX_POWERS)
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
