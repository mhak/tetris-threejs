import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TetrisField, Width, Height } from '../src/game/tetrisField.ts';
import { createTetromino, type PieceKind } from '../src/game/tetromino.ts';
import { GameScreen } from '../src/game/gameScreen.ts';
import { emptyState, type PadState } from '../src/game/input.ts';
import type { SoundName } from '../src/game/tetrisField.ts';
import { Block } from '../src/game/block.ts';

const fixedRandom = (value: number) => () => value;

/** The boards of a local game (no RemoteField). */
const fields = (game: GameScreen) => game.players as TetrisField[];

function fieldWith(kind: PieceKind) {
  const f = new TetrisField(0, { random: fixedRandom(0) });
  f.currentPiece = createTetromino(kind);
  f.resetPosition(f.currentPiece);
  f.currentPiece.posY = -1;
  return f;
}

test('rotateRight then rotateLeft restores the shape and orientation', () => {
  for (const kind of ['I', 'O', 'T', 'J', 'L', 'S', 'Z'] as const) {
    const p = createTetromino(kind);
    const original = JSON.stringify(p.shape);
    p.rotateRight();
    assert.equal(p.orientation, 1);
    p.rotateLeft();
    assert.equal(p.orientation, 0);
    assert.equal(JSON.stringify(p.shape), original, kind);
  }
});

test('rotateRight turns T clockwise', () => {
  const p = createTetromino('T');
  p.rotateRight();
  assert.deepEqual(p.shape, [
    [0, 4, 0],
    [0, 4, 4],
    [0, 4, 0],
  ]);
});

test('pieces do not share shape arrays', () => {
  const a = createTetromino('T');
  const b = createTetromino('T');
  a.rotateRight();
  assert.notDeepEqual(a.shape, b.shape);
});

test('hard drop lands the piece on the floor and spawns the next one', () => {
  const f = fieldWith('O');
  f.movePieceHardDrop();
  assert.equal(f.field[Height - 1][3], Block.O);
  assert.equal(f.field[Height - 1][4], Block.O);
  assert.equal(f.field[Height - 2][3], Block.O);
  assert.equal(f.currentPiece.posY, -1);
});

test('left and right movement stops at the walls', () => {
  const f = fieldWith('O');
  for (let i = 0; i < 20; i++) f.movePieceLeft();
  assert.equal(f.currentPiece.posX, 0);
  for (let i = 0; i < 20; i++) f.movePieceRight();
  assert.equal(f.currentPiece.posX, Width - 2);
});

test('clearing four lines scores a tetris', () => {
  const played: SoundName[] = [];
  const f = new TetrisField(0, { random: fixedRandom(0), sounds: { play: (n) => played.push(n) } });
  for (let y = Height - 4; y < Height; y++) f.field[y].fill(Block.J);
  assert.equal(f.clearLines(), 4);
  assert.equal(f.score, 1200);
  assert.equal(f.lines, 4);
  assert.ok(played.includes('tetris'));
  assert.ok(f.field.every((row) => row.every((v) => v === 0)));
});

test('clearing a line with a power block collects it', () => {
  const f = new TetrisField(0, { random: fixedRandom(0) });
  f.field[Height - 1].fill(Block.J);
  f.field[Height - 1][2] = Block.Drop;
  f.clearLines();
  assert.deepEqual(f.powers, [Block.Drop]);
});

test('addLine pushes a garbage row with one hole', () => {
  const f = new TetrisField(0, { random: fixedRandom(0.35) });
  f.addLine();
  const row = f.field[Height - 1];
  assert.equal(row.filter((v) => v === 0).length, 1);
  assert.equal(row[3], 0);
  assert.equal(f.field.length, Height);
});

test('leftSlide packs every row to the left', () => {
  const f = new TetrisField(0, { random: fixedRandom(0) });
  f.field[Height - 1] = [0, 1, 0, 2, 0, 0, 3, 0, 0, 0];
  f.leftSlide();
  assert.deepEqual(f.field[Height - 1], [1, 2, 3, 0, 0, 0, 0, 0, 0, 0]);
});

test('spawnRandomPower does not hang when only power blocks remain', () => {
  const f = new TetrisField(0, { random: fixedRandom(0) });
  f.field[Height - 1][0] = Block.AddLine;
  f.spawnRandomPower();
  assert.equal(f.field[Height - 1][0], Block.AddLine);
});

test('wall kick lets an I piece rotate next to the wall', () => {
  const f = fieldWith('I');
  f.currentPiece.rotateRight(); // vertical
  f.currentPiece.posY = 5;
  for (let i = 0; i < 10; i++) f.movePieceLeft();
  const before = f.currentPiece.posX;
  assert.equal(before, -1);
  f.rotatePieceLeft();
  assert.equal(f.currentPiece.orientation, 0);
  assert.ok(f.currentPiece.posX > before);
  assert.equal(f.isCollision(f.currentPiece), false);
});

test('a tetris sends a garbage line to the opponent', () => {
  const game = new GameScreen({ playerCount: 2, random: fixedRandom(0) });
  const [p1, p2] = game.players;
  for (let y = Height - 4; y < Height; y++) p1.field[y].fill(Block.J);
  game.update(16, () => emptyState());
  assert.equal(p1.lines, 4);
  assert.equal(p2.field[Height - 1].filter((v) => v === Block.Z).length, Width - 1);
});

test('start toggles pause and restarts after a win', () => {
  const game = new GameScreen({ playerCount: 2, random: fixedRandom(0) });
  const press = (i: number) => (j: number) => ({ ...emptyState(), start: i === j });
  game.update(16, press(0));
  assert.equal(game.pause, true);
  game.update(16, () => emptyState());
  game.update(16, press(0));
  assert.equal(game.pause, false);

  game.players[1].isGameOver = true;
  game.update(16, () => emptyState());
  assert.equal(game.players[0].isWinner, true);
  game.update(16, press(0));
  assert.equal(game.players[1].isGameOver, false);
});

test('held down key repeats after the key press delay', () => {
  const game = new GameScreen({ playerCount: 2, random: fixedRandom(0) });
  const p1 = fields(game)[0];
  const startX = p1.currentPiece.posX;
  const left = (j: number) => ({ ...emptyState(), left: j === 0 });
  game.update(16, left); // initial press moves immediately
  assert.equal(p1.currentPiece.posX, startX - 1);
  for (let i = 0; i < 5; i++) game.update(16, left); // 80ms held: no repeat yet
  assert.equal(p1.currentPiece.posX, startX - 1);
  for (let i = 0; i < 5; i++) game.update(16, left); // passes 150ms
  assert.equal(p1.currentPiece.posX, startX - 2);
});

test('holding rotate does not make a held direction repeat faster', () => {
  const game = new GameScreen({ playerCount: 2, random: fixedRandom(0) });
  const p1 = fields(game)[0];
  const hold = (buttons: Partial<PadState>) => (j: number) => ({ ...emptyState(), ...(j === 0 ? buttons : {}) });
  game.update(16, hold({ a: true })); // rotates once, then stays held
  const startX = p1.currentPiece.posX;
  game.update(16, hold({ a: true, left: true })); // initial press moves immediately
  assert.equal(p1.currentPiece.posX, startX - 1);
  for (let i = 0; i < 5; i++) game.update(16, hold({ a: true, left: true })); // 80ms: no repeat yet
  assert.equal(p1.currentPiece.posX, startX - 1);
  for (let i = 0; i < 5; i++) game.update(16, hold({ a: true, left: true })); // passes 150ms
  assert.equal(p1.currentPiece.posX, startX - 2);
});

test('a garbage line pushes a low piece up instead of ending the game', () => {
  const f = fieldWith('O');
  f.field[Height - 1].fill(Block.J);
  f.field[Height - 1][0] = 0;
  f.currentPiece.posY = Height - 3; // resting on the stack
  f.addLine();
  assert.equal(f.isCollision(f.currentPiece), false);
  f.update(16);
  assert.equal(f.isGameOver, false);
});

test('leftSlide under the falling piece does not end your game', () => {
  const f = fieldWith('O');
  f.currentPiece.posX = 0;
  f.currentPiece.posY = 14;
  for (let y = 14; y < Height; y++) f.field[y][9] = Block.J;
  f.leftSlide();
  f.update(16);
  assert.equal(f.isGameOver, false);
  assert.equal(f.isCollision(f.currentPiece), false);
});

test('a piece whose top matrix rows are empty can lock at the top', () => {
  const f = fieldWith('I'); // filled cells are in matrix row 2
  for (let y = 2; y < Height; y++) f.field[y].fill(Block.J);
  for (let y = 2; y < Height; y++) f.field[y][9] = 0; // no full rows
  f.movePieceDown(); // posY 0 collides, so it locks at -1 with cells in row 1
  assert.equal(f.isGameOver, false);
  assert.equal(f.field[1][3], Block.I);
});

test('locking with cells above the well is a game over', () => {
  const f = fieldWith('T'); // filled cells in matrix rows 0-1
  for (let y = 1; y < Height; y++) f.field[y].fill(Block.J);
  for (let y = 1; y < Height; y++) f.field[y][0] = 0;
  f.movePieceHardDrop();
  assert.equal(f.isGameOver, true);
});

test('lines the last piece completed make room for the next one', () => {
  const f = fieldWith('I');
  // Columns 1-9 stacked to the top, so the next piece can't spawn until a
  // vertical I in column 0 clears the bottom four rows.
  for (let y = 0; y < Height; y++) for (let x = 1; x < Width; x++) f.field[y][x] = Block.J;
  f.currentPiece.rotateRight();
  f.currentPiece.posX = -f.currentPiece.shape[0].findIndex((v) => v !== 0);
  f.movePieceHardDrop();
  assert.equal(f.update(16), 4); // still a tetris, so the garbage line goes out
  assert.equal(f.isGameOver, false);
  assert.equal(f.lines, 4);
});

test('a new piece that does not fit ends the game', () => {
  const f = fieldWith('T'); // filled cells in rows -1 and 0 at the spawn row
  for (let y = 0; y < Height; y++) f.field[y][4] = Block.J; // no full rows
  f.update(16);
  assert.equal(f.isGameOver, true);
});

test('hold swaps the held piece in at the spawn row and spawn rotation', () => {
  const f = fieldWith('T');
  f.holdPiece();
  f.canHoldPiece = true;
  f.currentPiece.rotateRight();
  f.currentPiece.posY = 10;
  const second = f.currentPiece;
  f.holdPiece();
  assert.equal(f.currentPiece.kind, 'T');
  assert.equal(f.currentPiece.posY, -1);
  assert.equal(f.heldPiece, second);
  assert.equal(second.orientation, 0);
});

test('the ghost piece is up to date after a line clear', () => {
  const f = fieldWith('O');
  f.field[Height - 1].fill(Block.J);
  f.field[Height - 1][0] = 0;
  f.field[Height - 1][1] = 0;
  f.currentPiece.posX = 0;
  f.movePieceHardDrop(); // completes the bottom row
  f.clearLines();
  // Next piece is a horizontal I (cells in matrix row 2) over an empty bottom
  // row, so it lands at posY 17; before the clear it would have been 16.
  assert.equal(f.currentPiece.kind, 'I');
  assert.equal(f.shadowY, 17);
});

test('only cleared rows with powers are left out of the power counter', () => {
  const f = new TetrisField(0, { random: fixedRandom(0) });
  f.field[Height - 1].fill(Block.J);
  f.field[1] = [Block.Drop, Block.AddLine, 0, 0, 0, 0, 0, 0, 0, 0];
  f.clearLines();
  assert.equal(f.powerIntervalCount, 1);

  f.field[Height - 1].fill(Block.J);
  f.field[Height - 1][4] = Block.Drop;
  f.clearLines();
  assert.equal(f.powerIntervalCount, 1);
});

test('when both players top out together, start restarts the game', () => {
  const game = new GameScreen({ playerCount: 2, random: fixedRandom(0) });
  game.players.forEach((p) => (p.isGameOver = true));
  assert.equal(game.allOut, true);
  assert.equal(game.isFinished, true);
  game.update(16, (j) => ({ ...emptyState(), start: j === 1 }));
  assert.ok(game.players.every((p) => !p.isGameOver));
});

test('powers do not touch opponents that are already out', () => {
  const game = new GameScreen({ playerCount: 2, random: fixedRandom(0) });
  const [p1, p2] = fields(game);
  p2.isGameOver = true;
  const before = JSON.stringify(p2.field);
  p1.powers = [Block.AddLine, Block.Drop];
  game.usePower(p1);
  game.usePower(p1);
  assert.equal(JSON.stringify(p2.field), before);
});

test('solo play has no winner and restarts from game over', () => {
  const game = new GameScreen({ playerCount: 1, random: fixedRandom(0) });
  game.update(16, () => emptyState());
  assert.equal(game.players[0].isWinner, false);
  assert.equal(game.isFinished, false);
  game.players[0].isGameOver = true;
  assert.equal(game.isFinished, true);
  game.update(16, () => ({ ...emptyState(), start: true }));
  assert.equal(game.players[0].isGameOver, false);
});

test('solo play only spawns powers that act on your own field', () => {
  const game = new GameScreen({ playerCount: 1 });
  assert.deepEqual(fields(game)[0].powerList, [Block.ClearLine, Block.LeftSlide]);
  const versus = new GameScreen({ playerCount: 2 });
  assert.equal(fields(versus)[0].powerList.length, 4);
});
