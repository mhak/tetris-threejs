// Port of Tetris/Screens/GameScreen.cs (game rules, input handling, powers).
// Rendering lives in src/render; audio playback in src/audio.js.
import { Block } from './block.js';
import { TetrisField } from './tetrisField.js';
import { emptyState } from './input.js';

export class GameScreen {
  constructor({ playerCount = 2, sounds, random = Math.random } = {}) {
    this.playerCount = playerCount;
    this.sounds = sounds;
    this.random = random;
    this.players = [];
    this.oldStates = [];
    this.keysAccumulation = [];
    this.pause = false;
    for (let i = 0; i < playerCount; i++) {
      this.players.push(this.createField(i));
      this.oldStates.push(emptyState());
      this.keysAccumulation.push(0);
    }
  }

  createField(i) {
    return new TetrisField(i, { sounds: this.sounds, random: this.random });
  }

  get hasWinner() {
    return this.players.some((p) => p.isWinner);
  }

  /** Every player topped out (e.g. both in the same frame), so nobody won. */
  get isDraw() {
    return this.players.every((p) => p.isGameOver);
  }

  get isFinished() {
    return this.hasWinner || this.isDraw;
  }

  opponentsOf(playerField) {
    return this.players.filter((p) => p !== playerField && !p.isGameOver);
  }

  /** @param getState (playerIndex) => virtual pad state */
  update(elapsedMs, getState) {
    if (this.isDraw) {
      // Game-over players are skipped below, so handle restart here.
      const states = this.players.map((_, i) => getState(i));
      const restart = states.some((s, i) => s.start && !this.oldStates[i].start);
      this.oldStates = states;
      if (restart) this.restartGame();
      return;
    }

    for (let i = 0; i < this.players.length; i++) {
      const playerField = this.players[i];
      if (playerField.isGameOver) continue;

      playerField.isWinner = this.players
        .filter((p) => p.playerNum !== playerField.playerNum)
        .every((p) => p.isGameOver);

      if (!this.handlePlayerInputs(elapsedMs, playerField, getState(i), this.oldStates[i])) continue;

      const lines = playerField.update(elapsedMs);

      if (lines === 4) {
        for (const player of this.opponentsOf(playerField)) player.addLine();
        this.onTetris?.(playerField);
      }
    }
  }

  handlePlayerInputs(elapsedMs, playerField, next, old) {
    const n = playerField.playerNum;
    const pressed = (b) => next[b] && !old[b];
    const repeat = (b) => {
      this.keysAccumulation[n] += elapsedMs;
      return !old[b] || this.keysAccumulation[n] >= playerField.keyPressDelay;
    };

    if (pressed('start')) {
      if (playerField.isWinner) {
        this.restartGame();
      } else {
        this.pause = !this.pause;
      }
    }

    if (this.pause || playerField.isGameOver || playerField.isWinner) {
      this.oldStates[n] = next;
      return false;
    }

    if (next.left && !next.down && repeat('left')) {
      playerField.movePieceLeft();
      this.keysAccumulation[n] = 0;
    }

    if (next.down && !next.left && !next.right && repeat('down')) {
      playerField.movePieceDown();
      this.keysAccumulation[n] = 0;
    }

    if (next.right && !next.down && repeat('right')) {
      playerField.movePieceRight();
      this.keysAccumulation[n] = 0;
    }

    if (pressed('up') && !next.left && !next.right) {
      playerField.movePieceHardDrop();
      this.keysAccumulation[n] = 0;
      this.onHardDrop?.(playerField);
    }

    if (next.a) {
      this.keysAccumulation[n] += elapsedMs;
      if (!old.a) {
        playerField.rotatePieceRight();
        this.keysAccumulation[n] = 0;
      }
    }

    if (next.x) {
      this.keysAccumulation[n] += elapsedMs;
      if (!old.x) {
        playerField.rotatePieceLeft();
        this.keysAccumulation[n] = 0;
      }
    }

    if (pressed('rb')) playerField.holdPiece();
    if (pressed('y')) this.usePower(playerField);
    if (pressed('lt')) playerField.shiftPowersLeft();
    if (pressed('rt')) playerField.shiftPowersRight();

    this.oldStates[n] = next;
    return true;
  }

  usePower(playerField) {
    if (playerField.powers.length < 1) return;
    const power = playerField.powers.shift();

    if (power === Block.AddLine) {
      for (const player of this.opponentsOf(playerField)) player.addLine();
      return;
    }

    if (power === Block.ClearLine) {
      playerField.clearLine();
      return;
    }

    if (power === Block.Drop) {
      for (const player of this.opponentsOf(playerField)) player.movePieceHardDrop();
      this.sounds?.play('boom', 0.5);
      this.onBoom?.(playerField);
      return;
    }

    if (power === Block.LeftSlide) {
      playerField.leftSlide();
    }
  }

  restartGame() {
    for (let i = 0; i < this.players.length; i++) {
      this.players[i] = this.createField(i);
    }
  }
}
