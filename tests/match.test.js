// Two sessions talking over the in-memory transport: the versus rules end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackNetwork, LoopbackTransport } from '../src/net/transport.js';
import { Session, COUNTDOWN_MS, RESULT_WINDOW_MS } from '../src/net/session.js';
import { emptyState } from '../src/game/input.js';
import { Block } from '../src/game/block.js';
import { Height, Width } from '../src/game/tetrisField.js';
import { FakeClock, flush } from './helpers.js';

const idle = () => emptyState();

/** A host and guest past the first countdown. */
export async function match({ seeds = [11, 22, 33] } = {}) {
  const network = new LoopbackNetwork();
  const clock = new FakeClock();
  const seedList = [...seeds];
  const host = new Session({
    role: 'host',
    name: 'alex',
    transport: new LoopbackTransport(network),
    clock,
    makeCode: () => 'K7QX3',
    makeSeed: () => seedList.shift(),
  });
  await host.open();
  const guest = new Session({ role: 'guest', name: 'sam', code: 'K7QX3', transport: new LoopbackTransport(network), clock });
  await guest.open();
  await flush();
  const inputs = { host: idle, guest: idle };
  const tick = async (ms = 16) => {
    clock.advance(ms);
    host.update(ms, inputs.host);
    guest.update(ms, inputs.guest);
    await flush();
  };
  /** Holds a button for one frame on one side. */
  const tap = async (who, button) => {
    inputs[who] = () => ({ ...emptyState(), [button]: true });
    await tick();
    inputs[who] = idle;
    await tick();
  };
  const countdown = async () => {
    for (let t = 0; t < COUNTDOWN_MS; t += 100) await tick(100);
  };
  await countdown();
  return { network, clock, host, guest, tick, tap, countdown };
}

const garbage = (field) => field[Height - 1].filter((v) => v === Block.Z).length;

test('both sides start the round with the same seed and pieces', async () => {
  const { host, guest } = await match();
  assert.equal(host.state, 'playing');
  assert.equal(guest.state, 'playing');
  assert.equal(host.seed, 11);
  assert.equal(guest.seed, 11);
  const [h, g] = [host.game.players[0], guest.game.players[0]];
  assert.equal(h.currentPiece.kind, g.currentPiece.kind);
  assert.equal(h.nextPiece.kind, g.nextPiece.kind);
});

test('a Tetris on one side adds a garbage line on the other', async () => {
  const { host, guest, tick } = await match();
  const h = host.game.players[0];
  for (let y = Height - 4; y < Height; y++) h.field[y].fill(Block.J);
  await tick();
  assert.equal(h.lines, 4);
  assert.equal(garbage(guest.game.players[0].field), Width - 1);
  assert.equal(garbage(h.field), 0);
});

test('Add Line and Drop powers hit the other device', async () => {
  const { host, guest, tap } = await match();
  const g = guest.game.players[0];
  const pieceBefore = g.currentPiece;
  let sent = [];
  guest.onAttackSent = (kind) => sent.push(kind);
  guest.game.players[0].powers = [Block.AddLine, Block.Drop];
  await tap('guest', 'y');
  await tap('guest', 'y');
  assert.deepEqual(sent, ['line', 'drop']);
  const h = host.game.players[0];
  assert.notEqual(h.currentPiece, pieceBefore);
  // The garbage row, then the dropped piece locked on top of it.
  assert.equal(garbage(h.field), Width - 1);
  assert.ok(h.field[Height - 2].some((v) => v !== 0));
});

test('the first top-out loses, and both sides agree', async () => {
  const { host, guest, tick, clock } = await match();
  guest.game.players[0].isGameOver = true;
  await tick();
  assert.equal(host.result, null); // the draw window is still open
  clock.advance(RESULT_WINDOW_MS);
  await flush();
  for (const s of [host, guest]) {
    assert.equal(s.state, 'roundOver');
    assert.equal(s.result, 'host');
    assert.deepEqual(s.wins, { host: 1, guest: 0 });
  }
  assert.equal(host.game.result, 0);
  assert.equal(guest.game.result, 1);
  assert.equal(host.winnerName, 'ALEX');
  assert.equal(guest.winnerName, 'ALEX');
  assert.deepEqual(guest.score, [0, 1]);
});

test('the host topping out gives the guest the win', async () => {
  const { host, guest, tick, clock } = await match();
  host.game.players[0].isGameOver = true;
  await tick();
  clock.advance(RESULT_WINDOW_MS);
  await flush();
  assert.equal(host.result, 'guest');
  assert.equal(guest.result, 'guest');
  assert.equal(guest.game.result, 0);
});

test('topping out within the window of each other is a draw', async () => {
  const { host, guest, tick } = await match();
  host.game.players[0].isGameOver = true;
  guest.game.players[0].isGameOver = true;
  await tick();
  assert.equal(host.result, 'draw');
  assert.equal(guest.result, 'draw');
  assert.deepEqual(host.wins, { host: 0, guest: 0 });
});

test('a top-out after the window closed does not change the result', async () => {
  const { host, guest, tick, clock } = await match();
  host.game.players[0].isGameOver = true;
  await tick();
  clock.advance(RESULT_WINDOW_MS + 10);
  guest.game.players[0].isGameOver = true;
  await tick();
  assert.equal(host.result, 'guest');
  assert.equal(guest.result, 'guest');
});

test('the guest keeps playing until the result arrives', async () => {
  const { host, guest, tick } = await match();
  host.game.players[0].isGameOver = true;
  await tick();
  assert.equal(guest.state, 'playing');
  const y = guest.game.players[0].currentPiece.posY;
  for (let i = 0; i < 70; i++) {
    host.clock.advance(0);
    guest.update(16, idle);
  }
  assert.ok(guest.game.players[0].currentPiece.posY > y);
});

test('pause and resume reach both sides, with a countdown', async () => {
  const { host, guest, tap, tick, countdown } = await match();
  await tap('host', 'start');
  assert.equal(host.state, 'paused');
  assert.equal(guest.state, 'paused');
  assert.equal(guest.game.pause, true);
  const y = guest.game.players[0].currentPiece.posY;
  for (let i = 0; i < 100; i++) await tick(16);
  assert.equal(guest.game.players[0].currentPiece.posY, y);
  await tap('guest', 'start'); // either player can resume
  assert.equal(host.state, 'countdown');
  assert.equal(guest.state, 'countdown');
  await countdown();
  assert.equal(host.state, 'playing');
  assert.equal(guest.state, 'playing');
});

test('an attack while paused lands after the resume countdown', async () => {
  const { host, guest, tap, countdown } = await match();
  await tap('host', 'start');
  host.receive({ t: 'attack', round: 1, kind: 'line' }, host.transport.current);
  assert.equal(garbage(host.game.players[0].field), 0);
  await tap('guest', 'start');
  await countdown();
  assert.equal(garbage(host.game.players[0].field), Width - 1);
  assert.equal(guest.state, 'playing');
});

test('attacks and results from an old round are ignored', async () => {
  const { host, guest } = await match();
  guest.receive({ t: 'attack', round: 0, kind: 'line' }, guest.transport.current);
  guest.receive({ t: 'attack', round: 1, kind: 'nuke' }, guest.transport.current);
  guest.receive({ t: 'result', round: 0, winner: 'guest' }, guest.transport.current);
  assert.equal(garbage(guest.game.players[0].field), 0);
  assert.equal(guest.result, null);
  assert.equal(host.state, 'playing');
});
