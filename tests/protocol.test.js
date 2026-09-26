import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeField, encodeField, snapshotOf, BUILD_ID } from '../src/net/protocol.js';
import { TetrisField, Width, Height } from '../src/game/tetrisField.js';
import { Block } from '../src/game/block.js';

const fixedRandom = (value) => () => value;

test('a field survives encode and decode', () => {
  const field = Array.from({ length: Height }, (_, y) => Array.from({ length: Width }, (_, x) => (x + y) % 12));
  const text = encodeField(field);
  assert.equal(text.length, 200);
  assert.match(text, /^[0-9ab]+$/);
  assert.deepEqual(decodeField(text), field);
});

test('a malformed field decodes to empty cells', () => {
  const empty = Array.from({ length: Height }, () => new Array(Width).fill(0));
  assert.deepEqual(decodeField('123'), empty);
  assert.deepEqual(decodeField(null), empty);
  assert.deepEqual(decodeField(42), empty);
  const bad = decodeField('z'.repeat(200));
  assert.ok(bad.every((row) => row.every((v) => v === 0)));
});

test('a snapshot has the board, piece, powers and score', () => {
  const f = new TetrisField(0, { random: fixedRandom(0) });
  f.field[Height - 1][0] = Block.Drop;
  f.powers = [Block.AddLine];
  f.score = 1200;
  f.lines = 14;
  f.currentPiece.rotateRight();
  const snap = snapshotOf(f, 3);
  assert.equal(snap.t, 'state');
  assert.equal(snap.round, 3);
  assert.equal(snap.field[190], 'a');
  assert.deepEqual(snap.piece, { kind: 'I', rot: 1, x: 3, y: -1 });
  assert.deepEqual(snap.powers, [Block.AddLine]);
  assert.equal(snap.score, 1200);
  assert.equal(snap.lines, 14);
  assert.equal(snap.over, false);
  assert.ok(JSON.stringify(snap).length < 400);

  f.isGameOver = true;
  assert.equal(snapshotOf(f, 3).piece, null);
});

test('the build ID falls back to dev outside a Vite build', () => {
  assert.equal(BUILD_ID, 'dev');
});
