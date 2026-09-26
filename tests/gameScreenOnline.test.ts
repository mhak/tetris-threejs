import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameScreen } from '../src/game/gameScreen.ts';
import { emptyState } from '../src/game/input.ts';
import { Block } from '../src/game/block.ts';
import { Height } from '../src/game/tetrisField.ts';
import type { RemoteField, AttackKind } from '../src/game/remoteField.ts';
import type { Button } from '../src/game/input.ts';

function onlineGame() {
  const game = new GameScreen({ online: true, random: () => 0 });
  game.startRound(1, 7, 0);
  return game;
}

const press = (button: Button) => () => ({ ...emptyState(), [button]: true });
const remote = (game: GameScreen) => game.players[1] as RemoteField;

test('online the opponent is a RemoteField and is never updated locally', () => {
  const game = onlineGame();
  assert.equal(game.players.length, 2);
  assert.equal(remote(game).isRemote, true);
  assert.equal(remote(game).round, 1);
  game.update(16, () => emptyState());
});

test('the opponent topping out does not make us the winner', () => {
  const game = onlineGame();
  game.players[1].isGameOver = true;
  game.update(16, () => emptyState());
  assert.equal(game.players[0].isWinner, false);
  assert.equal(game.isFinished, false);
  assert.equal(game.result, null);
});

test('both topped out is not a local draw either', () => {
  const game = onlineGame();
  game.players.forEach((p) => (p.isGameOver = true));
  game.update(16, () => emptyState());
  assert.equal(game.isFinished, false);
});

test('Start after a round asks the session instead of restarting', () => {
  const game = onlineGame();
  let asked = 0;
  game.onStartPressed = () => asked++;
  game.result = 1;
  const board = game.localField;
  game.update(16, press('start'));
  assert.equal(asked, 1);
  assert.equal(game.localField, board);
});

test('Start during play goes to the session, not straight to pause', () => {
  const game = onlineGame();
  let asked = 0;
  game.onStartPressed = () => asked++;
  game.update(16, press('start'));
  assert.equal(asked, 1);
  assert.equal(game.pause, false);
});

test('our top-out is reported once', () => {
  const game = onlineGame();
  let overs = 0;
  game.onOver = () => overs++;
  game.localField.isGameOver = true;
  game.update(16, () => emptyState());
  game.update(16, () => emptyState());
  assert.equal(overs, 1);
});

test('nothing moves during the countdown', () => {
  const game = new GameScreen({ online: true });
  game.startRound(1, 7, 3000);
  const y = game.localField.currentPiece.posY;
  for (let i = 0; i < 10; i++) game.update(250, press('down'));
  assert.equal(game.localField.currentPiece.posY, y);
  assert.equal(game.countdown, 500);
  game.update(500, () => emptyState());
  assert.equal(game.running, true);
});

test('a Tetris and Add Line send line attacks; Drop sends drop', () => {
  const game = onlineGame();
  const sent: AttackKind[] = [];
  game.onAttack = (kind) => sent.push(kind);
  const local = game.localField;
  for (let y = Height - 4; y < Height; y++) local.field[y].fill(Block.J);
  game.update(16, () => emptyState());
  local.powers = [Block.AddLine, Block.Drop];
  game.usePower(local);
  game.usePower(local);
  assert.deepEqual(sent, ['line', 'line', 'drop']);
});

test('attacks received while paused wait for the resume', () => {
  const game = onlineGame();
  const hits: AttackKind[] = [];
  game.onHit = (kind) => hits.push(kind);
  game.pause = true;
  game.receiveAttack('line');
  assert.deepEqual(hits, []);
  game.pause = false;
  game.countdown = 100;
  game.update(50, () => emptyState());
  assert.deepEqual(hits, []);
  game.update(50, () => emptyState());
  assert.deepEqual(hits, ['line']);
  assert.equal(game.localField.field[Height - 1].filter((v) => v === Block.Z).length, 9);
});

test('attacks are ignored once the round is decided or we are out', () => {
  const game = onlineGame();
  game.result = 0;
  game.receiveAttack('line');
  assert.equal(game.pendingAttacks.length, 0);
  const g2 = onlineGame();
  g2.localField.isGameOver = true;
  g2.receiveAttack('drop');
  assert.equal(g2.pendingAttacks.length, 0);
});

test('a new round gets fresh boards with the new seed', () => {
  const game = onlineGame();
  game.result = 'draw';
  game.startRound(2, 7, 3000);
  const again = new GameScreen({ online: true });
  again.startRound(2, 7, 3000);
  assert.equal(game.result, null);
  assert.equal(remote(game).round, 2);
  assert.equal(game.localField.currentPiece.kind, again.localField.currentPiece.kind);
  assert.equal(game.localField.nextPiece.kind, again.localField.nextPiece.kind);
});
