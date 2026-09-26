// Port of Tetris/Models/TetrisField.cs
import { Block } from './block.ts';
import { TETROMINO_KINDS, createTetromino, type Tetromino } from './tetromino.ts';
import {
  ClockwiseOffsets,
  CounterclockwiseOffsets,
  LineClockwiseOffsets,
  LineCounterclockwiseOffsets,
  type KickTable,
} from './wallKick.ts';

export const Width = 10;
export const Height = 20;
const MaxXIndex = Width - 1;
const MaxYIndex = Height - 1;
const PowerStartIndex = 8;
const SCORES = [40, 100, 300, 1200];

const emptyRow = (): number[] => new Array(Width).fill(0);

export type SoundName = 'gameOver' | 'impact' | 'clear' | 'tetris' | 'boom';

/** Sound hooks, e.g. src/audio.ts. */
export interface Sounds {
  play(name: SoundName, volume?: number): void;
}

const silent: Sounds = { play() {} };

export interface TetrisFieldOptions {
  sounds?: Sounds;
  random?: () => number;
  pieceRandom?: () => number;
  powerList?: readonly number[];
}

export class TetrisField {
  readonly isRemote = false;
  playerNum: number;
  sounds: Sounds;
  random: () => number;
  pieceRandom: () => number;
  field: number[][];
  revision: number;
  speed: number;
  current: number;
  isGameOver: boolean;
  isWinner: boolean;
  keyPressDelay: number;
  score: number;
  lines: number;
  powerInterval: number;
  powerIntervalCount: number;
  powerList: readonly number[];
  powers: number[];
  powersMax: number;
  disablePowerCollect: boolean;
  canHoldPiece: boolean;
  // Set by activatePiece() in the constructor.
  currentPiece!: Tetromino;
  heldPiece: Tetromino | null;
  nextPiece: Tetromino;

  /**
   * @param random power spawns and garbage gaps
   * @param pieceRandom the piece sequence only, so garbage and powers can't
   *   shift it (online both players get the same pieces from a shared seed)
   */
  constructor(
    playerNum = 0,
    {
      sounds = silent,
      random = Math.random,
      pieceRandom = random,
      powerList = [Block.AddLine, Block.ClearLine, Block.Drop, Block.LeftSlide],
    }: TetrisFieldOptions = {},
  ) {
    this.playerNum = playerNum;
    this.sounds = sounds;
    this.random = random;
    this.pieceRandom = pieceRandom;

    this.field = Array.from({ length: Height }, emptyRow);
    // Goes up whenever a cell changes, so online play can tell cheaply when
    // the board needs sending again.
    this.revision = 0;
    this.speed = 1000;
    this.current = 0;
    this.isGameOver = false;
    this.isWinner = false;
    this.keyPressDelay = 150;
    this.score = 0;
    this.lines = 0;
    this.powerInterval = 4;
    this.powerIntervalCount = 0;
    // The last entry is the rare one (15%); the rest share the other 85%.
    this.powerList = powerList;
    this.powers = [];
    this.powersMax = 5;
    this.disablePowerCollect = false;
    this.canHoldPiece = true;

    this.heldPiece = null;
    this.nextPiece = this.generatePiece();
    this.activatePiece();
  }

  get level() {
    return Math.floor(this.lines / 10);
  }

  randomInt(max: number): number {
    return Math.floor(this.random() * max);
  }

  activatePiece() {
    this.currentPiece = this.nextPiece;
    this.nextPiece = this.generatePiece();
    this.disablePowerCollect = false;
    this.spawn(this.currentPiece);
  }

  /** Places a piece at the spawn row; the next update() ends the game if it doesn't fit. */
  spawn(piece: Tetromino) {
    piece.posX = Width / 2 - 2;
    piece.posY = -1;
  }

  /** Row the current piece would land on. Computed on demand so it can't go stale. */
  get shadowY(): number {
    const piece = this.currentPiece;
    let y = piece.posY;
    while (!this.isCollision(piece, y + 1)) y++;
    return y;
  }

  generatePiece(): Tetromino {
    const kind = TETROMINO_KINDS[Math.floor(this.pieceRandom() * TETROMINO_KINDS.length)];
    return this.resetPosition(createTetromino(kind));
  }

  resetPosition(piece: Tetromino): Tetromino {
    piece.posX = Width / 2 - 2;
    piece.posY = 0;
    return piece;
  }

  holdPiece() {
    if (!this.canHoldPiece) return;

    const held = this.resetPosition(this.currentPiece);
    held.resetRotation();
    if (this.heldPiece == null) {
      this.heldPiece = held;
      this.activatePiece();
    } else {
      this.currentPiece = this.heldPiece;
      this.heldPiece = held;
      this.spawn(this.currentPiece);
    }

    this.canHoldPiece = false;
  }

  /** Advances the field by `elapsedMs`; returns the number of lines cleared. */
  update(elapsedMs: number): number {
    // Only a spawn (or held piece) that doesn't fit can overlap here: every
    // other field change runs settlePiece() to push the piece clear.
    if (this.isCollision(this.currentPiece)) {
      this.setGameOver();
      return 0;
    }

    const lines = this.clearLines();

    this.current += elapsedMs;
    if (this.current >= this.speed) {
      this.movePieceDown();
      this.current = 0;
    }
    return lines;
  }

  movePieceLeft() {
    this.currentPiece.posX--;
    if (this.isCollision(this.currentPiece)) {
      this.currentPiece.posX++;
    }
  }

  movePieceRight() {
    this.currentPiece.posX++;
    if (this.isCollision(this.currentPiece)) {
      this.currentPiece.posX--;
    }
  }

  movePieceDown() {
    this.currentPiece.posY++;

    if (this.isCollision(this.currentPiece)) {
      this.currentPiece.posY--;
      this.lockPiece();
    }
  }

  setGameOver() {
    this.sounds.play('gameOver', 1);
    this.isGameOver = true;
  }

  rotatePieceLeft() {
    this.currentPiece.rotateLeft();
    if (this.isCollision(this.currentPiece)) {
      if (!this.wallKicked(false)) {
        this.currentPiece.rotateRight();
      }
    }
  }

  rotatePieceRight() {
    this.currentPiece.rotateRight();
    if (this.isCollision(this.currentPiece)) {
      if (!this.wallKicked(true)) {
        this.currentPiece.rotateLeft();
      }
    }
  }

  movePieceHardDrop() {
    do {
      this.currentPiece.posY++;
    } while (!this.isCollision(this.currentPiece));
    this.currentPiece.posY--;
    this.lockPiece();
  }

  /** Locks the landed piece, or ends the game if part of it is above the well. */
  lockPiece() {
    if (this.isAboveField(this.currentPiece)) {
      this.setGameOver();
      return;
    }
    this.handlePieceImpact();
  }

  isAboveField(piece: Tetromino): boolean {
    return piece.shape.some((row, y) => y + piece.posY < 0 && row.some((v) => v !== 0));
  }

  /**
   * After the field changed under the falling piece (garbage line, powers),
   * push the piece up until it no longer overlaps instead of ending the game.
   */
  settlePiece() {
    const piece = this.currentPiece;
    if (!piece) return;
    while (this.isCollision(piece) && piece.posY > -piece.shape.length) {
      piece.posY--;
    }
  }

  handlePieceImpact() {
    this.sounds.play('impact', 0.5);
    this.addPieceToField();
    this.activatePiece();
    this.canHoldPiece = true;
  }

  isCollision(piece: Tetromino, yReplace: number | null = null): boolean {
    const yToCheck = yReplace ?? piece.posY;

    if (piece.posX > MaxXIndex) return true;
    if (piece.posY > MaxYIndex) return true;

    const shape = piece.shape;
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x] === 0) continue;
        if (y + yToCheck > MaxYIndex) return true;
        if (x + piece.posX < 0) return true;
        if (x + piece.posX > MaxXIndex) return true;
        if (y + yToCheck < 0) continue;
        if (this.field[y + yToCheck][x + piece.posX] > 0) return true;
      }
    }
    return false;
  }

  addPieceToField() {
    this.revision++;
    const piece = this.currentPiece;
    for (let y = 0; y < piece.shape.length; y++) {
      for (let x = 0; x < piece.shape[y].length; x++) {
        if (piece.shape[y][x] === 0) continue;
        this.field[y + piece.posY][x + piece.posX] = piece.shape[y][x];
      }
    }
  }

  wallKicked(isClockwise: boolean): boolean {
    const piece = this.currentPiece;
    if (piece.kind === 'O') return false;

    let table: KickTable;
    if (piece.kind === 'I') {
      table = isClockwise ? LineClockwiseOffsets : LineCounterclockwiseOffsets;
    } else {
      table = isClockwise ? ClockwiseOffsets : CounterclockwiseOffsets;
    }
    return this.checkWallKick(table[piece.orientation]);
  }

  checkWallKick(offsets: KickTable[number]): boolean {
    const piece = this.currentPiece;
    const currX = piece.posX;
    const currY = piece.posY;

    for (const [ox, oy] of offsets) {
      piece.posX += ox;
      piece.posY -= oy;
      if (!this.isCollision(piece)) return true;
      piece.posX = currX;
      piece.posY = currY;
    }
    return false;
  }

  clearLines(): number {
    let lines = 0;
    let linesWithPowers = 0;
    const powersToAdd: number[] = [];
    for (let y = Height - 1; y >= 0; y--) {
      powersToAdd.length = 0;
      for (let x = 0; x < Width; x++) {
        const val = this.field[y][x];
        if (val === 0) break;

        if (val >= PowerStartIndex && !this.disablePowerCollect) {
          powersToAdd.push(val);
        }
        if (x === Width - 1) {
          this.field.splice(y, 1);
          lines++;
          if (powersToAdd.length > 0) linesWithPowers++;
          if (this.powers.length < this.powersMax) {
            this.powers.push(...powersToAdd.slice(0, this.powersMax - this.powers.length));
          }
        }
      }
    }
    if (lines === 0) return 0;

    this.revision++;
    for (let i = 0; i < lines; i++) {
      this.field.unshift(emptyRow());
    }
    this.lines += lines;
    // Rows that paid out a power don't count towards spawning the next one.
    this.powerIntervalCount += lines - linesWithPowers;
    while (this.powerIntervalCount >= this.powerInterval) {
      this.spawnRandomPower();
      this.powerIntervalCount -= this.powerInterval;
    }
    this.sounds.play(lines === 4 ? 'tetris' : 'clear', 1);
    this.score += lines > 3 ? 1200 : SCORES[lines - 1];
    return lines;
  }

  shiftPowersLeft() {
    if (this.powers.length < 2) return;
    this.powers.push(this.powers.shift()!);
  }

  shiftPowersRight() {
    if (this.powers.length < 2) return;
    this.powers.unshift(this.powers.pop()!);
  }

  // #region powers
  spawnRandomPower() {
    let isEmpty = true;
    for (let i = 0; i < Width; i++) {
      if (this.field[Height - 1][i] > 0) isEmpty = false;
    }
    if (isEmpty) return;

    const ran = this.randomInt(100);
    const power =
      ran >= 85
        ? this.powerList[this.powerList.length - 1]
        : this.powerList[this.randomInt(this.powerList.length - 1)];

    // The original re-rolled random cells until it hit a normal block; picking
    // from the candidates directly is equivalent and can't loop forever.
    const candidates: [number, number][] = [];
    for (let y = 0; y < Height; y++) {
      for (let x = 0; x < Width; x++) {
        const val = this.field[y][x];
        if (val >= 1 && val <= 7) candidates.push([x, y]);
      }
    }
    if (candidates.length === 0) return;
    const [rx, ry] = candidates[this.randomInt(candidates.length)];
    this.field[ry][rx] = power;
    this.revision++;
  }

  addLine() {
    this.revision++;
    const emptyIndex = this.randomInt(10);
    const line: number[] = [];
    for (let i = 0; i < Width; i++) {
      line.push(i === emptyIndex ? Block.None : Block.Z);
    }
    this.field.push(line);
    this.field.shift();
    this.settlePiece();
  }

  clearLine() {
    this.revision++;
    this.field.splice(Height - 1, 1);
    this.field.unshift(emptyRow());
    this.settlePiece();
  }


  leftSlide() {
    this.revision++;
    this.disablePowerCollect = true;
    for (let y = 0; y < Height; y++) {
      let count = 0;
      for (let x = 0; x < Width; x++) {
        if (this.field[y][x] !== 0) this.field[y][count++] = this.field[y][x];
      }
      while (count < Width) this.field[y][count++] = 0;
    }
    this.settlePiece();
  }
  // #endregion powers
}
