import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteField } from '../src/game/remoteField.ts';
import { TetrisField, Height } from '../src/game/tetrisField.ts';
import { snapshotOf } from '../src/net/protocol.ts';
import { Block } from '../src/game/block.ts';
import type { AttackKind } from '../src/game/remoteField.ts';

const fixedRandom = (value: number) => () => value;

test('applies a snapshot of another field', () => {
  const source = new TetrisField(0, { random: fixedRandom(0.3) });
  source.movePieceHardDrop();
  source.currentPiece.rotateRight();
  source.currentPiece.posX = 5;
  source.powers = [Block.Drop, Block.ClearLine];
  source.score = 300;
  source.lines = 12;

  const remote = new RemoteField(1, { round: 2 });
  assert.equal(remote.applySnapshot(snapshotOf(source, 2)), true);
  assert.deepEqual(remote.field, source.field);
  assert.equal(remote.currentPiece?.kind, source.currentPiece.kind);
  assert.deepEqual(remote.currentPiece?.shape, source.currentPiece.shape);
  assert.equal(remote.currentPiece?.posX, 5);
  assert.deepEqual(remote.powers, [Block.Drop, Block.ClearLine]);
  assert.equal(remote.score, 300);
  assert.equal(remote.level, 1);
  assert.equal(remote.isGameOver, false);
});

test('ignores snapshots from another round', () => {
  const source = new TetrisField(0, { random: fixedRandom(0) });
  source.field[Height - 1].fill(Block.J);
  const remote = new RemoteField(1, { round: 3 });
  assert.equal(remote.applySnapshot(snapshotOf(source, 2)), false);
  assert.ok(remote.field.every((row) => row.every((v) => v === 0)));
});

test('a top-out snapshot marks the remote board game over', () => {
  const source = new TetrisField(0, { random: fixedRandom(0) });
  source.isGameOver = true;
  const remote = new RemoteField(1, { round: 1 });
  remote.applySnapshot(snapshotOf(source, 1));
  assert.equal(remote.isGameOver, true);
  assert.equal(remote.currentPiece, null);
});

test('junk in a snapshot is cleaned instead of crashing', () => {
  const remote = new RemoteField(1, { round: 1 });
  remote.applySnapshot({ t: 'state', round: 1, field: 'x', piece: { kind: 'Q' }, powers: [1, 8, 99, 'a'], score: 'lots' });
  assert.equal(remote.currentPiece, null);
  assert.deepEqual(remote.powers, [8]);
  assert.equal(remote.score, 0);
  remote.applySnapshot({ t: 'state', round: 1, piece: { kind: 'T', rot: 7, x: 1e9, y: -1e9 } });
  // Read it afresh: the assert above narrowed remote.currentPiece to null.
  const piece = (remote as RemoteField).currentPiece;
  assert.equal(piece?.orientation, 3);
  assert.equal(piece?.posX, 14);
  assert.equal(piece?.posY, -4);
});

test('attacks aimed at it are forwarded', () => {
  const sent: AttackKind[] = [];
  const remote = new RemoteField(1, { onAttack: (kind) => sent.push(kind) });
  remote.addLine();
  remote.movePieceHardDrop();
  assert.deepEqual(sent, ['line', 'drop']);
});
