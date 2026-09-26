import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, randomSeed } from '../src/game/random.ts';
import { TetrisField, Height } from '../src/game/tetrisField.ts';
import { GameScreen } from '../src/game/gameScreen.ts';
import type { PieceKind } from '../src/game/tetromino.ts';

test('mulberry32 is repeatable and stays in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('randomSeed gives 32-bit integers', () => {
  const s = randomSeed();
  assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32);
});

/** The first n pieces a field generates, in order, while `mess` messes with it. */
function pieceKinds(field: TetrisField, n: number, mess?: (field: TetrisField, i: number) => void): PieceKind[] {
  const kinds = [field.currentPiece.kind, field.nextPiece.kind];
  const generate = field.generatePiece.bind(field);
  field.generatePiece = () => {
    const piece = generate();
    kinds.push(piece.kind);
    return piece;
  };
  for (let i = 0; kinds.length < n; i++) {
    mess?.(field, i);
    field.movePieceHardDrop();
    for (const row of field.field) row.fill(0); // keep going forever
    field.isGameOver = false;
  }
  return kinds.slice(0, n);
}

test('the same seed gives the same 100 pieces, whatever else happens', () => {
  const calm = new TetrisField(0, { random: () => 0.5, pieceRandom: mulberry32(1234) });
  const busy = new TetrisField(0, { pieceRandom: mulberry32(1234) }); // Math.random for the rest
  const a = pieceKinds(calm, 100);
  const b = pieceKinds(busy, 100, (f, i) => {
    if (i % 2 === 0) f.addLine();
    if (i % 3 === 0) {
      f.field[Height - 1].fill(1);
      f.spawnRandomPower();
      f.clearLines();
    }
    if (i % 4 === 0) {
      f.canHoldPiece = true;
      f.holdPiece();
    }
  });
  assert.deepEqual(b, a);
  assert.ok(new Set(a).size === 7);
});

test('a different seed gives a different sequence', () => {
  const a = pieceKinds(new TetrisField(0, { pieceRandom: mulberry32(1) }), 30);
  const b = pieceKinds(new TetrisField(0, { pieceRandom: mulberry32(2) }), 30);
  assert.notDeepEqual(a, b);
});

test('without a piece seed, pieces come from random as before', () => {
  let calls = 0;
  const f = new TetrisField(0, {
    random: () => {
      calls++;
      return 0;
    },
  });
  assert.equal(calls, 2); // first and next piece
  assert.equal(f.currentPiece.kind, 'I');
});

test('GameScreen gives every local field its own PRNG from the seed', () => {
  const game = new GameScreen({ playerCount: 2, pieceSeed: 99 });
  const [p1, p2] = game.players as TetrisField[];
  assert.notEqual(p1.pieceRandom, p2.pieceRandom);
  assert.deepEqual(pieceKinds(p1, 20), pieceKinds(p2, 20));
});
