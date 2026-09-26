// Port of Tetris/Models/TetrisField.cs
import { Block } from './block.js';
import { TETROMINO_KINDS, createTetromino } from './tetromino.js';
import {
  ClockwiseOffsets,
  CounterclockwiseOffsets,
  LineClockwiseOffsets,
  LineCounterclockwiseOffsets,
} from './wallKick.js';

export const Width = 10;
export const Height = 20;
const MaxXIndex = Width - 1;
const MaxYIndex = Height - 1;
const PowerStartIndex = 8;
const SCORES = [40, 100, 300, 1200];

const emptyRow = () => new Array(Width).fill(0);

// Sound hooks: { play(name, volume) } where name is one of
// 'gameOver' | 'impact' | 'clear' | 'tetris' | 'boom'.
const silent = { play() {} };

export class TetrisField {
  constructor(playerNum = 0, deaths = 0, { sounds = silent, random = Math.random } = {}) {
    this.playerNum = playerNum;
    this.deaths = deaths;
    this.sounds = sounds;
    this.random = random;

    this.field = Array.from({ length: Height }, emptyRow);
    this.speed = 1000;
    this.current = 0;
    this.isGameOver = false;
    this.isWinner = false;
    this.keyPressDelay = 150;
    this.score = 0;
    this.lines = 0;
    this.linesToAdd = 0;
    this.powerInterval = 4;
    this.powerIntervalCount = 0;
    this.powerList = [Block.AddLine, Block.ClearLine, Block.Drop, Block.LeftSlide];
    this.powers = [];
    this.powersMax = 5;
    this.disablePowerCollect = false;
    this.shadowY = 0;
    this.canHoldPiece = true;

    this.currentPiece = null;
    this.heldPiece = null;
    this.nextPiece = this.generatePiece();
    this.activatePiece();
  }

  get level() {
    return Math.floor(this.lines / 10);
  }

  randomInt(max) {
    return Math.floor(this.random() * max);
  }

  activatePiece() {
    this.currentPiece = this.nextPiece;
    this.nextPiece = this.generatePiece();
    this.disablePowerCollect = false;
    this.currentPiece.posY = -1;
    this.calculateShadowY();
  }

  calculateShadowY() {
    let y = this.currentPiece.posY > 0 ? this.currentPiece.posY + 1 : 1;
    while (!this.isCollision(this.currentPiece, y)) {
      y++;
    }
    this.shadowY = y - 1;
  }

  generatePiece() {
    const kind = TETROMINO_KINDS[this.randomInt(TETROMINO_KINDS.length)];
    return this.resetPosition(createTetromino(kind));
  }

  resetPosition(piece) {
    piece.posX = Width / 2 - 2;
    piece.posY = 0;
    return piece;
  }

  holdPiece() {
    if (!this.canHoldPiece) return;

    if (this.heldPiece == null) {
      this.heldPiece = this.resetPosition(this.currentPiece);
      this.activatePiece();
    } else {
      const temp = this.heldPiece;
      this.heldPiece = this.resetPosition(this.currentPiece);
      this.currentPiece = temp;
      this.calculateShadowY();
    }

    this.canHoldPiece = false;
  }

  /** Advances the field by `elapsedMs`; returns the number of lines cleared. */
  update(elapsedMs) {
    while (this.linesToAdd > 0) {
      this.addLine();
      this.linesToAdd--;
    }

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
    this.calculateShadowY();
  }

  movePieceRight() {
    this.currentPiece.posX++;
    if (this.isCollision(this.currentPiece)) {
      this.currentPiece.posX--;
    }
    this.calculateShadowY();
  }

  movePieceDown() {
    this.currentPiece.posY++;

    if (this.isCollision(this.currentPiece)) {
      this.currentPiece.posY--;
      if (this.currentPiece.posY < 0) {
        this.setGameOver();
        return;
      }
      this.handlePieceImpact();
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
    this.calculateShadowY();
  }

  rotatePieceRight() {
    this.currentPiece.rotateRight();
    if (this.isCollision(this.currentPiece)) {
      if (!this.wallKicked(true)) {
        this.currentPiece.rotateLeft();
      }
    }
    this.calculateShadowY();
  }

  movePieceHardDrop() {
    do {
      this.currentPiece.posY++;
    } while (!this.isCollision(this.currentPiece));
    this.currentPiece.posY--;
    if (this.currentPiece.posY < 0) {
      this.setGameOver();
      return;
    }
    this.handlePieceImpact();
  }

  handlePieceImpact() {
    this.sounds.play('impact', 0.5);
    this.addPieceToField();
    this.activatePiece();
    this.canHoldPiece = true;
  }

  isCollision(piece, yReplace = null) {
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
    const piece = this.currentPiece;
    for (let y = 0; y < piece.shape.length; y++) {
      for (let x = 0; x < piece.shape[y].length; x++) {
        if (piece.shape[y][x] === 0) continue;
        this.field[y + piece.posY][x + piece.posX] = piece.shape[y][x];
      }
    }
  }

  wallKicked(isClockwise) {
    const piece = this.currentPiece;
    if (piece.kind === 'O') return false;

    let table;
    if (piece.kind === 'I') {
      table = isClockwise ? LineClockwiseOffsets : LineCounterclockwiseOffsets;
    } else {
      table = isClockwise ? ClockwiseOffsets : CounterclockwiseOffsets;
    }
    return this.checkWallKick(table[piece.orientation]);
  }

  checkWallKick(offsets) {
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

  clearLines() {
    let lines = 0;
    const powersToAdd = [];
    // Row 0 is never checked, matching the original loop bounds.
    for (let y = Height - 1; y > 0; y--) {
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
          if (this.powers.length < this.powersMax) {
            this.powers.push(...powersToAdd.slice(0, this.powersMax - this.powers.length));
          }
        }
      }
    }
    if (lines === 0) return 0;

    for (let i = 0; i < lines; i++) {
      this.field.unshift(emptyRow());
    }
    this.lines += lines;
    this.powerIntervalCount += lines - powersToAdd.length;
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
    this.powers.push(this.powers.shift());
  }

  shiftPowersRight() {
    if (this.powers.length < 2) return;
    this.powers.unshift(this.powers.pop());
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
    const candidates = [];
    for (let y = 0; y < Height; y++) {
      for (let x = 0; x < Width; x++) {
        const val = this.field[y][x];
        if (val >= 1 && val <= 7) candidates.push([x, y]);
      }
    }
    if (candidates.length === 0) return;
    const [rx, ry] = candidates[this.randomInt(candidates.length)];
    this.field[ry][rx] = power;
  }

  addLine() {
    const emptyIndex = this.randomInt(10);
    const line = [];
    for (let i = 0; i < Width; i++) {
      line.push(i === emptyIndex ? Block.None : Block.Z);
    }
    this.field.push(line);
    this.field.shift();
  }

  clearLine() {
    this.field.splice(19, 1);
    this.field.unshift(emptyRow());
  }

  gravity() {
    this.disablePowerCollect = true;
    for (let x = 0; x < Width; x++) {
      let count = Height - 1;
      for (let y = Height - 1; y > 0; y--) {
        if (this.field[y][x] !== 0) this.field[count--][x] = this.field[y][x];
      }
      while (count > 0) this.field[count--][x] = 0;
    }
  }

  leftSlide() {
    this.disablePowerCollect = true;
    for (let y = 0; y < Height; y++) {
      let count = 0;
      for (let x = 0; x < Width; x++) {
        if (this.field[y][x] !== 0) this.field[y][count++] = this.field[y][x];
      }
      while (count < Width) this.field[y][count++] = 0;
    }
  }
  // #endregion powers
}
