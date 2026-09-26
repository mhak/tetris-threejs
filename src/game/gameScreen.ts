// Port of Tetris/Screens/GameScreen.cs (game rules, input handling, powers).
// Rendering lives in src/render; audio playback in src/audio.ts.
import { Block } from './block.ts';
import { TetrisField, type Sounds, type TetrisFieldOptions } from './tetrisField.ts';
import { RemoteField, type AttackKind } from './remoteField.ts';
import { mulberry32 } from './random.ts';
import { emptyState, type Button, type PadState } from './input.ts';

// Add Line and Drop target opponents, so solo play only gets self-powers.
const SOLO_POWERS = [Block.ClearLine, Block.LeftSlide];

/** A board in GameScreen.players: our own, or online the opponent's mirror. */
export type Board = TetrisField | RemoteField;

/** Online round result: 0 (we won), 1 (they won) or 'draw'. */
export type GameResult = 0 | 1 | 'draw';

export interface GameScreenOptions {
  playerCount?: number;
  sounds?: Sounds;
  random?: () => number;
  pieceSeed?: number | null;
  online?: boolean;
}

export class GameScreen {
  online: boolean;
  playerCount: number;
  sounds: Sounds | undefined;
  random: () => number;
  pieceSeed: number | null;
  round: number;
  countdown: number;
  result: GameResult | null;
  names: [string, string] | null;
  overSent: boolean;
  pendingAttacks: AttackKind[];
  players: Board[];
  oldStates: PadState[];
  keysAccumulation: number[];
  pause: boolean;

  // Hooks for effects (main.ts) and, online, the session.
  onTetris?: (field: TetrisField) => void;
  onHardDrop?: (field: TetrisField) => void;
  onBoom?: (field: TetrisField) => void;
  onHit?: (kind: AttackKind) => void;
  onAttack?: (kind: AttackKind) => void;
  onOver?: () => void;
  onStartPressed?: () => void;

  /**
   * @param pieceSeed gives every local field the same piece sequence
   * @param online versus against another device: player 0 is the local board
   *   and player 1 a RemoteField that mirrors the opponent's snapshots. The
   *   session (src/net/session.ts) starts rounds and decides results.
   */
  constructor({ playerCount = 2, sounds, random = Math.random, pieceSeed = null, online = false }: GameScreenOptions = {}) {
    this.online = online;
    this.playerCount = online ? 2 : playerCount;
    this.sounds = sounds;
    this.random = random;
    this.pieceSeed = pieceSeed;
    // Online only, set through startRound() and the session.
    this.round = 0;
    this.countdown = 0; // ms before input and gravity (re)start
    this.result = null; // null while undecided, then 0 (we won), 1 (they won) or 'draw'
    this.names = null; // [local, remote] display names
    this.overSent = false;
    this.pendingAttacks = [];
    this.players = [];
    this.oldStates = [];
    this.keysAccumulation = [];
    this.pause = false;
    for (let i = 0; i < this.playerCount; i++) {
      this.players.push(this.createField(i));
      this.oldStates.push(emptyState());
      this.keysAccumulation.push(0);
    }
  }

  createField(i: number): Board {
    if (this.online && i > 0) {
      return new RemoteField(i, { round: this.round, onAttack: (kind) => this.onAttack?.(kind) });
    }
    const options: TetrisFieldOptions = { sounds: this.sounds, random: this.random };
    // A fresh PRNG per field, so one player's pieces never use up another's numbers.
    if (this.pieceSeed !== null) options.pieceRandom = mulberry32(this.pieceSeed);
    if (this.playerCount === 1) options.powerList = SOLO_POWERS;
    return new TetrisField(i, options);
  }

  get hasWinner(): boolean {
    return this.players.some((p) => p.isWinner);
  }

  /** Every player topped out: game over in solo, a draw in versus. */
  get allOut(): boolean {
    return this.players.every((p) => p.isGameOver);
  }

  get isFinished(): boolean {
    if (this.online) return this.result !== null;
    return this.hasWinner || this.allOut;
  }

  /** Online: input and gravity are live (started, not paused, counted down, undecided). */
  get running(): boolean {
    return this.round > 0 && !this.pause && this.countdown <= 0 && this.result === null;
  }

  /** Our own board: the only one online, player 1's in local play. */
  get localField(): TetrisField {
    return this.players[0] as TetrisField;
  }

  opponentsOf(playerField: Board): Board[] {
    return this.players.filter((p) => p !== playerField && !p.isGameOver);
  }

  /** @param getState (playerIndex) => virtual pad state */
  update(elapsedMs: number, getState: (playerIndex: number) => PadState) {
    if (this.online) {
      this.updateOnline(elapsedMs, getState);
      return;
    }
    if (this.allOut) {
      // Game-over players are skipped below, so handle restart here.
      const states = this.players.map((_, i) => getState(i));
      const restart = states.some((s, i) => s.start && !this.oldStates[i].start);
      this.oldStates = states;
      if (restart) this.restartGame();
      return;
    }

    for (let i = 0; i < this.players.length; i++) {
      const playerField = this.players[i];
      // A remote board is run by the other device; we only draw it.
      if (playerField.isRemote || playerField.isGameOver) continue;

      // Solo play has no winner; the round ends at game over instead.
      playerField.isWinner =
        this.players.length > 1 &&
        this.players.filter((p) => p !== playerField).every((p) => p.isGameOver);

      if (!this.handlePlayerInputs(elapsedMs, playerField, getState(i), this.oldStates[i])) continue;

      const lines = playerField.update(elapsedMs);

      if (lines === 4) {
        for (const player of this.opponentsOf(playerField)) player.addLine();
        this.onTetris?.(playerField);
      }
    }
  }

  /**
   * Online there is one local board. It never wins, loses or restarts here:
   * the host decides results, and Start goes to the session (pause, resume,
   * ready for a rematch) through onStartPressed.
   */
  updateOnline(elapsedMs: number, getState: (playerIndex: number) => PadState) {
    const local = this.localField;
    const next = getState(0);
    const old = this.oldStates[0];
    if (!this.pause && this.countdown > 0) this.countdown = Math.max(0, this.countdown - elapsedMs);
    if (this.running) this.flushAttacks();

    if (!this.running || local.isGameOver) {
      this.oldStates[0] = next;
      if (next.start && !old.start) this.onStartPressed?.();
    } else if (this.handlePlayerInputs(elapsedMs, local, next, old)) {
      const lines = local.update(elapsedMs);
      if (lines === 4) {
        for (const player of this.opponentsOf(local)) player.addLine();
        this.onTetris?.(local);
      }
    }
    this.checkOver();
  }

  /** Online: tell the session once when our board tops out. */
  checkOver() {
    if (!this.online || this.overSent || this.result !== null || this.round === 0) return;
    if (!this.localField.isGameOver) return;
    this.overSent = true;
    this.onOver?.();
  }

  /** Online: an attack from the opponent ('line' or 'drop'). Held while paused. */
  receiveAttack(kind: AttackKind) {
    if (this.round === 0 || this.result !== null || this.localField.isGameOver) return;
    if (this.running) this.applyAttack(kind);
    else this.pendingAttacks.push(kind);
  }

  flushAttacks() {
    const queued = this.pendingAttacks;
    this.pendingAttacks = [];
    for (const kind of queued) this.applyAttack(kind);
  }

  applyAttack(kind: AttackKind) {
    const local = this.localField;
    if (local.isGameOver) return;
    if (kind === 'line') {
      local.addLine();
    } else if (kind === 'drop') {
      local.movePieceHardDrop();
      this.sounds?.play('boom', 0.5);
      this.onBoom?.(local);
    } else {
      return;
    }
    this.onHit?.(kind);
    this.checkOver();
  }

  handlePlayerInputs(elapsedMs: number, playerField: TetrisField, next: PadState, old: PadState): boolean {
    const n = playerField.playerNum;
    const pressed = (b: Button) => next[b] && !old[b];
    const repeat = (b: Button) => {
      this.keysAccumulation[n] += elapsedMs;
      return !old[b] || this.keysAccumulation[n] >= playerField.keyPressDelay;
    };

    if (pressed('start')) {
      if (this.online) {
        this.onStartPressed?.();
      } else if (playerField.isWinner) {
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

  usePower(playerField: TetrisField) {
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
      // Online the shake is for the player who gets hit (applyAttack).
      if (!this.online) this.onBoom?.(playerField);
      return;
    }

    if (power === Block.LeftSlide) {
      playerField.leftSlide();
    }
  }

  /** Online: fresh boards for a round, with its piece seed and a countdown. */
  startRound(round: number, seed: number | null = null, countdownMs = 0) {
    this.round = round;
    this.pieceSeed = seed;
    this.countdown = countdownMs;
    this.result = null;
    this.overSent = false;
    this.pendingAttacks = [];
    this.pause = false;
    this.restartGame();
  }

  restartGame() {
    for (let i = 0; i < this.players.length; i++) {
      this.players[i] = this.createField(i);
    }
  }
}
